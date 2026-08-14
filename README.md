# N409 — 409.ai Platform Rebuild

Reverse-documentation and production rebuild of the **409.ai** AI-assisted valuation platform
(IRC §409A, ASC 718/820, gifts, QSBS, EMI/CSOP, and more).

## Status
- **Phase 0 (Discovery):** ✅ complete — read-only crawl of the live admin app (`onboard.app.409.ai`, v0.10.1).
- **Phase 1 (Documentation):** ✅ complete — all 9 design docs in [`/docs`](./docs).
- **Phase 2 (Implementation):** 🚧 in progress — **M0 (foundations) complete**; see [`docs/implementation-plan.md`](./docs/implementation-plan.md).

### Quick start (dev)
```bash
npm install
npm run dev:db          # Postgres + Redis via docker compose
npm run migrate         # apply SQL migrations (also runs on service boot)
npm test                # build + all workspace tests (integration tests need the DB)
npm run dev -w @n409/valuation   # valuation API on :3001 (needs JWT_SECRET, see .env.example)
```

Each integration test file runs against its own throwaway `n409_test_*` database and drops it
in `afterAll` — which does not run if the worker is killed or the run is interrupted, leaving a
migrated ~12 MB database behind. The valuation suite sweeps those at the start of every run
(anything idle and over an hour old), so they no longer accumulate. To collect them by hand:
```bash
npm run db:drop-test                        # idle and older than 60 minutes
npm run db:drop-test -- --dry-run           # list them, drop nothing
npm run db:drop-test -- --all               # every idle one, whatever its age
```
Neither the sweep nor the script will touch a database something is connected to, so both are
safe to run while another suite is in flight.
Monorepo layout: `src/packages/shared` (logger/OTel/problem+json/health/ULIDs),
`src/services/{valuation,web,ai,engine-wrapper,report}`, `infra/terraform`, CI in
`.github/workflows/ci.yml`.

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
| [api-design.md](./docs/api-design.md) | Client/Partner/Internal REST APIs + engine & AI contracts |
| [engine-numeric-invariants.md](./docs/engine-numeric-invariants.md) | Rules the compute engine holds to, and why NaN defeats ordinary validation |
| [implementation-plan.md](./docs/implementation-plan.md) | Milestones M0–M7 + GitHub issues #1–#34 |

## What 409.ai is (one paragraph)
A valuation firm's platform that turns uploaded company financials (cap tables, income
statements, balance sheets, projections, decks) into defensible business valuations. AI
(Claude Opus 4.8, Bedrock, Perplexity) extracts and normalizes the data, selects public
comparables, and drafts narrative; an **R-based quant engine** (Black-Scholes OPM, income/
market/asset approaches, Chaffee/Finnerty DLOM, roll-forwards) computes the concluded fair
market value; and a large ops team reviews, overrides, signs, and publishes the report through
a workflow-driven back-office. Partners (accounting & cap-table platforms) submit valuations via API.

## Layout
```
docs/    # the design documents (+ this index)
src/     # application code (Phase 2)
tests/   # tests (Phase 2)
keys/    # project brief + credentials — gitignored, never committed
```

## Discovery method & scope
Documented from an authorized, **read-only** admin crawl. No data was modified. **No customer
PII is reproduced** in these docs — entities are described by schema, not by their data.

## Notes for maintainers
- The GitHub, and other MCP connectors were unauthenticated during discovery; the implementation
  plan drafts issues in Markdown to be filed once GitHub is authorized.
- Stack inferences (Rails admin, R/Plumber engine, Stripe payments, PostgreSQL) are marked as such
  in the docs and should be confirmed against the real codebase before Phase 2.
