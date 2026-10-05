# R367 — Cross-cutting concerns (M4)

**Cycle 54 · Pair 4 · 2026-10-06**

Focus: inconsistencies in error handling, input validation, logging, and
security configuration that span multiple modules — patterns where one part
of the codebase has a guard and another does not.

---

## Findings

### 1. Unguarded `Number()` coercion feeds NaN/Infinity into financial calculations

**Severity:** HIGH  
**Files:**
- `src/services/valuation/src/routes/calculations.ts:167`
- `src/services/valuation/src/routes/debt.ts:415–416`
- `src/services/valuation/src/routes/grants.ts:182`

PostgreSQL `numeric` columns can hold `NaN` and `Infinity`, and the `pg`
driver returns them as the strings `"NaN"` and `"Infinity"`. Several route
files convert these strings to JavaScript numbers with `Number()` without
checking `Number.isFinite()`.

The safe pattern already exists in `projections.ts:153–160`, and the same
file (`calculations.ts:153`) validates the engine's **output** for
finiteness but not its **input** — so a corrupt column value would silently
enter the engine, propagate through every arithmetic operation, and either:

- Produce NaN results that fail the output check (blaming the engine for a
  bad input from the database), or
- In the `grants.ts` case, directly set the exercise price for stock options
  to NaN, which would be stored in the database without further validation.

**`calculations.ts:167` — the central `engineParams()` builder.** Every
standard 409A valuation flows through this function. Its `num()` helper
converted `null`/`undefined` to `null` but passed everything else through
`Number()` unchecked. A `numeric` column holding `'NaN'` would produce
`NaN` for any weight, DLOC, or DLOM parameter.

**`debt.ts:415–416` — credit terms.** `Number(terms.benchmark_yield)` and
`Number(terms.spread)` feed directly into the engine payload for debt
instrument valuations.

**`grants.ts:182` — adopted FMV conclusion.** `Number(resolution.fmv_conclusion)`
sets the exercise price for ISO/NSO stock options. NaN here means options are
priced at NaN, stored in the database, and rendered in grant agreements.

**Fix:** Added `Number.isFinite()` guards to all three sites, matching the
established pattern in `projections.ts`. In `calculations.ts` and `debt.ts`,
non-finite values become `null` (absent). In `grants.ts`, a non-finite FMV
throws `422 Unprocessable` with a clear message, since an exercise price is
mandatory and cannot be silently dropped.

**Test:** `test/unit/engineParamsFinite.test.ts` — verifies `engineParams()`
nullifies `NaN`, `Infinity`, and `-Infinity` strings while preserving valid
numeric strings and `null` columns.

---

### 2. Engine-wrapper missing credential environment census test

**Severity:** MEDIUM  
**File:** `src/services/engine-wrapper/tests/test_secret_env_census.py` (new)

The AI service has a comprehensive `test_secret_env_census.py` (since R241)
that uses AST parsing to scan every Python file for environment variable
reads, then verifies that every credential-shaped variable is listed in
`_SECRET_ENV_VARS` — the literal-value redaction net that catches secrets
without a recognizable prefix (AWS secret keys, session tokens).

The engine-wrapper service carries the same `_SECRET_ENV_VARS` tuple
(copied from the AI service) but had **no corresponding census test**. A
future commit adding a credential env var (e.g., a new market-data
provider's API key) to the engine-wrapper would not fail the test suite —
exactly the gap R241 wrote the AI tier's census to close, and the one it
has now caught twice (Bedrock credentials in R236, Perplexity key in R241).

The engine-wrapper's `_SECRET_ENV_VARS` also contains four entries
(`OPENROUTER_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`,
`PERPLEXITY_API_KEY`) that no code in this service reads. These are
retained as defense-in-depth: both services share an environment, so the
literal values may appear in library errors or tracebacks even though this
service does not use them directly.

**Fix:** Added `test_secret_env_census.py` to the engine-wrapper, adapted
from the AI service's version. The stale-entry test is adjusted to account
for shared-environment variables with explicit declarations of which service
owns each one.

---

## Files changed

| File | Change |
|------|--------|
| `src/services/valuation/src/routes/calculations.ts` | `num()` helper now checks `Number.isFinite()` |
| `src/services/valuation/src/routes/debt.ts` | Credit term coercions guarded with `Number.isFinite()` |
| `src/services/valuation/src/routes/grants.ts` | Adopted FMV coercion throws 422 if non-finite |
| `src/services/valuation/test/unit/engineParamsFinite.test.ts` | New: tests for `engineParams()` finite guards |
| `src/services/engine-wrapper/tests/test_secret_env_census.py` | New: credential env census for engine-wrapper |

## Tests run

```
src/services/valuation/test/unit/engineParamsFinite.test.ts  — 5 passed
src/services/engine-wrapper/tests/test_secret_env_census.py  — 3 passed
src/packages/shared/test/redactionParity.test.ts             — 10 passed (regression check)
```
