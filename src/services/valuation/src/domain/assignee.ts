import type pg from 'pg';
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
