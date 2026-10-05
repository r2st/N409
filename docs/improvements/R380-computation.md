# R380 — Computation Correctness (M2), Pass 4

**Result: CLEAN PASS**

No M2-category bugs (rounding errors, off-by-one, integer overflow,
floating-point precision, incorrect formula implementations, unit mismatches)
were found after thorough review.

## Scope

Every computation-heavy file across the monorepo was read in full:

### `services/valuation/src/domain/`

| File | Key computation | Verdict |
|---|---|---|
| `sensitivity.ts` | Abramowitz & Stegun erf, normCdf, Black-Scholes call, OPM FMV per share (multiplicative discounts), sensitivity grid with termFloor | Clean |
| `asc718.ts` | Black-Scholes-Merton with continuous dividend yield, Monte Carlo (deterministic LCG + Box-Muller), amortization schedule (last-period rounding absorption), expected-to-vest compound forfeiture, stated-component-authority rounding, calendar-year expense aggregation | Clean |
| `asc718Public.ts` | Cox-Ross-Rubinstein binomial lattice with Hull-White early exercise, historical volatility (Bessel's correction, 3+ closes), ESPP put-call parity, performance/market/relative-TSR Monte Carlo, draw budget system | Clean |
| `fmvEstimator.ts` | Lognormal parameter recovery from p10/p90, law of total variance pooling, independent lognormal multiplication, density curve plotting | Clean |
| `billing.ts` | Minor-unit currency scale via Intl, formatMoneyCents, invoice/receipt round2 on refund bounds, subscription price reading | Clean |
| `pricing.ts` | Band-based uplift, millions-to-cents conversion `Math.round(millions * 1_000_000 * 100)` | Clean |
| `numericColumn.ts` | Postgres numeric ceiling `10^(precision-scale)`, fitsNumeric absolute-value check | Clean |
| `portfolio.ts` | Subsidiary elimination, per-currency roll-ups with round2, mixed-currency null totals, cycle detection | Clean |
| `workbook.ts` | Derived formula computation, null-propagating helpers (sub/sum/ratio/perUnit), YoY growth left-to-right resolution | Clean |
| `vesting.ts` | monthsElapsed with day-of-month clamping, cliff + cadence boundary logic, addMonths with month-end clamping, percentVested `round(vested/total * 10000) / 100` | Clean |
| `capTable.ts` | parseNumericCell, normalizeDecimalSeparator, asConvertedShares, investedAmount, liquidationPreference, fullyDilutedShares, overflow detection | Clean |
| `capTableGraph.ts` | As-converted ownership denominator, stackOrder sort, pari-passu rank grouping, seniority edge count bound | Clean |
| `volatility.ts` | Date window resolution, price series extraction | Clean |
| `dlom.ts` | Multiple DLOM model methods | Clean |
| `financialAnomalies.ts` | Cost sign checks, revenue series, cross-statement validation | Clean |
| `rollforward.ts` | Period roll-forward arithmetic | Clean |
| `comparables.ts` | Implied multiples (EV/metric with positive-denominator guard), median (even-count averaging), set summarization | Clean |
| `payments.ts` | Refund state (clamped, Math.trunc), collected totals (net of refunds), currency-aware sums | Clean |
| `valuationBridge.ts` | LMDI-I index decomposition, logarithmic mean L(a,b), factor attribution with allPositive guard, per-share precision rendering | Clean |
| `qaChecks.ts` | Threshold-based QA checks with appliedDiscount reading engine results | Clean |
| `reportFigures.ts` | Template figure substitution, combined discount `1-(1-dloc)(1-dlom)` | Clean |
| `valuationCompare.ts` | pct_change `(b-a)/|a|`, point-move formatting, specialty payload flattening | Clean |
| `approaches.ts` | Approach weighting and indicated values | Clean |

### `services/valuation/src/clients/`

| File | Key computation | Verdict |
|---|---|---|
| `accounting.ts` | toCents `Math.round(n*100)` with isFinite guard, storable bounds | Clean |
| `deadline.ts` | Integration timeouts, streaming byte budget, paged pull budget | Clean |

### `services/web-frontend/src/lib/`

| File | Key computation | Verdict |
|---|---|---|
| `format.ts` | formatPerShare (4 dp), minorUnitScale via Intl, ordinal, date parsing | Clean |
| `capTableFigures.ts` | investedAmount restated (parity-tested with domain version) | Clean |
| `stats.ts` | Frontend statistics helpers | Clean |

### `packages/shared/src/`

| File | Key computation | Verdict |
|---|---|---|
| `finite.ts` | Number.isFinite guards, MAX_SAFE_INTEGER bounds | Clean |
| `int4.ts` | Postgres int4 overflow detection | Clean |
| `numberFormat.ts` | Intl.NumberFormat caching, currency-aware formatting | Clean |

## Why clean

The codebase has been through extensive computation hardening across prior
rounds (R98, R240, R255, R259, R265, R267, R270, R287, R301, R305, R330,
R345, R407, R409, R415, and others). Key patterns that make it robust:

- `Number.isFinite()` guards on every external numeric input
- `Math.round(n * precision) / precision` for controlled rounding
- Dedicated `round2`/`round4` helpers used consistently
- Last-period rounding absorption in schedules and amortization
- Stated-component-authority rounding (round disclosed parts, sum)
- Multiplicative discount application `(1-dloc)(1-dlom)`
- `Number.MAX_SAFE_INTEGER` bounds for integer overflow detection
- Postgres numeric column overflow detection (`numericColumn.ts`)
- Bessel's correction in sample statistics
- Positive-denominator guards on division
- Parity tests between frontend restated functions and domain originals
