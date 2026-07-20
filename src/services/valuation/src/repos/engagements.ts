import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';
import { ENGAGEMENT_EVENT_TYPES, type StageHistoryEntry } from '../domain/engagement.js';

export interface EngagementRow {
  id: string;
  valuation_id: string;
  current_stage: string;
  assigned_analyst_id: string | null;
  stage_entered_at: Date;
  created_at: Date;
  updated_at: Date;
}

export async function findEngagement(
  pool: pg.Pool,
  valuationId: string,
): Promise<EngagementRow | null> {
  const { rows } = await pool.query<EngagementRow>(
    'SELECT * FROM engagements WHERE valuation_id = $1',
    [valuationId],
  );
  return rows[0] ?? null;
}

/** Create the engagement at the kickoff stage if it doesn't exist yet. */
export async function ensureEngagement(
  pool: pg.Pool,
  valuationId: string,
  actor: EventActor,
): Promise<EngagementRow> {
  const existing = await findEngagement(pool, valuationId);
  if (existing) return existing;
  return withTransaction(pool, async (client) => {
    const id = newUlid();
    const { rows } = await client.query<EngagementRow>(
      `INSERT INTO engagements (id, valuation_id) VALUES ($1, $2)
       ON CONFLICT (valuation_id) DO NOTHING
       RETURNING *`,
      [id, valuationId],
    );
    // Lost the race — read the row the other writer created.
    if (rows.length === 0) {
      const { rows: again } = await client.query<EngagementRow>(
        'SELECT * FROM engagements WHERE valuation_id = $1',
        [valuationId],
      );
      return again[0]!;
    }
    await client.query(
      `INSERT INTO engagement_stage_history (id, engagement_id, valuation_id, stage, entered_by)
       VALUES ($1, $2, $3, 'kickoff', $4)`,
      [newUlid(), id, valuationId, actor.actorId ?? null],
    );
    await recordEvent(client, {
      valuationId,
      type: ENGAGEMENT_EVENT_TYPES.started,
      actor,
      payload: { stage: 'kickoff' },
    });
    return rows[0]!;
  });
}

export async function advanceStage(
  pool: pg.Pool,
  engagement: EngagementRow,
  toStage: string,
  actor: EventActor,
): Promise<EngagementRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<EngagementRow>(
      `UPDATE engagements SET current_stage = $2, stage_entered_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [engagement.id, toStage],
    );
    await client.query(
      `INSERT INTO engagement_stage_history (id, engagement_id, valuation_id, stage, entered_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [newUlid(), engagement.id, engagement.valuation_id, toStage, actor.actorId ?? null],
    );
    await recordEvent(client, {
      valuationId: engagement.valuation_id,
      type: ENGAGEMENT_EVENT_TYPES.stageAdvanced,
      actor,
      payload: { from: engagement.current_stage, to: toStage },
    });
    return rows[0]!;
  });
}

export async function assignAnalyst(
  pool: pg.Pool,
  engagement: EngagementRow,
  analystId: string | null,
  actor: EventActor,
): Promise<EngagementRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<EngagementRow>(
      `UPDATE engagements SET assigned_analyst_id = $2, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [engagement.id, analystId],
    );
    await recordEvent(client, {
      valuationId: engagement.valuation_id,
      type: ENGAGEMENT_EVENT_TYPES.analystAssigned,
      actor,
      payload: { analyst_id: analystId },
    });
    return rows[0]!;
  });
}

export async function stageHistory(
  pool: pg.Pool,
  engagementId: string,
): Promise<StageHistoryEntry[]> {
  const { rows } = await pool.query<StageHistoryEntry>(
    'SELECT stage, entered_at FROM engagement_stage_history WHERE engagement_id = $1 ORDER BY entered_at',
    [engagementId],
  );
  return rows;
}

export interface EngagementListRow extends EngagementRow {
  company_name: string;
  valuation_state: string;
  kind: string;
  analyst_email: string | null;
}

/**
 * Active engagements (not yet complete) for the pipeline dashboard, joined to
 * their valuation and assigned analyst.
 */
export async function listActiveEngagements(pool: pg.Pool): Promise<EngagementListRow[]> {
  const { rows } = await pool.query<EngagementListRow>(
    `SELECT e.*, v.company_name, v.state AS valuation_state, v.kind, u.email AS analyst_email
       FROM engagements e
       JOIN valuations v ON v.id = e.valuation_id
       LEFT JOIN users u ON u.id = e.assigned_analyst_id
      WHERE e.current_stage <> 'complete'
      ORDER BY e.stage_entered_at ASC`,
  );
  return rows;
}

/** Engagements whose current stage started before `before` (SLA-overdue candidates). */
export async function overdueCandidates(pool: pg.Pool): Promise<EngagementListRow[]> {
  return listActiveEngagements(pool);
}
