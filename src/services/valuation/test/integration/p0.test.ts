import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * P0 integrations (remaining-gaps §6): Stripe payments, signature workflow,
 * extraction auto-apply, and the three-table sensitivity dashboard.
 */

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('P0 features API', () => {
  let ctx: TestApp;
  let ops: { id: string; email: string; token: string };
  let client: { id: string; email: string; token: string };

  const createValuation = async (companyName: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  // ── Payments ────────────────────────────────────────────────────────────────
  describe('payments', () => {
    it('503s on checkout when Stripe is not configured (never a crash)', async () => {
      const vid = await createValuation('Pay Co');
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/payments/checkout`,
        headers: authHeader(ops.token),
        payload: {},
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().detail).toMatch(/STRIPE_SECRET_KEY/);
    });

    it('lists payments (empty) with valuation-scoped auth', async () => {
      const vid = await createValuation('Pay List Co');
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/payments`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().payments).toEqual([]);

      // Out-of-scope client sees 404, not 403 — same rule as valuations.
      const scoped = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/payments`,
        headers: authHeader(client.token),
      });
      expect(scoped.statusCode).toBe(404);
    });

    it('rejects unsigned webhook calls', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/stripe/webhook',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ type: 'checkout.session.completed' }),
      });
      // Secret unset in tests → 503 (config), never a silent 200.
      expect(res.statusCode).toBe(503);
    });
  });

  // ── Signatures + publish gate ───────────────────────────────────────────────
  describe('signatures', () => {
    it('records, replaces, and deletes signatures; ops-only', async () => {
      const vid = await createValuation('Sig Co');

      const forbidden = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/signatures`,
        headers: authHeader(client.token),
        payload: { role: 'main', signer_name: 'Client', signature_text: '/s/ Client' },
      });
      expect(forbidden.statusCode).toBe(403);

      const first = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/signatures`,
        headers: authHeader(ops.token),
        payload: { role: 'main', signer_name: 'Ada', signer_title: 'Analyst', signature_text: '/s/ Ada' },
      });
      expect(first.statusCode).toBe(201);

      // Re-signing the same role replaces, not duplicates.
      const second = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/signatures`,
        headers: authHeader(ops.token),
        payload: { role: 'main', signer_name: 'Bea', signature_text: '/s/ Bea' },
      });
      expect(second.statusCode).toBe(201);

      const list = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/signatures`,
        headers: authHeader(ops.token),
      });
      const { signatures } = list.json();
      expect(signatures).toHaveLength(1);
      expect(signatures[0].signer_name).toBe('Bea');

      const del = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${vid}/signatures/main`,
        headers: authHeader(ops.token),
      });
      expect(del.statusCode).toBe(204);
    });

    it('refuses a signature that is only whitespace', async () => {
      /*
       * `min(2)` is a character count and two spaces are two characters, so a
       * blank signature was a 201. `hasMainSignature` is the publish gate and
       * asks only whether a row exists, and `reportSignatures` draws both
       * fields onto the certification page — so the engagement published, and
       * the section of the 409A whose whole purpose is to say who stands
       * behind the conclusion printed `/s/` with nothing after it.
       */
      const vid = await createValuation('Blank Sig Co');
      for (const payload of [
        { role: 'main', signer_name: '   ', signature_text: '/s/ Ada' },
        { role: 'main', signer_name: 'Ada', signature_text: '  ' },
      ]) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${vid}/signatures`,
          headers: authHeader(ops.token),
          payload,
        });
        expect(res.statusCode).toBe(422);
        expect(res.json().detail).toMatch(/whitespace/i);
      }

      // Nothing was written, so the publish gate still has nothing to see.
      const list = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/signatures`,
        headers: authHeader(ops.token),
      });
      expect(list.json().signatures).toHaveLength(0);
    });

    it('gates the workflow advance into published', async () => {
      const vid = await createValuation('Gate Co');
      // Walk the happy path to draft_accepted.
      for (const state of [
        'started',
        'onboarding_completed',
        'user_finished',
        'completed',
        'review',
        'reviewed',
        'drafted',
        'draft_accepted',
      ]) {
        const res = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/valuations/${vid}`,
          headers: authHeader(ops.token),
          payload: { state },
        });
        expect(res.statusCode).toBe(200);
      }

      const blocked = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/workflow/advance`,
        headers: authHeader(ops.token),
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().detail).toMatch(/main signature/i);

      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/signatures`,
        headers: authHeader(ops.token),
        payload: { role: 'main', signer_name: 'Ada', signature_text: '/s/ Ada' },
      });
      const advanced = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/workflow/advance`,
        headers: authHeader(ops.token),
      });
      expect(advanced.statusCode).toBe(200);
      expect(advanced.json().valuation.state).toBe('published');
    });
  });

  // ── Extraction auto-apply ───────────────────────────────────────────────────
  describe('extract apply', () => {
    it('applies the latest successful extraction into params.engine_inputs', async () => {
      const vid = await createValuation('Apply Co');

      const empty = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/ai/extract/apply`,
        headers: authHeader(ops.token),
      });
      expect(empty.statusCode).toBe(422); // nothing to apply yet

      // Seed a succeeded extract job directly (the AI service is not running here).
      await ctx.pool.query(
        `INSERT INTO ai_jobs (id, valuation_id, pipeline, status, model, input, result, completed_at)
         VALUES ($1, $2, 'extract', 'succeeded', 'test/model', '{}',
                 '{"engine_inputs": {"cash": 1500000, "shares_outstanding_common": 8000000}}', now())`,
        [newUlid(), vid],
      );

      const applied = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/ai/extract/apply`,
        headers: authHeader(ops.token),
      });
      expect(applied.statusCode).toBe(200);
      expect(applied.json().applied_inputs).toEqual({
        cash: 1500000,
        shares_outstanding_common: 8000000,
      });

      const params = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/params`,
        headers: authHeader(ops.token),
      });
      expect(params.json().params.engine_inputs).toMatchObject({ cash: 1500000 });
    });
  });

  // ── Sensitivity dashboard ───────────────────────────────────────────────────
  describe('sensitivity tables', () => {
    it('returns the three-table dashboard alongside the classic grid', async () => {
      const vid = await createValuation('Stress Co');
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/sensitivity`,
        headers: authHeader(ops.token),
        payload: {
          equity_value_cents: 2_000_000_000,
          strike_cents: 500_000_000,
          volatility: 0.6,
          term_years: 3,
          risk_free_rate: 0.04,
          common_shares: 8_000_000,
          dlom: 0.3,
        },
      });
      expect(res.statusCode).toBe(200);
      const { sensitivity } = res.json();
      expect(sensitivity.rows).toHaveLength(5); // classic grid intact
      expect(Object.keys(sensitivity.tables).sort()).toEqual(['rfr_term', 'rfr_vol', 'term_vol']);
      expect(sensitivity.tables.rfr_vol.rowValues).toEqual([0.02, 0.03, 0.04, 0.05, 0.06]);
      expect(sensitivity.base.riskFreeRate).toBe(0.04);
      // Center cell of every table is the base case.
      for (const table of Object.values(sensitivity.tables) as Array<{
        rows: Array<Array<{ deltaFromBase: number }>>;
      }>) {
        expect(table.rows[2]![2]!.deltaFromBase).toBe(0);
      }
    });
  });
});
