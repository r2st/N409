# R384 — Cross-cutting concerns (M4), Pass 5 / C94 Pair 4

## Summary

Two cross-cutting security-header inconsistencies across the five-service estate.

## Issues found and fixed

### 1. Report service missing `Cache-Control: no-store` default

**File:** `src/services/report/src/app.ts`

The valuation service registers `registerNoStoreDefault` so every response
that does not explicitly set its own `Cache-Control` goes out with `no-store`.
The report service — whose single route serves `application/pdf` with
`content-disposition: inline` — registered no such default.

That means the rendered 409A report PDF went out with no `Cache-Control` at
all. Two things downstream of it decide from that header what to keep:

* The **browser disk cache**: an inline PDF opens in a tab and lands on disk,
  so the company's most sensitive document sat on whatever machine last
  viewed it.
* The **Cloudflare edge**: `.pdf` is on its default cacheable-extension list,
  and the only thing preventing a cache today is the absence of a directive
  saying it may store it — a thinner guarantee than a directive saying it
  must not.

**Fix:** Added `registerNoStoreDefault(app)` to the report service, matching
the valuation service. Test extended to assert `cache-control: no-store` on
the rendered PDF and on the 422 error response.

### 2. Python services' `Permissions-Policy` out of sync with TypeScript

**Files:** `src/services/ai/app/security_headers.py`,
`src/services/engine-wrapper/app/security_headers.py`

The shared TypeScript module (`securityHeaders.ts`) denies 24 features on
API surfaces. The two Python services still carried the round-74 list of 17
features, missing seven that the TypeScript services deny:

* `ambient-light-sensor`
* `clipboard-read`
* `clipboard-write`
* `idle-detection`
* `local-fonts`
* `publickey-credentials-create`
* `serial`

A response that crosses the estate changes its posture at the hop: an AI
pipeline result proxied through the valuation service picked up the full
policy on the way out, but a direct caller (an operator with a tunnel, a
future service) saw the shorter one.

**Fix:** Updated both Python `_PERMISSIONS_POLICY` constants to match the
TypeScript `API_PERMISSIONS_POLICY`. Tests in both services extended to
assert the newly added features.

## Files changed

| File | Change |
|------|--------|
| `src/services/report/src/app.ts` | Added `registerNoStoreDefault` import and call |
| `src/services/report/test/securityHeaders.test.ts` | Assert `cache-control: no-store` on PDF and 422 |
| `src/services/ai/app/security_headers.py` | Sync `_PERMISSIONS_POLICY` with TypeScript (7 features added) |
| `src/services/engine-wrapper/app/security_headers.py` | Same sync |
| `src/services/ai/tests/test_security_headers.py` | Assert new features in policy |
| `src/services/engine-wrapper/tests/test_security_headers.py` | Assert new features in policy |

## Tests

* `report` — 8/8 passed (securityHeaders.test.ts)
* `ai` — 9/9 passed (test_security_headers.py)
* `engine-wrapper` — 9/9 passed (test_security_headers.py)
