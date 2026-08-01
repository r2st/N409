import type pg from 'pg';
import { problems } from '@n409/shared';
import type { ValuationState } from './valuation.js';
import { hasMainSignature } from '../repos/signatures.js';
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
 */
export async function assertPublishGate(
  pool: pg.Pool,
  valuationId: string,
  to: ValuationState,
): Promise<void> {
  if (to !== 'published') return;
  if (!(await hasMainSignature(pool, valuationId))) {
    throw problems.conflict('A main signature is required before publishing — sign the valuation first');
  }

  const calculation = await latestSucceededCalculation(pool, valuationId);
  if (!calculation) return; // Nothing calculated — nothing for QA to judge.
  const review = await latestQaReviewForCalculation(pool, calculation.id);
  if (!review) {
    throw problems.conflict('Quality gate: run a QA review of the latest calculation before publishing');
  }
  if (review.status === 'fail') {
    throw problems.conflict(
      'Quality gate: the latest QA review failed — resolve the failing checks and re-run QA before publishing',
    );
  }
}
