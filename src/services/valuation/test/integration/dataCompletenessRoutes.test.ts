import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { applyEngineInputs } from '../../src/repos/params.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * `GET /api/v1/valuations/:id/completeness` (`routes/dataCompleteness.ts`).
 *
 * `domain/dataCompleteness.ts` scores a subject it is handed; the route is what
 * decides *which* subject — it assembles params, questionnaire, cap table and
 * documents, and unwraps `engine_inputs` off the params row. That assembly is
 * the untested part, and getting it wrong is silent: the score still comes back
 * looking plausible, just computed against an empty evidence base.
 *
 * The access rule is the other half, and it is deliberately not the ops-only
 * rule the health checks use — anyone who can read the valuation can ask what
 * it is still waiting on. What that must not become is a way to discover that
 * somebody else's engagement exists, so an unreadable one is a 404 and not a
 * 403.
 */
describe.skipIf(!dbUp)('data completeness route', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let stranger: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const createValuation = async (company: string, token = client.token) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { kind: '409a', company_name: company },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  const completeness = (id: string, token = client.token) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/completeness`,
      headers: authHeader(token),
    });

  beforeAll(async () => {
    ctx = await setupTestApp();
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    stranger = await seedUser(ctx, { roles: ['valuation_user'] });
    valuationId = await createValuation('Completeness Co');
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  describe('access', () => {
    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/completeness`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('lets the owning client read it — this is not ops-only', async () => {
      expect((await completeness(valuationId)).statusCode).toBe(200);
    });

    it('lets ops read it', async () => {
      expect((await completeness(valuationId, ops.token)).statusCode).toBe(200);
    });

    // 404 rather than 403: whether a valuation exists is itself scoped, so a
    // stranger must not be able to tell an engagement they cannot read from one
    // that does not exist.
    it('404s for a client who does not own it, hiding its existence', async () => {
      const res = await completeness(valuationId, stranger.token);
      expect(res.statusCode).toBe(404);
    });

    it('404s a non-ULID id rather than erroring', async () => {
      expect((await completeness('not-a-ulid')).statusCode).toBe(404);
    });

    it('404s a well-formed id that does not exist', async () => {
      expect((await completeness(newUlid())).statusCode).toBe(404);
    });

    it('404s a partner who is not on the engagement', async () => {
      const partnerId = await seedPartner(ctx, 'Unrelated Partner');
      const partner = await seedUser(ctx, { roles: ['partner'], partnerId });
      expect((await completeness(valuationId, partner.token)).statusCode).toBe(404);
    });
  });

  describe('the report it returns', () => {
    it('returns a scored report with severity counts', async () => {
      const body = (await completeness(valuationId)).json();
      expect(body.completeness).toBeDefined();
      expect(typeof body.completeness.score).toBe('number');
      expect(body.completeness.counts).toMatchObject({
        blocking: expect.any(Number),
        important: expect.any(Number),
        optional: expect.any(Number),
      });
      expect(Array.isArray(body.completeness.gaps)).toBe(true);
    });

    it('reports gaps for a brand-new engagement with no evidence at all', async () => {
      const bare = await createValuation('Empty Evidence Co');
      const body = (await completeness(bare)).json();
      expect(body.completeness.gaps.length).toBeGreaterThan(0);
      expect(body.completeness.counts.blocking).toBeGreaterThan(0);
    });

    /**
     * The assembly bug this pins. `engine_inputs` is a JSON blob on the params
     * row, and the route unwraps it before scoring; if that unwrap regressed to
     * passing the row itself — or to `{}` — the financial gaps would be scored
     * against nothing and the response would still look entirely normal.
     */
    it('scores against engine_inputs on the params row, not an empty object', async () => {
      const subject = await createValuation('Engine Inputs Co');
      // Weight the market approach on LTM revenue, which is what makes
      // `revenue_ltm` a figure this engagement is actually missing. Without a
      // weight the scorer asks for nothing, and the assembly would look correct
      // whether or not engine_inputs ever reached it.
      await pool.query(
        `UPDATE valuation_params
            SET weight_market = 1, weight_opm = 0, weight_income = 0, weight_asset = 0,
                market_method = 'revenue', market_horizon = 'ltm'
          WHERE valuation_id = $1`,
        [subject],
      );

      const gapKeys = async (): Promise<string[]> =>
        (await completeness(subject)).json().completeness.gaps.map((g: { key: string }) => g.key);

      expect(await gapKeys()).toContain('financials.revenue_ltm');

      // The production writer rather than raw SQL, so this test moves with the
      // shape the rest of the service actually stores.
      await applyEngineInputs(
        pool,
        subject,
        { revenue_ltm: 4_200_000 },
        {
          actorType: 'human',
          actorId: client.id,
        },
      );

      // The gap clears only if the route unwrapped engine_inputs off the params
      // row and handed it to the scorer.
      expect(await gapKeys()).not.toContain('financials.revenue_ltm');
    });

    /**
     * The route guards `engine_inputs` with a `typeof === 'object' && !== null`
     * check before scoring against it. The column is `NOT NULL DEFAULT '{}'`,
     * so null is unreachable — but jsonb happily holds a bare scalar, and that
     * is the shape that would otherwise be spread into the subject and reach
     * the scorer as something it cannot read. The fallback has to hold.
     */
    it('falls back to an empty object when engine_inputs is a jsonb scalar', async () => {
      const subject = await createValuation('Scalar Inputs Co');
      await pool.query(`UPDATE valuation_params SET engine_inputs = '5'::jsonb WHERE valuation_id = $1`, [
        subject,
      ]);
      const res = await completeness(subject);
      expect(res.statusCode).toBe(200);
      expect(res.json().completeness.gaps.length).toBeGreaterThan(0);
    });

    // Computed on demand rather than stored, so two reads with nothing changed
    // in between must agree — a drifting score would mean the assembly is
    // reading something non-deterministic.
    it('is stable across repeated reads', async () => {
      const first = (await completeness(valuationId)).json().completeness;
      const second = (await completeness(valuationId)).json().completeness;
      expect(second.score).toBe(first.score);
      expect(second.gaps.map((g: { key: string }) => g.key)).toEqual(
        first.gaps.map((g: { key: string }) => g.key),
      );
    });
  });
});
