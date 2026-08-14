import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { newUlid } from '@n409/shared';
import { eachActiveEngagement } from '../../src/repos/engagements.js';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('feature 8 — engagement lifecycle', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let analyst: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    analyst = await seedUser(ctx, { roles: ['data'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'EngageCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('creates the engagement at kickoff on first view', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/engagement`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.engagement.current_stage).toBe('kickoff');
    expect(body.sla.level).toBe('green');
    expect(body.durations).toHaveLength(1);
    expect(body.activity.length).toBeGreaterThan(0);
  });

  it('advances to the next stage and records history', async () => {
    const next = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/engagement/advance`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(next.statusCode).toBe(200);
    expect(next.json().engagement.current_stage).toBe('data_collection');
    expect(next.json().durations).toHaveLength(2);

    // Jump to a named stage.
    const jump = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/engagement/advance`,
      headers: authHeader(ops.token),
      payload: { stage: 'analysis' },
    });
    expect(jump.json().engagement.current_stage).toBe('analysis');

    // Advancing to the current stage is a conflict.
    const same = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/engagement/advance`,
      headers: authHeader(ops.token),
      payload: { stage: 'analysis' },
    });
    expect(same.statusCode).toBe(409);

    // Unknown stage is unprocessable.
    const bad = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/engagement/advance`,
      headers: authHeader(ops.token),
      payload: { stage: 'nonsense' },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('assigns an analyst', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/engagement/assign`,
      headers: authHeader(ops.token),
      payload: { analyst_id: analyst.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().engagement.assigned_analyst_id).toBe(analyst.id);
  });

  it('lists active engagements on the pipeline dashboard', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/engagements',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const mine = res.json().engagements.find((e: any) => e.valuation_id === valuationId);
    expect(mine).toBeTruthy();
    expect(mine.current_stage).toBe('analysis');
    expect(mine.analyst_email).toBe(analyst.email);
    expect(mine.sla).toBeTruthy();
  });

  it('emails the analyst when a stage is overdue', async () => {
    // Force the current stage to have started 10 days ago → past the analysis SLA.
    await pool.query(
      "UPDATE engagements SET stage_entered_at = now() - interval '10 days' WHERE valuation_id = $1",
      [valuationId],
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/engagements/remind-overdue',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reminded_count).toBeGreaterThanOrEqual(1);
    expect(res.json().reminded).toContain(valuationId);

    const outbox = await pool.query('SELECT * FROM email_outbox WHERE to_email = $1 AND subject LIKE $2', [
      analyst.email,
      'Overdue:%',
    ]);
    expect(outbox.rows.length).toBe(1);
  });

  it('is operations-only', async () => {
    for (const url of [`/api/v1/valuations/${valuationId}/engagement`, '/api/v1/engagements']) {
      const res = await app.inject({ method: 'GET', url, headers: authHeader(client.token) });
      expect(res.statusCode).toBe(403);
    }
  });

  /**
   * The pipeline board reads every engagement the firm has not finished, which
   * grows with the firm and with anything that stalls. Bounding it is fine for
   * the board; bounding the overdue sweep is not, because a reminder that never
   * sends still reports success.
   */
  describe('bounded reads', () => {
    /** Several active engagements sharing one `stage_entered_at` to the microsecond. */
    const seedSimultaneous = async (count: number) => {
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const created = await app.inject({
          method: 'POST',
          url: '/api/v1/valuations',
          headers: authHeader(client.token),
          payload: { kind: '409a', company_name: `PagerCo ${i}` },
        });
        ids.push(created.json().valuation.id);
      }
      // One statement, so every row lands on the same timestamp — the case a
      // keyset cursor without a tiebreaker loses rows on.
      await pool.query(
        `INSERT INTO engagements (id, valuation_id, current_stage, stage_entered_at)
         SELECT e, v, 'analysis', now()
           FROM unnest($1::ulid[], $2::ulid[]) AS t(e, v)
         ON CONFLICT (valuation_id) DO UPDATE SET stage_entered_at = EXCLUDED.stage_entered_at`,
        [ids.map(() => newUlid()), ids],
      );
      return ids;
    };

    it('caps the board and says so, without dropping the oldest-in-stage end', async () => {
      await seedSimultaneous(3);
      const capped = await app.inject({
        method: 'GET',
        url: '/api/v1/engagements?limit=2',
        headers: authHeader(ops.token),
      });
      expect(capped.statusCode).toBe(200);
      expect(capped.json().engagements).toHaveLength(2);
      expect(capped.json().truncated).toBe(true);

      const whole = await app.inject({
        method: 'GET',
        url: '/api/v1/engagements',
        headers: authHeader(ops.token),
      });
      expect(whole.json().truncated).toBe(false);
      expect(whole.json().engagements.length).toBeGreaterThan(2);
      // The cap takes the front of the same ordering, not a different one.
      expect(capped.json().engagements.map((e: { valuation_id: string }) => e.valuation_id)).toEqual(
        whole
          .json()
          .engagements.slice(0, 2)
          .map((e: { valuation_id: string }) => e.valuation_id),
      );
    });

    it('refuses a limit outside the ceiling rather than honouring it', async () => {
      for (const q of ['?limit=0', '?limit=100000']) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/engagements${q}`,
          headers: authHeader(ops.token),
        });
        expect(res.statusCode).toBe(422);
      }
    });

    /**
     * The sweep pages instead of truncating. Driven at a page size of 2 rather
     * than the 500 the route uses, because the property under test is that the
     * cursor advances correctly across pages — including across rows that share
     * a timestamp, where an `id`-less cursor repeats one row and drops another.
     */
    it('pages the whole active set, including rows sharing a timestamp', async () => {
      const ids = await seedSimultaneous(5);
      const seen: string[] = [];
      for await (const row of eachActiveEngagement(pool, { pageSize: 2 })) {
        seen.push(row.valuation_id);
      }
      for (const id of ids) expect(seen).toContain(id);
      // Each engagement exactly once — no repeats across the page boundaries.
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('reminds on an overdue engagement the sweep only reaches on a later page', async () => {
      const ids = await seedSimultaneous(4);
      const late = ids[ids.length - 1]!;
      await pool.query(
        "UPDATE engagements SET stage_entered_at = now() - interval '30 days' WHERE valuation_id = $1",
        [late],
      );
      // Give it an analyst with an address, or there is nobody to remind.
      await pool.query('UPDATE engagements SET assigned_analyst_id = $2 WHERE valuation_id = $1', [
        late,
        analyst.id,
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/engagements/remind-overdue',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().reminded).toContain(late);
      // The sweep reports what it walked, so a silent short read is visible.
      expect(res.json().scanned).toBeGreaterThanOrEqual(ids.length);
    });
  });
});
