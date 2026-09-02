import { problems } from '@n409/shared';

/**
 * The ceiling on a figure the engine computed and the service is about to store.
 *
 * `domain/int4.ts` bounds the numbers a *caller* sends. This is the other half:
 * numbers no caller ever typed, which the engine derived from inputs that were
 * each individually inside their own bound.
 *
 *   fund_marks.fair_value      numeric(24, 4)   → below 1e20
 *   debt_valuations.fair_value numeric(24, 6)   → below 1e18
 *
 * A fund mark on the `market` method is `quantity × quoted_price`. The route
 * caps quantity at 1e15 and quoted_price at 1e12 — both defensible on their own,
 * and their product is 1e27, seven orders of magnitude past what the column
 * holds. The same shape reaches debt valuation through an unbounded `face`: the
 * engine's `_num` refuses NaN and Inf but sets no maximum, so a dirty price of
 * 1e25 is a perfectly finite number that `numeric(24, 6)` cannot store.
 *
 * Both ended the same way — `22003 numeric field overflow` out of the driver,
 * uncaught, as a 500 naming nothing — and neither is reachable by tightening a
 * single input, because no single input is wrong. The product is.
 *
 * So the check belongs where the figure is finished rather than where its parts
 * came in, which is also where the engine already refuses its own overflows:
 * commit 8667778 made `approaches.py` name the figure that overflowed to `inf`.
 * This names the figure that stayed finite and still will not fit.
 */
export interface NumericColumn {
  /** Total significant digits — the `p` of `numeric(p, s)`. */
  readonly precision: number;
  /** Digits after the decimal point — the `s` of `numeric(p, s)`. */
  readonly scale: number;
}

/** `fund_marks.fair_value`, migration 0086. */
export const FUND_MARK_FAIR_VALUE: NumericColumn = { precision: 24, scale: 4 };

/** `debt_valuations.fair_value`, migration 0087. */
export const DEBT_FAIR_VALUE: NumericColumn = { precision: 24, scale: 6 };

/**
 * `rollforward_runs.prior_equity_value` / `.rolled_equity_value`, migration 0150.
 *
 * The same shape as the two above, in the subsystem that did not adopt the
 * rule. A roll-forward is `prior_equity_value x (1 + rate) ** years`: the rate
 * is capped at 10 (1000%) by `RunBody`, the gap is whatever two analyst-entered
 * valuation dates are apart, and the prior value is whatever the previous
 * engagement concluded. Each is defensible; the product is not — an eleven-year
 * gap at the maximum rate takes a $10M anchor past 1e18, and `numeric(20, 2)`
 * holds eighteen digits left of the point.
 *
 * The engine refuses `inf` and refuses a non-positive result
 * (`engine/rollforward.py`), and `shapeRollforward` repeats both. Neither asks
 * about magnitude, so a finite, positive, unstorable figure went to the driver
 * and came back as `22003 numeric field overflow` — a 500 naming nothing, on a
 * request whose accretion rate is the thing the analyst can actually change.
 */
export const ROLLFORWARD_EQUITY_VALUE: NumericColumn = { precision: 20, scale: 2 };

/**
 * `valuation_projections.terminal_value`, migration 0136.
 *
 * A Gordon terminal value is `FCF x (1 + g) / (r - g)`, which is the same
 * bounded-parts-unbounded-product shape one division further on: the closer the
 * discount rate is to the growth rate, the larger the quotient, and both are
 * ordinary fractions the caller is allowed to send.
 */
export const PROJECTION_TERMINAL_VALUE: NumericColumn = { precision: 20, scale: 2 };

/**
 * The exclusive upper bound on the magnitude the column accepts.
 *
 * Postgres rejects on the count of digits *left* of the point, so the limit is
 * 10^(precision − scale) — a `numeric(24, 4)` stores up to 20 integer digits.
 * Rounding to `scale` happens silently and is not an error, so only the
 * integer part is ever the thing that overflows.
 */
export function numericCeiling(column: NumericColumn): number {
  return 10 ** (column.precision - column.scale);
}

/** True when `value` can be stored in `column` without a 22003 from the driver. */
export function fitsNumeric(value: number, column: NumericColumn): boolean {
  return Number.isFinite(value) && Math.abs(value) < numericCeiling(column);
}

/**
 * A computed figure on its way into a `numeric` column, or a 422 naming it.
 *
 * 422 rather than 500 because the request is the thing that is wrong — the
 * caller asked for a valuation whose answer is too large to record — and 422 is
 * what this codebase already answers for a body it cannot act on.
 */
export function requireStorableFigure(
  value: number | null,
  name: string,
  column: NumericColumn,
): number | null {
  if (value === null) return null;
  if (!fitsNumeric(value, column)) {
    throw problems.unprocessable(
      `${name} is ${value.toExponential(3)}, too large to record — ` +
        `the stored figure must be below ${numericCeiling(column).toExponential(0)}. ` +
        'Check the magnitude of the inputs it was computed from.',
    );
  }
  return value;
}
