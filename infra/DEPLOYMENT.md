# N409 deployment (source of truth)

**Audit I-1 P1.** The committed Terraform (`infra/terraform/`) describes an
AWS-style containerized stack (RDS/Redis/S3/VPC) that is **not** how N409 runs.
The live system is **five systemd units on a single Hetzner host**, deployed by
pushing a build of the local checkout, fronted by Caddy. That divergence meant
the real production config — firewall, service bind addresses, DB SSL, backups —
was captured nowhere and reviewed nowhere. This document is the source of truth
for what actually runs; the Terraform is kept as an aspirational/reference design
and should be treated as **unused** until a migration is actually planned.

## Topology

| Unit                   | Port | Runtime                    | Exposure                         |
| ---------------------- | ---- | -------------------------- | -------------------------------- |
| `n409-web`             | 3000 | Node (`dist/index.js`)     | Public (Caddy → :3000)           |
| `n409-valuation`       | 3001 | Node (`dist/index.js`)     | **Internal only** (loopback)     |
| `n409-ai`              | 3002 | Python/uvicorn (venv)      | **Internal only** (loopback)     |
| `n409-engine-wrapper`  | 3003 | Python/uvicorn (venv)      | **Internal only** (loopback)     |
| `n409-report`          | 3004 | Node (`dist/index.js`)     | **Internal only** (loopback)     |

- Host: a Hetzner VPS (Ubuntu), code at `/opt/N409`, uploaded documents at
  `/opt/n409-data/documents` (outside the deploy tree). Native services — no
  Docker on the server. `docker-compose.yml` is for **local dev only**.
- Caddy terminates TLS for `n409.aiknol.com` and reverse-proxies to `:3000`
  (`infra/caddy/`). Only the web service faces the internet.
- Unit files: `infra/systemd/*.service` — install to `/etc/systemd/system/`,
  then `systemctl daemon-reload && systemctl enable --now 'n409-*'`.

## Security posture (audit B-1 P0 / I-1)

The single most important production control, and the reason this doc exists:

1. **Host firewall — run `infra/firewall/ufw-setup.sh` once as root.** It denies
   inbound by default and opens only SSH, 80/443 (Caddy), and 3000 (web). Ports
   **3001–3004 are never opened to the internet.** Historically `ufw` was
   inactive and the services bound `0.0.0.0`, leaving the unauthenticated AI and
   engine services reachable by anyone who could hit the box (the P0).
2. **Loopback bind.** The `n409-ai` / `n409-engine-wrapper` units start uvicorn
   with `--host 127.0.0.1`; the valuation service reaches them over loopback.
3. **Shared-secret header.** `INTERNAL_SERVICE_TOKEN` (in `/opt/N409/.env`) is
   sent as `X-Internal-Token` by the valuation client and required by both
   Python services on every non-health route.
4. **Forced PII redaction.** `n409-ai` runs with `APP_ENV=production`, which
   makes `options.anonymize=false` a no-op.
5. **Document encryption at rest.** Set `DOCUMENTS_ENCRYPTION_KEY` in
   `/opt/N409/.env` (`openssl rand -hex 32`) to AES-256-GCM the stored blobs.

## Required environment (`/opt/N409/.env`, chmod 600)

Beyond the pre-existing vars (DATABASE_URL, JWT_SECRET, JWT_ISSUER,
JWT_TTL_SECONDS, LOG_LEVEL, OPENROUTER_API_KEY, DOCUMENTS_DIR, …), the hardening
work adds:

```
NODE_ENV=production
INTERNAL_SERVICE_TOKEN=<openssl rand -hex 32>   # valuation ⇄ ai/engine
DOCUMENTS_ENCRYPTION_KEY=<openssl rand -hex 32> # document blobs at rest
PUBLIC_BASE_URL=https://n409.aiknol.com         # emailed links (reset, board sign)
BUILD_SHA_FILE=/opt/N409/BUILD_SHA              # provenance, written by the deploy
# On the ai unit (set in the unit file, not .env): APP_ENV=production
```

### Email delivery

`EMAIL_MODE` accepts only `smtp` | `log` | `off` (`config.ts`) — there is no
`sendgrid` mode, and no code reads `SENDGRID_API_KEY`. SendGrid is used as a
plain SMTP relay, which is why the only email transport in
`buildEmailTransports` is `smtpTransport`:

```
EMAIL_MODE=smtp
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey                                # literal string, not the key
SMTP_PASS=<SendGrid API key, SG.…>              # the key goes here
SMTP_FROM=N409 Valuations <no-reply@n409.aiknol.com>
```

Two failure modes that look like "email is broken" but are config, not code:

- `EMAIL_MODE=smtp` with `SMTP_HOST` unset silently **falls back to the log
  transport** (it warns once at boot). Outbox rows still go to `sent`, so
  nothing surfaces as an error — grep the boot log for that warning.
- `SMTP_FROM` must be a sender identity **verified in SendGrid** (single sender
  or an authenticated domain). The `no-reply@n409.local` default is not, and
  SendGrid rejects unverified senders with a 403 at send time, not at boot.

> The Node services bind **127.0.0.1** unless `HOST` says otherwise
> (`shared/listen.ts`), matching the Python units. Do not set `HOST` on this
> host — Caddy reaches web over loopback. `HOST=0.0.0.0` is for containers only,
> where Docker cannot publish a loopback-bound port.

> `JWT_SECRET` must be a unique random value — the config layer refuses to boot
> in production with a known example or low-entropy secret.

## Deploy procedure

1. Build locally and push the tree to `/opt/N409` (rsync excluding
   `node_modules dist keys .env* .venv __pycache__ *.tsbuildinfo`, or
   `git fetch + reset --hard origin/main` with a PAT — the server is a real git
   checkout).
2. On the server: `npm ci && npm run build` (**mandatory** — `dist/` is
   gitignored, so a skipped build is a silent no-op that keeps old code live).
   When a Python service's `requirements.txt` changed:
   `.venv/bin/pip install -r requirements.txt`.
3. **Record what was built** — immediately after a successful build, and only
   after, so the file always names code that actually compiled:

   ```
   git -C /opt/N409 rev-parse HEAD > /opt/N409/BUILD_SHA
   chown n409:n409 /opt/N409/BUILD_SHA
   ```

   `/health` reports this as `build_sha`, which is the only way to tell from
   outside the box which commit is live (step 2 is the step that gets skipped,
   and `git rev-parse` alone only proves what was *fetched*). `BUILD_SHA_FILE`
   in `.env` points the services at it. A deploy that skips this reports
   `"build_sha":"unknown"` rather than a stale value.
4. `systemctl restart 'n409-*'` (restart `n409-valuation` first — migrations run
   on its boot).
5. Verify: all five `/health` (engine-wrapper: `/engine/v1/health`) return 200,
   `curl -s localhost:3000/health | jq -r .build_sha` matches the commit you
   deployed, `curl -s localhost:3000/ready` is 200 with all four checks `ok`,
   and 3000–3004 are **not** reachable from off-host (`nc -z <public-ip> 3002`
   must fail — the services now bind loopback, so this holds even if ufw is
   misconfigured).

## Service user (audit P1-1)

The five services and the backup job run as the dedicated **`n409`** system user
(never root). Create it once on the host, then the unit files' `User=n409` /
`Group=n409` take effect:

```
useradd --system --home /opt/N409 --shell /usr/sbin/nologin n409
chown -R n409:n409 /opt/N409 /opt/n409-data
chown n409:n409 /opt/N409/.env && chmod 600 /opt/N409/.env   # audit P1-2
```

The units run with `ProtectSystem=strict` (the whole FS is read-only), so each
service can write only to its `ReadWritePaths`: `n409-valuation` →
`/opt/n409-data` (uploaded documents), `n409-backup` → `/opt/n409-backups`. The
other services (web, ai, engine-wrapper, report) write nothing to disk (logs go
to the journal), so they need no `ReadWritePaths`. Code under `/opt/N409` stays
world-readable, so services still start even if a deploy resets file ownership;
only `/opt/n409-data` and `/opt/n409-backups` must remain `n409`-owned.

## Backups / DR (audit P0-1)

Automated nightly PostgreSQL backups are live — see **`infra/backup/`**
(`README.md` has the full runbook):

- **`pg-backup.sh`** — `pg_dump -Fc` into `/opt/n409-backups/daily`, promotes a
  weekly copy on Sundays, prunes to **7 daily + 4 weekly**.
- **`n409-backup.timer`** fires **`n409-backup.service`** nightly at **02:00**
  (`Persistent=true`, runs as `n409`). Install:
  `cp infra/backup/n409-backup.{service,timer} /etc/systemd/system/ &&
  systemctl enable --now n409-backup.timer`.
- **Restore:** `infra/backup/pg-restore.sh <dump> [target-url]`
  (`pg_restore --clean --if-exists --single-transaction`). Rehearse monthly into
  a scratch DB per the README; the initial rehearsal passed (77 tables restored,
  matching live).
- **Off-host copies:** `/opt/n409-backups` lives on the same VPS — for true DR,
  also sync it (and `/opt/n409-data/documents`, now optionally encrypted) off-box.
