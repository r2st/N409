import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { invalidateValuation } from '../../src/repos/valuations.js';

const dbUp = await isDbAvailable();

/**
 * The SLA clock across a *closure*, which is the other way work stops.
 *
 * `engagementRestoreClock` and `taskRestoreClock` state the argument for the
 * retirement half: the readers were filtered and the clock was not, so an
 * engagement withdrawn mid-stage came back instantly red. R400 established that
 * closure — `cancelled`, `timeout`, `ignored` — is the reachable twin of
 * retirement and gave the board and the overdue sweep the same filter for it.
 * The clock repair was never given the twin: nothing credits the time a
 * reopened engagement spent called off, so a file cancelled two days into a
 * 72-hour stage and restarted ninety days later comes back ninety-two days into
 * it, red on the board, chased on the next sweep tick and counted as a breach
 * in every stage-duration report.
 */
describe.skipIf(!dbUp)('reopening a closed engagement credits back the closed time', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let analyst: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  /** Cancelled two days into a 72h `analysis` stage, restarted 90 days later. */
  let reopenedId: string;
  /** Never closed; the same age, so it is the control for every assertion. */
  let controlId: string;
  /** The task on the reopened engagement, due a day after it was cancelled. */
  let reopenedTaskId: string;

  const stageEnteredAt = async (valuationId: string): Promise<Date> => {
    const { rows } = await pool.query<{ stage_entered_at: Date }>(
      'SELECT stage_entered_at FROM engagements WHERE valuation_id = $1',
      [valuationId],
    );
    return rows[0]!.stage_entered_at;
  };

  const hoursSince = (at: Date): number => (Date.now() - at.getTime()) / 3_600_000;

  async function seedEngagement(name: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: name },
    });
    const id = created.json().valuation.id as string;
    const view = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/engagement`,
      headers: authHeader(ops.token),
    });
    if (view.statusCode !== 200) throw new Error(`engagement view failed: ${view.body}`);
    await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/engagement/assign`,
      headers: authHeader(ops.token),
      payload: { analyst_id: analyst.id },
    });
    const advanced = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/engagement/advance`,
      headers: authHeader(ops.token),
      payload: { stage: 'analysis' },
    });
    if (advanced.statusCode !== 200) throw new Error(`advance failed: ${advanced.body}`);
    return id;
  }

  async function addTask(valuationId: string, dueInHours: number): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/tasks`,
      headers: authHeader(ops.token),
      payload: {
        kind: 'data_review',
        title: 'Check the cap table',
        assignee_id: analyst.id,
        due_at: new Date(Date.now() + dueInHours * 3_600_000).toISOString(),
      },
    });
    if (res.statusCode !== 201) throw new Error(`task create failed: ${res.body}`);
    return res.json().task.id as string;
  }

  /**
   * A file called off `closedDaysAgo` days ago, as the product would have left
   * it: `state` moved and a `state_changed` on the spine dated when it moved.
   *
   * Written rather than driven through `PATCH /valuations/:id`, because
   * `valuation_events` is append-only by trigger — a closure that happened
   * three months ago cannot be staged by backdating a row written now.
   */
  async function closeAndBackdate(valuationId: string, closedDaysAgo: number): Promise<void> {
    const { rows } = await pool.query<{ state: string }>(
      `UPDATE valuations SET state = 'cancelled', version = version + 1
        WHERE id = $1 RETURNING (SELECT state FROM valuations WHERE id = $1) AS state`,
      [valuationId],
    );
    if (rows.length !== 1) throw new Error('cancel failed');
    await pool.query(
      `INSERT INTO valuation_events (id, valuation_id, type, actor_type, payload, occurred_at)
       VALUES ($1, $2, 'state_changed', 'human', $3::jsonb, now() - $4::interval)`,
      [
        newUlid(),
        valuationId,
        JSON.stringify({ from: 'pending', to: 'cancelled' }),
        `${closedDaysAgo} days`,
      ],
    );
    // The stage was entered two days before the closure: two days of the
    // 72-hour stage were spent, and `closedDaysAgo` were not.
    await pool.query(
      `UPDATE engagements SET stage_entered_at = now() - $2::interval WHERE valuation_id = $1`,
      [valuationId, `${closedDaysAgo + 2} days`],
    );
    await pool.query(
      `UPDATE review_tasks SET created_at = now() - $2::interval,
                               due_at = now() - $3::interval
        WHERE valuation_id = $1`,
      [valuationId, `${closedDaysAgo + 2} days`, `${closedDaysAgo - 1} days`],
    );
    // The row was written behind the repo's read-through cache, which every
    // writer that goes through it drops for itself.
    invalidateValuation(valuationId);
  }

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    analyst = await seedUser(ctx, { roles: ['data'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });

    reopenedId = await seedEngagement('Reopened Co');
    reopenedTaskId = await addTask(reopenedId, 24);
    await closeAndBackdate(reopenedId, 90);

    // Two days into the same stage, never closed: the control.
    controlId = await seedEngagement('Never Closed Co');
    await pool.query(
      `UPDATE engagements SET stage_entered_at = now() - interval '2 days' WHERE valuation_id = $1`,
      [controlId],
    );

    const restart = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${reopenedId}/workflow/restart`,
      headers: authHeader(ops.token),
    });
    if (restart.statusCode !== 200) throw new Error(`restart failed: ${restart.body}`);
    expect(restart.json().valuation.state).toBe('started');
  });
  afterAll(async () => ctx?.teardown());

  it('leaves the control alone — the stage is two days old, well inside its SLA', async () => {
    expect(hoursSince(await stageEnteredAt(controlId))).toBeGreaterThan(47);
    expect(hoursSince(await stageEnteredAt(controlId))).toBeLessThan(49);
  });

  it('does not hand the reopened engagement back ninety days into a three-day stage', async () => {
    const hours = hoursSince(await stageEnteredAt(reopenedId));
    // The two days it was actually open for business, and not one of the ninety
    // it spent called off. Not a reset either: it comes back two days in.
    expect(hours).toBeGreaterThan(47);
    expect(hours).toBeLessThan(49);
  });

  it('shows it green on the board rather than overdue', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/engagements',
      headers: authHeader(ops.token),
    });
    const row = (res.json().engagements as { valuation_id: string; sla: { overdue: boolean } }[]).find(
      (e) => e.valuation_id === reopenedId,
    );
    expect(row?.sla.overdue).toBe(false);
  });

  it('does not chase the analyst the moment the engagement comes back', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/engagements/remind-overdue',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reminded).not.toContain(reopenedId);
  });

  it('moves the task queue’s clock by the same span', async () => {
    const { rows } = await pool.query<{ due_at: Date }>('SELECT due_at FROM review_tasks WHERE id = $1', [
      reopenedTaskId,
    ]);
    // Due a day after the file was called off, so a day ahead of the reopening.
    const hours = -hoursSince(rows[0]!.due_at);
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThan(25);
  });

  it('records the credit on the spine rather than moving the clock in silence', async () => {
    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM valuation_events
        WHERE valuation_id = $1 AND type = 'state_changed' AND payload->>'to' = 'started'
        ORDER BY seq DESC LIMIT 1`,
      [reopenedId],
    );
    const credited = rows[0]!.payload.sla_credited as { stage: string; credited_seconds: number; tasks: number };
    expect(credited.stage).toBe('analysis');
    expect(credited.tasks).toBe(1);
    const days = credited.credited_seconds / 86_400;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
  });

  it('does not push forward a stage entered after the closure', async () => {
    const id = await seedEngagement('Restaged Co');
    await closeAndBackdate(id, 30);
    // The stage was entered *after* the engagement was called off — nothing was
    // owed for the closure, so the repair must be neutral here.
    await pool.query(
      `UPDATE engagements SET stage_entered_at = now() - interval '6 hours' WHERE valuation_id = $1`,
      [id],
    );
    const restart = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/workflow/restart`,
      headers: authHeader(ops.token),
    });
    expect(restart.statusCode).toBe(200);
    expect(hoursSince(await stageEnteredAt(id))).toBeLessThan(7);
  });
});
