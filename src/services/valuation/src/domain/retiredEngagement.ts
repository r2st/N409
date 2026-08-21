import { problems } from '@n409/shared';
import type { ValuationRow } from '../repos/valuations.js';

/**
 * A write aimed at a retired engagement.
 *
 * THE SHAPE OF THIS BUG, which is four rounds old and keeps producing new
 * instances. Valuations are never hard-deleted — `valuation_events` has a
 * BEFORE DELETE trigger — so the soft delete is `valuations.archived_at`,
 * stamped by the retention sweep when a policy period runs out and by
 * `retireValuations` when a firm withdraws a piece of work.
 *
 * Only `buildValuationWhere` applies that filter. R55 and R56 swept every repo
 * that built its own WHERE and put retired engagements out of the lists, the
 * counts, the dashboards and the drip campaigns. R57 then found the residue and
 * named the lesson: **a list that stops offering something is not a write that
 * refuses it**, because the page stays reachable by id. It fixed one instance —
 * `POST /valuations/:id/payments/checkout` ran through to a live Stripe Session
 * — and left the general question open.
 *
 * R89 asked it of every mutating valuation-scoped route by driving each one
 * twice, against a live engagement and an archived twin, and found ten more.
 * The severity is not uniform, which is why they are worth naming:
 *
 *   * `POST /remind-documents` **sent mail** — "we still need your cap table",
 *     to the client, about work the firm has withdrawn. Mail cannot be
 *     un-sent, which is what made the same class of leak the worst of R56.
 *   * `POST /report/render` and `/report/draft` produced the deliverable
 *     itself for a withdrawn engagement.
 *   * `POST /workflow/advance` and `/engagement/advance` moved a retired file
 *     through the pipeline, with everything that hangs off a state change.
 *   * `POST /clone` started *new* work from a retired file, and `PATCH
 *     /valuations/:id`, `PATCH /engine-inputs`, `PUT /questionnaire` and
 *     `POST /evidence-bundle` edited or produced from one.
 *
 * WHY A HELPER RATHER THAN THE THREE LINES, ten times. The three lines are not
 * the risk; the message and the status are. Two sites had already written this
 * check by hand and disagreed about both, which is the beginning of a rule
 * nobody can state — and a caller weighing whether to add it is much more
 * likely to when there is something to call.
 *
 * WHY WRITES ONLY. Reads stay open deliberately, and that predates this: the
 * auditor portal and the board flow both refuse to *mint* and to *act* while
 * still serving what a holder was already given. A firm that has withdrawn work
 * still has to be able to look at it, and so does the auditor who was sent it.
 * What stops is anything that changes the file, produces a new artifact from
 * it, or tells somebody about it.
 *
 * 409 rather than 404: the caller is looking at a real engagement they are
 * entitled to see, and the reason the write is refused is its state. A 404
 * would say the id is wrong, which sends whoever hit it looking for the wrong
 * problem.
 *
 * NOTE THAT THESE REFUSALS ARE PERMANENT. Nothing sets `valuations.archived_at`
 * back to NULL — partners have such a path (`adminUsers.ts`) and users have
 * `restoreUser`, but valuations have neither, so archiving is already one-way
 * and was before any of this. That is worth knowing rather than worth fixing
 * here: an engagement archived by mistake was *already* unreachable from every
 * list, count, dashboard and campaign, so what these guards change is not
 * whether it is recoverable but whether the platform is honest about it. If an
 * unarchive is ever wanted, it belongs beside `retireValuations` as a
 * deliberate ops action, not as a side effect of a PATCH that happened not to
 * be guarded.
 */
export function refuseIfRetired(valuation: Pick<ValuationRow, 'archived_at'>, doing: string): void {
  if (valuation.archived_at === null) return;
  throw problems.conflict(`This engagement has been retired and is no longer ${doing}.`);
}
