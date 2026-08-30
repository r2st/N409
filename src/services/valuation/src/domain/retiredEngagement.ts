import type pg from 'pg';
import { problems } from '@n409/shared';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';

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
 * THESE REFUSALS WERE PERMANENT WHEN THEY WERE WRITTEN, and R89 said so:
 * nothing set `valuations.archived_at` back to NULL, while partners had such a
 * path (`adminUsers.ts`) and users had `restoreUser`. It also said where an
 * unarchive would belong if one were ever wanted — beside `retireValuations`,
 * as a deliberate ops action rather than as a side effect of a PATCH that
 * happened not to be guarded. That is exactly where R90 put it:
 * `restoreValuations`, reached by `POST
 * /api/v1/admin/retention/valuations/:id/restore` and admin-only.
 *
 * Which changes the standing of these guards rather than their behaviour. They
 * still refuse; what a refusal now means is "an admin has to decide", not "this
 * work is gone". Worth knowing before writing a message that tells a caller
 * their engagement is unrecoverable — it is not.
 */
export function refuseIfRetired(valuation: Pick<ValuationRow, 'archived_at'>, doing: string): void {
  if (valuation.archived_at === null) return;
  throw problems.conflict(`This engagement has been retired and is no longer ${doing}.`);
}

/**
 * The same refusal, asked again immediately before a write that is minutes
 * younger than the request that started it.
 *
 * `refuseIfRetired` above reads the engagement the route loaded, which is the
 * right reading for a route whose write follows in the same millisecond. It is
 * the wrong one for the handful that call the AI service in between: that call
 * has a three-minute budget (`AI_PIPELINE_TIMEOUT_MS`), and a run is exactly
 * the length of time in which a decision about a file gets made. Somebody
 * withdrawing the engagement inside that window is the ordinary case, not the
 * exotic one.
 *
 * R232 closed this on the extraction auto-apply and R236 on the queued
 * auto-pipeline run; both re-read the engagement immediately before the write
 * rather than trusting the copy the request came in with. The two AI routes
 * that write something of their own were left on the old reading, so a
 * retirement landing mid-run still produced a report version drafted into a
 * withdrawn deliverable and a QA review filed against withdrawn work — under an
 * `ai` actor, with nothing on either row recording that the file had been
 * closed before they were written. Retirement is reversible since R90, so
 * those rows do not go away with the engagement: they come back with it.
 *
 * Refused rather than skipped, unlike the auto-apply. There the job was
 * correctly recorded and the write was incidental to it; here the write *is*
 * the request, and a 200 over a version nobody saved would be the same
 * discarded failure this codebase keeps finding. A vanished engagement is a
 * 404 for the reason it always is — the id no longer names anything.
 */
export async function refuseIfRetiredNow(pool: pg.Pool, valuationId: string, doing: string): Promise<void> {
  const live = await findValuationById(pool, valuationId);
  if (!live) throw problems.notFound();
  refuseIfRetired(live, doing);
}
