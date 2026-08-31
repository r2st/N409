import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { restoreValuations, retireValuations } from '../../src/repos/valuationPurge.js';
import { listActiveEngagements } from '../../src/repos/engagements.js';

const dbUp = await isDbAvailable();

/**
 * The SLA clock across a retirement.
 *
 * Retirement moves `archived_at` and nothing else — the same fact that produced
 * the board-and-sweep filter, where the *readers* were fixed and the clock was
 * not. `engagements.stage_entered_at` therefore ran for the whole withdrawal,
 * so an engagement retired mid-stage and restored months later came back
 * instantly red and its analyst was told the stage had been open for the length
 * of the retirement, past an SLA measured in days. No work was owed for any of
 * those hours: every write to the file was refused while it was withdrawn.
 */
describe.skipIf(!dbUp)('restoring an engagement credits back the withdrawn time', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let analyst: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  /** Retired two days into a 72h `analysis` stage, restored 90 days later. */
  let restoredId: string;
  /** Never retired; the same age, so it is the control for every assertion. */
  let controlId: string;

  const stageEnteredAt = async (valuationId: string): Promise<Date> => {
    const { rows } = await pool.query<{ stage_entered_at: Date }>(
      'SELECT stage_entered_at FROM engagements WHERE valuation_id = $1',
      [valuationId],
    );
    return rows[0]!.stage_entered_at;
  };

  async function seedEngagement(name: string, enteredAgo: string): Promise<string> {
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
    await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/engagement/advance`,
      headers: authHeader(ops.token),
      payload: { stage: 'analysis' },
    });
    await pool.query(
      `UPDATE engagements SET stage_entered_at = now() - $2::interval WHERE valuation_id = $1`,
      [id, enteredAgo],
    );
    return id;
  }

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    admin = await seedUser(ctx, { roles: ['admin'] });
    analyst = await seedUser(ctx, { roles: ['data'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });

    // Entered `analysis` 92 days ago and withdrawn 90 days ago — so two days
    // of the 72-hour stage were spent, and ninety were not. The order matters:
    // an `archived_at` older than `stage_entered_at` describes a stage entered
    // after the withdrawal, which nothing can produce and which the repair
    // deliberately skips.
    restoredId = await seedEngagement('Restored Co', '92 days');
    // Two days into the same stage, never retired: the control every assertion
    // below is measured against.
    controlId = await seedEngagement('Never Retired Co', '2 days');

    await retireValuations(pool, [restoredId]);
    await pool.query(`UPDATE valuations SET archived_at = now() - interval '90 days' WHERE id = $1`, [
      restoredId,
    ]);
    const result = await restoreValuations(pool, [restoredId]);
    expect(result.restored).toEqual([restoredId]);
  });
  afterAll(async () => ctx?.teardown());

  it('leaves the control alone — the stage is two days old, well inside its SLA', async () => {
    const { engagements } = await listActiveEngagements(pool);
    const control = engagements.find((e) => e.valuation_id === controlId);
    expect(control?.current_stage).toBe('analysis');
    const entered = await stageEnteredAt(controlId);
    const hours = (Date.now() - entered.getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(47);
    expect(hours).toBeLessThan(49);
  });

  it('does not hand the restored engagement back ninety days into a three-day stage', async () => {
    const entered = await stageEnteredAt(restoredId);
    const hours = (Date.now() - entered.getTime()) / 3_600_000;
    // The two days it was actually open for business, and not one of the
    // ninety it spent withdrawn. Not a reset either: it comes back two days
    // in, because it was two days in.
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
      (e) => e.valuation_id === restoredId,
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
    expect(res.json().reminded).not.toContain(restoredId);
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM email_outbox
        WHERE valuation_id = $1 AND template_key = 'engagement_overdue'`,
      [restoredId],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('leaves the stage trail alone — an entry records when the stage was entered', async () => {
    // Deliberate: rewriting `entered_at` to make a derived duration agree would
    // falsify an append-only trail. The repair is to the clock, not the record.
    const { rows } = await pool.query<{ stage: string; entered_at: Date }>(
      `SELECT h.stage, h.entered_at FROM engagement_stage_history h
         JOIN engagements e ON e.id = h.engagement_id
        WHERE e.valuation_id = $1 AND h.stage = 'analysis'`,
      [restoredId],
    );
    expect(rows).toHaveLength(1);
    const age = (Date.now() - rows[0]!.entered_at.getTime()) / 3_600_000;
    // Recorded when it happened — before the backdating, so only minutes old.
    expect(age).toBeLessThan(1);
  });

  /**
   * The repair is a write nobody asked for, so it says so.
   *
   * The admin asked for a restore; this also moves `stage_entered_at` on a
   * second table — the column the board colours by and the overdue sweep picks
   * its recipients from — while the stage trail beside it deliberately keeps
   * the original `entered_at`. Silent, that is two timestamps disagreeing with
   * a retention log that says only "restored", and whoever reconciles them has
   * to already know this repair exists.
   */
  it('reports the credited span rather than moving the clock in silence', async () => {
    const id = await seedEngagement('Reported Credit Co', '92 days');
    await retireValuations(pool, [id]);
    await pool.query(`UPDATE valuations SET archived_at = now() - interval '30 days' WHERE id = $1`, [id]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/retention/valuations/${id}/restore`,
      headers: authHeader(admin.token),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const credited = res.json().sla_credited as {
      valuation_id: string;
      stage: string;
      credited_seconds: number;
    }[];
    expect(credited).toHaveLength(1);
    expect(credited[0]!.valuation_id).toBe(id);
    // Named, because "the clock moved" is not an answer to which stage's.
    expect(credited[0]!.stage).toBe('analysis');
    const days = credited[0]!.credited_seconds / 86_400;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM admin_events WHERE type = 'valuation_restored' AND subject_id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.sla_credited).toEqual([
      { valuation_id: id, stage: 'analysis', credited_seconds: credited[0]!.credited_seconds },
    ]);
  });

  it('reports nothing credited when the restore owed nothing', async () => {
    const id = await seedEngagement('Nothing Owed Co', '2 days');
    await retireValuations(pool, [id]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/retention/valuations/${id}/restore`,
      headers: authHeader(admin.token),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    // A sub-second withdrawal still credits a sub-second span, so the list is
    // not empty — what matters is that it is honest about the size.
    const credited = res.json().sla_credited as { credited_seconds: number }[];
    for (const c of credited) expect(c.credited_seconds).toBeLessThan(2);
  });

  it('is a no-op for an engagement restored the same moment it was retired', async () => {
    const id = await seedEngagement('Immediately Restored Co', '2 days');
    const before = await stageEnteredAt(id);
    await retireValuations(pool, [id]);
    await restoreValuations(pool, [id]);
    const after = await stageEnteredAt(id);
    // Sub-second withdrawal, so the shift is sub-second too. The repair scales
    // with the withdrawal rather than being a flat reset.
    expect(Math.abs(after.getTime() - before.getTime())).toBeLessThan(1000);
  });
});
