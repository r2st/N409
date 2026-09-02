import type pg from 'pg';
import { recordEvents, type EventActor } from '../events/record.js';
import { EVENT_TYPES } from '../domain/valuation.js';
import { PIPELINE_EVENT_TYPES } from '../domain/pipeline.js';
import { invalidateValuation } from './valuations.js';

/**
 * What a closure handed back, so the caller can put it on the trail.
 *
 * Ids rather than counts, for the reason `upsertResolution` returns its
 * discarded sign-off ids: "three engagements were released" cannot be joined to
 * anything, and the whole point of recording it is that somebody has to pick
 * the work up.
 */
export interface ReleasedWork {
  /** Live engagements this account was the assigned reviewer of. */
  valuations: string[];
  /** Unfinished review tasks it was the assignee of. */
  reviewTasks: string[];
}

/** Nothing was held. Returned by the doors that decline to act. */
export const NOTHING_RELEASED: ReleasedWork = { valuations: [], reviewTasks: [] };

/**
 * Take the unfinished work off a closed account's name.
 *
 * THE RULE THAT WAS MISSING FROM EVERY DOOR THAT CLOSES AN ACCOUNT (round 336,
 * methodology M3). R334 made an assignment to a closed account impossible to
 * *create* — `assignableUser` behind all four doors that hand somebody work —
 * on the grounds that the write succeeds while every consumer downstream
 * silently drops the assignee: `resolveRecipients` in the state-change hook,
 * the auditor-note fan-out, the monitoring sweep's reviewer alert. It closed
 * the door that reaches that state from the assignment side. Nothing closed the
 * doors that reach the identical state from the other side, and those are the
 * ordinary ones: an analyst leaves the firm, somebody closes the account, and
 * every engagement and task already on their name stays on it.
 *
 * The attention queue is what makes it invisible rather than merely wrong.
 * `domain/firmDashboard.ts` flags an engagement in review or drafting with
 * nobody's name on it — "the failure mode a firm cannot see from any single
 * valuation's own page" — by asking whether `assigned_reviewer_id` is null. A
 * released engagement is flagged; one still naming a closed account is not,
 * because the column is populated. So the one surface built to catch unowned
 * work is the surface that certifies this work as owned, while the reviewer
 * workload panel goes on counting the file against somebody who cannot sign in.
 *
 * HERE RATHER THAN AT THE THREE DOORS. `softDeleteUser` is the console's and
 * the self-service one; `setUserActive(false)` is the directory's, and it is
 * the *automated* one — an HR system deprovisioning a departing employee is
 * precisely the scenario above. A rule with three copies is a rule two of them
 * will stop matching, which is the note `domain/assignee.ts` carries about the
 * assignment side of the same question.
 *
 * Takes a client rather than a pool: every caller has a transaction that is
 * already writing the closure, and a release committed separately is one a
 * crash between the two can skip — leaving the roles taken and the file still
 * on the departed analyst's name.
 *
 * WHAT IS DELIBERATELY LEFT ALONE. Published engagements keep their reviewer —
 * that is a record of who reviewed the thing, not a claim about who is going to
 * — and so do archived ones, which are out of the product entirely. Finished
 * tasks (`done`, `cancelled`) keep their assignee for the same reason. What is
 * released is exactly the work somebody still has to do.
 *
 * `engagements.assigned_analyst_id` is left alone too, and that one is a
 * decision rather than an omission: `analystChaseBlock` already names `closed`
 * as one of its four causes and the overdue sweep reports it as `unreachable`
 * with the reason attached, so that surface says out loud what this one could
 * not. Nulling it would replace a named alert with an unassigned engagement
 * nothing chases and nothing reports.
 *
 * `version` moves on every engagement released, per
 * `lockCounterDiscipline.test.ts`: `assigned_reviewer_id` is in
 * `OPS_PATCH_FIELDS`, so an operator holding the workflow form is holding a
 * reviewer this statement changed, and without the bump their `If-Match` would
 * be told nobody had touched it. The caller drops the cached rows after its
 * commit — see {@link invalidateReleased}.
 *
 * Idempotent by construction, which the directory door needs: an IdP re-asserts
 * `active: false` for everybody on every resync pass, and a second pass finds
 * nothing to release and therefore writes no second event.
 */
export async function releaseAssignedWork(
  client: pg.PoolClient,
  userId: string,
  actor: EventActor,
  reason: 'account_closed',
): Promise<ReleasedWork> {
  const { rows: valuations } = await client.query<{ id: string }>(
    `UPDATE valuations
        SET assigned_reviewer_id = NULL,
            version = version + 1
      WHERE assigned_reviewer_id = $1
        AND archived_at IS NULL
        AND state <> 'published'
      RETURNING id`,
    [userId],
  );
  // The shape `patchValuation` writes for the same column, so the change log
  // and the evidence bundle read it as the reassignment it is rather than as
  // an event with no descriptor — see `extractChanges`.
  //
  // One statement rather than one per engagement (round 351, methodology M8).
  // This runs inside the transaction that closes the account, and the UPDATE
  // above holds a row lock on every engagement it touched until the COMMIT — so
  // a serial insert per row held all of them for the length of the batch. See
  // `recordEvents`.
  await recordEvents(
    client,
    valuations.map((row) => ({
      valuationId: row.id,
      type: EVENT_TYPES.updated,
      actor,
      payload: { changes: { assigned_reviewer_id: { from: userId, to: null } }, reason },
    })),
  );

  const { rows: tasks } = await client.query<{ id: string; valuation_id: string }>(
    `UPDATE review_tasks
        SET assignee_id = NULL,
            updated_at = now()
      WHERE assignee_id = $1
        AND status IN ('open', 'in_progress', 'blocked')
      RETURNING id, valuation_id`,
    [userId],
  );
  await recordEvents(
    client,
    tasks.map((row) => ({
      valuationId: row.valuation_id,
      type: PIPELINE_EVENT_TYPES.taskUpdated,
      actor,
      payload: { task_id: row.id, changes: { assignee_id: { from: userId, to: null } }, reason },
    })),
  );

  return { valuations: valuations.map((r) => r.id), reviewTasks: tasks.map((r) => r.id) };
}

/**
 * Drop the cached rows a release moved, after the COMMIT and not inside it —
 * see `invalidateValuationAfter`. `findValuationById` is a read-through cache
 * and it is only correct because every writer of the table does this.
 */
export function invalidateReleased(released: ReleasedWork | null): void {
  for (const valuationId of released?.valuations ?? []) invalidateValuation(valuationId);
}
