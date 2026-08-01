# N409 — PROJECT_INFO

**Reverse-documentation and production rebuild of the 409.ai AI-assisted valuation platform (IRC §409A, ASC 718/820, gifts, QSBS, EMI/CSOP).**

- **Repo:** https://github.com/r2st/N409 · branch `main`
- **Local path:** `Products/N409`
- **Status:** Phase 0 (discovery) ✅ · Phase 1 (documentation) ✅ · Phase 2 (implementation) 🚧 — M0 foundations complete

## Tech stack

| Layer | Technology |
|---|---|
| Language | TypeScript, Node.js — npm-workspaces monorepo |
| Services | `src/services/{valuation,web,ai,engine-wrapper,report}` |
| Shared | `src/packages/shared` — logger, OpenTelemetry, problem+json, health, ULIDs |
| Database | PostgreSQL (raw SQL migrations, applied on service boot) |
| Cache/queue | Redis |
| Infra | Terraform (`infra/terraform`), Caddy, systemd |
| CI | GitHub Actions — `.github/workflows/ci.yml` |

## Deploy location

| | |
|---|---|
| Host | Hetzner `204.168.241.124` — **a different box** from the `89.167.8.178` estate |
| Code | `/opt/N409` — rsync-based deploy |
| Public URL | https://n409.aiknol.com |
| Reverse proxy | Caddy — `infra/caddy/n409.aiknol.com.caddy` (auto-TLS, gzip/zstd, `X-Real-IP`) |
| Ports | `3000` web · `3001` valuation API |
| Process model | systemd units — see `infra/systemd` |

Infra layout: `infra/{terraform,caddy,systemd,firewall,backup}` and `infra/DEPLOYMENT.md`.

## SSH key

`keys/hetzner_ustradingbot` (+ `.pub`) — shared with USTradingBot, which is on the same box.
Root password also stored at `keys/hetzner_root_password`; host IP at `keys/hetzner_vps_ip`.

```bash
ssh -i keys/hetzner_ustradingbot root@204.168.241.124
```

## Environment variables

| Where | What |
|---|---|
| `.env.example` | Documented var list (incl. `JWT_SECRET`, required by the valuation API) |
| `.env` (gitignored) | Local dev |
| `keys/` (gitignored) | `openrouter-key`, `polygon_api_key`, `409.ai-login`, `sendgrid.txt`, `Cloudfare_token.txt`, `Git_token.txt` |
| Server | `/opt/N409/.env` |

⚠️ **Known production gap** (`docs/n409-final-status-report.md`): `/opt/N409/.env` defines
little more than `DATABASE_URL`. Several code-complete features — Stripe billing among them —
are unconfigured in production and need env vars plus a webhook registration.

## Key commands

```bash
npm install
npm run dev:db                      # Postgres + Redis via docker compose
npm run migrate                     # apply SQL migrations
npm run dev -w @n409/valuation      # valuation API on :3001 (needs JWT_SECRET)
npm run build                       # tsc -b + web-frontend build
npm test                            # build + all workspace tests (integration needs the DB)
npm run test:unit
npm run lint && npm run typecheck
```

## Related projects

- [`../USTradingBot`](../USTradingBot) — **same Hetzner box, same SSH key** (`hetzner_ustradingbot`); rotate as one unit
- The rest of the `*.aiknol.com` estate lives on `89.167.8.178`; N409 is the exception
- `~/projects/PROJECT-INDEX.md`, `~/projects/keys/KEYS_INDEX.md` — estate-wide index
