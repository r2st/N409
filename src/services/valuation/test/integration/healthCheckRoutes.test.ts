import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The health-check HTTP surface (`routes/healthChecks.ts`).
 *
 * `domain/healthChecks.ts` and `repos/healthChecks.ts` were both well covered
 * and the route between them was not, which is the gap that matters here: the
 * route is what enforces ops-only access and what decides whether the
 * finalization gate reads as satisfied. Neither of those is expressible in the
 * domain function — it is handed a calculation and told to score it.
 *
 * The gate is the subtle half. `satisfied` is true when there is nothing to
 * check, false when the latest calculation has no run against it, and false
 * again when a run exists but blocks — three different states that all have to
 * be distinguished by a caller deciding whether to let a report be finalized.
 */
describe.skipIf(!dbUp)('health check routes', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  /** A succeeded calculation whose results are clean enough not to block. */
  const seedCalculation = async (
    valuation: string,
    results: Record<string, unknown> = {
      approaches: { opm_backsolve: { method: 'backsolve_single', equity_value: 9_000_000 } },
      discounts: { dlom: 0.2, dlom_method: 'chaffee' },
    },
  ) => {
    const id = newUlid();
    await pool.query(
      `INSERT INTO calculations
         (id, valuation_id, engine_version, status, inputs, results, equity_value, fmv_per_share)
       VALUES ($1, $2, 'test-engine', 'succeeded', $3::jsonb, $4::jsonb, 9000000, 0.9)`,
      [id, valuation, JSON.stringify({ inputs: {} }), JSON.stringify(results)],
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
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  const run = (id: string, token = ops.token) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/health-checks`,
      headers: authHeader(token),
    });

  const list = (id: string, token = ops.token) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/health-checks`,
      headers: authHeader(token),
    });

  beforeAll(async () => {
    ctx = await setupTestApp();
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    valuationId = await createValuation('Health Check Co');
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  describe('access', () => {
    it('refuses a client on the run endpoint', async () => {
      const res = await run(valuationId, client.token);
      expect(res.statusCode).toBe(403);
    });

    it('refuses a client on the list endpoint', async () => {
      const res = await list(valuationId, client.token);
      expect(res.statusCode).toBe(403);
    });

    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/health-checks`,
      });
      expect(res.statusCode).toBe(401);
    });

    // A malformed id must not reach the database, and must not be
    // distinguishable from an id that simply is not there.
    it('404s a non-ULID id rather than erroring', async () => {
      const res = await list('not-a-ulid');
      expect(res.statusCode).toBe(404);
    });

    it('404s a well-formed id that does not exist', async () => {
      const res = await list(newUlid());
      expect(res.statusCode).toBe(404);
    });
  });

  describe('running a check', () => {
    it('is unprocessable when there is no succeeded calculation to check', async () => {
      const bare = await createValuation('No Calculation Co');
      const res = await run(bare);
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/run a calculation first/i);
    });

    it('stores a run and returns it', async () => {
      const calculationId = await seedCalculation(valuationId);
      const res = await run(valuationId);
      expect(res.statusCode).toBe(201);
      const row = res.json().health_check;
      expect(row.valuation_id).toBe(valuationId);
      expect(row.calculation_id).toBe(calculationId);
      expect(Array.isArray(row.checks)).toBe(true);
      expect(row.created_by).toBe(ops.id);
    });

    it('records each run rather than replacing the last', async () => {
      const before = (await list(valuationId)).json().health_checks.length;
      await run(valuationId);
      const after = (await list(valuationId)).json().health_checks.length;
      expect(after).toBe(before + 1);
    });
  });

  describe('the finalization gate', () => {
    it('is satisfied when there is no calculation to check at all', async () => {
      const bare = await createValuation('Nothing To Check Co');
      const body = (await list(bare)).json();
      expect(body.gate.satisfied).toBe(true);
      expect(body.gate.health_check_id).toBeNull();
      expect(body.latest_calculation_id).toBeNull();
    });

    it('is not satisfied when the latest calculation has never been checked', async () => {
      const fresh = await createValuation('Unchecked Calculation Co');
      const calculationId = await seedCalculation(fresh);
      const body = (await list(fresh)).json();
      expect(body.latest_calculation_id).toBe(calculationId);
      expect(body.gate.satisfied).toBe(false);
      expect(body.gate.health_check_id).toBeNull();
    });

    it('reports the run belonging to the latest calculation', async () => {
      const fresh = await createValuation('Gate Co');
      await seedCalculation(fresh);
      const created = (await run(fresh)).json().health_check;
      const body = (await list(fresh)).json();
      expect(body.gate.health_check_id).toBe(created.id);
      expect(body.gate.severity).toBe(created.severity);
      expect(body.gate.blocking).toBe(created.blocking);
      expect(body.gate.satisfied).toBe(!created.blocking);
    });

    /**
     * The regression this pins: a new calculation after a passing run must
     * reopen the gate. Carrying the old run forward would let a report be
     * finalized against numbers nothing ever checked.
     */
    it('reopens once a newer calculation supersedes the checked one', async () => {
      const fresh = await createValuation('Superseded Co');
      await seedCalculation(fresh);
      await run(fresh);
      expect((await list(fresh)).json().gate.health_check_id).not.toBeNull();

      const newer = await seedCalculation(fresh);
      const body = (await list(fresh)).json();
      expect(body.latest_calculation_id).toBe(newer);
      expect(body.gate.satisfied).toBe(false);
      expect(body.gate.health_check_id).toBeNull();
    });
  });
});
