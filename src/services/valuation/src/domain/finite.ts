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
