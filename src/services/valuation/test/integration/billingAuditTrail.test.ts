import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_EVENT_CATALOG } from '../../src/domain/auditTrail.js';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * The billing surface on the audit spine.
 *
 * `admin_events` is the ledger an ops reviewer is pointed at when the question
 * is "what was done to this account", and every entitlement-changing action on
 * it was missing: a plan starting, a plan swapped inside Stripe's hosted
 * portal, a renewal declining, a subscription ending and an invoice settling.
 * Each of those told somebody by email and moved a number on the ops rollup,
 * and none of them left a row — so the trail could describe an administrator
 * editing a help article and not the day an account's quota doubled.
 *
 * Three things have to hold for the rows to be worth reading, and the parts
 * below are one apiece:
 *
 *   1. Each transition writes exactly one row, including the transitions Stripe
 *      reports twice. Two events describe one new subscription
 *      (`checkout.session.completed`, `customer.subscription.created`) and two
 *      describe one cancellation (`customer.subscription.updated` with
 *      `status: 'canceled'`, and `.deleted`); a trail that double-counts them
 *      cannot be counted at all.
 *   2. A row that arrives from Stripe says so — `system` / `stripe` — and
 *      carries the `stripe_event_id` that joins it to the delivery in Stripe's
 *      own dashboard, because no principal of ours took the action and the
 *      actor column alone is a dead end.
 *   3. The vocabulary and the handlers match in both directions: no billing
 *      event type nothing writes, no billing write with no type.
 */

const dbUp = await isDbAvailable();
const WEBHOOK_SECRET = 'whsec_billing_audit';

function signed(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

const uniq = () => crypto.randomBytes(6).toString('hex');

/** The billing half of the admin catalog, named once. */
const BILLING_EVENT_TYPES = [
  'checkout_started',
  'billing_portal_opened',
  'subscription_started',
  'subscription_changed',
  'subscription_canceled',
  'subscription_payment_failed',
  'invoice_paid',
  'invoice_refunded',
] as const;

const priceItem = (amountCents: number, interval: 'month' | 'year' = 'year') => ({
  data: [{ quantity: 1, price: { unit_amount: amountCents, currency: 'usd', recurring: { interval } } }],
});

describe.skipIf(!dbUp)('the billing audit spine', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  });
  afterAll(async () => ctx?.teardown());

  const webhook = (event: unknown) => {
    const payload = JSON.stringify(event);
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: signed(payload),
      payload,
    });
  };

  /** Every admin event on one account, oldest first. */
  const events = async (userId: string) => {
    const { rows } = await ctx.pool.query<{
      type: string;
      actor_type: string;
      actor_id: string | null;
      source: string | null;
      subject_type: string;
      subject_id: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT type, actor_type, actor_id, source, subject_type, subject_id, payload
         FROM admin_events WHERE subject_id = $1 ORDER BY occurred_at ASC, id ASC`,
      [userId],
    );
    return rows;
  };
  const billingEvents = async (userId: string) =>
    (await events(userId)).filter((e) => (BILLING_EVENT_TYPES as readonly string[]).includes(e.type));

  const subscriptionEvent = (
    type: string,
    subId: string,
    userId: string,
    over: Record<string, unknown> = {},
  ) => ({
    id: `evt_${uniq()}`,
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: subId,
        metadata: { user_id: userId, plan_tier: 'annual_retainer' },
        status: 'active',
        customer: `cus_${uniq()}`,
        items: priceItem(2_000_000),
        ...over,
      },
    },
  });

  it('records a subscription starting, once, as Stripe rather than as a user', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const subId = `sub_start_${uniq()}`;
    expect(
      (await webhook(subscriptionEvent('customer.subscription.created', subId, user.id))).statusCode,
    ).toBe(200);

    const rows = await billingEvents(user.id);
    expect(rows.map((r) => r.type)).toEqual(['subscription_started']);
    const row = rows[0]!;
    // Truthful attribution: Stripe is not one of our principals.
    expect(row.actor_type).toBe('system');
    expect(row.actor_id).toBeNull();
    expect(row.source).toBe('stripe');
    // ...and the correlation that keeps that from being a dead end.
    expect(String(row.payload.stripe_event_id)).toMatch(/^evt_/);
    expect(row.payload.stripe_subscription_id).toBe(subId);
    expect(row.payload.plan_tier).toBe('annual_retainer');
    // Subjected to the account, so one customer's billing history is one filter.
    expect(row.subject_type).toBe('user');
  });

  it('writes one start for the two events that describe one new subscription', async () => {
    // `checkout.session.completed` and `customer.subscription.created` both
    // land for one plan, in no guaranteed order. Keyed off the event type this
    // is two "Subscription started" rows for one subscription; keyed off which
    // statement created the row — what `inserted` reports — it is one.
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const subId = `sub_pair_${uniq()}`;
    const checkout = {
      id: `evt_${uniq()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_${uniq()}`,
          mode: 'subscription',
          payment_status: 'paid',
          subscription: subId,
          customer: `cus_${uniq()}`,
          metadata: { user_id: user.id, plan_tier: 'annual_retainer' },
        },
      },
    };
    expect((await webhook(checkout)).statusCode).toBe(200);
    expect(
      (await webhook(subscriptionEvent('customer.subscription.created', subId, user.id))).statusCode,
    ).toBe(200);

    const rows = await billingEvents(user.id);
    expect(rows.filter((r) => r.type === 'subscription_started')).toHaveLength(1);
  });

  it('records a plan change as a field-level from/to, and a no-op change as nothing', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const subId = `sub_upgrade_${uniq()}`;
    await webhook(subscriptionEvent('customer.subscription.created', subId, user.id));

    // The same reading again, as a distinct delivery: Stripe re-sends
    // `customer.subscription.updated` for changes this platform does not carry.
    expect(
      (await webhook(subscriptionEvent('customer.subscription.updated', subId, user.id))).statusCode,
    ).toBe(200);
    expect((await billingEvents(user.id)).map((r) => r.type)).toEqual(['subscription_started']);

    // Now an upgrade made in Stripe's portal: the item is repriced to the
    // enterprise tier and the metadata still says what checkout stamped.
    expect(
      (
        await webhook(
          subscriptionEvent('customer.subscription.updated', subId, user.id, {
            items: priceItem(5_000_000),
          }),
        )
      ).statusCode,
    ).toBe(200);

    const rows = await billingEvents(user.id);
    expect(rows.map((r) => r.type)).toEqual(['subscription_started', 'subscription_changed']);
    const changes = rows[1]!.payload.changes as Record<string, { from: unknown; to: unknown }>;
    expect(changes.plan_tier).toEqual({ from: 'annual_retainer', to: 'enterprise' });
  });

  it('writes one cancellation for the two events that describe one ending', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const subId = `sub_end_${uniq()}`;
    await webhook(subscriptionEvent('customer.subscription.created', subId, user.id));

    expect(
      (
        await webhook(
          subscriptionEvent('customer.subscription.updated', subId, user.id, { status: 'canceled' }),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await webhook({
          id: `evt_${uniq()}`,
          type: 'customer.subscription.deleted',
          created: Math.floor(Date.now() / 1000),
          data: { object: { id: subId } },
        })
      ).statusCode,
    ).toBe(200);

    const rows = await billingEvents(user.id);
    expect(rows.filter((r) => r.type === 'subscription_canceled')).toHaveLength(1);
  });

  it('records a declined renewal every time it declines', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const subId = `sub_dunning_${uniq()}`;
    await webhook(subscriptionEvent('customer.subscription.created', subId, user.id));

    const failure = () => ({
      id: `evt_${uniq()}`,
      type: 'invoice.payment_failed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: { id: `in_${uniq()}`, subscription: subId, amount_due: 2_000_000, currency: 'usd' },
      },
    });
    expect((await webhook(failure())).statusCode).toBe(200);
    // A second decline on an account already past due is a second failed
    // payment, not a repeat of the first — the run of them is the whole signal.
    expect((await webhook(failure())).statusCode).toBe(200);

    const failed = (await billingEvents(user.id)).filter((r) => r.type === 'subscription_payment_failed');
    expect(failed).toHaveLength(2);
    expect(failed[0]!.payload.amount_due_cents).toBe(2_000_000);
    expect(failed[0]!.payload.currency).toBe('usd');
  });

  it('records one settled invoice for the pair of settlement events', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const stripeInvoiceId = `in_paid_${uniq()}`;
    const object = {
      id: stripeInvoiceId,
      metadata: { user_id: user.id },
      amount_paid: 2_000_000,
      currency: 'usd',
      description: 'Annual retainer',
    };
    const [a, b] = await Promise.all([
      webhook({ id: `evt_${uniq()}`, type: 'invoice.paid', data: { object } }),
      webhook({ id: `evt_${uniq()}`, type: 'invoice.payment_succeeded', data: { object } }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);

    const paid = (await billingEvents(user.id)).filter((r) => r.type === 'invoice_paid');
    expect(paid).toHaveLength(1);
    expect(paid[0]!.payload.stripe_invoice_id).toBe(stripeInvoiceId);
    expect(paid[0]!.payload.amount_cents).toBe(2_000_000);
    expect(String(paid[0]!.payload.invoice_number)).not.toBe('');
  });

  it('refuses to rewrite or erase a billing audit row', async () => {
    // The spine is only evidence if it is append-only, and that is a property
    // of the table rather than of the callers: `admin_events` carries the same
    // BEFORE UPDATE OR DELETE trigger `valuation_events` has.
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const subId = `sub_immutable_${uniq()}`;
    await webhook(subscriptionEvent('customer.subscription.created', subId, user.id));
    const rows = await billingEvents(user.id);
    expect(rows).toHaveLength(1);

    await expect(
      ctx.pool.query("UPDATE admin_events SET payload = '{}'::jsonb WHERE subject_id = $1", [user.id]),
    ).rejects.toThrow(/append-only/);
    await expect(ctx.pool.query('DELETE FROM admin_events WHERE subject_id = $1', [user.id])).rejects.toThrow(
      /append-only/,
    );
  });
});

// ── The vocabulary against the handlers ──────────────────────────────────────

describe('the billing vocabulary', () => {
  const routeSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routes/billing.ts'),
    'utf8',
  );

  it('names every billing type in the admin catalog', () => {
    for (const type of BILLING_EVENT_TYPES) {
      expect(Object.keys(ADMIN_EVENT_CATALOG), `${type} has no descriptor`).toContain(type);
    }
  });

  it('leaves no billing type that nothing writes', () => {
    // The other direction, and the one that rots quietly: a type with a label
    // and no writer reads as a covered case. `invoice_refunded` is written by
    // the payments route rather than this one, so it is checked there.
    const written = BILLING_EVENT_TYPES.filter((t) => t !== 'invoice_refunded');
    const missing = written.filter((t) => !new RegExp(`'${t}'`).test(routeSource));
    expect(missing).toEqual([]);
  });

  it('grades an entitlement change above a receipt', () => {
    // Severity is what an ops reviewer filters on. The four rows that change
    // what an account is entitled to — or say the money stopped arriving — are
    // the ones a review has to see.
    for (const type of [
      'subscription_started',
      'subscription_changed',
      'subscription_canceled',
      'subscription_payment_failed',
    ] as const) {
      expect(ADMIN_EVENT_CATALOG[type].severity, type).toBe('critical');
    }
  });
});
