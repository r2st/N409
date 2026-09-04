import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { assignableUser } from '../repos/users.js';

/**
 * The one refusal behind every door that hands somebody work.
 *
 * Three routes set who is expected to act on something — `POST
 * /workflow/reassign`, the bulk `assign_reviewer`, `PATCH /valuations/:id`'s
 * `assigned_reviewer_id` — and a fourth sets the assignee of a review task.
 * All four asked `userExists`, which is a question about whether a row is
 * there, and none of them asked the question the *readers* of that column ask:
 * see {@link assignableUser} for what the two halves disagreeing costs.
 *
 * Here rather than at the four call sites, and for the reason this codebase
 * keeps writing down: two of them had already drifted into two spellings of
 * the same sentence, and a rule with four copies is a rule three of them will
 * stop matching.
 *
 * `Unknown …` is kept verbatim for the missing case — it is the sentence
 * clients and tests already have, and it is still the right one. The inactive
 * case is new, and separate, because the reader needs to know the id was right
 * and the account is not: told "Unknown reviewer" about a colleague whose
 * account was closed this morning, they will go and check the id.
 */
export async function assertAssignable(
  pool: pg.Pool,
  id: string,
  noun: 'reviewer' | 'assignee',
  field: string,
): Promise<void> {
  const errors = [{ path: [field] }];
  if (!isUlid(id)) throw problems.unprocessable(`Unknown ${noun}`, { errors });
  switch (await assignableUser(pool, id)) {
    case 'ok':
      return;
    case 'missing':
      throw problems.unprocessable(`Unknown ${noun}`, { errors });
    case 'inactive':
      throw problems.unprocessable(
        `That account is deactivated or suspended, so it cannot be assigned as the ${noun} — ` +
          'nothing about the engagement would reach them. Pick someone else, or have an ' +
          'administrator restore the account first.',
        { errors },
      );
  }
}

/**
 * The `?assignee=` filter on a work queue: `me`, or somebody's user id.
 *
 * `GET /tasks` and `GET /reviews` both spelled it `z.string().optional()` with
 * `// 'me' or a user id` beside it, and the comment was the whole of the rule.
 * What the value reaches is `t.assignee_id = $1` against a `ulid` column, and
 * an `=` on a domain over text does not apply the domain's CHECK to the
 * parameter — so a malformed id is not an error at any layer. It simply
 * matches nothing.
 *
 * That is the failure worth naming (R419, methodology M19): these two are the
 * ops work queues, and "no rows" is a *meaningful* answer on them — it is what
 * "this reviewer has nothing outstanding" looks like. A truncated id pasted
 * out of a spreadsheet, a stale link, `?assignee=Me`, a user id where an email
 * was meant: every one of them answers "nothing assigned to them" about a
 * person who may have a full queue, and nothing anywhere says the filter did
 * not apply.
 *
 * One schema rather than two spellings, for the reason {@link assertAssignable}
 * gives one paragraph up: the two call sites had already drifted into two
 * copies of the same comment.
 */
export const ASSIGNEE_FILTER_MESSAGE = 'must be "me" or a 26-character Crockford-base32 ULID user id';

export const assigneeFilter = (): z.ZodEffects<z.ZodString, string, string> =>
  z.string().refine((value) => value === 'me' || isUlid(value), { message: ASSIGNEE_FILTER_MESSAGE });
