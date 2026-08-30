import type pg from 'pg';
import { problems } from '@n409/shared';
import { VALUATION_STATES, stateLabel, type ValuationState } from './valuation.js';
import { canTransition } from './workflow.js';

/**
 * The lifecycle legality check, for the paths that let a caller name the state
 * to move to.
 *
 * `WORKFLOW_TRANSITIONS` has described the legal edges since M4, and until now
 * exactly one caller consulted it: the `set_state` arm of the bulk executor.
 * The single-engagement door — `PATCH /valuations/:id` with a `state` — never
 * did. `state` has been in `OPS_PATCH_FIELDS` since M0 carrying the comment
 * "guarded transitions arrive in M1 (#5)", and they did not arrive; the field
 * validated only against the enum, so any of the fifteen states could be
 * written over any other in one request.
 *
 * What that allows is not exotic. `pending → published` skips onboarding, the
 * client's own inputs, payment, review, QA and drafting, and lands an
 * engagement in the one state the table gives no way out of — the publish gate
 * still demands a signature, so it is not a *silent* publish, but everything
 * between `pending` and the gate is gone and the audit spine records a single
 * `state_changed` from a state nine steps back. `published → started` is the
 * same door in reverse: the table deliberately leaves `published` with no
 * outgoing edges and `canRestart` refuses a restart out of it, and both of
 * those are enforced only on routes a PATCH goes around.
 *
 * The dashboard is why the damage outlives the request. Named buckets, the SLA
 * counts, the review queue, the publish-throughput chart and the auto email
 * workflows are all keyed on `state`, and each assumes the sequence it was
 * built to describe. A file that arrives in `review` without passing
 * `completed` sits in the review queue with no `completed_at`, and the ageing
 * figures beside it are computed from a timestamp nothing ever set.
 *
 * Deliberately not applied to the two routes that bypass the table by design:
 * `workflow/restart` lands on `started` from wherever the file is, which is
 * illegal from most states and is the whole point of a restart, and
 * `workflow/advance` reads its target out of `AUTO_ADVANCE`, every entry of
 * which is already an edge in the table.
 */
export function assertTransition(from: ValuationState, to: ValuationState): void {
  // A write that does not move the state is not a transition and has no edge to
  // find in the table. `patchValuation` drops it from the diff anyway; checking
  // it here would refuse `{ state: 'published' }` on a published engagement,
  // which is a no-op PATCH rather than an attempt to leave a terminal state.
  if (from === to) return;
  if (!canTransition(from, to)) {
    throw problems.conflict(
      `This valuation cannot move from “${stateLabel(from)}” to “${stateLabel(to)}”. ` +
        `From “${stateLabel(from)}” it can go to: ${legalStatesFrom(from)}.`,
    );
  }
}

/**
 * The same check as a precondition of the write, rather than as a question
 * asked beforehand.
 *
 * The same reason `assertPublishGateForWrite` exists next door. A check against
 * the row the route loaded is a check against a reading another connection is
 * free to invalidate before the UPDATE lands: two operators acting on one
 * engagement both read `drafted`, both judge their own transition legal, and
 * the second write is applied to a row that is no longer where it was judged
 * from. `PATCH`'s `If-Match` would catch that, but it is opt-in and most
 * clients send nothing.
 *
 * Run as `patchValuation`'s `preCommit`, this takes the row lock on the client
 * about to issue the UPDATE, so the state the transition is judged against is
 * the state being transitioned from. `FOR UPDATE` is the right lock here,
 * unlike the publish gate's advisory one: the fact being protected is the row's
 * own `state` column, and every writer of it goes through `patchValuation`'s
 * transaction.
 */
export function assertTransitionForWrite(
  valuationId: string,
  to: ValuationState,
): (client: pg.PoolClient) => Promise<void> {
  return async (client) => {
    const { rows } = await client.query<{ state: ValuationState }>(
      'SELECT state FROM valuations WHERE id = $1 FOR UPDATE',
      [valuationId],
    );
    const live = rows[0]?.state;
    // A row that has vanished under the route that loaded and authorized it is
    // not this guard's failure to report — the UPDATE below raises the conflict
    // the caller's version check exists for.
    if (!live) return;
    /*
     * Somebody else already made this move.
     *
     * `assertTransition` reads `from === to` as a no-op and lets it through,
     * which is right for the question it is asked before the write — a PATCH
     * naming the state the caller can see is not an attempt to leave it, and
     * `patchValuation` drops it from the diff before a transaction is opened.
     * It is the wrong answer here. This guard only runs once the diff is
     * non-empty, so the caller read some *other* state: `live === to` means the
     * transition it is about to write has already been written by someone else,
     * between its read and this lock.
     *
     * Letting it through wrote the move a second time — a duplicate
     * `state_changed` naming a `from` the row had already left, a second
     * `onStateChanged`, and the client emailed twice for one move. The version
     * guard on the write refuses this too and refuses it a moment later; this
     * says which of the two things went wrong, since "already at `review`" and
     * "somebody changed something" send an operator to different places.
     */
    if (live === to) {
      throw problems.conflict(
        `This valuation is already “${stateLabel(to)}” — someone else made that change while you ` +
          'were working. Reload it before deciding what to do next.',
      );
    }
    assertTransition(live, to);
  };
}

/** The table's outgoing edges as prose, for the refusal message above. */
function legalStatesFrom(from: ValuationState): string {
  // Read through `canTransition` rather than off the table, so there is one
  // definition of "legal" and the message cannot disagree with the refusal.
  const legal = VALUATION_STATES.filter((s) => canTransition(from, s));
  return legal.length > 0
    ? legal.map((s) => `“${stateLabel(s)}”`).join(', ')
    : 'nowhere — this is a final state';
}
