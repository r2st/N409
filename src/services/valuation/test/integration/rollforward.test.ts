import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Roll-forward — the bridge from the prior 409A to this one (migration 0150).
 *
 * Three behaviours carry the claim this feature makes and are why this file
 * exists:
 *
 *   * the prior engagement is authorised on its own, so its concluded equity
 *     value cannot be read out through a valuation the caller *can* see;
 *   * running is not adopting. A run leaves the engagement's engine inputs
 *     exactly as they were, and only the apply call moves the anchor the next
 *     calculation will be struck on;
 *   * adopting clears the prior round price. `compute` prefers a round price
 *     over the post-money anchor, so a rolled value adopted beside a stale
 *     price would be thrown away and the value re-derived off last year's
 *     round — the failure the engine's own `pre_populated_inputs` exists to
 *     prevent and the one this route has to carry through.
 *
 * The engine is stubbed: what is under test is the wiring, and the arithmetic
 * belongs to engine-wrapper's own suite (tests/test_rollforward.py).
 */

/** Stands in for `engine/v1/rollforward`. */
async function startEngineStub() {
  const stub = Fastify({ logger: false });
  let lastBody: Record<string, unknown> = {};
  let reply: Record<string, unknown> | null = null;
  let status = 200;
  stub.post('/engine/v1/rollforward', async (req, res) => {
    lastBody = (req.body ?? {}) as Record<string, unknown>;
    if (status !== 200) return res.status(status).send({ detail: 'new_valuation_date is required' });
    return (
      reply ?? {
        prior_valuation_date: '2025-06-30',
        new_valuation_date: '2026-06-30',
        years_elapsed: 1.0,
        prior_equity_value: 33_600_000,
        rolled_equity_value: 42_000_000,
        annual_accretion: 0.25,
        calibration_steps: [
          { step: 'prior_equity_value', value: 33_600_000 },
          { step: 'time_accretion', annual_rate: 0.25, years: 1.0, factor: 1.25, value: 42_000_000 },
        ],
        material_changes: [
          { field: 'revenue', material: false, detail: 'revenue moved +4.0%', delta_pct: 0.04 },
        ],
        requires_full_revaluation: false,
        pre_populated_inputs: {
          valuation_date: '2026-06-30',
          last_round_post_money: 42_000_000,
        },
      }
    );
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => stub.close(),
    body: () => lastBody,
    setReply: (next: Record<string, unknown> | null) => {
      reply = next;
    },
    setStatus: (next: number) => {
      status = next;
    },
  };
}

describe.skipIf(!dbUp)('roll-forward', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engine: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let stranger: Awaited<ReturnType<typeof seedUser>>;
  /** This year's engagement, and last year's. */
  let currentId: string;
  let priorId: string;
  /** An engagement belonging to somebody else entirely. */
  let foreignId: string;

  const createValuation = async (token: string, name: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { kind: '409a', company_name: name },
    });
    return res.json().valuation.id;
  };

  const seedCalculation = (valuationId: string, results: Record<string, unknown>, inputs: unknown) =>
    pool.query(
      `INSERT INTO calculations (id, valuation_id, engine_version, status, inputs, results)
       VALUES ($1, $2, 'test', 'succeeded', $3::jsonb, $4::jsonb)`,
      [newUlid(), valuationId, JSON.stringify(inputs), JSON.stringify(results)],
    );

  const setEngineInputs = (valuationId: string, inputs: Record<string, unknown>) =>
    pool.query('UPDATE valuation_params SET engine_inputs = $2::jsonb WHERE valuation_id = $1', [
      valuationId,
      JSON.stringify(inputs),
    ]);

  const readEngineInputs = async (valuationId: string): Promise<Record<string, unknown>> => {
    const { rows } = await pool.query<{ engine_inputs: Record<string, unknown> }>(
      'SELECT engine_inputs FROM valuation_params WHERE valuation_id = $1',
      [valuationId],
    );
    return rows[0]?.engine_inputs ?? {};
  };

  const list = (valuationId = currentId, token = ops.token) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/rollforward`,
      headers: authHeader(token),
    });

  const run = (payload: Record<string, unknown>, token = ops.token, valuationId = currentId) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/rollforward`,
      headers: authHeader(token),
      payload,
    });

  const apply = (runId: string, token = ops.token, valuationId = currentId) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/rollforward/${runId}/apply`,
      headers: authHeader(token),
    });

  beforeAll(async () => {
    engine = await startEngineStub();
    ctx = await setupTestApp({ ENGINE_URL: engine.url });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    stranger = await seedUser(ctx, { roles: ['valuation_user'] });

    currentId = await createValuation(client.token, 'Northwind Robotics');
    priorId = await createValuation(client.token, 'Northwind Robotics');
    foreignId = await createValuation(stranger.token, 'Someone Else, Inc.');

    await seedCalculation(
      priorId,
      { equity_value: 33_600_000, approaches: { income: { discount_rate: 0.28 } } },
      { params: {}, inputs: { valuation_date: '2025-06-30', revenue: 6_000_000 } },
    );
    await seedCalculation(
      foreignId,
      { equity_value: 999_000_000 },
      { params: {}, inputs: { valuation_date: '2025-06-30' } },
    );
    await setEngineInputs(currentId, {
      valuation_date: '2026-06-30',
      revenue: 6_240_000,
      last_round_post_money: 30_000_000,
      last_round_price_per_share: 1.25,
      last_round_class: 'Series A',
      // The benchmark that moved *last* year's round indication forward, so
      // adopting a rolled anchor has something stale to supersede.
      market_movement: { index_start: 100, index_end: 120 },
    });
  });

  afterAll(async () => {
    await ctx?.teardown();
    await engine?.close();
  });

  it('starts with no runs and reports the date one would roll forward to', async () => {
    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(res.json().runs).toEqual([]);
    expect(res.json().new_valuation_date).toBe('2026-06-30');
    expect(res.json().applied_anchor).toBe(30_000_000);
    expect(res.json().rolling_forward).toBe(false);
  });

  it('is invisible to someone who cannot read the engagement', async () => {
    expect((await list(currentId, stranger.token)).statusCode).toBe(404);
  });

  it('lets the engagement owner read the runs but not start one', async () => {
    const read = await list(currentId, client.token);
    expect(read.statusCode).toBe(200);
    expect(read.json().can_edit).toBe(false);
    const res = await run({ prior_valuation_id: priorId }, client.token);
    expect(res.statusCode).toBe(403);
  });

  it('resolves the prior valuation through the same read check as reading it', async () => {
    // The whole substance of the answer is the prior engagement's concluded
    // equity value, so the prior id goes through `canReadValuation` on its own
    // rather than riding on the current engagement's authorisation. A 404
    // either way, so the endpoint never distinguishes "no such valuation" from
    // "not yours". Every ops role scopes to the whole table today (rbac.ts
    // `valuationScope`), so an engagement belonging to a stranger is legitimately
    // readable *by ops* — which is why what is exercised here is the id that
    // resolves to nothing.
    expect((await run({ prior_valuation_id: newUlid() })).statusCode).toBe(404);
    // A *malformed* id is 422 since round 331: `prior_valuation_id` is
    // `ulidField()`, so the schema names the field rather than letting the
    // string reach a lookup. That leaks nothing the 404 above protects —
    // "this is not an id" is not an answer about whether one exists.
    expect((await run({ prior_valuation_id: 'not-a-ulid' })).statusCode).toBe(422);
    // And an ops caller may legitimately bridge from an engagement they do not
    // own, which is the case that would break if this were scoped by owner.
    expect((await run({ prior_valuation_id: foreignId })).statusCode).toBe(201);
  });

  it('refuses to roll a valuation forward from itself', async () => {
    const res = await run({ prior_valuation_id: currentId });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/from itself/i);
  });

  it('refuses a prior engagement that has never computed', async () => {
    const fresh = await createValuation(client.token, 'Never Computed, Inc.');
    const res = await run({ prior_valuation_id: fresh });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/no successful calculation/i);
  });

  it('sends the prior conclusion, both dates and the prior cost of capital', async () => {
    const res = await run({ prior_valuation_id: priorId });
    expect(res.statusCode).toBe(201);

    const body = engine.body();
    expect(body.prior_valuation_date).toBe('2025-06-30');
    expect(body.new_valuation_date).toBe('2026-06-30');
    expect((body.prior_results as Record<string, unknown>).equity_value).toBe(33_600_000);
    // The rate the prior appraisal itself concluded, not the engine's flat
    // fallback: that is the figure a reviewer can challenge.
    expect(body.annual_accretion).toBe(0.28);
    // Both input documents, so the engine can detect what changed between them.
    expect((body.prior_inputs as Record<string, unknown>).revenue).toBe(6_000_000);
    expect((body.updated_inputs as Record<string, unknown>).revenue).toBe(6_240_000);
  });

  it('stores the trail and the change list, not just the two ends', async () => {
    const res = await list();
    const [row] = res.json().runs as Array<Record<string, unknown>>;
    expect(row!.prior_equity_value).toBe(33_600_000);
    expect(row!.rolled_equity_value).toBe(42_000_000);
    expect(row!.calibration_steps).toHaveLength(2);
    expect(row!.material_changes).toHaveLength(1);
    expect(row!.material_change_count).toBe(0);
    expect(row!.requires_full_revaluation).toBe(false);
    expect(row!.prior_valuation_number).toBeTruthy();
    expect(row!.applied_at).toBeNull();
  });

  it('leaves the engagement’s anchor exactly where it was', async () => {
    // Running is not adopting. A run that quietly moved the anchor would change
    // the concluded value of a valuation somebody may be mid-review on.
    const inputs = await readEngineInputs(currentId);
    expect(inputs.last_round_post_money).toBe(30_000_000);
    expect((await list()).json().applied_anchor).toBe(30_000_000);
  });

  it('prefers an accretion the analyst states over the prior appraisal’s rate', async () => {
    const res = await run({ prior_valuation_id: priorId, annual_accretion: 0.12 });
    expect(res.statusCode).toBe(201);
    expect(engine.body().annual_accretion).toBe(0.12);
  });

  it('passes a new priced round and the analyst’s adjustments through', async () => {
    const res = await run({
      prior_valuation_id: priorId,
      new_round_post_money: 60_000_000,
      value_adjustments: [{ label: 'Secondary mark', pct: -0.1 }],
    });
    expect(res.statusCode).toBe(201);
    expect(engine.body().new_round_post_money).toBe(60_000_000);
    expect(engine.body().value_adjustments).toEqual([{ label: 'Secondary mark', pct: -0.1 }]);
    expect(res.json().run.new_round_post_money).toBe(60_000_000);
  });

  it('refuses an adjustment that says neither pct nor amount', async () => {
    const res = await run({
      prior_valuation_id: priorId,
      value_adjustments: [{ label: 'Something happened' }],
    });
    expect(res.statusCode).toBe(422);
  });

  it('refuses a non-finite figure rather than storing it as null', async () => {
    // `1e999` parses to Infinity, which stringifies back to null through jsonb.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${currentId}/rollforward`,
      headers: { ...authHeader(ops.token), 'content-type': 'application/json' },
      payload: `{"prior_valuation_id":"${priorId}","annual_accretion":1e999}`,
    });
    expect(res.statusCode).toBe(422);
  });

  it('refuses to bridge two currencies', async () => {
    // One equity value carried forward, so a euro-denominated prior conclusion
    // and a dollar-denominated new one cannot be two ends of the same bridge.
    const euro = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Northwind GmbH', currency: 'EUR' },
    });
    const euroId = euro.json().valuation.id as string;
    await seedCalculation(
      euroId,
      { equity_value: 20_000_000 },
      { params: {}, inputs: { valuation_date: '2025-06-30' } },
    );
    const res = await run({ prior_valuation_id: euroId });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/cannot cross currencies/i);
  });

  it('refuses a kind that concludes no equity value, in its own words', async () => {
    /*
     * A roll-forward compounds a prior appraisal's concluded *equity value*
     * forward, and the engine reads that figure off the prior run's stored
     * results. A specialty engine writes `{ kind, specialty }` and states no
     * equity value, so this used to reach the engine and come back as
     * `prior_results.equity_value (positive) is required` — the only sentence
     * the analyst sees, in the wire vocabulary of a service they have never
     * heard of, about a request the product knew was unanswerable.
     */
    const emi = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: 'emi', company_name: 'Northwind UK Ltd' },
    });
    const emiId = emi.json().valuation.id as string;
    // With an ordinary 409A compute against it, which the Calculations tab
    // offers on every kind: the refusal is about what the engagement *is*, not
    // about which button was pressed last against it.
    await seedCalculation(
      emiId,
      { equity_value: 20_000_000 },
      { params: {}, inputs: { valuation_date: '2025-06-30' } },
    );

    const asPrior = await run({ prior_valuation_id: emiId });
    expect(asPrior.statusCode).toBe(422);
    expect(asPrior.json().detail).toMatch(/concludes no equity value/i);
    expect(asPrior.json().detail).not.toMatch(/prior_results/);

    // And onto one, because adopting a run writes the rolled value onto this
    // engagement's backsolve anchor, which an EMI engagement does not have.
    const onto = await run({ prior_valuation_id: priorId }, ops.token, emiId);
    expect(onto.statusCode).toBe(422);
    expect(onto.json().detail).toMatch(/concludes no equity value/i);
  });

  it('refuses to run backwards in time', async () => {
    await setEngineInputs(currentId, { valuation_date: '2024-01-01' });
    const res = await run({ prior_valuation_id: priorId });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/runs forward in time/i);
  });

  it('refuses an engagement with no valuation date to roll forward to', async () => {
    await setEngineInputs(currentId, { revenue: 6_240_000 });
    const res = await run({ prior_valuation_id: priorId });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/no valuation date/i);
    expect((await list()).json().new_valuation_date).toBeNull();
  });

  it('surfaces an engine refusal as a 422 rather than a 500', async () => {
    await setEngineInputs(currentId, {
      valuation_date: '2026-06-30',
      last_round_post_money: 30_000_000,
      last_round_price_per_share: 1.25,
      last_round_class: 'Series A',
    });
    engine.setStatus(422);
    const res = await run({ prior_valuation_id: priorId });
    expect(res.statusCode).toBe(422);
    engine.setStatus(200);
  });

  it('refuses a response with no usable rolled value rather than storing one', async () => {
    engine.setReply({
      prior_valuation_date: '2025-06-30',
      new_valuation_date: '2026-06-30',
      years_elapsed: 1,
      prior_equity_value: 33_600_000,
      rolled_equity_value: null,
      annual_accretion: 0.25,
    });
    const res = await run({ prior_valuation_id: priorId });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/rolled equity value/i);
    engine.setReply(null);
  });

  describe('adopting a run', () => {
    let runId: string;

    beforeAll(async () => {
      const res = await run({ prior_valuation_id: priorId });
      expect(res.statusCode).toBe(201);
      runId = res.json().run.id;
    });

    it('is operations-only', async () => {
      expect((await apply(runId, client.token)).statusCode).toBe(403);
    });

    it('404s on a run that belongs to another engagement', async () => {
      expect((await apply(newUlid())).statusCode).toBe(404);
    });

    it('moves the anchor and says the engagement needs recalculating', async () => {
      const res = await apply(runId);
      expect(res.statusCode).toBe(200);
      expect(res.json().applied_anchor).toBe(42_000_000);
      expect(res.json().recalculation_required).toBe(true);
      expect(res.json().run.applied_at).not.toBeNull();
      expect((await readEngineInputs(currentId)).last_round_post_money).toBe(42_000_000);
    });

    it('clears the superseded round price and the class that named it', async () => {
      // The failure this prevents: `compute` root-finds off a round price when
      // one is present, so a rolled anchor adopted beside last year's $1.25
      // would be discarded and the value re-derived from the stale price.
      const inputs = await readEngineInputs(currentId);
      expect(inputs.last_round_price_per_share).toBeNull();
      expect(inputs.last_round_class).toBeNull();
    });

    it('clears the superseded benchmark adjustment', async () => {
      // Sharper than the price, because it multiplies the anchor instead of
      // replacing it: `market_movement` moves a round indication over the
      // interval the rolled value has already been carried across, so left in
      // place the same market move is applied twice.
      expect((await readEngineInputs(currentId)).market_movement).toBeNull();
    });

    it('ticks the rolling_forward flag the params table has always carried', async () => {
      const { rows } = await pool.query<{ rolling_forward: boolean }>(
        'SELECT rolling_forward FROM valuation_params WHERE valuation_id = $1',
        [currentId],
      );
      expect(rows[0]!.rolling_forward).toBe(true);
      expect((await list()).json().rolling_forward).toBe(true);
    });

    it('is idempotent — re-applying keeps the first adoption’s timestamp', async () => {
      const first = (await list()).json().runs.find((r: { id: string }) => r.id === runId).applied_at;
      const again = await apply(runId);
      expect(again.statusCode).toBe(200);
      expect(again.json().run.applied_at).toBe(first);
      // And the second call is no longer a change to anything.
      expect(again.json().recalculation_required).toBe(false);
    });

    it('records the adoption in the admin event trail', async () => {
      const { rows } = await pool.query<{ type: string; payload: Record<string, unknown> }>(
        `SELECT type, payload FROM admin_events
          WHERE subject_id = $1 AND type = 'rollforward_applied'
          ORDER BY occurred_at DESC LIMIT 1`,
        [currentId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload.to).toBe(42_000_000);
      expect(rows[0]!.payload.cleared_round_price).toBe(true);
      expect(rows[0]!.payload.cleared_market_movement).toBe(true);
    });

    it('keeps the round price when the new date supplies one of its own', async () => {
      // The engine decides this, in `pre_populated_inputs`: a price stated for
      // the *new* date is a market observation the roll-forward has not
      // superseded, and the route follows its answer rather than forming one.
      engine.setReply({
        prior_valuation_date: '2025-06-30',
        new_valuation_date: '2026-06-30',
        years_elapsed: 1,
        prior_equity_value: 33_600_000,
        rolled_equity_value: 55_000_000,
        annual_accretion: 0,
        calibration_steps: [{ step: 'new_round_post_money', value: 55_000_000 }],
        material_changes: [{ field: 'new_round', material: true, detail: 'a new priced round' }],
        requires_full_revaluation: true,
        pre_populated_inputs: {
          valuation_date: '2026-06-30',
          last_round_post_money: 55_000_000,
          last_round_price_per_share: 2.4,
          last_round_class: 'Series B',
          market_movement: { index_start: 120, index_end: 132 },
        },
      });
      const created = await run({ prior_valuation_id: priorId, new_round_post_money: 55_000_000 });
      expect(created.statusCode).toBe(201);
      expect(created.json().run.requires_full_revaluation).toBe(true);

      // A price on the engagement to see survive the adoption.
      await setEngineInputs(currentId, {
        valuation_date: '2026-06-30',
        last_round_post_money: 42_000_000,
        last_round_price_per_share: 1.9,
        last_round_class: 'Series A',
        market_movement: { index_start: 100, index_end: 110 },
      });
      const res = await apply(created.json().run.id);
      expect(res.statusCode).toBe(200);
      const inputs = await readEngineInputs(currentId);
      expect(inputs.last_round_post_money).toBe(55_000_000);
      // Untouched: the route only clears what the engine dropped.
      expect(inputs.last_round_price_per_share).toBe(1.9);
      expect(inputs.last_round_class).toBe('Series A');
      expect(inputs.market_movement).toEqual({ index_start: 100, index_end: 110 });
      engine.setReply(null);
    });
  });
});
