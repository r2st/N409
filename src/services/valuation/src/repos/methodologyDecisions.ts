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

/**
 * A decision may be revised once, and this is what the second revision gets
 * back (R372, methodology M3).
 *
 * `supersedes` is the log's only edge and the only thing that decides whether
 * an entry is struck through, so two rows pointing at one prior decision is a
 * fork: the earlier entry is struck through exactly once, and the log — and the
 * evidence bundle an auditor reads it out of — then carries two live,
 * contradictory revisions of the same choice with nothing to order them.
 *
 * The browser already treated it as illegal. `DecisionsTab` populates the
 * "Supersedes" select from `decisions.filter((d) => !d.superseded)`, so the
 * control cannot offer a revised entry — and that snapshot is the *only* place
 * the rule was written. Every ordinary way of getting past it is a stale one:
 * the second of two operators working the same engagement, a tab left open
 * while a colleague revises the row it is listing, a retried submit. The
 * route's own read cannot close it either, being one statement earlier on
 * another connection, which is why the check below is taken under a lock on the
 * row being revised.
 */
export interface DecisionAlreadyRevised {
  reason: 'already_revised';
  /** The decision that got there first — what the message has to name. */
  supersededBy: string;
}

export function isDecisionAlreadyRevised(
  result: MethodologyDecisionRow | DecisionAlreadyRevised,
): result is DecisionAlreadyRevised {
  return 'reason' in result && result.reason === 'already_revised';
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
): Promise<MethodologyDecisionRow | DecisionAlreadyRevised> {
  return withTransaction(pool, async (client) => {
    if (args.supersedes) {
      /*
       * The row being revised, held still while this decides.
       *
       * `FOR UPDATE` on the *target* rather than on the answer, because in the
       * direction that matters there is no answer row to lock — what must not
       * race is a second revision that does not exist yet. Both writers queue
       * on the prior decision, and the loser's `NOT EXISTS` below is a new
       * statement with a new snapshot, so it sees the revision the winner
       * committed. The same shape `lockPublishGate` uses for a missing
       * signature.
       *
       * The target's existence and its valuation are the route's 422 and are
       * left there: this lock is taken on whatever the route has already
       * established is a decision of this engagement.
       */
      await client.query('SELECT id FROM methodology_decisions WHERE id = $1 FOR UPDATE', [
        args.supersedes,
      ]);
      const { rows: existing } = await client.query<{ id: string }>(
        'SELECT id FROM methodology_decisions WHERE supersedes = $1 ORDER BY created_at ASC LIMIT 1',
        [args.supersedes],
      );
      if (existing[0]) return { reason: 'already_revised', supersededBy: existing[0].id };
    }
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

/**
 * Ceiling on one page of the decision log.
 *
 * Append-only by design: a revised decision is a new row pointing at the one it
 * supersedes, so nothing here is ever updated or removed and the log grows for
 * as long as the engagement is worked. Oldest first — a decision log read from
 * the middle loses the reasoning the later entries revise.
 */
export const DECISION_PAGE_LIMIT = 500;

export async function listDecisions(
  pool: pg.Pool,
  valuationId: string,
): Promise<{ decisions: MethodologyDecisionRow[]; truncated: boolean }> {
  const { rows } = await pool.query<MethodologyDecisionRow>(
    'SELECT * FROM methodology_decisions WHERE valuation_id = $1 ORDER BY created_at ASC LIMIT $2',
    [valuationId, DECISION_PAGE_LIMIT + 1],
  );
  return {
    decisions: rows.slice(0, DECISION_PAGE_LIMIT),
    truncated: rows.length > DECISION_PAGE_LIMIT,
  };
}

export async function findDecisionById(pool: pg.Pool, id: string): Promise<MethodologyDecisionRow | null> {
  const { rows } = await pool.query<MethodologyDecisionRow>(
    'SELECT * FROM methodology_decisions WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}
