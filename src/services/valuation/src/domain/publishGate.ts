import type pg from 'pg';
import { problems } from '@n409/shared';
import type { ValuationState } from './valuation.js';
import { hasMainSignature } from '../repos/signatures.js';

/**
 * Signature gating (remaining-gaps §3 #3): no valuation enters 'published'
 * without a Signature (main) on file. Called by every path that can set the
 * state — the workflow routes, bulk actions, and the direct PATCH.
 */
export async function assertPublishGate(
  pool: pg.Pool,
  valuationId: string,
  to: ValuationState,
): Promise<void> {
  if (to !== 'published') return;
  if (!(await hasMainSignature(pool, valuationId))) {
    throw problems.conflict(
      'A main signature is required before publishing — sign the valuation first',
    );
  }
}
