import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { patchValuation, type ValuationRow } from '../repos/valuations.js';
import { onStateChanged, type EmailTransport } from '../hooks/stateChange.js';
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
 * `guardVersion` makes the write conditional on the row still being at the
 * version it was read at. A caller that loads a valuation and writes it in the
 * next statement does not need it — the state the transition was judged against
 * is the state being transitioned from. A caller that batched its reads does;
 * see the bulk executor in routes/workflow.ts.
 */
export interface ApplyStateDeps {
  pool: pg.Pool;
  transport?: EmailTransport;
  log: FastifyBaseLogger;
}

export async function applyValuationState(
  deps: ApplyStateDeps,
  valuation: ValuationRow,
  to: ValuationState,
  actor: EventActor,
  guardVersion = false,
): Promise<ValuationRow> {
  await assertPublishGate(deps.pool, valuation.id, to);
  const updated = await patchValuation(deps.pool, valuation, { state: to }, actor, {
    ...(guardVersion ? { expectedVersion: valuation.version } : {}),
    preCommit: assertPublishGateForWrite(valuation.id, to),
  });
  await onStateChanged({ pool: deps.pool, transport: deps.transport, log: deps.log }, updated, to);
  return updated;
}
