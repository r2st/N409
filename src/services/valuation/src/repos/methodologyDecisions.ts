import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';

export const DECISION_CATEGORIES = [
  'approach_selection',
  'weighting',
  'dlom',
  'dloc',
  'volatility',
  'discount_rate',
  'comparables',
  'backsolve',
  'allocation',
  'other',
] as const;
export type DecisionCategory = (typeof DECISION_CATEGORIES)[number];

export interface MethodologyDecisionRow {
  id: string;
  valuation_id: string;
  category: DecisionCategory;
  decision: string;
  rationale: string;
  supersedes: string | null;
  decided_by: string;
  created_at: Date;
}

export async function createDecision(
  pool: pg.Pool,
  args: {
    valuationId: string;
    category: DecisionCategory;
    decision: string;
    rationale: string;
    supersedes?: string | null;
    decidedBy: string;
  },
  actor: EventActor,
): Promise<MethodologyDecisionRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<MethodologyDecisionRow>(
      `INSERT INTO methodology_decisions
         (id, valuation_id, category, decision, rationale, supersedes, decided_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        newUlid(),
        args.valuationId,
        args.category,
        args.decision,
        args.rationale,
        args.supersedes ?? null,
        args.decidedBy,
      ],
    );
    await recordEvent(client, {
      valuationId: args.valuationId,
      type: 'methodology_decision_recorded',
      actor,
      payload: {
        decision_id: rows[0]!.id,
        category: args.category,
        supersedes: args.supersedes ?? null,
      },
    });
    return rows[0]!;
  });
}

export async function listDecisions(
  pool: pg.Pool,
  valuationId: string,
): Promise<MethodologyDecisionRow[]> {
  const { rows } = await pool.query<MethodologyDecisionRow>(
    'SELECT * FROM methodology_decisions WHERE valuation_id = $1 ORDER BY created_at ASC',
    [valuationId],
  );
  return rows;
}

export async function findDecisionById(
  pool: pg.Pool,
  id: string,
): Promise<MethodologyDecisionRow | null> {
  const { rows } = await pool.query<MethodologyDecisionRow>(
    'SELECT * FROM methodology_decisions WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}
