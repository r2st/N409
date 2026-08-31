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

/**
 * The same refusal, for a subject addressed by its own id rather than by its
 * engagement's.
 *
 * WHY THIS SHAPE ESCAPES THE SWEEP. R89 asked the retirement question of every
 * mutating route "under a valuation id", and `retiredEngagementWrites.test.ts`
 * still drives exactly that set out of the route table — so a route added
 * tomorrow under `/api/v1/valuations/:id/…` is swept the day it is registered.
 * Nothing swept the routes addressed by the subject's own id, and the census
 * structurally could not: the request does not mention the engagement, so the
 * engagement is reached by a second read that only the handler knows to make.
 *
 * R279 found the first surface — a fund portfolio and a debt instrument, which
 * migrations 0086/0087 built as standalone ops tools keyed to nothing and 0110
 * gave an engagement link afterwards. Neither route file contained a single
 * retirement check: on a withdrawn `fund` engagement ops could still add a
 * holding, edit one, record a new fair-value mark, roll a mark forward, or
 * rewrite the LP waterfall terms — and on a withdrawn `debt` one, re-price the
 * instrument and store the result.
 *
 * A mark is not a note in the margin. `domain/navExhibits.ts` renders the NAV
 * schedule by summing the *stored* marks at render time — deliberately, so that
 * re-rendering an opinion cannot silently restate it at today's prices — which
 * means a mark written after retirement changes the NAV of a report the firm
 * has already issued, and retirement is reversible (R90), so it is still there
 * when the engagement is restored. `POST /positions/:pid/marks` and `POST
 * /instruments/:id/value` also spend an engine call each on work nobody is
 * doing.
 *
 * R282 asked whether the measurement surface was the only one of its shape and
 * found it was not, which is why this is no longer named after it. Two more
 * writes reach an engagement's file without naming it in the path, and both
 * had the guard on the create and not on the edit — the create is under a
 * valuation id, so R89 swept it and stopped exactly where the sweep's reach
 * did:
 *
 *   * `PATCH /api/v1/tasks/:id` — `POST /valuations/:id/tasks` refuses to open
 *     a task on withdrawn work, and this then let the same task be retitled,
 *     reassigned, given a new due date or moved to done, writing a
 *     `review_task_updated` onto the spine of a file the firm has closed.
 *   * `PATCH /api/v1/comments/:commentId` — same pair, same gap, over the
 *     thread the client and the reviewer are reading.
 *
 * Reads stay open, as everywhere else: the NAV rollup, the waterfall and the
 * calibration calculators persist nothing, and a firm that has withdrawn work
 * still has to be able to look at it. The DELETEs stay open too, by the
 * exemption the board flow made before there was a rule — cleaning up rows on a
 * withdrawn file is the one thing that should still work, and it is what the
 * "detach it from the engagement before deleting" refusal on `DELETE /funds/:id`
 * assumes is available.
 *
 * A link that reads back no valuation is not a retired engagement and is not
 * refused: 0110 chose `ON DELETE SET NULL` precisely so a deleted engagement
 * clears the link rather than leaving a dangling one, so this is a row that
 * went away between the two reads. Subjects whose link is NOT NULL never take
 * that branch.
 */
export async function refuseIfSubjectRetired(
  pool: pg.Pool,
  subject: { valuation_id: string | null },
  doing: string,
): Promise<void> {
  if (subject.valuation_id === null) return;
  const valuation = await findValuationById(pool, subject.valuation_id);
  if (!valuation) return;
  refuseIfRetired(valuation, doing);
}

/**
 * The same refusal, asked *inside* the transaction that does the write, with
 * the engagement row locked.
 *
 * WHY THE POOL VERSION ABOVE IS NOT ENOUGH. `refuseIfSubjectRetired` reads the
 * engagement on the pool and the route then opens a transaction and writes, so
 * the question and the answer are two statements with a gap between them. On
 * most of the measurement surface that gap is sub-millisecond and the exposure
 * is theoretical. On `POST /funds/:id/positions/:pid/marks` it was the whole
 * engine round trip: the guard ran, the route spent up to `timeoutMs` in
 * `/engine/v1/fund-valuation`, and only then wrote the mark. That is the exact
 * window `refuseIfRetiredNow` exists for — "a run is exactly the length of time
 * in which a decision about a file gets made" — and the two sibling routes that
 * also call the engine before writing (`POST /debt/instruments/:id/value`,
 * `POST /funds/:id/positions/:pid/rollforward`) both re-ask afterwards. The
 * mark route, the one whose figure the NAV schedule is a sum of, did not.
 *
 * Re-asking on the pool would only narrow the window. `FOR SHARE` closes it:
 * `retireValuations` archives with an UPDATE, which takes `FOR NO KEY UPDATE`
 * on the row, and that conflicts with `FOR SHARE`. So the two orders are the
 * only two orders. Either this transaction takes the lock first, the retirement
 * waits for the mark to commit, and the mark is genuinely a write that happened
 * before the withdrawal; or the retirement commits first, this read sees
 * `archived_at` set, and the write is refused. There is no interleaving in
 * which a mark lands on work the firm had already withdrawn.
 *
 * Read through the client and not through `findValuationById`, deliberately.
 * That reader is the 5s read-through cache from `repos/valuations.ts`, and a
 * cached row is a row nobody locked — the check would answer from a copy taken
 * before the transaction began, which is the failure this function exists to
 * remove rather than a smaller version of it.
 *
 * A link that reads back no valuation is not refused, for the reason the pool
 * version gives: 0110's `ON DELETE SET NULL` means a missing row is a deleted
 * engagement clearing its own link, not a retired one.
 */
export async function refuseIfSubjectRetiredIn(
  client: pg.PoolClient,
  subject: { valuation_id: string | null },
  doing: string,
): Promise<void> {
  if (subject.valuation_id === null) return;
  const { rows } = await client.query<{ archived_at: Date | null }>(
    'SELECT archived_at FROM valuations WHERE id = $1 FOR SHARE',
    [subject.valuation_id],
  );
  const live = rows[0];
  if (!live) return;
  refuseIfRetired(live, doing);
}

/**
 * Has this engagement been withdrawn *since* the row naming it was read?
 *
 * For the sweeps, which are the one shape the `archived_at IS NULL` predicate
 * in a reader's WHERE cannot protect. `eachActiveEngagement` applies that
 * filter when it reads a page — up to `ENGAGEMENT_PAGE_LIMIT` rows — and the
 * overdue sweep then walks that page sending one transactional email per
 * overdue row, awaiting the transport each time. The filter is therefore true
 * of the row when it was *selected* and says nothing about whether it is still
 * true when the mail goes out, which for a row late in a slow page is minutes
 * later.
 *
 * Which is the failure R89 named the worst of its set: "`POST
 * /remind-documents` **sent mail** — 'we still need your cap table', to the
 * client, about work the firm has withdrawn. Mail cannot be un-sent." Here it
 * is the assigned analyst being told to move forward a file that no longer
 * exists to move, and the sweep also writes an `engagement_overdue_reminder`
 * onto that engagement's spine, where `valuation_events_immutable` means it
 * cannot afterwards be taken back off.
 *
 * A boolean rather than a throw, because the caller is not a route: a sweep
 * that raised on the first withdrawn row would abandon every row behind it.
 * The caller skips and reports, which is the standing rule for a sweep that
 * declines to act on something — see `unreachable` beside it.
 *
 * Not `findValuationById`: that reader is a 5s read-through cache, and the
 * whole question here is whether the answer is current. A missing row counts as
 * withdrawn — a sweep should not mail about an engagement that has been deleted
 * out from under it either.
 */
export async function isRetiredNow(pool: pg.Pool, valuationId: string): Promise<boolean> {
  const { rows } = await pool.query<{ archived_at: Date | null }>(
    'SELECT archived_at FROM valuations WHERE id = $1',
    [valuationId],
  );
  const live = rows[0];
  return !live || live.archived_at !== null;
}
