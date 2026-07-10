import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';
import type { QaCheck, QaStatus } from '../domain/qaChecks.js';

export interface QaReviewRow {
  id: string;
  valuation_id: string;
  calculation_id: string;
  status: QaStatus;
  checks: QaCheck[];
  ai_findings: Record<string, unknown> | null;
  ai_model: string | null;
  created_by: string | null;
  created_at: Date;
}

export async function createQaReview(
  pool: pg.Pool,
  args: {
    valuationId: string;
    calculationId: string;
    status: QaStatus;
    checks: QaCheck[];
    aiFindings?: Record<string, unknown> | null;
    aiModel?: string | null;
    createdBy: string;
  },
  actor: EventActor,
): Promise<QaReviewRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<QaReviewRow>(
      `INSERT INTO qa_reviews
         (id, valuation_id, calculation_id, status, checks, ai_findings, ai_model, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        newUlid(),
        args.valuationId,
        args.calculationId,
        args.status,
        JSON.stringify(args.checks),
        args.aiFindings ? JSON.stringify(args.aiFindings) : null,
        args.aiModel ?? null,
        args.createdBy,
      ],
    );
    await recordEvent(client, {
      valuationId: args.valuationId,
      type: 'qa_review_completed',
      actor,
      payload: {
        qa_review_id: rows[0]!.id,
        calculation_id: args.calculationId,
        status: args.status,
        checks: args.checks.length,
        ai: args.aiFindings != null,
      },
    });
    return rows[0]!;
  });
}

export async function listQaReviews(pool: pg.Pool, valuationId: string): Promise<QaReviewRow[]> {
  const { rows } = await pool.query<QaReviewRow>(
    'SELECT * FROM qa_reviews WHERE valuation_id = $1 ORDER BY created_at DESC LIMIT 20',
    [valuationId],
  );
  return rows;
}

/** The publish gate consults the newest review of a specific calculation. */
export async function latestQaReviewForCalculation(
  pool: pg.Pool,
  calculationId: string,
): Promise<QaReviewRow | null> {
  const { rows } = await pool.query<QaReviewRow>(
    'SELECT * FROM qa_reviews WHERE calculation_id = $1 ORDER BY created_at DESC LIMIT 1',
    [calculationId],
  );
  return rows[0] ?? null;
}
