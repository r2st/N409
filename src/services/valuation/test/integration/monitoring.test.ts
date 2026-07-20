import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createCalculation } from '../../src/repos/calculations.js';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('feature 10 — valuation monitoring', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'MonitorCo' },
    });
    valuationId = created.json().valuation.id;
    // A concluded FMV + a completed-ish state + baseline revenue.
    await createCalculation(
      pool,
      { valuationId, engineVersion: 't', status: 'succeeded', inputs: {}, results: {}, equityValue: 1, fmvPerShare: 2, createdBy: ops.id },
      { actorType: 'human', actorId: ops.id },
    );
    await pool.query("UPDATE valuations SET state = 'published', assigned_reviewer_id = $2 WHERE id = $1", [
      valuationId,
      ops.id,
    ]);
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(ops.token),
      payload: { last_year_revenue_cents: 100_000_000 }, // $1,000,000
    });
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('enables monitoring and snapshots a baseline', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/monitor`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().monitor.enabled).toBe(true);
    expect(res.json().monitor.baseline.annual_revenue).toBe(1_000_000);
  });

  it('reports green immediately after enabling', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/monitor`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('green');
    expect(res.json().triggers).toHaveLength(0);
  });

  it('fires a revenue trigger when revenue moves past materiality', async () => {
    // Move revenue +40% from the baseline.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(ops.token),
      payload: { last_year_revenue_cents: 140_000_000 },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/monitor`,
      headers: authHeader(ops.token),
    });
    expect(res.json().status).toBe('red');
    expect(res.json().triggers.some((t: any) => t.type === 'revenue_change' && t.level === 'red')).toBe(true);
  });

  it('scans and emails the reviewer once, then dedupes', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/monitors/scan',
      headers: authHeader(ops.token),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().alerts_sent).toBeGreaterThanOrEqual(1);

    const outbox = await pool.query(
      'SELECT count(*)::int AS n FROM email_outbox WHERE subject LIKE $1',
      ['Revaluation trigger:%'],
    );
    const firstCount = outbox.rows[0].n as number;
    expect(firstCount).toBeGreaterThanOrEqual(1);

    // Re-scanning does not re-alert the same trigger.
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/monitors/scan',
      headers: authHeader(ops.token),
    });
    expect(second.json().alerts_sent).toBe(0);
    const outbox2 = await pool.query(
      'SELECT count(*)::int AS n FROM email_outbox WHERE subject LIKE $1',
      ['Revaluation trigger:%'],
    );
    expect(outbox2.rows[0].n).toBe(firstCount);
  });

  it('lists the monitor on the dashboard with status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/monitors',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const mine = res.json().monitors.find((m: any) => m.valuation_id === valuationId);
    expect(mine.status).toBe('red');
  });

  it('one-click roll-forward creates a fresh valuation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/monitor/new-valuation`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().valuation.id).not.toBe(valuationId);
    expect(res.json().valuation.company_name).toBe('MonitorCo');
    expect(res.json().valuation.state).toBe('pending');
  });

  it('disables monitoring', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/valuations/${valuationId}/monitor`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(204);
    const after = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/monitor`,
      headers: authHeader(ops.token),
    });
    expect(after.json().monitor).toBeNull();
  });

  it('is operations-only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/monitor`,
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(403);
  });
});
