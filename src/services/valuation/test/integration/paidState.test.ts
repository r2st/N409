import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPayment } from '../../src/repos/payments.js';
import { priceForKind } from '../../src/routes/payments.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * The `paid` lifecycle state (migration 0107) — the fifteenth state, and the
 * gate between "the client has given us everything" and "an analyst has picked
 * it up".
 *
 * Two things have to hold for it to be a state rather than a label: the enum
 * has to accept it, and something real has to put a valuation into it. The
 * second is the point of most of this file — a gate nothing ever passes
 * through is decoration, and a gate that closes on the engagements that will
 * never be settled through Stripe is worse than decoration.
 */

const WEBHOOK_SECRET = 'whsec_paid_state_test';

function signedHeaders(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('the paid lifecycle state', () => {
  let ctx: TestApp;
  let ops: { id: string; email: string; token: string };

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

  const setState = async (id: string, state: string): Promise<void> => {
    await ctx.pool.query('UPDATE valuations SET state = $2 WHERE id = $1', [id, state]);
  };

  const stateOf = async (id: string): Promise<string> => {
    const { rows } = await ctx.pool.query<{ state: string }>('SELECT state FROM valuations WHERE id = $1', [
      id,
    ]);
    return rows[0]!.state;
  };

  const advance = async (id: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/workflow/advance`,
      headers: authHeader(ops.token),
    });

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
    ops = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  it('exists in the valuation_state enum, positioned between completed and review', async () => {
    const { rows } = await ctx.pool.query<{ labels: string[] }>(
      `SELECT array_agg(enumlabel::text ORDER BY enumsortorder) AS labels
         FROM pg_enum WHERE enumtypid = 'valuation_state'::regtype`,
    );
    const labels = rows[0]!.labels;
    expect(labels).toHaveLength(15);
    expect(labels.indexOf('paid')).toBe(labels.indexOf('completed') + 1);
    expect(labels.indexOf('review')).toBe(labels.indexOf('paid') + 1);
  });

  it('accepts paid as a stored state', async () => {
    const vid = await createValuation('Enum Co');
    await setState(vid, 'paid');
    expect(await stateOf(vid)).toBe('paid');
  });

  describe('advancing out of completed', () => {
    it('routes around the gate when the money has not arrived', async () => {
      // Production has no Stripe keys configured, so this is every live
      // valuation. If the gate defaulted to closed they would all strand here.
      const vid = await createValuation('Unpaid Co');
      await setState(vid, 'completed');

      expect((await advance(vid)).statusCode).toBe(200);
      expect(await stateOf(vid)).toBe('review');
    });

    it('passes a settled file through paid, then on to review', async () => {
      const vid = await createValuation('Settled Co');
      await setState(vid, 'completed');
      await ctx.pool.query(`UPDATE valuations SET paid_status = 'paid' WHERE id = $1`, [vid]);

      expect((await advance(vid)).statusCode).toBe(200);
      expect(await stateOf(vid)).toBe('paid');

      expect((await advance(vid)).statusCode).toBe(200);
      expect(await stateOf(vid)).toBe('review');
    });

    it('treats partner-settled money as settled', async () => {
      const vid = await createValuation('Partner Paid Co');
      await setState(vid, 'completed');
      await ctx.pool.query(`UPDATE valuations SET paid_status = 'paid_by_partner' WHERE id = $1`, [vid]);

      expect((await advance(vid)).statusCode).toBe(200);
      expect(await stateOf(vid)).toBe('paid');
    });
  });

  describe('settlement moves the workflow', () => {
    const fulfil = async (vid: string, sessionId: string) => {
      await createPayment(ctx.pool, {
        valuationId: vid,
        sessionId,
        amountCents: priceForKind('409a'),
        currency: 'USD',
        createdBy: ops.id,
      });
      const event = JSON.stringify({
        type: 'checkout.session.completed',
        data: { object: { id: sessionId, payment_intent: `pi_${sessionId}`, amount_total: 119_000 } },
      });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/stripe/webhook',
        headers: signedHeaders(event),
        payload: event,
      });
      expect(res.statusCode).toBe(200);
    };

    it('moves a completed valuation to paid when the money lands', async () => {
      const vid = await createValuation('Stripe Gate Co');
      await setState(vid, 'completed');

      await fulfil(vid, 'cs_paid_gate_1');

      expect(await stateOf(vid)).toBe('paid');
      const { rows } = await ctx.pool.query<{ paid_status: string; paid_at: Date | null }>(
        'SELECT paid_status, paid_at FROM valuations WHERE id = $1',
        [vid],
      );
      expect(rows[0]!.paid_status).toBe('paid');
      // paid_at is the payment layer's to set. Entering the state must not
      // also stamp it, or the two writes collide in one UPDATE.
      expect(rows[0]!.paid_at).not.toBeNull();
    });

    it('records the transition on the audit spine', async () => {
      const vid = await createValuation('Audit Gate Co');
      await setState(vid, 'completed');

      await fulfil(vid, 'cs_paid_gate_audit');

      const { rows } = await ctx.pool.query<{ type: string; payload: unknown }>(
        `SELECT type, payload FROM valuation_events
          WHERE valuation_id = $1 AND type = 'state_changed'
          ORDER BY occurred_at DESC, seq DESC LIMIT 1`,
        [vid],
      );
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0]!.payload)).toContain('paid');
    });

    it('leaves a valuation that never reached the gate where it is', async () => {
      // Money on a file still in intake says nothing about where the work got
      // to; jumping it to `paid` would skip the states in between.
      const vid = await createValuation('Early Payer Co');
      await setState(vid, 'started');

      await fulfil(vid, 'cs_paid_gate_early');

      expect(await stateOf(vid)).toBe('started');
      const { rows } = await ctx.pool.query<{ paid_status: string }>(
        'SELECT paid_status FROM valuations WHERE id = $1',
        [vid],
      );
      expect(rows[0]!.paid_status).toBe('paid');
    });

    it('does not rewind a file that is already past the gate', async () => {
      const vid = await createValuation('Late Payer Co');
      await setState(vid, 'drafted');

      await fulfil(vid, 'cs_paid_gate_late');

      expect(await stateOf(vid)).toBe('drafted');
    });
  });

  describe('dashboard placement', () => {
    it('counts a paid valuation as open, not as in review', async () => {
      const vid = await createValuation('Grouping Co');
      await setState(vid, 'paid');

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations?group=open&per_page=100',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().valuations.map((v: { id: string }) => v.id)).toContain(vid);

      const inReview = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations?group=in_review&per_page=100',
        headers: authHeader(ops.token),
      });
      expect(inReview.json().valuations.map((v: { id: string }) => v.id)).not.toContain(vid);
    });
  });
});
