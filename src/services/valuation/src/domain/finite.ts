import { z } from 'zod';

/**
 * The floating-point sibling of `domain/int4.ts`: a number that is actually a
 * number.
 *
 * `z.number()` rejects NaN and nothing else. `Infinity` is a number to zod, and
 * every constraint that does not bound the value from above lets it through —
 * `.positive()`, `.nonnegative()`, `.min(0)`, a bare `z.number()`. Only `.max()`
 * / `.lt()` / `.int()` happen to exclude it, as a side effect of what they
 * actually test.
 *
 * That would be academic if a client had to go out of its way to send one, but
 * JSON produces it by accident:
 *
 *     JSON.parse('{"cash": 1e999}')      →  { cash: Infinity }
 *
 * — no exotic encoding, just a number with too many digits, which is what a
 * spreadsheet paste or an off-by-a-few-orders-of-magnitude unit conversion
 * looks like on the wire. It validated, and then:
 *
 *     JSON.stringify({ cash: Infinity })  →  '{"cash":null}'
 *
 * so the value the analyst sent was written to `valuation_params.engine_inputs`
 * as `null` and handed to the engine as `null`. A share count, a cash balance
 * or a preference stack silently became "not provided", with a 200 on the way
 * back saying it had been saved. Verified before this module existed: an
 * `EngineInputsBody` carrying `{"cash": 1e999, "share_classes": [{..., "shares":
 * 1e999}]}` parsed clean and round-tripped to `{"shares": null, "cash": null}`.
 *
 * A silent null is the worst available outcome. A 422 naming the field is the
 * point of these three exports; use them anywhere a non-integer number is
 * accepted from a request body, in place of the bare zod constructors.
 *
 * Where a field has a real business ceiling it should still declare its own
 * `.max()` — `volatility` stops at 5, `exit_multiple` at 100. These say only
 * "this is a finite quantity", which is the floor, not the rule.
 */

/** Any real number: rejects NaN and both infinities. */
export const finite = () => z.number().finite();

/** A finite quantity that may be zero — a balance, a count, a preference. */
export const finiteNonNegative = () => z.number().finite().nonnegative();

/** A finite quantity that must be above zero — a price, a share count. */
export const finitePositive = () => z.number().finite().positive();

/**
 * The largest magnitude a monetary amount or a share count may carry.
 *
 * `Number.MAX_SAFE_INTEGER`, and the bound is about arithmetic rather than
 * about how big a company can be. Above 2^53 a double cannot represent
 * consecutive integers, so addition silently stops being addition:
 *
 *     1e16 + 1 === 1e16      // true
 *
 * A cap table carrying one class of 1e16 shares and another of 1 therefore
 * sums to 1e16 — the second class contributes nothing, the fully-diluted count
 * is wrong, and every per-share figure derived from it is wrong with it. No
 * error is raised anywhere: the inputs are finite, `finite()` above passes
 * them, the engine's own range checks are warnings rather than refusals, and
 * the report states a number that was never computed from the cap table it
 * prints beside it.
 *
 * That is reachable by accident, not just by attack — a unit slip (a figure
 * entered in units rather than millions, twice), a spreadsheet paste, an
 * extraction that read a concatenated column. So it is refused at the edge,
 * with the field named, in preference to being warned about deep inside the
 * arithmetic.
 *
 * Note this is a *floor* on carefulness, not a business rule. No real 409A
 * subject has $9 quadrillion of anything; a field with a tighter real ceiling
 * should still declare it (`volatility` stops at 5, `exit_multiple` at 100).
 */
export const MAX_QUANTITY = Number.MAX_SAFE_INTEGER;

const TOO_LARGE = `Above ${MAX_QUANTITY} a value cannot be added exactly, so totals derived from it would be wrong`;

/** A non-negative quantity that is also small enough to add exactly. */
export const boundedNonNegative = () => finiteNonNegative().max(MAX_QUANTITY, TOO_LARGE);

/** A positive quantity that is also small enough to add exactly. */
export const boundedPositive = () => finitePositive().max(MAX_QUANTITY, TOO_LARGE);

/**
 * A signed quantity bounded in both directions.
 *
 * For the figures that are legitimately negative — EBITDA is routinely
 * negative for a venture-backed company, and a retained-earnings or
 * net-working-capital line can be either way round. The sign stays free; only
 * the magnitude is bounded, and for the same reason as above.
 */
export const boundedSigned = () =>
  finite().min(-MAX_QUANTITY, TOO_LARGE).max(MAX_QUANTITY, TOO_LARGE);
