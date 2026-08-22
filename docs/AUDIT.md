# N409 Platform — Engineering Audit

**Date:** 2026-07-20
**Scope:** Full-stack audit of the 5-service 409A valuation platform — `valuation`
(TS/Fastify), `engine-wrapper` (Python/FastAPI), `ai` (Python/FastAPI), `report`
(TS/Fastify), `web-frontend` (React/Vite) — plus the shared package, tests, CI, and infra.
**Method:** Read-only source review (~40k LOC). No code was modified. This report only
recommends; it implements nothing.

---

> **This is a snapshot from 2026-07-20, not a backlog.** A month of hardening rounds has
> closed a large share of what follows, and nothing here was rewritten as items shipped —
> so a finding below is a description of the code *as it was on that date* and has to be
> checked against the code before it is acted on. R94 walked into four of them looking for
> open work and found all four already fixed: every Fastify service sets a strict CSP and
> the rest of the header set (B-1 P1) — `valuation` and `report` through `@fastify/helmet`,
> `web` through `shared/securityHeaders.ts` — the document download carries `nosniff`, login
> timing is equalised through `verifyPasswordOrDecoy`, and uploads are magic-byte checked in
> `documents/fileType.ts`. That is a 4-for-4 hit rate on
> already-closed findings, which is the reason for this paragraph rather than a mark against
> any one entry.
>
> `REVISION` is the record of what actually shipped. Where the two disagree, `REVISION` is
> the one written afterwards.

## Executive summary

The platform is **well-engineered**. The TypeScript backend is disciplined: every SQL
query is parameterized, sort columns are whitelisted, IDOR is blocked by consistent
`canReadValuation` → 404 checks, JWTs carry a `session_epoch` for instant revocation,
passwords use scrypt with `timingSafeEqual`, the Stripe webhook is verified in constant
time, errors render as RFC-9457 problem+json with no 5xx leakage, and logs are pino with
PII redaction. Test coverage is genuinely broad (33 integration + 24 unit suites on the
valuation service, ~55 frontend suites). CI runs lint, format, build, node+python tests,
docker builds, and terraform validate.

The findings below are therefore **hardening and polish**, not structural repair. The
themes that matter most:

- **P0 — the two Python services have no authentication at all** and bind `0.0.0.0`. If
  ports 3002/3003 are reachable, anyone can run LLM pipelines (cost/abuse) and the compute
  engine (DoS) unauthenticated. This is the single most important item.
- **P1 — auth-surface hardening**: login has no rate limiting (brute-force), the known
  example `JWT_SECRET` can silently reach production, and confidential client financials
  are sent to **free-tier** external LLMs with **regex-only** PII redaction that never
  removes names, company names, or addresses.
- **P1/P2 — frontend resilience**: no React error boundary (one render throw = white
  screen), JWT in `localStorage` (XSS-exfiltratable), and no CSP / security headers.
- **P2 — operational maturity**: the auto-pipeline is fire-and-forget in-process (orphaned
  on restart, unbounded concurrency), there's no metrics pipeline (traces only), no
  dependency/secret scanning in CI, and Python containers run as root.

### Findings by priority

| Priority | Backend | Frontend | Infra/CI/Test | Total |
|----------|:-------:|:--------:|:-------------:|:-----:|
| **P0 Critical** | 1 | 0 | 0 | **1** |
| **P1 High** | 5 | 2 | 2 | **9** |
| **P2 Medium** | 8 | 5 | 5 | **18** |
| **P3 Low** | 5 | 5 | 3 | **13** |

---

## Severity legend

- **P0 Critical** — exploitable now / data-loss / outage risk. Fix before next deploy.
- **P1 High** — serious security or reliability gap; schedule immediately.
- **P2 Medium** — real weakness or notable UX/maintainability debt; plan it in.
- **P3 Low** — polish, nice-to-have, or defense-in-depth.

---

# BACKEND

## B-1 · API security, auth, validation

### 🔴 P0 — Internal Python services (`ai`, `engine-wrapper`) have zero authentication
**Files:** `src/services/ai/app/main.py`, `src/services/engine-wrapper/app/main.py`;
Dockerfiles bind `--host 0.0.0.0` (`src/services/ai/Dockerfile:7`,
`src/services/engine-wrapper/Dockerfile:9`).
Neither FastAPI app declares any auth dependency. Every route
(`/ai/v1/pipelines/{pipeline}`, `/ai/v1/test`, `/engine/v1/compute`, `/engine/v1/market-feed`,
…) is open. Security rests entirely on network isolation, yet the containers listen on
`0.0.0.0` and `docker-compose.yml` publishes ports `3002`/`3003` to the host.
**Risk:** If the host firewall doesn't block those ports (the deployment is 5 systemd units
on a public Hetzner box, ports 3000–3004), an attacker can run unlimited LLM calls against
your OpenRouter key (financial abuse), trigger arbitrary `yfinance` fetches, and hammer the
CPU-bound engine (`/engine/v1/compute`) for DoS.
**Fix:** (1) Require a shared secret header (e.g. `X-Internal-Token`) on all non-health
routes, injected by the valuation service's `internal.ts` client. (2) Bind uvicorn to
`127.0.0.1` and/or firewall 3001–3004 to loopback. (3) Add the token to the internal client
in `src/services/valuation/src/clients/internal.ts`.

### 🟠 P1 — Login endpoint has no rate limiting (credential brute-force / stuffing)
**File:** `src/services/valuation/src/routes/auth.ts:184` (`POST /api/v1/auth/login`).
The sliding-window limiter (`auth.ts:70`) is applied to `forgot-password` and
`resend-verification`, but **not** to `login`. `plugins/rateLimit.ts` exists but is wired
only to the partner API. Unlimited password guesses per account/IP are possible.
**Fix:** Apply the existing per-email + per-IP `slidingWindowLimiter` to `login` (e.g. 10
attempts / 15 min per email, 100 / 15 min per IP), and consider an exponential backoff or
lockout after N failures.

### 🟠 P1 — Known example `JWT_SECRET` can silently reach production
**Files:** `.env.example:7`, `docker-compose.yml:36` — both ship
`JWT_SECRET=dev-only-secret-change-me-0123456789abcdef` (40 chars, so it passes the
`min(32)` check in `config.ts:8`). There is no guard rejecting the well-known default.
**Risk:** A deploy that copies `.env.example` (or reuses the compose value) runs with a
**publicly known signing key** → anyone can forge admin JWTs → full auth bypass.
**Fix:** In `config.ts`, reject a denylist of known example secrets when `NODE_ENV==='production'`
(and reject secrets with low entropy). Fail closed on boot.

### 🟠 P1 — Confidential financials sent to free-tier external LLMs with weak redaction
**Files:** `src/services/ai/app/anonymize.py`, `src/services/ai/app/openrouter.py:18-22`,
`src/services/ai/app/main.py:41` (`options.anonymize` can disable redaction).
Document text and cap-table data are POSTed to OpenRouter **`:free`** models. Free tiers
commonly log/retain (and may train on) inputs. The `redact()` step is **regex-only** — it
strips emails, SSNs, EINs, and phone numbers but **never** founder/employee **names**,
**company names**, or **addresses**, which is exactly the sensitive content of a cap table
and a valuation. Redaction is also skippable per-request via `options: {anonymize:false}`.
**Risk:** Client-confidential deal data leaves the trust boundary to a third party with weak
governance — a compliance/contractual exposure for a valuation firm.
**Fix:** (1) Move to paid/enterprise LLM endpoints with a no-retention/no-train contract, or
self-host. (2) Add named-entity redaction (or tokenized placeholders with a local mapping).
(3) Make `anonymize:false` impossible in production. (4) Document the data-flow in a DPA.

### 🟠 P1 — No security headers / CSP on the served app
**Files:** `src/services/valuation/src/app.ts` (no `@fastify/helmet`), `src/services/web`
BFF, `infra/caddy/n409.aiknol.com.caddy` (TLS only, no header hardening).
No `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`, `X-Content-Type-Options:
nosniff`, `Referrer-Policy`, or HSTS max-age tuning. Combined with the JWT living in
`localStorage` (see F-2), any reflected/stored XSS becomes full account takeover.
**Fix:** Add `@fastify/helmet` (or set headers in Caddy): a strict CSP, `nosniff`,
`frame-ancestors 'none'`, `Referrer-Policy: strict-origin-when-cross-origin`, HSTS.

### 🟠 P1 — Document downloads served without `nosniff`
**File:** `src/services/valuation/src/routes/documents.ts:162-165`. The download route sets
`content-type` from the stored value and `content-disposition: attachment` (good) but no
`X-Content-Type-Options: nosniff`. An uploaded `text/html` blob could still be sniffed/opened
inline in some paths.
**Fix:** Add `nosniff` to the download response, and consider serving user blobs from a
cookieless/separate origin.

### 🟡 P2 — Login is vulnerable to timing-based account enumeration
**File:** `src/services/valuation/src/routes/auth.ts:192-198`. Because of `||` short-circuit,
`verifyPassword` (expensive scrypt) only runs when the account exists. Response time reveals
whether an email is registered — despite the (good) identical error message.
**Fix:** Always run a scrypt verification against a dummy digest when the user is absent, to
equalize timing.

### 🟡 P2 — No upload content validation beyond size/extension (no magic-byte/AV check)
**File:** `src/services/valuation/src/routes/documents.ts:93-125`. Uploads are capped at 25 MB
and the `kind` enum is validated, but the file's actual type isn't verified against its
declared MIME, and there's no malware scan. Extractable files feed the AI pipeline directly.
**Fix:** Sniff magic bytes to confirm declared type; integrate an AV scan (e.g. ClamAV) or a
sandboxed extraction step for untrusted documents.

### 🟡 P2 — OAuth `state` for Google SSO is not bound to the browser session
**File:** `src/services/valuation/src/auth/jwt.ts:53-65`. `signOidcState` is a generic signed
token with no nonce tied to the initiating client, so it protects against tampering but not a
replayed/attacker-supplied state (login CSRF).
**Fix:** Bind a nonce to a cookie/PKCE verifier and check it in the callback.

### 🟢 P3 — Accounting OAuth callback trusts only the signed `state` (no PKCE)
**File:** `src/services/valuation/src/auth/jwt.ts:77-101`. Acceptable given 30-min expiry and
signature, but PKCE would harden the provider round-trip.

### 🟢 P3 — `req.log.error({ err })` on 5xx may include messages with sensitive substrings
**File:** `src/packages/shared/src/problem.ts:93`. Redaction covers structured PII paths but
not free-text error `message` fields. Low risk; worth a scrub on known-sensitive throwers.

## B-2 · Python engine & AI robustness

### 🟡 P2 — Sync route handlers + blocking HTTP can exhaust FastAPI's threadpool
**Files:** `ai/app/main.py:118` (`def run_pipeline`), `ai/app/openrouter.py:71` (sync
`httpx.Client`, 90 s timeout), `engine-wrapper/app/main.py:131` (`def engine_compute`).
FastAPI runs sync `def` handlers in a bounded threadpool (default ~40). LLM calls block up to
90 s each; CPU-bound engine work blocks a thread for its duration. Under concurrency the pool
saturates and unrelated requests (incl. `/health`) queue.
**Fix:** Make LLM/market-feed handlers `async` with `httpx.AsyncClient`; run CPU-bound engine
compute in a process pool; raise/limit the threadpool deliberately.

### 🟡 P2 — No request-body size limit on AI/engine payloads
**Files:** `ai/app/main.py:30-46` (`documents: list[dict]` of base64 blobs),
`engine-wrapper/app/main.py`. FastAPI has no default body cap, so a large `documents` array is
buffered fully in memory → OOM/DoS vector (compounds P0).
**Fix:** Enforce a max body size (reverse proxy `client_max_body_size` and/or app-level guard)
and a per-request document count/size limit.

### 🟡 P2 — No cost/token ceiling on LLM calls
**File:** `ai/app/openrouter.py`. No max-tokens cap, per-run budget, or daily quota. Free tier
limits exposure today, but the moment a paid key is set (see P1 above) a runaway/abusive loop
is uncapped.
**Fix:** Set `max_tokens`, add a per-valuation and global daily budget, log token usage.

### 🟢 P3 — LLM JSON output is parsed but not schema-validated
**File:** `ai/app/openrouter.py:107-127` (`extract_json`). Robust to fences/prose, but the
resulting object isn't validated against a per-pipeline schema before persistence — a
well-formed-but-wrong shape flows downstream.
**Fix:** Validate each pipeline's output with a Pydantic model; reject/repair on mismatch.

### 🟢 P3 — No structured logging / request tracing in the Python services
**Files:** both FastAPI apps. Uptime is exposed on `/health`, but there's no
structured logger, request-id propagation, or OTel (the TS side has OTel via
`@n409/shared`). The Python tier is a trace blind spot.
**Fix:** Add `structlog` + OTel FastAPI instrumentation; propagate `x-request-id` from the
valuation client.

## B-3 · Data layer, performance, resilience

### 🟡 P2 — Auto-pipeline is fire-and-forget in-process (orphaned runs, unbounded fan-out)
**File:** `src/services/valuation/src/pipeline/autoPipeline.ts:65-70` (started **without
await**). There's no durable job queue/worker. A process restart mid-run leaves the
`pipeline_runs` row stuck `running` with no recovery; N simultaneous uploads spawn N
concurrent in-process orchestrations, each doing blocking AI+engine calls.
**Fix:** Move to a durable queue (Redis/BullMQ is already in the compose stack, or pg-boss),
cap concurrency, and add a reaper that fails runs stuck beyond a timeout.

### 🟡 P2 — DB pool has no statement/connection timeouts
**File:** `src/services/valuation/src/db/pool.ts:5-7` — `new pg.Pool({ max: 10 })` only. No
`statement_timeout`, `idle_in_transaction_session_timeout`, `connectionTimeoutMillis`, or SSL.
A single slow query can pin a connection; a 10-connection ceiling with no timeout stalls the
whole service.
**Fix:** Set `statement_timeout` (e.g. 15 s), `connectionTimeoutMillis`, and require TLS in
production (`ssl` from `DATABASE_URL`).

### 🟡 P2 — No metrics pipeline (traces only)
**File:** `src/packages/shared/src/otel.ts` exports **traces** via OTLP but no metrics
(request rate/latency/error histograms, DB pool gauges, queue depth). Production RED/USE
dashboards and alerting aren't possible from what's emitted.
**Fix:** Add an OTel `MeterProvider` (or `prom-client`), export RED metrics + pool/queue
gauges, and wire alerts.

### 🟡 P2 — Synchronous PDF/ZIP export generation on the request path
**Files:** `src/services/valuation/src/export/pdf.ts`, `export/zip.ts`, `routes/exports.ts`.
Report/evidence bundles are generated inline in the request. For large valuations this ties up
an event-loop turn and risks request timeouts.
**Fix:** Generate large exports in a background job and hand back a download link, or stream.

### 🟢 P3 — Per-request DB read for maintenance mode on every mutating call
**File:** `src/services/valuation/src/plugins/auth.ts:80-85`. `settings.get('maintenance_mode')`
runs on each non-GET request. It's cached in `SystemSettingsStore`, but confirm the cache TTL —
otherwise this is an extra round-trip per write.
**Fix:** Ensure a short in-memory TTL cache; it appears intended but verify.

### 🟢 P3 — List endpoints — confirm every list route paginates
Valuations (`repos/valuations.ts`), admin users, notifications, and activity log all use
`LIMIT/OFFSET`. Spot-check smaller list repos (comments, tasks, documents, transactions) for
any unbounded `SELECT` as data grows, and prefer keyset pagination on the hot valuations list.

## B-4 · API documentation

### 🟡 P2 — No machine-readable OpenAPI spec for the TS API
**Files:** `docs/api-design.md` (prose only); the frontend `ApiDocsPage.tsx` renders hand-kept
docs. Fastify can emit OpenAPI via `@fastify/swagger`, but it isn't wired. The **partner API**
(external integrators) especially needs a generated, versioned contract.
**Fix:** Add `@fastify/swagger` + `swagger-ui`, drive it from the route JSON schemas, and serve
`/openapi.json`; back `ApiDocsPage` with it so docs can't drift.
> Note: routes validate with **zod**, not Fastify JSON schema, so schemas won't auto-surface to
> Swagger — either add response/body JSON schemas or generate OpenAPI from the zod definitions.

## B-5 · Missing capabilities a 409A platform should have

These are gaps in the **code** (some are tracked in `docs/remaining-gaps.md` /
`feature-gap-analysis.md`; flagged here where the running system lacks them):

### 🟠 P1 — No PII / document encryption at rest
**File:** `src/services/valuation/src/routes/documents.ts:55-87` writes raw uploaded blobs to
`DOCUMENTS_DIR` unencrypted; cap-table/PII columns are plaintext in Postgres. For a firm holding
cap tables, SSNs, and financials this is a baseline compliance expectation.
**Fix:** Encrypt documents at rest (envelope encryption / KMS), enable Postgres TDE or
column-level encryption for sensitive fields, and encrypt backups.

### 🟡 P2 — No 409A 12-month safe-harbor expiry tracking / re-valuation reminders
A 409A valuation is presumed reasonable for 12 months or until a material event. There's no
`valid_until`/expiry field driving reminder emails or a "valuation expiring" dashboard signal.
**Fix:** Add an expiry date + a scheduled reminder (the drip-campaign scanner in
`hooks/autoEmails.ts` is a natural home) and surface it on the dashboard.

### 🟡 P2 — No material-event / re-valuation trigger capture
No structured capture of material events (new priced round, secondary, M&A, major forecast
change) that should force a re-valuation. Roll-forward exists (`engine/rollforward.py`) but the
*trigger* is manual.
**Fix:** Add a material-events log per company that flags when a fresh valuation is warranted.

### 🟢 P3 — Data-retention / GDPR-style deletion is soft-delete only
`users.deleted_at` soft-deletes; there's no hard-delete/erasure workflow or retention policy for
documents and PII. `problems`/soft-delete is fine operationally but not for a "delete my data"
request.
**Fix:** Add a retention policy + a right-to-erasure job that purges blobs and PII on request.

### 🟢 P3 — Backup/DR strategy not evident in-repo
Terraform provisions RDS/Redis/S3 (`infra/terraform/`), but there's no documented backup
cadence, PITR setting, or restore runbook, and the actual deployment is systemd-on-Hetzner
(divergent from the Terraform — see I-1). Confirm Postgres backups + a tested restore.

---

# FRONTEND

## F-1 · Reliability & error handling

### 🟠 P1 — No React error boundary anywhere (one render throw = white screen)
**Files:** `src/services/web-frontend/src/main.tsx`, `App.tsx` (grep for
`ErrorBoundary`/`componentDidCatch` → none). Any uncaught render error blanks the entire SPA
with no recovery and no telemetry.
**Fix:** Add a top-level `<ErrorBoundary>` (and per-route boundaries for the valuation
workspace tabs) with a fallback UI + error reporting; consider `react-router`'s `errorElement`.

### 🟡 P2 — Manual `useEffect` fetching in ~59 files; no server-state library
**Files:** across `src/pages/**` and `src/components/**` (no `@tanstack/react-query`/SWR). Each
page re-implements loading/error/refetch by hand → duplicated logic, no request dedup/caching,
stale data after mutations (manual invalidation), and race conditions on fast tab switches
(the auth context guards with a `cancelled` flag, but page fetches largely don't).
**Fix:** Adopt React Query (or SWR) for server state: caching, dedup, `staleTime`,
invalidation-on-mutation, and built-in `isLoading`/`isError`. Big consistency + reliability win.

### 🟡 P2 — No global 404 / not-found page
**File:** `App.tsx:192` — `<Route path="*" element={<Navigate to="/" replace />} />`. Any bad
URL silently redirects home, which hides broken links and confuses users mid-workflow.
**Fix:** Render a real 404 page for unknown routes.

## F-2 · Security (frontend)

### 🟠 P1 — JWT stored in `localStorage` (XSS-exfiltratable)
**File:** `src/services/web-frontend/src/lib/api.ts:7-20`, `lib/auth.tsx`. The bearer token
lives in `localStorage`, readable by any injected script. With no CSP (B-1 P1), an XSS =
account takeover, and the 8-hour TTL widens the window.
**Fix:** Prefer an httpOnly, `SameSite=Strict`, `Secure` cookie set by the BFF (`web` service),
with the SPA relying on the cookie instead of a JS-readable token. If localStorage must stay,
pair it with a strict CSP and short TTL + refresh.

## F-3 · Accessibility

### 🟡 P2 — Modals/overlays lack focus trapping & `role="dialog"` semantics
**Files:** `src/services/web-frontend/src/components/HelpWidget.tsx`, `CookieConsent.tsx` (the
two overlay components; there's no shared `Modal` primitive in `ui.tsx`). Keyboard focus isn't
trapped, `Esc`-to-close and focus-return-on-close aren't guaranteed, and dialog roles/`aria-modal`
are missing.
**Fix:** Add a shared accessible `Modal` (focus trap, `role="dialog"`, `aria-modal`, Esc, focus
restore) and route overlays through it.

### 🟡 P2 — Form inputs don't wire `aria-invalid`/`aria-describedby` to their errors
**File:** `src/services/web-frontend/src/components/ui.tsx:30-60`. `Field` renders the error
text but the `TextInput`/`Select` aren't marked `aria-invalid` nor linked to the error via
`aria-describedby`, so screen readers don't announce validation failures. (Label association via
wrapping `<label>` is good.)
**Fix:** Thread an `id`, set `aria-invalid` when `error`, and point `aria-describedby` at the
error/hint element.

### 🟢 P3 — `Spinner` has no accessible loading announcement
**File:** `ui.tsx:131-137`. Pure visual spinner — no `role="status"`, `aria-live`, or
visually-hidden "Loading" text, so non-sighted users get silence during fetches.
**Fix:** Add `role="status"` + an `sr-only` "Loading…" label.

### 🟢 P3 — Only 13 `role=` and 147 `aria-*` across the app — audit interactive widgets
Tables, tab lists (valuation workspace), sort headers, and bulk-action toolbars should be
checked for roving-tabindex/`aria-sort`/`aria-selected`. Run axe-core in CI (see T-3).

## F-4 · UX, responsiveness, dashboard

### 🟡 P2 — Very large page components hurt maintainability & likely mobile UX
**Files:** `AdminUsersPage.tsx` (754 lines), `ValuationsPage.tsx` (704), `SettingsPage.tsx`
(695), `CommunicationsPage.tsx` (608), `FinancialModelPanel.tsx` (625). These mix data
fetching, table rendering, filtering, and modals in one component — hard to test and reuse, and
data-dense tables of this size rarely collapse gracefully to mobile.
**Fix:** Extract table/row/filter/toolbar subcomponents and shared `DataTable`/`Pagination`
primitives; verify responsive behavior (card/stacked layouts) at mobile widths.

### 🟢 P3 — No shared `DataTable`/`Pagination` primitive
`ui.tsx` provides `Button`, `Field`, `StateBadge`, `EmptyState`, `Spinner`, `StatCard`,
`ErrorNote` (a good base) but no table/pagination/modal/toast. Each list page re-implements
tables and paging.
**Fix:** Add `DataTable`, `Pagination`, `Modal`, and a toast to the shared library.

### 🟢 P3 — Client-side validation depth varies by form
Auth forms validate (zod on the server mirrors 10-char passwords etc.), but confirm inline,
pre-submit validation + disabled-submit on `NewValuationPage`, `SettingsPage`, `ContactForm`,
and `PhoneInput` rather than relying on a server round-trip for basic field errors.

### 🟢 P3 — Token expiry logs the user out but doesn't warn first
**File:** `lib/auth.tsx:81-92`. A `setTimeout` cleanly signs out at JWT expiry, but the user
gets no "your session is about to expire" prompt and unsaved work in the workspace could be
lost.
**Fix:** Warn a few minutes before expiry with a re-auth affordance (needs a refresh endpoint).

---

# TESTING, CI/CD, INFRA

## T-1 · Test coverage

**Strengths:** 33 integration suites on the valuation service (`test/integration/`) covering
auth flows, partner API, payments, auto-pipeline, operations, reviews, white-label, evidence,
scenarios, RBAC, plus 24 unit suites; ~55 frontend suites; Python `pytest` for both services.
This is strong.

### 🟡 P2 — No end-to-end / browser tests
No Playwright/Cypress. Cross-service flows (upload → auto-pipeline → calculation → report →
publish) and the auth redirect round-trips are only tested at the unit/integration seam, never
through a real browser.
**Fix:** Add a small Playwright suite for the top 3–4 critical journeys.

### 🟢 P3 — No cross-service contract tests
The valuation ↔ ai/engine JSON contracts (`clients/internal.ts` ↔ FastAPI Pydantic models) are
tested on each side independently; a shape drift wouldn't be caught. Add contract/pact-style
tests or a shared schema.

### 🟢 P3 — Confirm negative-path coverage on the Python engine
`engine-wrapper/tests/` covers backsolve, waterfall, wacc, volatility, etc. Verify explicit
tests for non-convergence, empty cap table, negative/zero vol, and NaN/Inf inputs (the code
guards these in `newton.py`/`bs.py`; lock them with tests).

## T-2 · CI/CD

### 🟠 P1 — No dependency vulnerability / secret / SAST scanning
**File:** `.github/workflows/ci.yml`. CI runs lint, format, build, tests, docker build, and
`terraform validate` — but no `npm audit`/`pip-audit`, no CodeQL/Semgrep, no secret scanning
(`gitleaks`), and no Dependabot/renovate config in-repo.
**Fix:** Add `npm audit --audit-level=high` + `pip-audit`, enable Dependabot, add CodeQL, and a
`gitleaks` step (the repo already keeps secrets in `keys/`, so a scan guards against leaks).

### 🟡 P2 — No coverage measurement or gate
CI runs tests but never collects/enforces coverage, so regressions in coverage go unnoticed.
**Fix:** Emit coverage (vitest `--coverage`, pytest-cov) and set a floor.

### 🟢 P3 — `web` and `web-frontend` images aren't built in the docker CI job
**File:** `.github/workflows/ci.yml` docker job builds valuation/ai/engine only. The `web` BFF
and `web-frontend` build aren't exercised in CI.
**Fix:** Add them so a broken frontend/BFF build fails CI.

## I-1 · Infra / deployment

### 🟠 P1 — Deployment method diverges from the committed infra (drift & unknowns)
**Files:** `infra/terraform/*` (RDS/Redis/S3/VPC) and `docker-compose.yml` describe a
containerized AWS-style stack, but the live system is **5 systemd units on a Hetzner box via
rsync** (per project memory) fronted by Caddy (`infra/caddy/`). The Terraform-provisioned
RDS/Redis/S3 may be unused. This drift means the real prod config (firewall, TLS to services,
DB SSL, backups) isn't captured or reviewed anywhere.
**Fix:** Make the repo describe the *actual* deployment — systemd unit files, host firewall
rules (critical for the P0 above), and backup config — or reconcile onto the Terraform stack.
Document which is source of truth.

### 🟡 P2 — Python containers run as root
**Files:** `src/services/ai/Dockerfile`, `src/services/engine-wrapper/Dockerfile` — no `USER`
directive (the Node images correctly use `USER node`).
**Fix:** Add a non-root user to both Python images.

### 🟡 P2 — No container healthchecks / resource limits / restart policy in compose
**File:** `docker-compose.yml`. Postgres/Redis have healthchecks, but the five app services
have none, no `deploy.resources` limits, and no `restart:` policy. `web`/`ai` don't wait on
their dependencies' health.
**Fix:** Add `HEALTHCHECK` (hit `/health`), memory/CPU limits, `restart: unless-stopped`, and
`depends_on: condition: service_healthy`.

### 🟢 P3 — Service ports 3001–3004 published to the host in compose
**File:** `docker-compose.yml:39,65,73,83`. Publishing internal service ports to the host is
fine for local dev but must **not** carry to prod (ties into the P0). Keep internal services
on an internal docker network only.

### 🟢 P3 — Caddy sets no security response headers
**File:** `infra/caddy/n409.aiknol.com.caddy`. Good: auto-TLS, gzip/zstd, `X-Real-IP`. Missing:
HSTS/CSP/`nosniff`/`frame-ancestors` (pairs with F-2/B-1). A `header` block here is the simplest
place to add them platform-wide.

---

## Quick wins (high value / low effort)

1. **Firewall/bind Python services to loopback + shared-secret header** — closes the P0.
2. **Apply the existing limiter to `POST /auth/login`** — a few lines in `auth.ts`.
3. **Reject the example `JWT_SECRET` in production** — a denylist check in `config.ts`.
4. **Add a top-level React `ErrorBoundary`** — prevents white-screen outages.
5. **Add `@fastify/helmet` + Caddy security headers** — CSP/HSTS/nosniff platform-wide.
6. **Add `npm audit` + `pip-audit` + Dependabot to CI** — one workflow edit.
7. **Set `statement_timeout` and non-root `USER` in the two Python Dockerfiles.**
8. **Add `nosniff` to the document download response.**

## What's already good (don't regress it)

Parameterized SQL everywhere; whitelisted sort columns (`repos/valuations.ts:151`); IDOR-safe
404s (`documents.ts:31-42`); scrypt + `timingSafeEqual` (`auth/password.ts`); session-epoch JWT
revocation (`plugins/auth.ts:71`); constant-time Stripe webhook verification (`payments/stripe.ts:51`);
problem+json with no 5xx leakage (`shared/problem.ts`); pino PII redaction (`shared/logger.ts`);
OTel tracing scaffold; robust engine numerics with bracketing fallback (`engine/newton.py`);
broad integration + unit + python test suites; non-root Node containers; auto-TLS via Caddy.
