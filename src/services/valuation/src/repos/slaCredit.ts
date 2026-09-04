import type pg from 'pg';
import { STATE_GROUPS } from '../domain/operations.js';
import type { ValuationState } from '../domain/valuation.js';

/**
 * The SLA clocks a *closure* ran through, credited back when the file reopens.
 *
 * THE OTHER HALF OF THE PAIR THIS ESTATE KEEPS FINDING ONE OF (round 432,
 * methodology M3). `creditEngagementsForRetirement` and
 * `creditTasksForRetirement` (repos/valuationPurge.ts) state the argument in
 * full for retirement: "Retirement stops none of them — it moves `archived_at`
 * and nothing else, which is the same fact that produced the 'board and sweep
 * drop retired engagements' filter: the readers are filtered, the clock is not."
 *
 * Closure is the reachable twin. `cancelled`, `timeout` and `ignored` are the
 * three terminal states of `WORKFLOW_TRANSITIONS` — how work actually stops,
 * the week a client goes quiet — and R400 gave the pipeline board and the
 * overdue sweep the same filter for them that R363 had given retirement
 * (`ACTIVE_ENGAGEMENT_WHERE`), for the same reasons and in the same words. The
 * clock repair was never given the twin. Closing a valuation moves `state` and
 * nothing else: not `engagements.stage_entered_at`, not `review_tasks.due_at`.
 *
 * So an engagement cancelled two days into a 72-hour `analysis` stage and
 * restarted ninety days later came back ninety-two days into it — red on the
 * board, first in the overdue tab, chased by the sweep on its next tick, and
 * counted as a ninety-day SLA breach by `stageDurations` forever after. No work
 * was owed for any of those hours: R89 refuses every write to a closed file,
 * the board did not show it and the sweep did not chase it, which is exactly
 * what hides the clock running underneath.
 *
 * Restart is not the only door — `canRestart` refuses only `published` and
 * `started`, and a direct `PATCH /valuations/:id {state}` moves the same row —
 * so this hangs off `patchValuation`, which is the one statement in the service
 * that writes `state` (see `stateTransitionGuards.test.ts`), inside the same
 * transaction as the transition itself.
 */

const CLOSED_STATES: ReadonlySet<string> = new Set(STATE_GROUPS.closed);

export interface ReopenSlaCredit {
  /** The stage whose clock was moved, or null when only tasks were. */
  stage: string | null;
  /** How many open tasks had their due date moved. */
  tasks: number;
  /** The span credited back, in seconds — the length of the closure. */
  creditedSeconds: number;
}

/** True for a transition that takes a file back out of a terminal state. */
export function isReopening(from: ValuationState, to: ValuationState): boolean {
  return CLOSED_STATES.has(from) && !CLOSED_STATES.has(to);
}

/**
 * When this valuation was called off, from the spine.
 *
 * There is no `cancelled_at` column — `TIMESTAMP_ON_STATE` stamps the forward
 * states only — so the closure's own `state_changed` event is the record of
 * when it happened, which is the same row `firstEntryPerState` reads for the
 * progress stepper. Read by `seq` rather than by `occurred_at`: the sequence is
 * the spine's own order and a hand-written `occurred_at` cannot reorder it.
 *
 * The newest one has to name the state the file is *in* — otherwise the spine
 * and the row disagree, which is not something to guess at — and a file with no
 * `state_changed` at all (state written before the event existed, or by hand)
 * is answered `null`. Both mean "the length of the closure is unknown", and an
 * unknown span credits nothing rather than a made-up one.
 */
async function closureInstant(
  client: pg.PoolClient,
  valuationId: string,
  closedState: ValuationState,
): Promise<Date | null> {
  const { rows } = await client.query<{ occurred_at: Date; to_state: string | null }>(
    `SELECT occurred_at, payload->>'to' AS to_state
       FROM valuation_events
      WHERE valuation_id = $1 AND type = 'state_changed'
      ORDER BY seq DESC
      LIMIT 1`,
    [valuationId],
  );
  const latest = rows[0];
  if (!latest || latest.to_state !== closedState) return null;
  return latest.occurred_at;
}

/**
 * Move both clocks forward by the length of the closure.
 *
 * The same shift, the same guards and the same reasoning as the retirement
 * pair, one column over on each table:
 *
 *   * `stage_entered_at < closedAt` — a stage entered *after* the file was
 *     called off has not been waiting through the closure, and a repair meant
 *     to be neutral must not push it into the future.
 *   * Tasks are moved only where the `overdue` predicate can reach them. A
 *     `done` or `cancelled` task's clock already stopped, and rewriting its due
 *     date would falsify a closed record to tidy a number nothing reads.
 *
 * The stage trail is deliberately left alone: `engagement_stage_history` records
 * when the stage was entered, and rewriting it to make a derived duration agree
 * would falsify an append-only record. The repair is to the clock, not to the
 * history — which is why the caller puts the credit on the spine.
 *
 * An engagement both closed and retired is credited here and then, on restore,
 * measured against `archived_at` by the retirement repair's own
 * `stage_entered_at < was_archived_at` guard — which this shift will usually
 * have carried it past, so the same hours are not credited twice.
 */
export async function creditClocksForReopen(
  client: pg.PoolClient,
  valuationId: string,
  closedState: ValuationState,
): Promise<ReopenSlaCredit | null> {
  const closedAt = await closureInstant(client, valuationId, closedState);
  if (closedAt === null) return null;

  const { rows: staged } = await client.query<{ stage: string; credited_seconds: number }>(
    `UPDATE engagements
        SET stage_entered_at = stage_entered_at + (now() - $2::timestamptz),
            updated_at = now()
      WHERE valuation_id = $1 AND stage_entered_at < $2::timestamptz
      RETURNING current_stage AS stage,
                round(extract(epoch FROM (now() - $2::timestamptz)))::int AS credited_seconds`,
    [valuationId, closedAt],
  );
  const { rows: tasks } = await client.query<{ credited_seconds: number }>(
    `UPDATE review_tasks
        SET due_at = due_at + (now() - $2::timestamptz),
            updated_at = now()
      WHERE valuation_id = $1
        AND due_at IS NOT NULL
        AND status IN ('open','in_progress','blocked')
        AND created_at < $2::timestamptz
      RETURNING round(extract(epoch FROM (now() - $2::timestamptz)))::int AS credited_seconds`,
    [valuationId, closedAt],
  );

  const creditedSeconds = staged[0]?.credited_seconds ?? tasks[0]?.credited_seconds ?? 0;
  // Nothing was owed — every clock on this file started after it was called
  // off. An empty answer rather than a zero credit, so the event payload says
  // nothing rather than saying "0 seconds were credited to no stage".
  if (staged.length === 0 && tasks.length === 0) return null;
  return { stage: staged[0]?.stage ?? null, tasks: tasks.length, creditedSeconds };
}
