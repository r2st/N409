# R378 — Fence Audit

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Round          | R378                                     |
| Methodology    | M6 — fence audit                         |
| Cycle / Pass   | 57 / 6                                   |
| Findings       | 3 (1 HIGH, 2 MEDIUM)                     |
| Commit         | (this commit)                            |

## Finding 1 — HIGH: Unsubscribe routes have no rate limiting

**Files**: `src/services/valuation/src/routes/unsubscribe.ts`

**Bug**: Both `POST /api/v1/unsubscribe` and `GET /api/v1/unsubscribe` were the
only public, database-writing endpoints without a per-IP rate limiter. The POST
verifies a cryptographic token (CPU cost) and upserts a preference row on every
valid request (database write). The GET does the same and returns an HTML page.

Every other public endpoint that writes to the database — contact form, client
intake, auditor portal, board approval — has a per-IP rate limiter. These two
were exempted under the reasoning that a 429 to a mailbox provider "reads as
this sender does not honour unsubscribe." That reasoning is sound for the POST
response *status* (which must stay 200), but does not preclude counting requests
and silently dropping the preference write once the budget is spent.

**Impact**: An attacker can flood these endpoints to burn CPU on signature
verification and exhaust database connections with upsert writes. The POST is
reachable by anyone who can guess or enumerate valid tokens, and the GET is
linked in every marketing email.

**Fix**: Added a `FixedWindowRateLimiter` (30 req/10 min per IP) shared between
both verbs. The POST still answers 200 when throttled (so mail providers never
see a 429) but returns `{ unsubscribed: false }` without touching the database.
The GET answers 429 with an HTML page, since a human who sees it can retry.
Added the `unsubscribe` door to `ThrottledDoor` and wired `recordThrottleRefusal`.

**Tests**: `test/unit/unsubscribeRateLimit.test.ts` — 3 cases: POST budget
exhaustion (still 200), GET budget exhaustion (429 with HTML), shared budget
between verbs.

---

## Finding 2 — MEDIUM: Public computation endpoints have no rate limiting

**Files**: `src/services/valuation/src/routes/fmvEstimator.ts`,
`src/services/valuation/src/routes/valuationSelector.ts`

**Bug**: `POST /api/v1/fmv-estimator` and `POST /api/v1/valuation-selector` were
the only public POST routes without a per-IP rate limiter. Both carried the
comment "the platform limiter is the only one it needs" — but the platform
limiter (`applyCostLimiter` in `plugins/auth.ts`) keys on `req.principal.id`,
which is absent on unauthenticated requests. No rate limit existed at all for
these endpoints.

Every other public POST on the service has a per-IP throttle: contact (5/10 min),
client-errors (20/5 min), client-intake (120/10 min), auditor-portal (30/10 min),
board-approval (30/10 min), sample-report/pdf (10/10 min).

**Impact**: A single IP can send unlimited requests to these computation
endpoints. While individually lightweight, sustained flooding pins the event loop
and degrades the service for all users.

**Fix**: Added `FixedWindowRateLimiter` (60 req/10 min per IP) to both routes.
The limiter runs before body validation so even malformed floods are refused.
Updated `PUBLIC_RATE_LIMITS` in `rateLimitPolicy.ts` to file both routes under
named policies instead of `open`, and added both doors to `ThrottledDoor`.

**Tests**: `test/unit/publicComputeRateLimit.test.ts` — 4 cases: per-IP budget
exhaustion for each route, and throttle-before-validation for each.

---

## Finding 3 — MEDIUM: `gatedElsewhere` path normalisation inconsistency

**File**: `src/packages/shared/src/internalAuth.ts` (line 148)

**Bug**: The `registerInternalAuth` onRequest hook checks two path sets in
sequence:

1. `isInternalPublicPath(req.url)` — strips trailing slashes before lookup
2. `gatedElsewhere.has(req.url.split('?')[0])` — does **not** strip trailing slashes

A request to `/metrics/` (with trailing slash) fails the `gatedElsewhere` check
because the set contains `/metrics`, not `/metrics/`. The request then falls
through to the internal service token check, which rejects it with 401.

This fails safe (the stricter check applies), but it creates an inconsistency
in the same hook: two adjacent path-set lookups using different normalisation
rules. The inconsistency would become a gap if a future `gatedElsewhere` entry
guarded a path with weaker authentication than the internal service token.

**Impact**: Operational: a metrics scraper that sends `/metrics/` (e.g., from a
misconfigured Prometheus target with a trailing slash) gets 401 instead of
reaching the metrics endpoint's own `METRICS_TOKEN` gate. Security: the
inconsistency is a latent hazard that would become exploitable if
`gatedElsewhere` grows.

**Fix**: Applied the same trailing-slash normalisation to the `gatedElsewhere`
lookup: `rawPath.replace(/\/+$/, '')`, matching `isInternalPublicPath` exactly.

**Tests**: Added to `src/packages/shared/test/internalAuth.test.ts` — verifies
that `/metrics/` and `/metrics///` are no longer rejected with 401 by the
internal auth hook.
