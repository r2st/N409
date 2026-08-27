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

export async function findEngagement(pool: pg.Pool, valuationId: string): Promise<EngagementRow | null> {
  const { rows } = await pool.query<EngagementRow>('SELECT * FROM engagements WHERE valuation_id = $1', [
    valuationId,
  ]);
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

/**
 * Ceiling on one engagement's stage trail.
 *
 * A row per stage entry, and the stage can be re-entered — an engagement that
 * bounces between review and drafting writes one every time — so the trail is
 * not bounded by the number of stages. Oldest first: the trail is read to see
 * where the time went, which is a question about the beginning.
 */
export const STAGE_HISTORY_LIMIT = 500;

export async function stageHistory(
  pool: pg.Pool,
  engagementId: string,
): Promise<{ history: StageHistoryEntry[]; truncated: boolean }> {
  const { rows } = await pool.query<StageHistoryEntry>(
    `SELECT stage, entered_at FROM engagement_stage_history
      WHERE engagement_id = $1 ORDER BY entered_at LIMIT $2`,
    [engagementId, STAGE_HISTORY_LIMIT + 1],
  );
  return {
    history: rows.slice(0, STAGE_HISTORY_LIMIT),
    truncated: rows.length > STAGE_HISTORY_LIMIT,
  };
}

export interface EngagementListRow extends EngagementRow {
  company_name: string;
  valuation_state: string;
  kind: string;
  analyst_email: string | null;
}

/** Ceiling on one page of the active-engagement pipeline. */
export const ENGAGEMENT_PAGE_LIMIT = 500;

/**
 * Active engagements (not yet complete) for the pipeline dashboard, joined to
 * their valuation and assigned analyst.
 *
 * Bounded: the set is every engagement the firm has not finished, which grows
 * with the firm and with anything that stalls. Oldest-in-stage first is kept
 * deliberately under the cap — the rows a pipeline board exists to surface are
 * the ones that have sat longest, so a capped page is the end that matters
 * rather than an arbitrary slice.
 */
export async function listActiveEngagements(
  pool: pg.Pool,
  opts: { limit?: number } = {},
): Promise<{ engagements: EngagementListRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? ENGAGEMENT_PAGE_LIMIT, 1), ENGAGEMENT_PAGE_LIMIT);
  const { rows } = await pool.query<EngagementListRow>(
    `${ACTIVE_ENGAGEMENT_SELECT}
      WHERE ${ACTIVE_ENGAGEMENT_WHERE}
      ORDER BY e.stage_entered_at ASC, e.id ASC
      LIMIT $1`,
    [limit + 1],
  );
  return { engagements: rows.slice(0, limit), truncated: rows.length > limit };
}

/**
 * The join the pipeline board and the overdue sweep both read through.
 *
 * `v.archived_at IS NULL` belongs here rather than in either caller, so the
 * board and the sweep cannot come to disagree about which engagements are still
 * live. Archiving is this platform's soft delete for valuations, and it moves
 * `archived_at` and nothing else — not `engagements.current_stage`, not the
 * valuation's `state` — so a retired engagement stayed `<> 'complete'` and both
 * readers kept finding it.
 *
 * The board showed it, which was wrong. The sweep emailed about it, which was
 * worse: the assigned analyst was chased with "Overdue: … is past SLA in …"
 * over work the firm had withdrawn, once per sweep, for as long as the stage
 * stayed open — and the stage cannot close, because nobody is working it.
 */
const ACTIVE_ENGAGEMENT_SELECT = `
  SELECT e.*, v.company_name, v.state AS valuation_state, v.kind, u.email AS analyst_email
    FROM engagements e
    JOIN valuations v ON v.id = e.valuation_id
    LEFT JOIN users u ON u.id = e.assigned_analyst_id`;

/** Applied by both readers below; see ACTIVE_ENGAGEMENT_SELECT for why. */
const ACTIVE_ENGAGEMENT_WHERE = `v.archived_at IS NULL AND e.current_stage <> 'complete'`;

/**
 * Every active engagement, a page at a time.
 *
 * The overdue-reminder sweep must see all of them — a cap there does not slow a
 * page down, it silently stops sending the alerts the SLA exists to produce, and
 * the failure is invisible because the endpoint still reports a success count.
 * So the sweep pages rather than truncates: bounded memory per query, complete
 * coverage across them. Keyset rather than OFFSET because the set is being
 * mutated as the sweep advances through it.
 *
 * Ordered by `id`, not by `stage_entered_at` as the board is. A sweep needs
 * every row exactly once and does not care in what order, and `id` is the one
 * column that can deliver that: it is the primary key, so it is unique and
 * totally ordered, and it is text, so the cursor survives the round trip
 * through JavaScript intact. A `timestamptz` does not — Postgres keeps
 * microseconds, node-postgres hands back a `Date` carrying milliseconds, and
 * the truncated value sent back as a cursor re-selects the row it was supposed
 * to advance past. That is not a slow sweep, it is a sweep that never
 * terminates.
 */
export async function* eachActiveEngagement(
  pool: pg.Pool,
  opts: { pageSize?: number } = {},
): AsyncGenerator<EngagementListRow> {
  const size = Math.min(Math.max(opts.pageSize ?? ENGAGEMENT_PAGE_LIMIT, 1), ENGAGEMENT_PAGE_LIMIT);
  let after: string | null = null;
  for (;;) {
    const params: unknown[] = [size];
    const cursorSql: string = after ? `AND e.id > $${params.push(after)}` : '';
    const { rows }: pg.QueryResult<EngagementListRow> = await pool.query<EngagementListRow>(
      `${ACTIVE_ENGAGEMENT_SELECT}
        WHERE ${ACTIVE_ENGAGEMENT_WHERE} ${cursorSql}
        ORDER BY e.id ASC
        LIMIT $1`,
      params,
    );
    for (const row of rows) yield row;
    if (rows.length < size) return;
    after = rows[rows.length - 1]!.id;
  }
}
