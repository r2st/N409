import type pg from 'pg';
import { problems } from '@n409/shared';
import type { Queryable } from '../db/pool.js';
import type { ValuationState } from './valuation.js';
import { hasMainSignature } from '../repos/signatures.js';
import { lockPublishGate } from '../repos/publishLock.js';
import { latestSucceededCalculation } from '../repos/calculations.js';
import { latestQaReviewForCalculation } from '../repos/qaReviews.js';
import { findReportByValuation } from '../repos/reports.js';

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
 * 3. The report body that review graded must still be the current one. The
 *    review grades two independent things and only the first of them used to be
 *    identified: `runQa` opens the report and checks it for dead exhibit
 *    references, unexplained approaches, frozen figures and chapters still
 *    carrying the skeleton's instructions — and a `PUT /report` afterwards
 *    replaces that body without touching anything rule 2 reads. So a document
 *    edited after its review published over a review of prose no longer in it.
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

  /*
   * Rule 3. Only when there is a report: an engagement with none has no body to
   * have graded, which is the same reading `runQa` files as a null.
   *
   * A null `report_version` beside a report that exists is a review filed
   * before the column did, and is read as "does not say" rather than as "did
   * not change". Refused, because the column answers a compliance question and
   * an unknown is not a yes — the remediation is one QA re-run and the message
   * names it.
   *
   * `>` rather than `!==`: a revert moves `current_version` forwards too (it
   * writes the restored content as a *new* version), so there is no direction
   * in which the pointer goes back, and an inequality that could fire on a
   * lower number would only be describing a state that cannot arise.
   */
  const report = await findReportByValuation(db, valuationId);
  if (!report) return;
  if (review.report_version === null || report.current_version > review.report_version) {
    throw problems.conflict(
      'Quality gate: the report body has been edited since the last QA review — re-run QA before publishing',
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
