import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import { MAX_SCENARIOS } from '../../src/routes/scenarios.js';
import { deleteScenario, findScenarioById } from '../../src/repos/scenarios.js';

const dbUp = await isDbAvailable();

/**
 * Saved scenarios — the half of `routes/scenarios.ts` with no tests at all.
 *
 * `scenarios.test.ts` covers the sandbox: boot it, preview a case, confirm
 * nothing is persisted. The three routes that *do* persist — save, list,
 * delete — had none, which is most of what left the file at 73.6% branch
 * coverage.
 *
 * The delete rule is the one that matters. A saved case carries somebody's
 * name on it and is compared side by side against the official figure, so who
 * may remove one is not a formality: ops can prune anything, everyone else only
 * what they saved themselves.
 */
describe.skipIf(!dbUp)('saved scenarios', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let otherClient: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;
  /** An engagement that never calculated. */
  let barrenId: string;

  let engineShouldFail = false;

  const BASE_INPUTS = {
    income: { discount_rate: 0.25, terminal_growth: 0.03, free_cash_flows: [100_000, 200_000] },
    market: { metric: 5_000_000, multiples: [4, 6] },
    volatility: 0.6,
    shares_outstanding_common: 10_000_000,
  };

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);

    engineStub = Fastify({ logger: false });
    engineStub.post('/engine/v1/compute', async (req, reply) => {
      if (engineShouldFail) {
        return reply.status(422).send({ detail: 'income.discount_rate must exceed terminal_growth' });
      }
      const body = req.body as { inputs?: { income?: { discount_rate?: number } } };
      const dr = body.inputs?.income?.discount_rate ?? 0.25;
      const equity = Math.round(20_000_000 * (0.25 / dr));
      return reply.send({
        engine_version: 'py-stub',
        results: { equity_value: equity, fmv_per_share: equity / 10_000_000, approaches: { income: {} } },
      });
    });
    await engineStub.listen({ port: 0, host: '127.0.0.1' });
    const address = engineStub.server.address();
    const enginePort = typeof address === 'object' && address ? address.port : 0;

    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      ENGINE_URL: `http://127.0.0.1:${enginePort}`,
      AUTO_PIPELINE: 'off',
    });
    app = buildApp({ config, pool });
    await app.ready();

    const seedCtx = { app, pool, teardown: async () => {} };
    ops = await seedUser(seedCtx, { roles: ['reviewer'] });
    client = await seedUser(seedCtx, { roles: ['valuation_user'] });
    otherClient = await seedUser(seedCtx, { roles: ['valuation_user'] });

    valuationId = await newValuation('SavedCaseCo');
    barrenId = await newValuation('NeverCalculatedCo');

    const calc = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/calculations`,
      headers: authHeader(ops.token),
      payload: { inputs: BASE_INPUTS },
    });
    expect(calc.statusCode).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
    await engineStub?.close();
    await db?.teardown();
  });

  async function newValuation(name: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(created.statusCode).toBe(201);
    return created.json().valuation.id as string;
  }

  const save = (payload: Record<string, unknown>, token = client.token, id = valuationId) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/scenarios`,
      headers: authHeader(token),
      payload,
    });

  const list = (token = client.token, id = valuationId) =>
    app.inject({ method: 'GET', url: `/api/v1/valuations/${id}/scenarios`, headers: authHeader(token) });

  const remove = (scenarioId: string, token = client.token, id = valuationId) =>
    app.inject({
      method: 'DELETE',
      url: `/api/v1/valuations/${id}/scenarios/${scenarioId}`,
      headers: authHeader(token),
    });

  let seq = 0;
  const uniqueName = () => `case-${(seq += 1)}`;

  // ── Saving ────────────────────────────────────────────────────────────────
  describe('saving a case', () => {
    it('computes it against the official baseline and stores both sides', async () => {
      const res = await save({ name: uniqueName(), label: 'bear', discount_rate: 0.5 });
      expect(res.statusCode, res.body).toBe(201);
      const s = res.json().scenario;
      expect(s.label).toBe('bear');
      // The knobs are stored, so the case can be explained later without
      // re-deriving it from the figure.
      expect(s.inputs).toMatchObject({ discount_rate: 0.5 });
      // Doubling the discount rate halves the value in the stub.
      expect(Number(s.equity_value)).toBe(10_000_000);
      expect(s.baseline_calculation_id).toBeTruthy();
    });

    it('defaults an unlabelled case to custom', async () => {
      const res = await save({ name: uniqueName() });
      expect(res.statusCode).toBe(201);
      expect(res.json().scenario.label).toBe('custom');
    });

    it('422s a case with no name, or a label outside the four', async () => {
      for (const payload of [
        {},
        { name: '' },
        { name: 'x'.repeat(101) },
        { name: uniqueName(), label: 'catastrophic' },
        { name: uniqueName(), discount_rate: 5 },
        { name: uniqueName(), multiples: [] },
      ]) {
        const res = await save(payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      }
    });

    it('422s a save on an engagement that has never calculated', async () => {
      // A scenario is a delta from an official figure. Without one there is
      // nothing to be a delta from.
      const res = await save({ name: uniqueName() }, client.token, barrenId);
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/no completed calculation/i);
    });

    it('reports an engine rejection as a problem rather than storing a broken case', async () => {
      engineShouldFail = true;
      try {
        const before = (await list()).json().scenarios.length;
        const res = await save({ name: uniqueName(), discount_rate: 0.02 });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.json().detail).toBeTruthy();
        // Nothing persisted — a saved case that never computed would sit in the
        // comparison table with empty figures.
        expect((await list()).json().scenarios.length).toBe(before);
      } finally {
        engineShouldFail = false;
      }
    });

    it('caps a valuation at its scenario limit and says how to proceed', async () => {
      const id = await newValuation('FullHouseCo');
      const calc = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/calculations`,
        headers: authHeader(ops.token),
        payload: { inputs: BASE_INPUTS },
      });
      expect(calc.statusCode).toBe(201);

      for (let i = 0; i < MAX_SCENARIOS; i++) {
        const res = await save({ name: `cap-${i}` }, client.token, id);
        expect(res.statusCode, `case ${i}`).toBe(201);
      }
      const overflow = await save({ name: 'one-too-many' }, client.token, id);
      expect(overflow.statusCode).toBe(422);
      expect(overflow.json().detail).toContain(String(MAX_SCENARIOS));
      expect(overflow.json().detail).toMatch(/delete one first/i);

      // The cap is checked before the engine is asked, so the refusal costs
      // nothing.
      expect((await list(client.token, id)).json().scenarios.length).toBe(MAX_SCENARIOS);
    });
  });

  // ── Listing ───────────────────────────────────────────────────────────────
  describe('the comparison payload', () => {
    it('carries the cases, the baseline and the cap the UI enforces', async () => {
      const res = await list();
      expect(res.statusCode).toBe(200);
      expect(res.json().scenarios.length).toBeGreaterThan(0);
      expect(res.json().baseline).toBeTruthy();
      expect(res.json().max_scenarios).toBe(MAX_SCENARIOS);
      expect(res.json().currency).toBeTruthy();
    });

    it('reports a null baseline for an engagement that never calculated', async () => {
      // Not an error: the sandbox tab renders an empty state from this.
      const res = await list(client.token, barrenId);
      expect(res.statusCode).toBe(200);
      expect(res.json().baseline).toBeNull();
      expect(res.json().scenarios).toEqual([]);
    });

    /**
     * A saved case is the answer to the run it was struck against, and the
     * comparison table subtracts it from whatever run is official today.
     *
     * `baseline_calculation_id` has recorded which run that was since the table
     * was created and nothing read it, so the first recalculation of an
     * engagement turned every saved delta into knob-effect plus baseline drift
     * under a column headed "Δ vs baseline" — and the drift can be the larger
     * half. Here the second calculation *doubles* the equity value, so a bear
     * case saved 50% below the first baseline reads as 75% below the second,
     * and the row would have printed a loss the assumptions never caused.
     *
     * The row is not restated — it is what the client saved — so the flag is
     * what changes, and the UI drops the delta on it.
     */
    it('marks a case whose baseline has been superseded', async () => {
      const id = await newValuation('RecalculatedCo');
      const runCalculation = async (discountRate: number) => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${id}/calculations`,
          headers: authHeader(ops.token),
          payload: { inputs: { ...BASE_INPUTS, income: { ...BASE_INPUTS.income, discount_rate: discountRate } } },
        });
        expect(res.statusCode, res.body).toBe(201);
      };

      await runCalculation(0.25);
      const saved = await save({ name: uniqueName(), discount_rate: 0.5 }, client.token, id);
      expect(saved.statusCode, saved.body).toBe(201);

      const before = (await list(client.token, id)).json();
      expect(before.scenarios).toHaveLength(1);
      expect(before.scenarios[0].superseded).toBe(false);
      expect(before.scenarios[0].baseline_calculation_id).toBe(before.baseline.calculation_id);

      // A fresh official run at half the discount rate: the baseline doubles
      // under the case that is already on the table.
      await runCalculation(0.125);
      const after = (await list(client.token, id)).json();
      expect(after.baseline.calculation_id).not.toBe(before.baseline.calculation_id);
      expect(after.baseline.equity_value).toBeGreaterThan(before.baseline.equity_value);
      // The stored figures are untouched — the case is not restated.
      expect(after.scenarios[0].equity_value).toBe(before.scenarios[0].equity_value);
      expect(after.scenarios[0].superseded).toBe(true);
    });

    it('is invisible to someone who cannot read the engagement', async () => {
      for (const call of [list(otherClient.token), save({ name: uniqueName() }, otherClient.token)]) {
        expect((await call).statusCode).toBe(404);
      }
    });
  });

  // ── Deleting ──────────────────────────────────────────────────────────────
  describe('deleting a case', () => {
    async function saveOne(token = client.token): Promise<string> {
      const res = await save({ name: uniqueName() }, token);
      expect(res.statusCode, res.body).toBe(201);
      return res.json().scenario.id as string;
    }

    it('lets the person who saved it remove it', async () => {
      const scenarioId = await saveOne();
      expect((await remove(scenarioId)).statusCode).toBe(204);
      const ids = (await list()).json().scenarios.map((s: { id: string }) => s.id);
      expect(ids).not.toContain(scenarioId);
    });

    it('lets ops prune anyone’s', async () => {
      const scenarioId = await saveOne();
      expect((await remove(scenarioId, ops.token)).statusCode).toBe(204);
    });

    it('403s someone who can read the engagement but did not save the case', async () => {
      // 403 rather than 404 on purpose: the case is visible to them in the
      // comparison table, so pretending it does not exist would be a lie they
      // can see through.
      const scenarioId = await save({ name: uniqueName() }, ops.token);
      expect(scenarioId.statusCode).toBe(201);
      const res = await remove(scenarioId.json().scenario.id as string, client.token);
      expect(res.statusCode).toBe(403);
    });

    it('records the removal once when two deletes race off one read', async () => {
      // The route loads the row, then deletes it, and those are two statements
      // on two connections — so a double-clicked button reaches the repo twice
      // with the same row. The DELETE is idempotent; the event beside it was
      // not, and `scenario_deleted` is on an append-only trail the activity log
      // reads (round 356, methodology M3).
      const scenarioId = await saveOne();
      const scenario = await findScenarioById(pool, scenarioId);
      expect(scenario).not.toBeNull();
      const actor = { actorType: 'human' as const, actorId: client.id };
      await deleteScenario(pool, scenario!, actor);
      await deleteScenario(pool, scenario!, actor);

      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM valuation_events
          WHERE valuation_id = $1 AND type = 'scenario_deleted'
            AND payload->>'scenario_id' = $2`,
        [valuationId, scenarioId],
      );
      expect(rows[0]!.n).toBe('1');
    });

    it('404s a scenario id that is malformed or belongs to another engagement', async () => {
      const scenarioId = await saveOne();
      const other = await newValuation('ElsewhereCo');
      for (const [label, id, url] of [
        ['malformed', 'not-a-ulid', valuationId],
        ['absent', '01ARZ3NDEKTSV4RRFFQ69G5FAV', valuationId],
        ['cross-engagement', scenarioId, other],
      ] as const) {
        const res = await remove(id, client.token, url);
        expect(res.statusCode, label).toBe(404);
      }
    });
  });

  // ── Baseline bootstrap ────────────────────────────────────────────────────
  it('boots an uncalculated engagement with nulls rather than refusing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${barrenId}/scenarios/baseline`,
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().baseline).toBeNull();
    expect(res.json().defaults).toBeNull();
    expect(res.json().approaches).toBeNull();
    // The currency still comes back — the tab formats its empty state with it.
    expect(res.json().currency).toBeTruthy();
  });
});
