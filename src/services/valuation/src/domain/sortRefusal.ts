import { problems, type ApiProblem } from '@n409/shared';
import { MAX_SORT_TERMS, SORTABLE_COLUMNS, type SortRefusal } from '../repos/valuations.js';

/**
 * What `?sort=` says when it refuses.
 *
 * `parseSort` has three ways to fail — too many terms, a column that is not
 * sortable, and a direction that is not a direction (a stray comma reaches the
 * second of those as an empty column) — and returned `null` for all of them.
 * Both call sites turned that
 * into `problems.badRequest('Invalid sort')`, which is the exact shape R180
 * spent a round removing from the schema rejections: a category noun, with the
 * fact that would let the caller fix it left on the floor. It survived because
 * it is a hand-rolled parse rather than a zod one, so `invalidQuery` — which
 * needs a `ZodError` — could not be pointed at it, and the census that bans
 * the old idiom is written over `problems.*(…, { errors: …issues })`.
 *
 * The sortable columns are listed rather than described. There are eight of
 * them, the caller is holding a string they composed, and "sort by one of
 * these" is the whole answer; a message that said "an unknown column" and
 * stopped would leave them guessing at spelling.
 */
const COLUMN_LIST = SORTABLE_COLUMNS.join(', ');

export function sortDetail(refusal: SortRefusal): string {
  switch (refusal.reason) {
    case 'too_many':
      return (
        `sort names ${refusal.count} terms; at most ${MAX_SORT_TERMS} are accepted. ` +
        `Repeating a column changes nothing after the first, so drop the duplicates.`
      );
    case 'unknown_column':
      return (
        `sort: “${refusal.column}” is not a sortable column. ` +
        `Sort by one of: ${COLUMN_LIST} — each optionally followed by “:asc” or “:desc”.`
      );
    case 'bad_direction':
      return (
        `sort: “${refusal.term}” — the direction after “:” must be asc or desc, ` +
        `not “${refusal.direction}”.`
      );
  }
}

/**
 * A malformed `?sort=`, as the 400 both list endpoints answer with.
 *
 * 400 rather than 422 for the reason `invalidQuery` is: a query string that
 * does not parse is a malformed request, and there is no entity to be
 * unprocessable about. The subject is kept out front so the message says which
 * of the three schemas a route validates against — path, query, body — the
 * caller should go and look at.
 */
export function invalidSort(refusal: SortRefusal): ApiProblem {
  return problems.badRequest(`Invalid sort — ${sortDetail(refusal)}`);
}
