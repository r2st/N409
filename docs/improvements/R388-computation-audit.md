# R388 — Computation Audit (M2), Pass 5

**Result: CLEAN PASS**

No M2-category bugs (float precision, rounding errors, off-by-one dates,
currency math, integer overflow, incorrect formula implementations) were
found after a thorough second-pass review that focused on areas the R380
audit documented as clean and on modules added or changed since then.

## Scope

Every computation-heavy file across the monorepo was read, with particular
attention to:

### Float precision and rounding

| Area | What was checked | Verdict |
|---|---|---|
| `Number(x.toFixed(4))` in `comparables.ts:99`, `aiComparables.ts:185,199` | Tested `toFixed` vs `Math.round` for value ranges this code handles (multiples 1×–100×, EVs up to low billions). The two produce the same result for these ranges; the `toFixed` pattern is a stylistic inconsistency with the codebase's `Math.round(n * scale) / scale` convention but not a computation bug. | Clean — cosmetic only |
| `round2`/`round4` helpers across 6 domain files | All use `Math.round(n * scale) / scale` consistently | Clean |
| `reportValueConsistency.test.ts:61,69` uses `Number(toFixed)` | Intentional — mirrors engine's own rounding to test value consistency | Correct |
| Python `round()` banker's rounding (6dp intermediates, 4dp conclusions) | Documented in `engine-rounding-policy.md`. The quantum at 6dp cannot reach the 4dp conclusion. `debt_valuation.py:156` explicitly documents the `round(8.5) = 8` consideration for period counts. | Clean |

### Currency math

| Area | What was checked | Verdict |
|---|---|---|
| `pricing.ts:68` — `M()` helper | `Math.round(millions * 1_000_000 * 100)` — correct | Clean |
| `accounting.ts:320` — `toCents()` | `Number.isFinite` guard + `Math.round(n * 100)` | Clean |
| `billing.ts` — all amounts in minor units (cents) throughout | Integer cents, `Intl`-based formatting | Clean |
| `payments.ts` — refund clamping | `Math.trunc` on refund amounts, cent-based totals net of refunds | Clean |
| `hris.ts:350` — option count overflow | `Math.round` + `Number.isSafeInteger` + INT4_MAX bound | Clean |
| `seo.ts:83` — structured data price | `(priceCents / 100).toFixed(2)` — display string for JSON-LD, not computation | Clean |
| `portfolio.ts:98` — roll-up totals | `round2` applied at output; per-currency buckets avoid cross-currency addition | Clean |

### Date arithmetic and off-by-one

| Area | What was checked | Verdict |
|---|---|---|
| `dates.ts` — `isIsoCalendarDate()` | Validates day-of-month against month length including leap years; rejects year 0000 for Postgres `date` compatibility | Clean |
| `calendarDate.ts` — driver date extraction | Reads local parts (not UTC) to invert the driver's midnight-local construction; documented with the UTC±0 host latency and when *not* to use it | Clean |
| `vesting.ts` — `monthsElapsed()` | Day-of-month clamping mirrors `addMonths`; the `asOfDay < daysInMonth` guard handles short months correctly (documented bug history) | Clean |
| `vesting.ts` — `addMonths()` | Clamps day-of-month via `daysInMonth`, handles year rollover via modular arithmetic, `isFinite` on result stamp | Clean |
| `progress.ts` — `daysBetween()` | `Math.floor((to - from) / MS_PER_DAY)`, floored at 0 | Clean |
| Python engine — `days / 365.25` convention | Used consistently in `compute.py:210`, `rollforward.py:109`, `validate.py:1526`, `qsbs.py:141` for year-fraction conversion. The 365.25 convention is standard for this domain (average Gregorian year). | Clean |
| `invoicePeriod()` — billing period extraction | `isoString.slice(0, 7).replace('-', '')` — correct `YYYYMM` derivation from ISO string | Clean |

### Python engine guards

| Area | What was checked | Verdict |
|---|---|---|
| `_num()` helpers across all 21+ engine modules | Every one has `math.isfinite()` + `EngineInputError`; signatures vary (`minimum`, `maximum`, `positive`, `nonneg`) per module | Clean |
| `_finite()` output guards | Present in `intangibles.py`, `smb.py`, `market_movement.py` and throughout `compute.py` — guards computed results, not just inputs | Clean |
| `compounding.py` — `compound_factor()` | Guards NaN, overflow (`OverflowError`), underflow (zero factor), complex result (negative base). Documented bug history for each case. | Clean |
| Division-by-zero guards | `smb.py:114` (cap rate > 0), `comparables.py` (positive-denominator), `sensitivity.ts:191` (baseFmv > 0), `vesting.ts:253` (total > 0) | Clean |
| `intangibles.py` — negative-asset guard | `_asset_value()` raises on negative rather than clamping to zero, with documented reasoning | Clean |

### Monte Carlo and stochastic

| Area | What was checked | Verdict |
|---|---|---|
| `asc718Public.ts` — deterministic LCG + Box-Muller | Seeded, reproducible, uses `round4`/`round2` on outputs. Draw budget caps CPU time per request. | Clean |
| `asc718.ts` — amortization schedule | Last-period rounding absorption ensures sum = totalCost exactly. `round2` on every output. | Clean |

## Why clean

This is the fifth computation-correctness pass (following R98, R240, R380,
and others). The codebase has accumulated deep guards at every numeric
boundary:

- `Number.isFinite()` / `math.isfinite()` on every external numeric input
- `_num()` coercion helpers with `EngineInputError` in every engine module
- `_finite()` output guards on computed results
- `Math.round(n * precision) / precision` as the canonical rounding pattern
- `compound_factor()` centralizing all `(1 + rate) ** periods` with
  overflow, underflow, and complex-number guards
- `isIsoCalendarDate()` rejecting impossible dates before they reach
  Postgres or `new Date()`
- `calendarDate()` / `calendarDateOf()` isolating the Postgres date-driver
  artifact from UTC conversion bugs
- Last-period rounding absorption in every schedule
- Positive-denominator guards on every division
- Per-currency roll-ups preventing cross-currency addition
- `Number.isSafeInteger` + column-width bounds on integer paths
- 365.25-day year convention used consistently for year-fraction conversion

### Note for future rounds

The `Number(x.toFixed(4))` pattern in `comparables.ts:99` and
`aiComparables.ts:185,199` is stylistically inconsistent with the
`Math.round(n * 10000) / 10000` convention used in every other domain file.
For typical comparable multiples and enterprise values the two produce
identical results, so this is a consistency observation, not a defect. If
these files are touched for another reason, aligning them with the
`Math.round` convention would close the last style gap in the rounding
layer.
