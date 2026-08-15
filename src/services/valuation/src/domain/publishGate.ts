import type pg from 'pg';
import { problems } from '@n409/shared';
import type { Queryable } from '../db/pool.js';
import type { ValuationState } from './valuation.js';
import { hasMainSignature } from '../repos/signatures.js';
import { lockPublishGate } from '../repos/publishLock.js';
import { latestSucceededCalculation } from '../repos/calculations.js';
import { latestQaReviewForCalculation } from '../repos/qaReviews.js';

/**
 * Publish gating, called by every path that can set the state — the workflow
 * routes, bulk actions, review decisions, and the direct PATCH.
 *
 * 1. Signature (remaining-gaps §3 #3): no valuation enters 'published'
 *    without a Signature (main) on file.
 * 2. QA (IMPROVEMENTS_RESEARCH §4.3): when the valuation has a successful
 *    calculation, its LATEST calculation must carry a non-failing QA review.
 *    A recalculation invalidates the previous review by construction — the
 *    review is keyed to the calculation it examined.
 *
 * Runs on the pool or on a transaction's client. Both readings matter and they
 * are not the same reading — see {@link assertPublishGateForWrite}.
 */
export async function assertPublishGate(
  db: Queryable,
  valuationId: string,
  to: ValuationState,
): Promise<void> {
  if (to !== 'published') return;
  if (!(await hasMainSignature(db, valuationId))) {
    throw problems.conflict('A main signature is required before publishing — sign the valuation first');
  }

  const calculation = await latestSucceededCalculation(db, valuationId);
  if (!calculation) return; // Nothing calculated — nothing for QA to judge.
  const review = await latestQaReviewForCalculation(db, calculation.id);
  if (!review) {
    throw problems.conflict('Quality gate: run a QA review of the latest calculation before publishing');
  }
  if (review.status === 'fail') {
    throw problems.conflict(
      'Quality gate: the latest QA review failed — resolve the failing checks and re-run QA before publishing',
    );
  }
}

/**
 * The gate as a precondition of the write, rather than as a question asked
 * beforehand.
 *
 * `assertPublishGate` on the pool decides nothing durable: it reads on one
 * connection and the caller writes `state` on another, so every row the gate
 * consulted is free to change in between. It did. A `DELETE
 * /valuations/:id/signatures/main` concurrent with a publish left the
 * engagement `published` with no main signature on file — the gate had seen the
 * signature, and the route deleting it refuses only once the valuation is
 * already published, which the publisher had not yet made true. Reproduced on
 * five runs in six; see test/integration/publishGateRace.test.ts.
 *
 * Passed as `patchValuation`'s `preCommit`, this runs on the client that is
 * about to issue the UPDATE, under a lock the signature and QA writers also
 * take. So the reading the state change is justified by is a reading nothing
 * can invalidate before that state change commits.
 *
 * The pool-side call stays, and is not redundant: it fails an unsignable
 * publish before a transaction and a lock are taken, and it is the call that
 * produces the 409 an operator sees in the ordinary, uncontended case.
 */
export function assertPublishGateForWrite(
  valuationId: string,
  to: ValuationState,
): (client: pg.PoolClient) => Promise<void> {
  return async (client) => {
    if (to !== 'published') return;
    await lockPublishGate(client, valuationId);
    await assertPublishGate(client, valuationId, to);
  };
}
