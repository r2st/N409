/**
 * Money that landed on work that had been called off (R401, methodology M11).
 *
 * R400 shut the checkout door: `unpayableReason` refuses to open a Checkout
 * Session for a retired or closed engagement, and it wrote the consequence of
 * the ones that get through down in as many words — "the money buys a closed
 * engagement and needs a hand-issued refund".
 *
 * What no door can shut is the window between the two. A Checkout Session
 * lives for hours: the client has the pay panel open, ops cancel the
 * engagement that afternoon, the client pays. Every instrument on the
 * settlement path then reported a healthy sale — the settlement line is `info`
 * and worded 'the engagement has been paid for', the advance to `paid` is
 * skipped in silence because the state is not `completed`, and the client is
 * emailed a receipt. So the refund the code knows is owed depended entirely on
 * somebody noticing, and the one surface that would have shown it — the pay
 * panel — now correctly refuses to say anything at all.
 *
 * Driven through the real webhook handler rather than by calling the log
 * directly: the claim is about the settlement path, and a unit test of a
 * predicate passes whether or not that path consults it.
 */

import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Writable } from 'node:stream';
import { createPayment } from '../../src/repos/payments.js';
import { findValuationById } from '../../src/repos/valuations.js';
import { priceForKind } from '../../src/routes/payments.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const WEBHOOK_SECRET = 'whsec_stopped_settlement';
const dbUp = await isDbAvailable();

function signedHeaders(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

const T = Math.floor(Date.UTC(2026, 8, 3, 10, 0, 0) / 1000);

describe.skipIf(!dbUp)('a checkout that settles after the engagement stopped', () => {
  let ctx: TestApp;
  let lines: Array<Record<string, unknown>>;

  beforeAll(async () => {
    // `setupTestApp` runs at 'silent', which would leave the log assertions
    // reading an empty array and passing for the wrong reason.
    ctx = await setupTestApp({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, LOG_LEVEL: 'info' });
    // `alertBilling` writes to holders of BILLING_ALERT_ROLES, and to nobody
    // else here: the owner is deliberately not told (see the note at the call
    // site). Without one on the estate every notification assertion below
    // would pass by having nobody to write to.
    await seedUser(ctx, { roles: ['admin'] });
    lines = [];
    (ctx.app.log as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
        cb();
      },
    });
  });
  afterAll(async () => ctx?.teardown());

  const deliver = (event: unknown) => {
    const payload = JSON.stringify(event);
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/stripe/webhook',
      headers: signedHeaders(payload),
      payload,
    });
  };

  const completed = (eventId: string, sessionId: string) => ({
    id: eventId,
    type: 'checkout.session.completed',
    created: T,
    data: {
      object: { id: sessionId, mode: 'payment', payment_status: 'paid', amount_total: priceForKind('409a') },
    },
  });

  /** A live engagement with a Checkout Session already open against it. */
  async function seedCheckout(company: string, sessionId: string) {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const vid = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(user.token),
        payload: { kind: '409a', company_name: company },
      })
    ).json().valuation.id as string;
    await createPayment(ctx.pool, {
      valuationId: vid,
      sessionId,
      amountCents: priceForKind('409a'),
      currency: 'USD',
      createdBy: user.id,
    });
    return { user, vid };
  }

  const alertsFor = (valuationId: string) =>
    lines.filter((l) => l.alert === true && l.valuationId === valuationId);

  const opsNotices = async (valuationId: string) =>
    (
      await ctx.pool.query(
        `SELECT count(*)::int AS n FROM notifications
          WHERE valuation_id = $1 AND type = 'payment_on_stopped_engagement'`,
        [valuationId],
      )
    ).rows[0].n as number;

  it('alerts when the money lands on an engagement ops had cancelled', async () => {
    const { vid } = await seedCheckout('Cancelled Mid-Checkout Co', 'cs_stopped_cancelled');
    // The close happens while the client is on the Stripe page — the window
    // R400's checkout gate cannot reach.
    await ctx.pool.query(`UPDATE valuations SET state = 'cancelled'::valuation_state WHERE id = $1`, [vid]);

    const res = await deliver(completed('evt_stopped_cancelled', 'cs_stopped_cancelled'));
    expect(res.statusCode).toBe(200);

    // The money really did land — this is not a refusal, and asserting it keeps
    // the alert below from being read as "the settlement was blocked".
    expect((await findValuationById(ctx.pool, vid))?.paid_status).toBe('paid');

    const alerts = alertsFor(vid);
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0]!.msg)).toContain('called off');
    // The fields an operator needs to act without opening the Stripe dashboard.
    expect(alerts[0]).toMatchObject({
      unpayableReason: 'closed',
      valuationState: 'cancelled',
      amountCents: priceForKind('409a'),
    });

    // And a person is told, not only the journal.
    expect(await opsNotices(vid)).toBeGreaterThan(0);
  });

  it('alerts on a retired engagement too', async () => {
    const { vid } = await seedCheckout('Retired Mid-Checkout Co', 'cs_stopped_retired');
    await ctx.pool.query(`UPDATE valuations SET archived_at = now() WHERE id = $1`, [vid]);

    expect((await deliver(completed('evt_stopped_retired', 'cs_stopped_retired'))).statusCode).toBe(200);

    const alerts = alertsFor(vid);
    expect(alerts).toHaveLength(1);
    // Retirement is checked ahead of closure, so a retired file says so even
    // though its state is untouched.
    expect(alerts[0]).toMatchObject({ unpayableReason: 'retired' });
    expect(await opsNotices(vid)).toBeGreaterThan(0);
  });

  it('says nothing about an ordinary settlement', async () => {
    const { vid } = await seedCheckout('Ordinary Sale Co', 'cs_stopped_none');

    expect((await deliver(completed('evt_stopped_none', 'cs_stopped_none'))).statusCode).toBe(200);

    // Non-vacuity for the two cases above: the settlement did run, so a green
    // assertion here is the absence of an alert rather than the absence of a
    // delivery.
    expect((await findValuationById(ctx.pool, vid))?.paid_status).toBe('paid');
    expect(alertsFor(vid)).toEqual([]);
    expect(await opsNotices(vid)).toBe(0);
  });
});
