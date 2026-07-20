import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

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

    const outbox = await pool.query(
      'SELECT * FROM email_outbox WHERE to_email = $1 AND subject LIKE $2',
      [analyst.email, 'Overdue:%'],
    );
    expect(outbox.rows.length).toBe(1);
  });

  it('is operations-only', async () => {
    for (const url of [
      `/api/v1/valuations/${valuationId}/engagement`,
      '/api/v1/engagements',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: authHeader(client.token) });
      expect(res.statusCode).toBe(403);
    }
  });
});
