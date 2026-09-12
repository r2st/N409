import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import {
  authHeader,
  isDbAvailable,
  SEEDED_PASSWORD,
  seedPartner,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';

const dbUp = await isDbAvailable();

const COMPLETE_ANSWERS = {
  legal_name: 'Quota Robotics, Inc.',
  state_of_incorporation: 'Delaware',
  incorporation_date: '2021-03-04',
  industry: 'Robotics',
  business_description: 'Autonomous warehouse robots.',
  revenue_status: 'post_revenue',
  total_shares_outstanding: 10_000_000,
  has_articles: true,
};

/**
 * The plan's valuation quota, at every door that opens an engagement (R449).
 *
 * `flowBilling.test.ts` proves `POST /valuations` draws each new engagement
 * against the plan and refuses the thirteenth on a twelve-a-year retainer. The
 * platform has three more doors that open an engagement for a user, and none
 * of them asked: a client rolling last year's 409A forward through
 * `/clone` — the engagement an annual retainer exists to count — the partner
 * API's create under the same account's key, and a firm converting a
 * submitted intake questionnaire. The thirteenth was one press of "Roll
 * forward" away.
 *
 * Each door is driven twice: exhausted, where the refusal is the only thing
 * that can come back, and with headroom, where a 201 must move the counter by
 * exactly one. The pairing is what makes the 402 evidence of the draw rather
 * than of something else refusing the request.
 */
describe.skipIf(!dbUp)('the plan quota at every door that opens an engagement', () => {
  let ctx: TestApp;
  let firmId: string;
  /** A firm user on an annual retainer — the account every door is metered on. */
  let subscriber: { id: string; token: string };
  let ops: { id: string; token: string };
  let apiKey: string;

  const RETAINER_LIMIT = 12;

  beforeAll(async () => {
    ctx = await setupTestApp(
      { AUTO_PIPELINE: 'off' },
      { partnerApiLimiter: new FixedWindowRateLimiter(1000, 60_000) },
    );
    firmId = await seedPartner(ctx, 'Retained Advisory');
    subscriber = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    ops = await seedUser(ctx, { roles: ['admin'] });
    await ctx.pool.query(
      `INSERT INTO subscriptions (id, user_id, plan_tier, status, stripe_subscription_id, stripe_customer_id)
       VALUES ($1, $2, 'annual_retainer', 'active', $3, $4)`,
      [newUlid(), subscriber.id, 'sub_quota_doors', 'cus_quota_doors'],
    );
    const minted = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/partners/${firmId}/tokens`,
      headers: authHeader(subscriber.token),
      payload: { current_password: SEEDED_PASSWORD, name: 'quota doors' },
    });
    expect(minted.statusCode).toBe(201);
    apiKey = minted.json().secret as string;
  }, 120_000);

  afterAll(async () => ctx?.teardown());

  const used = async (): Promise<number> => {
    const { rows } = await ctx.pool.query<{ valuations_used: number }>(
      'SELECT valuations_used FROM subscriptions WHERE user_id = $1',
      [subscriber.id],
    );
    return rows[0]!.valuations_used;
  };
  const setUsed = (n: number) =>
    ctx.pool.query('UPDATE subscriptions SET valuations_used = $2 WHERE user_id = $1', [subscriber.id, n]);

  /** An engagement of the subscriber's, opened outside the meter. */
  const seedOwned = async (name: string): Promise<string> => {
    await setUsed(0);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(subscriber.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  const expectPlanLimit = (res: { statusCode: number; json: () => { type?: string; detail?: string } }) => {
    expect(res.statusCode).toBe(402);
    expect(res.json().type).toContain('plan-limit');
    expect(res.json().detail).toContain('/billing');
  };

  describe('POST /valuations/:id/clone', () => {
    it('refuses a roll-forward once the plan is spent', async () => {
      const source = await seedOwned('Rolled Forward Co');
      await setUsed(RETAINER_LIMIT);
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${source}/clone`,
        headers: authHeader(subscriber.token),
        payload: { roll_forward: true },
      });
      expectPlanLimit(res);
      expect(await used()).toBe(RETAINER_LIMIT);
    });

    it('draws exactly one when there is headroom', async () => {
      const source = await seedOwned('Headroom Co');
      await setUsed(RETAINER_LIMIT - 1);
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${source}/clone`,
        headers: authHeader(subscriber.token),
        payload: { roll_forward: true },
      });
      expect(res.statusCode).toBe(201);
      expect(await used()).toBe(RETAINER_LIMIT);
    });

    it('meters the owner, not the operator, when ops clone on their behalf', async () => {
      const source = await seedOwned('Ops Cloned Co');
      await setUsed(RETAINER_LIMIT);
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${source}/clone`,
        headers: authHeader(ops.token),
        payload: {},
      });
      // The clone is opened for the source's owner (`userId = source.user_id`
      // on the ops path), so it is the owner's plan that answers — the same
      // account `POST /valuations` meters when ops name `user_id`.
      expectPlanLimit(res);
      expect(await used()).toBe(RETAINER_LIMIT);
    });
  });

  describe('POST /api/partner/v1/valuations', () => {
    const create = (name: string, key = `key-${name}-${newUlid()}`) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/partner/v1/valuations',
        headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': key },
        payload: { kind: '409a', company_name: name, currency: 'USD' },
      });

    it('refuses the create once the plan is spent', async () => {
      await setUsed(RETAINER_LIMIT);
      expectPlanLimit(await create('Over The Key Co'));
      expect(await used()).toBe(RETAINER_LIMIT);
    });

    it('draws exactly one when there is headroom, and not again on a replay', async () => {
      await setUsed(RETAINER_LIMIT - 1);
      const key = `replayed-${newUlid()}`;
      const first = await create('Metered Key Co', key);
      expect(first.statusCode).toBe(201);
      expect(await used()).toBe(RETAINER_LIMIT);
      // The draw sits inside the idempotency claim: a replay is answered from
      // the receipt and the counter does not move — which, with the plan now
      // spent, is also the difference between a replayed 201 and a 402.
      const replay = await create('Metered Key Co', key);
      expect(replay.statusCode).toBe(201);
      expect(replay.json().valuation.id).toBe(first.json().valuation.id);
      expect(await used()).toBe(RETAINER_LIMIT);
    });
  });

  describe('POST /firm/intake-links/:id/convert', () => {
    const submitted = async (): Promise<string> => {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/firm/intake-links',
        headers: authHeader(subscriber.token),
        payload: { client_name: 'Convertible Co' },
      });
      expect(created.statusCode).toBe(201);
      const { token, link } = created.json() as { token: string; link: { id: string } };
      const saved = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake/portal/answers',
        payload: { token, answers: COMPLETE_ANSWERS },
      });
      expect(saved.statusCode).toBe(200);
      const done = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake/portal/submit',
        payload: { token },
      });
      expect(done.statusCode).toBe(200);
      return link.id;
    };
    const convert = (id: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/firm/intake-links/${id}/convert`,
        headers: authHeader(subscriber.token),
        payload: {},
      });

    it('refuses the conversion once the plan is spent, and leaves the link convertible', async () => {
      const id = await submitted();
      await setUsed(RETAINER_LIMIT);
      expectPlanLimit(await convert(id));
      expect(await used()).toBe(RETAINER_LIMIT);
      // Nothing was opened, so the link is still waiting for its engagement.
      const { rows } = await ctx.pool.query<{ valuation_id: string | null }>(
        'SELECT valuation_id FROM client_intake_links WHERE id = $1',
        [id],
      );
      expect(rows[0]!.valuation_id).toBeNull();
    });

    it('draws exactly one when there is headroom', async () => {
      const id = await submitted();
      await setUsed(RETAINER_LIMIT - 1);
      expect((await convert(id)).statusCode).toBe(201);
      expect(await used()).toBe(RETAINER_LIMIT);
    });

    it('returns the draw when the conversion is refused by the transaction', async () => {
      const id = await submitted();
      await setUsed(0);
      expect((await convert(id)).statusCode).toBe(201);
      expect(await used()).toBe(1);
      // A second conversion is turned away *inside* the transaction, after the
      // draw — and the draw comes back, so a refused press costs nothing.
      expect((await convert(id)).statusCode).toBe(409);
      expect(await used()).toBe(1);
    });
  });

  it('leaves an account with no subscription unmetered at every door', async () => {
    const outsider = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(outsider.token),
      payload: { kind: '409a', company_name: 'Per Valuation Co' },
    });
    expect(created.statusCode).toBe(201);
    const cloned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${created.json().valuation.id}/clone`,
      headers: authHeader(outsider.token),
      payload: { roll_forward: true },
    });
    expect(cloned.statusCode).toBe(201);
  });
});
