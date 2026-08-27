# Engine rounding policy

A 409A opinion is checked by someone re-doing the arithmetic. Every `round()`
between an input and the concluded fair market value is therefore either
invisible to that person or something they have to be told about, and the
difference between the two is what this document fixes.

`src/services/engine-wrapper/tests/test_calculation_provenance.py` is this
document made executable. If the two disagree, the test is right.

## The two kinds

**Presentational.** The value is rounded on its way into the result document
and nothing reads it back. It cannot move a number, only how a number is
printed.

**Load-bearing.** The rounded value is what later arithmetic consumes. It can
move the conclusion, and the only question worth asking about it is by how
much.

The distinction is not visible at the call site — `round(x, 6)` looks the same
either way — so it is a property of who reads the field, and it changes the
moment a new consumer appears. That is exactly how the one defect this document
was written after came about: `sensitivity` began dividing
`results.fmv_per_share` by another run's, and a rounding that had been purely
presentational for as long as it existed became load-bearing without anybody
editing the line.

## The reported precisions

| Kind of figure | Places | Example |
| --- | --- | --- |
| Currency | 2 (cents) | `equity_value`, `common_equity_value` |
| Concluded value per share | 4 | `fmv_per_share` |
| Intermediate value per share | 6 | `allocation.common_per_share`, per-class `per_share` |
| Discounts and fractions | 4 concluded / 6 in the working | `discounts.dlom`, `dlom_detail.dlom` |
| Volatility | 4 | `recommended_volatility` |
| Years | 4 | `time_to_exit_years` |

Four decimals on the concluded per-share is the platform-wide figure — the API,
the workbook export, the report exhibits and the browser all print it that way,
and `n409-per-share-precision` is the note about what happens when one of them
does not.

## The load-bearing sites

Each of these produces a rounded value that the FMV chain then multiplies,
divides or sums.

| Site | Places | Consumed by |
| --- | --- | --- |
| `waterfall.allocate_waterfall` → `common_per_share` | 6 | `compute._opm_allocate` → FMV |
| `waterfall.exit_allocation` → `common_per_share`, class `value` | 6 / 2 | `pwerm.allocate_pwerm` → FMV |
| `current_value.allocate_cvm` → `common_per_share` | 6 | `compute._compute_cvm` → FMV |
| `pwerm.allocate_pwerm` → `common_per_share` | 6 | `compute._compute_pwerm` → FMV |
| `monte_carlo.allocate_monte_carlo` → `common_per_share` | 6 | `compute._compute_monte_carlo` → FMV |
| `compute._resolve_discounts` → `dlom` | 4 | the FMV multiplication, on every path |
| `compute._blended_dlom` → each leg's `weighted` | 6 | summed into the concluded DLOM |
| `dlom` study blends → `dlom` | 4 | as above |
| `dloc._invert_premium` → `dloc` | 6 | the FMV multiplication |
| `volatility.estimate_volatility` → `recommended_volatility` | 4 | the allocation, on the `auto_volatility` path only |

`hybrid.blend_hybrid` is the near miss. It rounds a `common_per_share` for each
of its two legs at six places, and neither is load-bearing: they are copies of
the leg figures for display, and the blend the FMV is actually struck from —
`blend_hybrid`'s own `common_per_share` — is a weighted mean of the *unrounded*
legs. The census in `test_calculation_provenance.py` cannot tell those apart
from the real thing, so it insists this table mentions the module, which is why
this paragraph exists.

Everything else in the engine is presentational.

### One name, two figures

`pwerm.allocate_pwerm` calls each row of `allocation.classes` an
`fmv_per_share`. It is not the conclusion — it is one share class's
probability-weighted present value per share, before any discount, at six
places. `results.fmv_per_share` is the concluded figure at four. A consumer
grepping the name finds both; only the second one is the opinion.

## The rule

> Load-bearing rounding must not move the concluded FMV by half its last
> reported place — 5e-5 per share — and the result document must reproduce its
> own conclusion from the figures printed beside it.

The second clause is why the concluded DLOM is quantised to four decimals
*before* it is applied rather than after. A reviewer multiplies the reported
per-share by the reported discounts and has to land on the reported conclusion;
applying an unrounded model DLOM and printing a rounded one breaks that at the
fifth decimal, which is invisible on a $0.60 share and worth a quarter of a cent
on a $50 one. The model's own unquantised output stays available in
`discounts.dlom_detail.dlom`, one place wider, so nothing is lost — it simply is
not the concluded figure.

The per-share intermediates sit at six decimals for the same reason read the
other way: two orders finer than the conclusion, so the quantum cannot reach it,
and still narrow enough that a per-class schedule is readable.

## Ratios are not covered by any of this

A ratio of two conclusions inherits the quantum of both, scaled by 1/FMV. At the
four decimals the conclusion is reported to, that is 1e-4/FMV — 0.01% on a $1
share and **2% on a half-cent one**, which is the ordinary shape for an
early-stage company with a heavy preference stack. `sensitivity` published those
ratios to six decimals.

So a consumer computing a ratio must divide unrounded figures. `compute` returns
`fmv_per_share_unrounded` beside `results` for exactly this, placed outside
`results` for the same reason `trace` is: `results` is the persisted answer, it
is diffed between runs and rendered into the deliverable, and a second per-share
figure inside it reads as a second conclusion. It is not one, and it must never
be printed as one.

## Adding a consumer

Before reading a figure out of `results` and doing arithmetic on it, check this
table. If the figure is presentational and you are about to divide, subtract or
compound it, you are converting it to load-bearing — take the unrounded source
instead, and add a row above.
