import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { patchValuation, type ValuationRow } from '../repos/valuations.js';
import { onStateChanged, type EmailTransport, type TransitionRenderDeps } from '../hooks/stateChange.js';
import { assertPublishGate, assertPublishGateForWrite } from './publishGate.js';
import type { EventActor } from '../events/record.js';
import type { ValuationState } from './valuation.js';

/**
 * Move one valuation to one state: gate, write, and fire the side effects.
 *
 * Lifted out of `registerWorkflowRoutes`, where it was a closure over `deps`
 * and `app.log`, when the partner API needed to make the same move. Copying it
 * would have been three lines of duplication and one real risk: the publish
 * gate is checked twice on purpose — once against the row that was read and
 * again as a precondition of the write, because the first is a question about a
 * reading another connection is free to invalidate — and a second copy is
 * exactly where one of the two halves goes missing.
 *
 * `onStateChanged` is not optional decoration either. It is what sends the
 * client their email and what advances the automated pipeline, so a transition
 * written without it is a state change the rest of the system never learns
 * about.
 *
 * The write is conditional on the row still being at the version it was read
 * at, always, for every caller.
 *
 * It used to be an opt-in the bulk executor turned on and the single-engagement
 * routes left off, on the reasoning that a caller which loads a valuation and
 * writes it in the next statement is judging the transition against the state it
 * is transitioning from. That reasoning holds for one request at a time and for
 * nothing else, and this is a *derived* transition — `advance` reads its target
 * out of `AUTO_ADVANCE`, `restart` out of `RESTART_STATE`, a review decision out
 * of `decisionTarget`, all keyed on the state that was read. Two holders of one
 * read are the ordinary case: a double-clicked button, a retried request, two
 * operators on the same worklist row.
 *
 * Both things that then went wrong are silent. Two callers who both read
 * `completed` both write `review`: the row lands where it should, and the spine
 * records the transition twice, `onStateChanged` runs twice, and the client is
 * emailed twice for one move. And a caller whose read has since been overtaken
 * writes its target over a row that is further on — `completed → review` applied
 * to a file already at `reviewed` walks it *backwards*, recorded as a transition
 * out of a state it left two moves ago.
 *
 * `patchValuation` bumps `version` on every write, so a row that moved fails
 * this write with the 409 the second caller should have had. Nothing else writes
 * `state`; see `stateTransitionGuards.test.ts`.
 */
export interface ApplyStateDeps extends TransitionRenderDeps {
  pool: pg.Pool;
  transport?: EmailTransport;
  log: FastifyBaseLogger;
}

export async function applyValuationState(
  deps: ApplyStateDeps,
  valuation: ValuationRow,
  to: ValuationState,
  actor: EventActor,
): Promise<ValuationRow> {
  await assertPublishGate(deps.pool, valuation.id, to);
  const updated = await patchValuation(deps.pool, valuation, { state: to }, actor, {
    expectedVersion: valuation.version,
    preCommit: assertPublishGateForWrite(valuation.id, to),
  });
  await onStateChanged(
    {
      pool: deps.pool,
      transport: deps.transport,
      log: deps.log,
      publicBaseUrl: deps.publicBaseUrl,
      settings: deps.settings,
    },
    updated,
    to,
  );
  return updated;
}
