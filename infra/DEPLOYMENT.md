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
   sent as `X-Internal-Token` by the valuation client and required by all three
   internal services — `ai`, `engine-wrapper` and `report` — on every non-health
   route. `report` was the exception until r38: it rendered an 8 MB body for any
   caller that reached port 3004, with the firewall and the loopback bind as the
   only guard. Every unit already loads the same `.env`, so no new variable is
   needed.

   **This is fail-closed.** A missing secret used to log one warning and then
   serve every non-health route unauthenticated — a line indistinguishable from
   the one a developer laptop prints, where it is correct. All three services
   now **refuse to start** without it when they are told they are in production:
   `NODE_ENV=production` for `report`, `APP_ENV=production` for `ai` and
   `engine-wrapper`. If a unit crash-loops after a deploy with
   `INTERNAL_SERVICE_TOKEN is required`, that is this check, and the fix is the
   variable rather than the flag.
4. **Forced PII redaction.** `n409-ai` runs with `APP_ENV=production`, which
   makes `options.anonymize=false` a no-op. `n409-engine-wrapper` sets it too,
   for the token check in item 3 — it has no LLM call to redact.
5. **Document encryption at rest.** Set `DOCUMENTS_ENCRYPTION_KEY` in
   `/opt/N409/.env` (`openssl rand -hex 32`) to AES-256-GCM the stored blobs.

## Required environment (`/opt/N409/.env`, chmod 600)

Beyond the pre-existing vars (DATABASE_URL, JWT_SECRET, JWT_ISSUER,
JWT_TTL_SECONDS, LOG_LEVEL, OPENROUTER_API_KEY, DOCUMENTS_DIR, …), the hardening
work adds:

```
NODE_ENV=production
INTERNAL_SERVICE_TOKEN=<openssl rand -hex 32>   # valuation ⇄ ai/engine/report; REQUIRED
DOCUMENTS_ENCRYPTION_KEY=<openssl rand -hex 32> # document blobs at rest
PUBLIC_BASE_URL=https://n409.aiknol.com         # emailed links (reset, board sign)
BUILD_SHA_FILE=/opt/N409/BUILD_SHA              # provenance, written by the deploy
# On the ai and engine-wrapper units (set in the unit files, not .env):
#   APP_ENV=production
```

`INTERNAL_SERVICE_TOKEN` is the one entry above that is not optional: omit it
and `report`, `ai` and `engine-wrapper` all fail to start (security posture
item 3). Everything else degrades rather than refusing.

### Optional: Amazon Bedrock as a second completion provider (design §12.2)

OpenRouter is the default and needs nothing here. Bedrock is for the
installation whose counsel has approved AWS and not a third-party aggregator:
the same prompts, run inside your own account, in a region you name, under an
IAM role you control. Set all three and the provider turns on; leave any one
unset and it stays off, and every prompt keeps routing to OpenRouter.

```
BEDROCK_REGION=us-east-1
AWS_ACCESS_KEY_ID=<key with bedrock:InvokeModel and bedrock:ListFoundationModels>
AWS_SECRET_ACCESS_KEY=<secret>
AWS_SESSION_TOKEN=<only for temporary credentials>
BEDROCK_MODEL=anthropic.claude-sonnet-4-20250514-v1:0   # optional; this is the default
BEDROCK_MAX_TOKENS=2000                                  # optional
BEDROCK_CALL_BUDGET_S=150                                # optional; 0 disables
```

Routing is per prompt, by model id: bind a prompt to `bedrock/<model-id>` in
Bot Prompts and it runs there; anything else runs on OpenRouter. `/ready`
reports `bedrock_credentials` when configured but never gates on it — a lapsed
AWS key must not take the OpenRouter path down with it, and only the prompts
explicitly bound to a `bedrock/` model are affected.

### Client addresses behind the proxy (`TRUSTED_PROXIES`)

Nothing reaches the services from a browser directly: Caddy dials web, and web
proxies `/api` to valuation over loopback. Left at Fastify's default, `req.ip`
is therefore the *socket peer* — Caddy at web, and web itself at valuation —
which is the same value for every request on the internet. Fourteen throttles
key on it (contact, the client-intake / auditor / board portals, SCIM, and eight
in the auth routes), so they were fourteen **global** limits rather than
per-client ones: five contact submissions per ten minutes for everybody
together, and one caller able to spend the whole platform's budget and lock out
the rest. The login audit trail recorded the proxy on every row for the same
reason.

Both Node services now resolve the caller through the hops we run.
`TRUSTED_PROXIES` overrides which those are — a comma-separated list of
addresses, CIDRs, or proxy-addr presets:

```
# Default, and correct for this box — no need to set it:
TRUSTED_PROXIES=loopback, linklocal, uniquelocal
```

The default deliberately spans both documented topologies, because they differ:
the note below says Caddy reaches web over loopback, while `infra/caddy/` dials
`host.docker.internal` from a container, which arrives from the Docker bridge
(172.17/16). `uniquelocal` covers RFC1918 and so covers the bridge; `loopback`
covers the same-host case and the web→valuation hop. Neither range is routable
from the internet, so a direct connection to the published port 3000 still
resolves to its own source address.

`TRUSTED_PROXIES=none` trusts no hop (`req.ip` stays the socket peer) — correct
only for a service exposed with nothing in front. **`true` / `all` / `*` are
refused at boot**: they make `req.ip` the client's own header, so every rate
limit becomes self-exempting and every audit row becomes a claim. If a service
will not start with that message, name the hops instead of widening the trust.

**A wide CIDR is refused for the same reason**, because it says the same thing
without looking like it. `0.0.0.0/1, 128.0.0.0/1` tiles the whole IPv4 space and
is therefore exactly `true`; `2000::/3` is every routable IPv6 address; a single
`198.0.0.0/4` already covers enough of the internet to hand the forgery to
anyone inside it. The rule is breadth, not routability — a trusted-proxy list
names hops you operate, so IPv4 entries must be `/8` or tighter and IPv6 entries
`/32` or tighter. Real fleets are unaffected (a CDN's widest IPv4 block is about
a `/13`, an ISP IPv6 allocation about a `/32`), and blocks lying wholly inside
non-routable space — `10.0.0.0/8`, `fc00::/7`, `127.0.0.0/8` — are exempt at any
width, since that is what `uniquelocal` and `loopback` already are.

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

> **Run `infra/deploy.sh` instead of following the steps by hand.** It performs
> exactly the sequence below and enforces the four traps this section documents:
> the build is mandatory and fatal, `BUILD_SHA` comes from the *local* checkout
> and is written only after a build that succeeded, files deleted since the
> deployed commit are removed, and `n409-valuation` restarts first — *and has
> finished booting*, which is what makes "migrations run first" true rather than
> merely intended. It then verifies `/health` reports the commit you deployed and
> fails the deploy if it does not.
>
> Both waits poll rather than probe once. Every unit is `Type=simple`, so
> `systemctl restart` returns when the process has been **forked**, not when it
> is listening — a single immediate probe races the boot and usually loses,
> failing a deploy that actually succeeded. `VERIFY_TIMEOUT` (default 120s) and
> `VERIFY_INTERVAL` (default 3s) bound the wait.
>
> ```
> infra/deploy.sh                                   # dry run — prints the plan, changes nothing
> HOST=root@204.168.241.124 infra/deploy.sh --apply # deploy HEAD
> ```
>
> Dry run is the default deliberately — this is the one script whose accidental
> invocation restarts production. It refuses a dirty working tree, because the
> archive is built from `HEAD`: uncommitted work would silently not deploy while
> `BUILD_SHA` claimed the commit. `src/packages/shared/test/deploy.test.ts`
> exercises it against stubbed `ssh`/`scp`/`curl`.
>
> The manual steps remain below as the specification the script implements, and
> for the case where something has gone wrong enough to need them.

1. Push the tree to `/opt/N409`. The host has **no GitHub credentials**, so
   `git fetch` there fails with `could not read Username` — pushing from the
   local checkout is the only path that works:

   ```
   git archive --format=tar.gz -o /tmp/n409.tar.gz HEAD
   scp /tmp/n409.tar.gz root@<host>:/root/
   ssh root@<host> 'cd /opt/N409 && tar -xzf /root/n409.tar.gz'
   ```

   `git archive` carries only tracked files at HEAD, so `.env`, `keys/`,
   `node_modules/`, `dist/` and the `.venv`s are left alone. It also never
   **deletes**, so when a commit removed a tracked file, remove it by hand
   (`git diff --diff-filter=D --name-only <deployed>..HEAD`). rsync works too,
   excluding `node_modules dist keys .env* .venv __pycache__ *.tsbuildinfo`.
2. On the server: `npm ci && npm run build` (**mandatory** — `dist/` is
   gitignored, so a skipped build is a silent no-op that keeps old code live).
   When a Python service's `requirements.txt` changed:
   `.venv/bin/pip install -r requirements.txt`.
3. **Record what was built** — immediately after a successful build, and only
   after, so the file always names code that actually compiled:

   ```
   git rev-parse HEAD                     # in the LOCAL checkout you archived
   ssh root@<host> 'cat > /opt/N409/BUILD_SHA && chown n409:n409 /opt/N409/BUILD_SHA'
   ```

   Take the SHA from the **local** checkout. Do not run
   `git -C /opt/N409 rev-parse HEAD` on the server: a `git archive` deploy
   updates the working tree without moving the server's `HEAD`, so that command
   reports whatever commit was last actually checked out there — writing a
   confidently wrong SHA, which is worse than the `unknown` this file exists to
   replace. (A side effect of the same thing: `git status` on the host lists
   hundreds of modified files and its `HEAD` is meaningless as a version
   marker.)

   `/health` reports this as `build_sha`, which is the only way to tell from
   outside the box which commit is live (step 2 is the step that gets skipped,
   and `git rev-parse` alone only proves what was *fetched*). `BUILD_SHA_FILE`
   in `.env` points the services at it. A deploy that skips this reports
   `"build_sha":"unknown"` rather than a stale value.
4. `systemctl restart 'n409-*'` (restart `n409-valuation` first — migrations run
   on its boot — and wait for its `/health` to answer before restarting the
   others; `Type=simple` means `restart` returns at fork, so issuing the two
   commands in order does not by itself sequence the two boots).
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
