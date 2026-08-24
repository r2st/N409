import { z } from 'zod';

/**
 * A boolean written into a query string, parsed the way a query string means it.
 *
 * `z.coerce.boolean()` is the obvious spelling and the wrong one. Coercion here
 * is `Boolean(value)`, and a query-string value is always a *string* — so every
 * non-empty one is true:
 *
 *   ?include_deleted=false   → true
 *   ?include_deleted=0       → true
 *   ?include_deleted=no      → true
 *   ?include_deleted=banana  → true
 *   ?include_deleted=        → false
 *
 * Only the two spellings nobody writes deliberately produce `false`: omitting
 * the key, and setting it to the empty string. Every deliberate "no" — which is
 * what a caller unsetting a filter writes, and what a hand-built URL or a
 * client library that serialises `false` as `"false"` sends — turns the filter
 * on instead. Six query schemas across this service were written that way, on
 * flags including `include_deleted` (deactivated accounts in the admin console),
 * `include_released` (addresses lifted out of the suppression list) and `unread`
 * — so `?unread=false` narrowed the list to unread rather than widening it to
 * everything, silently, with a 200 and a plausible page.
 *
 * The list filters never had this: `routes/valuations.ts` has always written
 * `z.enum(['true', 'false']).transform(v => v === 'true')` for
 * `waiting_on_client` and `unread`. This is that, once, so there is one spelling
 * of a query-string boolean in the service and one place a change to it lands.
 *
 * Anything that is not exactly `true` or `false` is a 400 naming the field,
 * rather than a filter that quietly did the opposite of what was asked. That
 * includes the empty string: `?unread=` is a present-but-blank filter, which a
 * caller only sends by accident, and the frontend already drops a key rather
 * than send one (see `ValuationsFilters.test.tsx`, "sends unread-only as a flag,
 * and drops it again when unchecked").
 */
const FLAG = z.enum(['true', 'false']).transform((v) => v === 'true');

type Flag = typeof FLAG;

/**
 * `?flag=true|false`.
 *
 * With no argument the field is optional and parses to `boolean | undefined` —
 * absent means "no opinion", which is what a filter that narrows nothing wants.
 * With a fallback it parses to `boolean`, so a route that always needs an answer
 * does not have to write `?? false` at the point of use.
 */
export function flagParam(): z.ZodOptional<Flag>;
export function flagParam(fallback: boolean): z.ZodDefault<Flag>;
export function flagParam(fallback?: boolean): z.ZodOptional<Flag> | z.ZodDefault<Flag> {
  // `.default()` takes the schema's *input*, which here is the literal text —
  // the transform runs after it, so the route still sees a boolean.
  return fallback === undefined ? FLAG.optional() : FLAG.default(fallback ? 'true' : 'false');
}
