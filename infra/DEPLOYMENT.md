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
- Request flow: browser → Caddy → `web` → `valuation`, and `valuation` →
  `ai` / `engine-wrapper` / `report`. The last of those three was aspirational
  until round 98 — `n409-report` had run since M2 serving nothing but `/health`
  while the valuation service rendered every PDF in-process — and is now real:
  `REPORT_URL` (default `http://127.0.0.1:3004`) sends the document to 3004 so
  that a 400–700ms pdfkit layout does not block the API's event loop.
  `REPORT_URL=` takes the hop back out. **A report unit that is down is not an
  outage:** the caller falls back to rendering in-process, which is what it did
  before. Confirm which is happening with
  `curl -H "authorization: Bearer $METRICS_TOKEN" localhost:3001/metrics | grep report_render`
  — a rising `mode="local"` with a `reason` other than `not_configured` means
  the offload is failing and nothing else will say so. (`METRICS_TOKEN` is
  optional and unset here; the endpoint accepts `INTERNAL_SERVICE_TOKEN`, which
  is what the command above actually uses on this host.)
- The valuation service holds at most 4 renders in flight at 3004 and lets 12
  more wait; past that it renders in-process again and counts
  `reason="queue_full"`. The bound is memory, measured on the report service:
  116MB idle and about 10MB of retained working set per concurrent render
  (326MB at 12, 407MB at 24), against 3.8GB of host with ~2.4GB in use and swap
  already touched. Round 99 gave that bound a ceiling to sit under — see
  [Memory limits](#memory-limits) — and the two numbers are checked against each
  other on every deploy rather than kept in step by hand. The renders
  serialize anyway — one Node thread — so a deeper queue buys latency and memory
  and no throughput at all. A non-zero `queue_full` rate means the renders want
  their own host, not a bigger number.
- Unit files: `infra/systemd/*.service` and `infra/backup/*.{service,timer}`.
  **`deploy.sh` installs these** (via `infra/install-units.sh`) on every deploy:
  it copies any that differ from the checkout into `/etc/systemd/system/`,
  reloads systemd if any moved, enables all of them, and re-arms changed timers.
  This repo is the authority — a unit edited on the box is overwritten by the
  next deploy. It was not always so: for four weeks the host ran units dated
  21 Jul against a repo that had moved on 14 Aug, and the line that had not
  travelled was engine-wrapper's `Environment=APP_ENV=production`, which is the
  switch that makes its `INTERNAL_SERVICE_TOKEN` guard mandatory rather than
  advisory. First-time bring-up on a bare host is the same command:
  `bash infra/install-units.sh` as root.

## Memory limits

Every unit this repo installs declares three memory directives. Until round 99
none of them did, which meant the answer to a leak in any N409 process was the
kernel's global OOM killer — and that picks its victim by resident size. On this
box the two largest processes are an unrelated product's engine and PostgreSQL,
so a memory bug in the report renderer would have killed the database and left
the renderer running.

| Unit                       |   High |    Max | Swap | Sized from                             |
| -------------------------- | -----: | -----: | ---: | -------------------------------------- |
| `n409-report`              |  384M  |  512M  | 128M | 16 concurrent renders (derived, below) |
| `n409-valuation`           |  288M  |  384M  |  96M | 144M peak + in-process render fallback |
| `n409-web`                 |  144M  |  192M  |  48M | 78M peak                               |
| `n409-ai`                  |  192M  |  256M  |  64M | 62M peak                               |
| `n409-engine-wrapper`      |  192M  |  256M  |  64M | 50M peak                               |
| `n409-backup`              |  192M  |  256M  |  64M | `pg_dump` is a streaming client        |
| `n409-backup-verify`       |  384M  |  512M  | 128M | as above, doubled — see below          |

Why three directives rather than one `MemoryMax`:

- **`MemoryMax`** is the kill. Under cgroup v2 it caps pages resident in RAM,
  and a process that breaches it is SIGKILLed and restarted by `Restart=always`.
- **`MemorySwapMax`** is what makes `MemoryMax` a bound at all. Swap is
  accounted separately and defaults to unlimited, so a leak under a `MemoryMax`
  alone stays *under its limit indefinitely* while filling this host's 2GB of
  swap and thrashing every other tenant. The estate writes a quarter of the RAM
  ceiling: enough for reclaim to have somewhere to put cold pages, not enough
  for a service to run mostly paged out.
- **`MemoryHigh`** is the throttle, and the only thing that happens *before* the
  kill. Without it a unit has one memory behaviour and no warning.

Two of the numbers are checked rather than trusted, both by
`preflight-cli.js` during the deploy (section 4b), so a fault costs a failed
deploy with the previous release still serving:

- **The report ceiling against the delegation bound.** `MAX_DELEGATED_IN_FLIGHT`
  + `MAX_DELEGATED_QUEUED` in `clients/reportRender.ts` is 16 renders that can
  be resident at once, at the idle size and per-render cost measured in round
  98 — a 276M floor. Raise the queue depth without raising the unit's ceiling
  and the deploy fails instead of the host.
- **The estate's total against the host's RAM.** The sum is the always-on units
  plus the largest scheduled job — 04:00 Sunday is a moment when the backup
  verification and all five services are live at once — and it has to leave a
  gigabyte for PostgreSQL, Caddy, the kernel and the two unrelated products. A
  limit raised past what this box can honour, or the estate moved onto a smaller
  box, is invisible from any single unit file and fails here.

The backup pair sits above its measurement rather than at it, deliberately: a
`pg_dump` killed by a memory limit is a night with no backup, and a verification
killed part-way reports as a failed verification — the one false alarm
guaranteed to get that timer switched off.

### Watching a unit approach its ceiling

The three Fastify services export their own cgroup state, so the limit is
visible beside the usage rather than only in `systemctl show`:

```bash
curl -H "authorization: Bearer $INTERNAL_SERVICE_TOKEN" localhost:3004/metrics \
  | grep n409_cgroup_memory
```

`n409_cgroup_memory_current_bytes` over `n409_cgroup_memory_max_bytes` is the
number to watch. `n409_cgroup_memory_events{event="high"}` counts throttling
episodes and `{event="max"}` counts near-breaches; both tick long before
anything dies and are the actual early warning.

`{event="oom_kill"}` is the one to read carefully. systemd destroys a unit's
cgroup when it stops and creates a fresh one when it starts, so these counters
reset on every restart — and a restart is what follows a kill. A service killed
at its ceiling comes back reporting `oom_kill 0`. The durable record of a kill
is the journal:

```bash
journalctl -u n409-report --since '-1d' | grep -i 'memory\|oom\|killed'
systemctl show n409-report -p MemoryPeak -p MemoryCurrent -p MemoryMax
```

The Python pair has no `/metrics` endpoint — the same reason the readiness
contract covers three services rather than five — so their ceilings are visible
through `systemctl show` and the journal only.

### Alert thresholds

Every instrument named above — and the three dozen beside it — is a number
somebody has to already suspect before they go and look at it. The thresholds
that turn them into a signal live in `infra/monitoring/alerts.yml`, as a
Prometheus rule group: what value is a problem, for how long, and whether it is
worth waking somebody for. That file's header carries the scrape configuration
(the three targets, the token, and why the Python pair is measured from the
caller instead) and the two-level severity policy.

Nothing on the box scrapes it today. The file is still the written answer to
"how would we know?", and `alertRulesCensus.test.ts` holds every metric it names
to one the code actually registers — so a renamed instrument fails the suite
rather than silently converting an alert into one that can never fire. A rule
matching no series is indistinguishable from a healthy system.

### How much journal there is to read

`journalctl` is only useful for as far back as the journal goes, and that used
to be whatever the distro defaulted to. `infra/journald/10-n409.conf` states it,
`infra/install-journald.sh` puts it in place, and section 4c2 of `deploy.sh`
runs that on every deploy:

- **persistent** — the default `auto` keeps the journal in a tmpfs unless
  `/var/log/journal` already exists, which means the reboot that follows an OOM
  kill is also what erases the evidence of it. This creates the directory.
- **512M, 30 days** — whichever binds first. Unbounded, the journal is a
  slow-motion outage on a single-disk host whose first symptom is Postgres
  refusing writes, not "the logs got big". `SystemKeepFree` is deliberately left
  at its 15%-of-filesystem default; any absolute figure worth writing would be
  smaller.
- **rate limit raised to 20000/30s** — the default 10000 drops the rest with one
  "Suppressed N messages" line, and five Fastify services plus two Python ones
  sharing an incident will pass it at exactly the moment the lines matter.

The install verifies rather than assuming: it asks `systemd-analyze cat-config
systemd/journald.conf` what is actually in force and fails the deploy if a
later-sorting drop-in has overridden any of it. A drop-in being overridden looks
identical on disk to one that is working.

```bash
journalctl --disk-usage
systemd-analyze cat-config systemd/journald.conf | grep -E '^(Storage|SystemMaxUse|MaxRetentionSec)='
```

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
6. **Integration credentials at rest.** The same key (or `MFA_ENCRYPTION_KEY`,
   or a dedicated `CONNECTION_ENCRYPTION_KEY` — the first one set wins) also
   seals the OAuth access and refresh tokens for a client's accounting
   software, HRIS and cap-table provider, and the HMAC secrets partners verify
   our webhook signatures with. Both keys are already set on this box, so this
   needs no new variable; `GET /api/v1/monitoring/capabilities` reports it as
   `connection_secret_encryption` either way. Values written before the key was
   set stay readable and re-seal on the next reconnect.

## Cloudflare sits in front of the origin

`dig +short n409.aiknol.com` returns Cloudflare addresses, not 204.168.241.124:
the DNS record is **proxied**. So the request chain is
`client → Cloudflare edge → Caddy → web`, and the app has to be told that the
edge is a hop, or it attributes every request on the internet to a Cloudflare
datacenter. It did, until R88 — measured, not inferred: a request from
49.43.232.92 was logged by `n409-web` as `remoteAddress: 104.23.175.42`. Every
throttle keyed on `req.ip` was keyed on a shared POP, `login-ip:`,
`register-ip:` and `reset-ip:` among them.

The host therefore sets:

```
TRUSTED_PROXIES=loopback, uniquelocal, cloudflare
```

`cloudflare` expands to Cloudflare's published ranges — see
`src/packages/shared/src/clientIp.ts` for the list, when it was fetched, and how
to refresh it.

### Open item: the origin still accepts 80/443 from anywhere

Trusting Cloudflare's ranges is only completely safe once the origin accepts
those ports *from those ranges alone*. Without that, code running inside
Cloudflare — a Worker — can reach 204.168.241.124 directly, be treated as a
trusted hop, and name any client it likes, which puts the per-IP limits back
within reach of someone willing to do that work.

It is not done, and not shipped as an unapplied script either, for one reason:
**this host's Caddy serves two unrelated products from the same ports**
(`ustradingbot.aiknol.com`, `talentping.aiknol.com`). Restricting 80/443 to
Cloudflare would take those down unless they are proxied too, and that is not
this repo's decision to make.

**They are not.** This used to say "confirm the other two sites are proxied" and
leave the confirming to a human; R89 ran it and the answer was no:

```
$ node infra/check-edge-exposure.mjs --origin 204.168.241.124 --probe
  proxied  n409.aiknol.com (104.21.13.34 172.67.197.163)
  proxied  talentping.aiknol.com (172.67.197.163 104.21.13.34)
  DIRECT   ustradingbot.aiknol.com → 204.168.241.124
  NOT safe to restrict 80/443 to Cloudflare.
```

`ustradingbot.aiknol.com` is grey-clouded — its A record *is* the origin. So the
recipe below would take a live product off the internet, and the script is now
the gate rather than the prose. Re-run it before applying anything here; it
exits 0 only when every site on the box survives the change.

**And read this before you do, even then.** A grey-clouded site loses its
certificate as well as its traffic, on a delay. Caddy renews from Let's Encrypt,
and HTTP-01 validation is dialled at the origin address in DNS — which for a
proxied site is Cloudflare (so the challenge arrives from a permitted range and
renewal keeps working), and for a grey-clouded one is the box itself (so the
same rule that took the site down also blocks its renewal). The first failure is
immediate and obvious; the second lands sixty days later, looking like an
unrelated certificate expiry.

The shape of the change, when the script says it is safe:

```sh
# For each range in CLOUDFLARE_RANGES (src/packages/shared/src/clientIp.ts):
ufw allow from <range> to any port 80,443 proto tcp comment 'Cloudflare edge'
# then, and only once check-edge-exposure.mjs exits 0:
ufw delete allow 80/tcp && ufw delete allow 443/tcp
```

What the change does and does not buy, measured on the live origin in R89:

- It does **not** close a header-forging hole for ordinary clients. That is
  already closed: a request sent straight to `204.168.241.124` carrying
  `X-Forwarded-For: 1.2.3.4` is logged by `n409-web` with the real client
  address, because Caddy overwrites the header for any peer outside the ranges.
- It **does** close two things. Code running inside Cloudflare is a trusted hop
  today and could name any client it likes; and every edge protection — WAF, bot
  management, edge rate limiting — is skippable by anyone who dials the origin.
  The origin's address is not a secret: the grey-clouded sibling publishes it.

Note that this is a narrowing of an already-narrow exposure, not the removal of
an open door: before R88 the per-IP limits were a single shared bucket that took
no effort at all to defeat. Ranked against that, the residual risk is smaller
than what it replaced.

## Required environment (`/opt/N409/.env`, chmod 600)

Beyond the pre-existing vars (DATABASE_URL, JWT_SECRET, JWT_ISSUER,
JWT_TTL_SECONDS, LOG_LEVEL, OPENROUTER_API_KEY, DOCUMENTS_DIR, …), the hardening
work adds:

```
NODE_ENV=production
INTERNAL_SERVICE_TOKEN=<openssl rand -hex 32>   # valuation ⇄ ai/engine/report; REQUIRED
DOCUMENTS_ENCRYPTION_KEY=<openssl rand -hex 32> # document blobs at rest
MFA_ENCRYPTION_KEY=<openssl rand -hex 32>       # TOTP seeds; falls back to the above
# CONNECTION_ENCRYPTION_KEY=...                 # optional: separates integration
#                                               # credentials from the two above
PUBLIC_BASE_URL=https://n409.aiknol.com         # emailed links (reset, board sign)
BUILD_SHA_FILE=/opt/N409/BUILD_SHA              # provenance, written by the deploy
# On the ai and engine-wrapper units (set in the unit files, not .env):
#   APP_ENV=production
```

`INTERNAL_SERVICE_TOKEN` is the one entry above that is not optional: omit it
and `report`, `ai` and `engine-wrapper` all fail to start (security posture
item 3). Everything else degrades rather than refusing.

### Rotating an at-rest key

AES-GCM authenticates, so a value written under an old key does not decode to
garbage under a new one — it throws. Changing `DOCUMENTS_ENCRYPTION_KEY` on its
own is therefore not a rotation, it is data loss with a delayed fuse: every
document uploaded before the change becomes unreadable, and nothing says so
until somebody clicks download.

Each key accepts a retired companion, `<NAME>_PREVIOUS`, on read only.

1. `openssl rand -hex 32`
2. In `/opt/N409/.env`, move the current value to `<NAME>_PREVIOUS` and put the
   new one in `<NAME>`. Restart the units. Reads try new-then-old, so nothing
   is down at any point; this step is safe to leave in place indefinitely.
3. `node tools/rotate-at-rest-keys.mjs --apply` from `/opt/N409` (after
   `npm run build`). It re-seals every value still under the old key —
   documents on disk and the four sealed columns — and is safe to re-run and to
   interrupt. Run it without `--apply` first for a count.
4. Re-run without `--apply`. When it reports nothing left to write, delete
   `<NAME>_PREVIOUS` and restart.

Step 4 is the point of the exercise: until that line is gone, the key you
rotated away from is still one this process accepts. A rotation stopped after
step 3 looks finished and is not.

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

## Rolling back

Until round 158 this document did not use the word. There was also no mechanism:
`deploy.sh` shipped `HEAD` and nothing else, and the host's only record of what
was running — `BUILD_SHA` — is overwritten by the very deploy you would want to
undo, so by the time anyone needed the previous commit its name had already been
destroyed.

```bash
# Undo the last deploy: redeploys the previous verified release.
HOST=root@204.168.241.124 infra/deploy.sh --apply --rollback

# Or name a commit yourself.
HOST=root@204.168.241.124 infra/deploy.sh --apply --to=<sha>
```

**A rollback is an ordinary deploy of an earlier commit.** Same archive, same
preflight, same restart order, same verification — there is no separate restore
path, deliberately: a code path only ever exercised when production is already
broken is one nobody has confidence in. This way the rollback path is the path
that runs every day.

### What it does not do: the schema

`--rollback` does **not** revert migrations, and nothing here will. The runner
(`src/services/valuation/src/db/migrate.ts`) is forward-only: there are no
down-steps to run. So the older code runs against the newer schema.

That is safe, but only because every migration is additive — the newer schema is
a superset of what the older code expects. `src/db/migrationSafety.ts` is what
keeps that true, refusing `DROP TABLE`, `DROP COLUMN`, type changes, renames, and
`NOT NULL` without a `DEFAULT`; `test/unit/migrationSafety.test.ts` runs it over
all 132 files on every CI run. The same property is what makes the rolling
restart safe, since valuation migrates while the other four units are still
serving the previous release.

If you ever genuinely need a destructive change, it is two releases: stop using
the column, ship that, then remove it — never one migration.

### How long a migration may lock (round 192)

Additive-only answers *whether a rollback is safe*. It says nothing about the
other way a migration hurts production, which is **how long it holds a lock**,
and that half had no bound worth the name until R192.

The runner borrows its client from the application pool, so it inherited a pool
tuned for request handlers. Both settings were wrong for DDL, in opposite
directions:

| | pool (request handlers) | migration needs | why |
| --- | --- | --- | --- |
| `statement_timeout` | 15s | **longer** | an index build over a real table takes longer than any request may |
| `lock_timeout` | `0` (Postgres default) | **shorter, and non-zero** | a blocked `ALTER TABLE` blocks everything queued behind it |

Each was a live fault, and neither could be seen from CI:

- **The 15s ceiling cancelled long DDL.** There are 164 `CREATE INDEX`
  statements in `migrations/` and none can be `CONCURRENTLY` — the runner wraps
  each file in a transaction and Postgres forbids it there (0148 says so in
  prose). So each builds under a lock in one statement. Over an empty CI
  database that is milliseconds; over a production table it crosses 15s,
  Postgres cancels it (`57014`), and `migrate()` throws *before* `app.listen`.
  valuation then never binds its port, never answers `/health`, and `deploy.sh`
  reads it as a hung deploy. Restarting does not help: the next attempt is
  equally slow. The failure is a function of how much data an environment has,
  which is the one axis CI cannot vary.
- **The unbounded `lock_timeout` took the table down while it waited.**
  Postgres's lock queue is ordered, so a statement waiting for ACCESS EXCLUSIVE
  sits ahead of every request that arrives after it — including plain `SELECT`s
  that conflict with nothing. Measured against a real database (one reader
  holding an open transaction, an `ALTER TABLE ADD COLUMN` behind it): an
  unrelated `SELECT count(*)` issued afterwards was **still blocked six seconds
  later**, and would have stayed blocked for the full 15s before the migration
  died and failed the deploy regardless.

Each migration's transaction now sets its own bounds — `MIGRATION_DDL_LOCK_TIMEOUT_MS`
(default 3000) and `MIGRATION_STATEMENT_TIMEOUT_MS` (default 300000), both in
`.env.example`. They are `SET LOCAL`, so they revert at `COMMIT` and at
`ROLLBACK` and cannot ride the pooled connection back to a request handler.

**Failing fast here is the design, not a regression.** The unit is
`Restart=always` with `RestartSec=3`, so a migration that loses a lock race is
retried within seconds and succeeds once the holder clears — which is what
"wait forever" only appeared to provide.

Retrying faster does not thrash the unit. Neither valuation's unit nor any
other sets `StartLimitBurst`, so systemd's default applies: 5 starts per 10s
before the unit is failed and left down. A lock-timeout cycle costs the 3s wait
plus `RestartSec=3` plus boot, so roughly two starts per window — the same
budget the previous 15s cancellation used more slowly, and comfortably inside
the limit. Worth re-checking if `MIGRATION_DDL_LOCK_TIMEOUT_MS` is ever lowered
much below a second. The two cancellations are reported
differently on purpose, because their conclusions are opposites:

- `55P03` (**lock** timeout) — nothing was applied, the file is fine, it will
  retry itself. Find the holder with
  `SELECT * FROM pg_stat_activity WHERE state <> 'idle' ORDER BY xact_start`.
  Do **not** raise `MIGRATION_DDL_LOCK_TIMEOUT_MS`: that lengthens the queue
  behind the migration rather than shortening the wait.
- `57014` (**statement** timeout) — the statement ran and is genuinely that
  slow, so a retry does the same thing again. Apply it by hand under a raised
  `MIGRATION_STATEMENT_TIMEOUT_MS` in a maintenance window, or split it.

**Known limitation, deliberately not fixed.** 53 of the index builds are on
tables that already exist, so each takes a `SHARE` lock (blocking writes,
leaving reads alone) for the length of the build. Removing that needs
`CREATE INDEX CONCURRENTLY`, which needs the runner to *not* wrap the file in a
transaction — and a non-transactional migration that fails partway is neither
applied nor recorded, and `CONCURRENTLY` can leave an `INVALID` index behind to
be cleaned up by hand. That trade has not been taken. The bounds above make the
current behaviour survivable; they do not make these builds concurrent.

### Where the target comes from

`$REMOTE_DIR/RELEASES`, appended by section 8 of `deploy.sh` **after** a deploy
verifies. Two files, two different questions:

| File | Answers | Written |
| --- | --- | --- |
| `BUILD_SHA` | what is running *now* | every deploy, overwritten |
| `RELEASES` | what has run, in order | append-only, only after verification |

A SHA written before verification would name a commit that never successfully
served, and `--rollback` would then roll *forward* into it. So a deploy with
`SKIP_VERIFY=1` updates `BUILD_SHA` and deliberately leaves `RELEASES` alone.

The target is the entry immediately **before** the running commit's last
appearance, not simply the newest entry that is not running. That is also why a
rollback is not itself recorded: with a log of `A,B,C` and `C` running, one
rollback lands on `B`; the log still reads `A,B,C`, so a second rollback finds
`B`'s position and lands on `A`. Under "newest entry that isn't running" the
second rollback would return to `C` — forward, into the release just undone.

Both files are gitignored and `export-ignore`d, so `git archive` cannot ship one
over the host's, and the deletion sweep skips both by name.

### Limits worth knowing before you need them

- **The commit must exist in your local clone.** The archive ships from there,
  not from the host. `git fetch` first.
- **`RELEASES` only starts from the first deploy that wrote it.** On a host
  deployed before round 158 the first `--rollback` has nothing to resolve and
  says so; use `--to=<sha>`.
- **Roll back, then deploy forward, then roll back again** resolves to the
  commit before the one you just shipped — which may be the release you
  originally rolled away from. Use `--to=<sha>` when the history is not linear.
- **A dry run cannot plan a `--rollback`**, because it resolves its target from
  the host and a dry run does not contact the host. Use `--to=<sha>` to see a
  full plan, or `--apply`.

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
to the journal, which `infra/journald/10-n409.conf` bounds — see above), so they
need no `ReadWritePaths`. Code under `/opt/N409` stays
world-readable, so services still start even if a deploy resets file ownership;
only `/opt/n409-data` and `/opt/n409-backups` must remain `n409`-owned.

## Backups / DR (audit P0-1)

Automated nightly PostgreSQL backups are live — see **`infra/backup/`**
(`README.md` has the full runbook):

- **`pg-backup.sh`** — `pg_dump -Fc` into `/opt/n409-backups/daily`, promotes a
  weekly copy on Sundays, prunes to **7 daily + 4 weekly**.
- **`n409-backup.timer`** fires **`n409-backup.service`** nightly at **02:00**
  (`Persistent=true`, runs as `n409`). Installed and enabled by `deploy.sh`
  along with every other unit — see the unit-files bullet at the top. A change
  to the timer's `OnCalendar=` takes effect on the next deploy, because
  `install-units.sh` restarts a timer whose file moved; the two `.service`
  bodies are deliberately never restarted, since "restarting" them would take a
  backup and start a restore rehearsal rather than apply anything.
- **Restore:** `infra/backup/pg-restore.sh <dump> [target-url]`
  (`pg_restore --clean --if-exists --single-transaction`). Rehearse monthly into
  a scratch DB per the README; the initial rehearsal passed (77 tables restored,
  matching live).
- **Off-host copies:** `/opt/n409-backups` lives on the same VPS — for true DR,
  also sync it (and `/opt/n409-data/documents`, now optionally encrypted) off-box.
