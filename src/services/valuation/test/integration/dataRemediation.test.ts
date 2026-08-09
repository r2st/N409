import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/** Engine stub — a clean run with no single-breakpoint backsolve in it. */
async function startEngineStub() {
  const stub = Fastify({ logger: false });
  stub.get('/engine/v1/health', async () => ({ engine_version: 'stub-1' }));
  stub.post('/engine/v1/compute', async () => ({
    engine_version: 'stub-1',
    results: {
      equity_value: 12_000_000,
      fmv_per_share: 1.4,
      approaches: { opm_backsolve: { method: 'backsolve_waterfall', equity_value: 12_000_000 } },
      discounts: { dlom: 0.3, dlom_method: 'chaffee' },
    },
    warnings: [],
  }));
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

/**
 * Design §7.4 — the two stored-data defects, listed before they are acted on.
 *
 * The case that matters most is the one that must NOT happen: a published
 * opinion being re-run underneath a signed document a client has relied on.
 */
describe.skipIf(!dbUp)('data remediation', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engine: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let unpublishedId: string;
  let publishedId: string;
  let qaValuationId: string;

  const queue = async (token = ops.token) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/admin/data-remediation',
      headers: authHeader(token),
    });

  const staleCalculation = async (valuationId: string, optionsOutstanding: number) => {
    const id = newUlid();
    await pool.query(
      `INSERT INTO calculations
         (id, valuation_id, engine_version, status, inputs, results, equity_value, fmv_per_share)
       VALUES ($1, $2, 'pre-99383b2', 'succeeded', $3::jsonb, $4::jsonb, 9000000, 0.9)`,
      [
        id,
        valuationId,
        JSON.stringify({ inputs: { options_outstanding: optionsOutstanding } }),
        JSON.stringify({
          approaches: { opm_backsolve: { method: 'backsolve_single', equity_value: 9_000_000 } },
          discounts: { dlom: 0.42, dlom_method: 'chaffee' },
        }),
      ],
    );
    return id;
  };

  const createValuation = async (company: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: company },
    });
    return res.json().valuation.id as string;
  };

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    engine = await startEngineStub();
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      ENGINE_URL: engine.url,
      AUTO_PIPELINE: 'off',
    });
    app = buildApp({ config, pool });
    await app.ready();

    const ctx = { app, pool, teardown: async () => {} };
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { email: 'remediation@client.example', roles: ['valuation_user'] });

    unpublishedId = await createValuation('Stale Unpublished Co');
    publishedId = await createValuation('Stale Published Co');
    const cleanId = await createValuation('Clean Co');
    qaValuationId = await createValuation('Stale QA Co');

    await staleCalculation(unpublishedId, 1_500_000);
    await staleCalculation(publishedId, 900_000);
    await pool.query(`UPDATE valuations SET state = 'published' WHERE id = $1`, [publishedId]);

    // A single-breakpoint backsolve with NO option pool is not affected — the
    // defect is the pool's share going missing, so a zero pool loses nothing.
    await staleCalculation(cleanId, 0);

    // A QA review of a Chaffee run carrying every check except dlom_range —
    // the shape reviews recorded before 9ed0aa6 have.
    const qaCalcId = await staleCalculation(qaValuationId, 0);
    await pool.query(
      `INSERT INTO qa_reviews (id, valuation_id, calculation_id, status, checks)
       VALUES ($1, $2, $3, 'pass', $4::jsonb)`,
      [
        newUlid(),
        qaValuationId,
        qaCalcId,
        JSON.stringify([{ key: 'weights_sum', label: 'Weights', status: 'pass', detail: 'ok' }]),
      ],
    );
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await engine?.close();
    await db?.teardown();
  });

  it('is operations-only', async () => {
    expect((await queue(client.token)).statusCode).toBe(403);
  });

  it('lists the affected backsolves and nothing else', async () => {
    const body = (await queue()).json();
    const rows = body.stale_backsolves.rows as Array<{ company_name: string; published: boolean }>;
    expect(rows.map((r) => r.company_name).sort()).toEqual(['Stale Published Co', 'Stale Unpublished Co']);
    // The zero-pool run and the QA-only engagement are not backsolve defects.
    expect(rows.map((r) => r.company_name)).not.toContain('Clean Co');
    expect(body.stale_backsolves.published).toBe(1);
    expect(body.stale_backsolves.rerunnable).toBe(1);
  });

  it('lists a model-DLOM review with no DLOM check', async () => {
    const body = (await queue()).json();
    const rows = body.stale_qa_reviews.rows as Array<{
      company_name: string;
      dlom_method: string;
      applied_dlom: string;
      has_dlom_check: boolean;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.company_name).toBe('Stale QA Co');
    expect(rows[0]!.dlom_method).toBe('chaffee');
    // The figure the review should have graded and did not: 42% is over the
    // 35% benchmark, so this one published on a check that never ran.
    expect(Number(rows[0]!.applied_dlom)).toBeCloseTo(0.42);
    expect(rows[0]!.has_dlom_check).toBe(false);
  });

  it('re-runs an unpublished engagement and clears it from the queue', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/data-remediation/rerun',
      headers: authHeader(ops.token),
      payload: { valuation_ids: [unpublishedId] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().succeeded).toBe(1);

    const rows = (await queue()).json().stale_backsolves.rows as Array<{ company_name: string }>;
    expect(rows.map((r) => r.company_name)).not.toContain('Stale Unpublished Co');
  });

  /**
   * The one that matters. A published 409A is a signed document a client has
   * acted on; re-running the engine underneath it makes the platform disagree
   * with a document already out in the world, silently.
   */
  it('refuses to re-run a published engagement', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/data-remediation/rerun',
      headers: authHeader(ops.token),
      payload: { valuation_ids: [publishedId] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().succeeded).toBe(0);
    expect(res.json().results[0].error).toMatch(/published/i);

    // …and the stored figure is untouched.
    const { rows } = await pool.query<{ equity_value: string }>(
      'SELECT equity_value FROM calculations WHERE valuation_id = $1 ORDER BY created_at DESC LIMIT 1',
      [publishedId],
    );
    expect(Number(rows[0]!.equity_value)).toBe(9_000_000);

    // It stays listed, because it still needs a human decision.
    const listed = (await queue()).json().stale_backsolves.rows as Array<{ company_name: string }>;
    expect(listed.map((r) => r.company_name)).toContain('Stale Published Co');
  });

  it('refuses an id that is not in the queue at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/data-remediation/rerun',
      headers: authHeader(ops.token),
      payload: { valuation_ids: [newUlid()] },
    });
    expect(res.json().failed).toBe(1);
  });

  it('records the sweep on the audit spine', async () => {
    const { rows } = await pool.query<{ type: string }>(
      `SELECT type FROM admin_events WHERE type = 'data_remediation_rerun'`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
