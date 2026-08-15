import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { eachActiveEngagement, listActiveEngagements } from '../../src/repos/engagements.js';

const dbUp = await isDbAvailable();

/**
 * The engagement board and the overdue-SLA sweep both read through
 * `ACTIVE_ENGAGEMENT_SELECT`, and neither filtered the soft delete.
 *
 * Archiving moves `archived_at` and nothing else — not `engagements.
 * current_stage`, not the valuation's `state` — so a retired engagement stayed
 * `<> 'complete'` and both readers kept finding it. The board showing it was
 * wrong; the sweep was worse, because it emails: the assigned analyst was
 * chased with "Overdue: … is past SLA in …" over work the firm had withdrawn,
 * once per sweep, for as long as the stage stayed open. And the stage cannot
 * close on its own, because nobody is working it — so the reminders do not stop.
 */
describe.skipIf(!dbUp)('engagement board and SLA sweep drop retired engagements', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let analyst: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  let liveId: string;
  let retiredId: string;

  /**
   * An engagement sitting in `kickoff` long enough to be overdue, with an
   * analyst to chase. The stage is backdated rather than waited out.
   */
  async function seedOverdueEngagement(name: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: name },
    });
    const id = created.json().valuation.id as string;
    // First view is what creates the engagement row at `kickoff`.
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
    await pool.query(
      `UPDATE engagements SET stage_entered_at = now() - interval '400 days' WHERE valuation_id = $1`,
      [id],
    );
    return id;
  }

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    analyst = await seedUser(ctx, { roles: ['data'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });

    liveId = await seedOverdueEngagement('Board Live Inc');
    retiredId = await seedOverdueEngagement('Board Retired Inc');

    await pool.query('UPDATE valuations SET archived_at = now() WHERE id = $1', [retiredId]);
  });
  afterAll(async () => ctx?.teardown());

  it('leaves the retired engagement mid-stage — the engagement row is untouched', async () => {
    const { rows } = await pool.query<{ current_stage: string }>(
      'SELECT current_stage FROM engagements WHERE valuation_id = $1',
      [retiredId],
    );
    // If archiving completed the engagement, the filter under test would be
    // unreachable through this path and the rest of the file would pass
    // vacuously.
    expect(rows[0]!.current_stage).not.toBe('complete');
  });

  it('keeps the retired engagement off the pipeline board', async () => {
    const { engagements } = await listActiveEngagements(pool);
    const ids = engagements.map((e) => e.valuation_id);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(retiredId);
  });

  it('never hands the retired engagement to the sweep', async () => {
    const seen: string[] = [];
    // pageSize 1 forces the keyset cursor to walk, so the filter is exercised
    // on every page rather than only on the first.
    for await (const row of eachActiveEngagement(pool, { pageSize: 1 })) {
      seen.push(row.valuation_id);
    }
    expect(seen).toContain(liveId);
    expect(seen).not.toContain(retiredId);
  });

  it('does not chase the analyst about the retired engagement', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/engagements/remind-overdue',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Both were seeded overdue and both have an analyst, so the live one is the
    // control: a sweep that still walked the retired one would remind twice.
    expect(body.reminded).toContain(liveId);
    expect(body.reminded).not.toContain(retiredId);

    // And nothing was queued to be sent about it either.
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM email_outbox WHERE valuation_id = $1 AND template_key = 'engagement_overdue'",
      [retiredId],
    );
    expect(rows[0]!.n).toBe(0);
  });
});
