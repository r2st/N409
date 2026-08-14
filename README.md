# N409 — 409.ai Platform Rebuild

Reverse-documentation and production rebuild of the **409.ai** AI-assisted valuation platform
(IRC §409A, ASC 718/820, gifts, QSBS, EMI/CSOP, and more).

## What 409.ai is (one paragraph)

A valuation firm's platform that turns uploaded company financials (cap tables, income
statements, balance sheets, projections, decks) into defensible business valuations. AI
extracts and normalizes the data, selects public comparables, and drafts narrative; a quant
engine (Black-Scholes OPM, income/market/asset approaches, Chaffee/Finnerty DLOM,
roll-forwards) computes the concluded fair market value; and an ops team reviews, overrides,
signs, and publishes the report through a workflow-driven back-office. Partners (accounting &
cap-table platforms) submit valuations via API.

## Status

- **Phase 0 (Discovery):** ✅ complete — read-only crawl of the live admin app
  (`onboard.app.409.ai`, v0.10.1).
- **Phase 1 (Documentation):** ✅ complete — the design docs in [`/docs`](./docs).
- **Phase 2 (Implementation):** the platform is built and deployed. All five services run, the
  409A deliverable renders end to end, and the partner API is live with an OpenAPI spec.

Two caveats on reading the docs as a status report:

- [`docs/implementation-plan.md`](./docs/implementation-plan.md) is **stale as a checklist**. Its
  boxes are ticked only through M0, while the M1–M4 features it lists — the workflow state
  machine, the 68-field overwrites, document ingestion with virus scanning, partner webhooks,
  sensitivity grids — are all in the tree. Treat it as the original scope, not as progress.
- [`REVISION`](./REVISION) is the running log and the honest one. `closed:` entries are shipped;
  the `gap:` lines are the live list of known-unfixed issues, and there are currently two (the
  OpenRouter free-tier request ceiling, and nothing entering `paid` except a Stripe settlement).

## Quick start (dev)

```bash
npm install
npm run dev:db          # Postgres + Redis via docker compose
npm run migrate         # apply SQL migrations (also runs on service boot)
npm test                # build + all TypeScript workspace tests
npm run dev -w @n409/valuation   # valuation API on :3001 (needs JWT_SECRET, see .env.example)
```

`.env.example` is the **deployment contract**, not a sample: every variable the services read has
a line in it, and `envExample.test.ts` fails the build in either direction — a variable read but
undocumented, or documented after the code that read it went away.

### Services

Local `docker-compose.yml` is for dev only; production runs these as five systemd units on one
host. See [`infra/DEPLOYMENT.md`](./infra/DEPLOYMENT.md), which is the source of truth — the
committed Terraform describes an AWS design that is **not** what runs.

| Workspace | Port | Runtime | Role |
|-----------|------|---------|------|
| `src/services/web` | 3000 | Node/Fastify | The only internet-facing service; serves the SPA and proxies |
| `src/services/valuation` | 3001 | Node/Fastify | Domain core: engagements, workflow, RBAC, partner API, billing |
| `src/services/ai` | 3002 | Python/FastAPI | Extraction, narrative, research; PII redaction before any external LLM |
| `src/services/engine-wrapper` | 3003 | Python/FastAPI | The numeric engine (OPM, DLOM, ASC 718/820, gifts, IFRS 2) |
| `src/services/report` | 3004 | Node | PDF rendering of the deliverable |
| `src/services/web-frontend` | — | React/Vite | The SPA, built and served by `web` |
| `src/packages/shared` | — | Node | Logger/OTel/problem+json/health/ULIDs |

Ports 3001–3004 are loopback-only in production. Also: `infra/` (systemd, Caddy, firewall,
backups, Terraform), `e2e/` (Playwright), `tools/` (dev scripts), CI in `.github/workflows/ci.yml`.

## Tests

```bash
npm test                # TypeScript workspaces only — see the caveat below
npm run e2e             # Playwright against a reset database
npm run sample:report   # render the sample 409A PDF
```

**`npm test` does not run the Python services.** `ai` and `engine-wrapper` are not npm
workspaces; each has its own virtualenv and is run directly. CI runs them separately, so a
green `npm test` is two-thirds of the suite:

```bash
cd src/services/ai            && .venv/bin/python -m pytest
cd src/services/engine-wrapper && .venv/bin/python -m pytest
```

| Suite | Files | Tests | Coverage floor (lines/stmts/functions/branches) |
|-------|------:|------:|--------------------------------------------------|
| `shared` | 24 | 373 | 99 / 99 / 100 / 96 |
| `valuation` | 329 | 5152 | 87 / 87 / 89 / 90 |
| `web` | 4 | 44 | 81 / 81 / 81 / 85 |
| `report` | 11 | 232 | 96 / 96 / 96 / 89 |
| `web-frontend` | 212 | 2506 | 97 / 97 / 86 / 89 |
| `ai` (pytest) | — | 729 | 80 (`--cov-fail-under`) |
| `engine-wrapper` (pytest) | — | 2545 | 80 (`--cov-fail-under`) |

Floors are enforced in each workspace's vitest config and fail CI on a regression; they are set
a point or two under the measured level and ratcheted upward, never down. The engine also has
mutation testing over the pure numeric functions (`mutmut`, config in
`src/services/engine-wrapper/setup.cfg`) — a surviving mutant there is an FMV no test would catch.

Each integration test file runs against its own throwaway `n409_test_*` database and drops it in
`afterAll` — which does not run if the worker is killed, leaving a migrated ~12 MB database
behind. The valuation suite sweeps those at the start of every run (idle and over an hour old).
To collect them by hand:

```bash
npm run db:drop-test                        # idle and older than 60 minutes
npm run db:drop-test -- --dry-run           # list them, drop nothing
npm run db:drop-test -- --all               # every idle one, whatever its age
```

Neither the sweep nor the script touches a database something is connected to, so both are safe
to run while another suite is in flight.

## API surfaces

Three, per [`docs/api-design.md`](./docs/api-design.md):

- **Client/admin** — `/api/v1/*`, session or bearer JWT. Consumed by this repo's own SPA. Every
  route is either behind `app.authenticate` or listed with a reason in
  `src/services/valuation/src/plugins/routeAudit.ts`; a route that is neither **fails the service
  at boot** rather than serving an engagement to anyone who knows the id.
- **Partner** — `/api/partner/v1/*`, API-key authed, with a self-describing `/docs` and an
  **OpenAPI 3.1 spec at `/api/partner/v1/openapi.json`**. The spec is generated from the same
  registry the routes register through (one `define()` call does both), so it cannot drift.
- **Internal** — service-to-service, shared-secret authed.

Errors everywhere are RFC 9457 `application/problem+json`. Branch on `type`, never on `title` or
`detail`: the vocabulary is listed in [`docs/api-design.md` §1.1](./docs/api-design.md#11-problem-types)
and a test fails if the code and that table disagree in either direction.

The internal `/api/v1` surface has no OpenAPI document — it validates with Zod inside each
handler rather than with Fastify route schemas, so there is no machine-readable source to
generate one from. It is a first-party contract consumed only by this repo's SPA; the partner
API is the published one.

## Documentation

| Doc | Contents |
|-----|----------|
| [features.md](./docs/features.md) | As-built product: domain model, lifecycle, AI layer, engine, all features |
| [requirements.md](./docs/requirements.md) | Functional (FR) + non-functional (NFR) requirements, actors/roles |
| [feature-gap-analysis.md](./docs/feature-gap-analysis.md) | Gaps vs. best practice/competitors, prioritized |
| [improvements.md](./docs/improvements.md) | UX & feature recommendations with what/why/how |
| [architecture.md](./docs/architecture.md) | Target C4 architecture, services, flows |
| [system-design.md](./docs/system-design.md) | Component/infra design, workflow, observability, migration |
| [database-design.md](./docs/database-design.md) | PostgreSQL schema (ER + tables) |
| [api-design.md](./docs/api-design.md) | Client/Partner/Internal REST APIs, problem types, engine & AI contracts |
| [engine-numeric-invariants.md](./docs/engine-numeric-invariants.md) | Rules the compute engine holds to, and why NaN defeats ordinary validation |
| [implementation-plan.md](./docs/implementation-plan.md) | Original milestones M0–M7 + issues #1–#34 (checkboxes stale — see Status) |
| [infra/DEPLOYMENT.md](./infra/DEPLOYMENT.md) | What actually runs in production, and how to deploy it |

## Layout

```
docs/    # the design documents (+ this index)
src/     # application code — packages/shared + services/*, tests in each workspace's test/
e2e/     # Playwright end-to-end suite
infra/   # systemd units, Caddy, firewall, backups, Terraform (reference only)
tools/   # dev scripts (sample report, seeding, test-db cleanup)
keys/    # project brief + credentials — gitignored, never committed
```

## Discovery method & scope

Documented from an authorized, **read-only** admin crawl. No data was modified. **No customer
PII is reproduced** in these docs — entities are described by schema, not by their data.
