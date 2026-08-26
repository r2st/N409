import crypto from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import {
  BILLING_SUBSCRIPTION_STATUSES,
  canTransitionInvoice,
  INVOICE_INITIAL_STATUSES,
  INVOICE_REACHABLE_STATUSES,
  INVOICE_STATUSES,
  INVOICE_TRANSITIONS,
  invoiceNumber,
  isTerminalInvoiceStatus,
  SERVED_SUBSCRIPTION_STATUSES,
  type InvoiceStatus,
} from '../../src/domain/billing.js';
import {
  cancelSubscription,
  createInvoice,
  findInvoiceByStripeId,
  nextInvoiceSequence,
  upsertSubscription,
} from '../../src/repos/billing.js';
import { listNotifications } from '../../src/repos/notifications.js';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * The billing state machine, stated and then exercised.
 *
 * Two entities carry a lifecycle here and neither had its edges written down
 * anywhere: `invoices.status` (draft / open / paid / void) and
 * `subscriptions.status` (active / trialing / past_due / canceled). What
 * existed were the two CHECK constraints — the *states*, with nothing saying
 * which moves between them are legal, what fires on each, or what a second
 * delivery of the same transition does.
 *
 * The four parts below supply it, in order: the declared machine; the censuses
 * that stop it drifting from the schema and from the code; every invoice
 * transition and non-transition driven through the real webhook; and the same
 * for subscriptions.
 */

const dbUp = await isDbAvailable();
const WEBHOOK_SECRET = 'whsec_state_machine';

function signed(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

const uniq = () => crypto.randomBytes(6).toString('hex');

// ── Part 1: the declared machine ─────────────────────────────────────────────

describe('the declared invoice state machine', () => {
  it('gives every status an entry, and names no status that is not one', () => {
    expect(Object.keys(INVOICE_TRANSITIONS).sort()).toEqual([...INVOICE_STATUSES].sort());
    for (const [from, tos] of Object.entries(INVOICE_TRANSITIONS)) {
      for (const to of tos) {
        expect(INVOICE_STATUSES, `${from} → ${to} names an undeclared status`).toContain(to);
      }
    }
  });

  it('has no self-edges — a redelivery is not a transition', () => {
    // The distinction the whole file turns on. Recording the same fact twice
    // must be a no-op, not a move, so no status may list itself.
    for (const status of INVOICE_STATUSES) {
      expect(INVOICE_TRANSITIONS[status], `${status} lists itself`).not.toContain(status);
    }
  });

  it('makes both endings terminal and neither beginning terminal', () => {
    expect(isTerminalInvoiceStatus('paid')).toBe(true);
    expect(isTerminalInvoiceStatus('void')).toBe(true);
    expect(isTerminalInvoiceStatus('draft')).toBe(false);
    expect(isTerminalInvoiceStatus('open')).toBe(false);
  });

  it('refuses the reversals, which is the property the ledger depends on', () => {
    // Nothing walks money backwards: a paid invoice cannot be re-opened,
    // re-drafted or voided, and a voided one is never revived.
    expect(canTransitionInvoice('paid', 'open')).toBe(false);
    expect(canTransitionInvoice('paid', 'draft')).toBe(false);
    expect(canTransitionInvoice('paid', 'void')).toBe(false);
    expect(canTransitionInvoice('void', 'open')).toBe(false);
    expect(canTransitionInvoice('void', 'paid')).toBe(false);
    expect(canTransitionInvoice('open', 'draft')).toBe(false);
    // ...and permits exactly the four that are real.
    expect(canTransitionInvoice('draft', 'open')).toBe(true);
    expect(canTransitionInvoice('draft', 'void')).toBe(true);
    expect(canTransitionInvoice('open', 'paid')).toBe(true);
    expect(canTransitionInvoice('open', 'void')).toBe(true);
  });

  it('leaves `void` reachable only by transition, never by creation', () => {
    expect(INVOICE_INITIAL_STATUSES).not.toContain('void');
    // ...and it is reachable, so excluding it from creation loses nothing.
    const reachesVoid = INVOICE_STATUSES.some((s) => INVOICE_TRANSITIONS[s].includes('void'));
    expect(reachesVoid).toBe(true);
  });

  it('states what the system actually produces, as a subset of what it permits', () => {
    for (const status of INVOICE_REACHABLE_STATUSES) {
      expect(INVOICE_STATUSES).toContain(status);
    }
  });
});

// ── Part 2: censuses — the machine against the schema, and against the code ──

/** Every `.ts` under the service's src tree. */
function sourceFiles(): Array<{ file: string; text: string }> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts'))
        out.push({ file: path.relative(root, full), text: readFileSync(full, 'utf8') });
    }
  };
  walk(root);
  return out;
}

describe('the invoice status census', () => {
  /**
   * Who writes `invoices.status`, according to the source.
   *
   * A grep rather than a runtime check because the property being asserted is
   * an absence — "nothing updates this column" — and an absence cannot be
   * observed by calling anything. The register below is the whole surface;
   * adding a writer fails here until it is declared.
   */
  it('has no statement anywhere that updates an invoice status', () => {
    const offenders: string[] = [];
    const files = sourceFiles();
    expect(files.length, 'the source scan found no files').toBeGreaterThan(0);
    for (const { file, text } of files) {
      // Each `UPDATE invoices ... SET <clause> WHERE`, however it is wrapped.
      const re = /UPDATE\s+invoices\b([\s\S]*?)\bWHERE\b/gi;
      for (const m of text.matchAll(re)) {
        if (/\bstatus\s*=/i.test(m[1]!)) offenders.push(file);
      }
    }
    // `recordInvoiceRefund` is the only UPDATE against the table and it moves
    // an amount, not a state — Stripe leaves a refunded invoice `paid`.
    expect(offenders).toEqual([]);
  });

  it('creates invoices in exactly the statuses it declares reachable', () => {
    const written = new Set<string>();
    for (const { file, text } of sourceFiles()) {
      if (file === path.join('repos', 'billing.ts')) continue; // the definition, not a caller
      // The status handed to createInvoice at each call site.
      for (const m of text.matchAll(/createInvoice\(([\s\S]{0,600}?)\n\s*\}\)/g)) {
        const status = /\bstatus:\s*'([a-z]+)'/.exec(m[1]!);
        written.add(status ? status[1]! : 'open'); // the repo's default
      }
    }
    // A census that matched nothing would pass by having nothing left to ask.
    expect(written.size, 'no createInvoice call site was found — the scan is vacuous').toBeGreaterThan(0);
    expect([...written].sort()).toEqual([...INVOICE_REACHABLE_STATUSES].sort());
  });
});

describe.skipIf(!dbUp)('the schema states the same machine', () => {
  let ctx: TestApp;
  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  });
  afterAll(async () => ctx?.teardown());

  /** The quoted literals in a table's CHECK constraint on `column`. */
  const checkedValues = async (table: string, column: string): Promise<string[]> => {
    const { rows } = await ctx.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
        WHERE c.conrelid = $1::regclass AND c.contype = 'c'`,
      [table],
    );
    const def = rows.map((r) => r.def).find((d) => new RegExp(`\\b${column}\\b`).test(d));
    expect(def, `${table}.${column} has no CHECK constraint`).toBeDefined();
    return [...def!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
  };

  it('permits exactly the invoice statuses the domain declares', async () => {
    // Two statements of one list drift; this is the join between them. The
    // domain list is what queries read, the CHECK is what the table enforces,
    // and a status added to either alone is a row no reader expects.
    expect(await checkedValues('invoices', 'status')).toEqual([...INVOICE_STATUSES].sort());
  });

  it('permits exactly the subscription statuses the domain splits into sets', async () => {
    // SERVED ∪ {canceled} is the whole vocabulary; BILLING is a subset of
    // SERVED. Both are asserted so neither set can grow a status the column
    // would reject, nor miss one it would accept.
    const declared = [...new Set([...SERVED_SUBSCRIPTION_STATUSES, 'canceled'])].sort();
    expect(await checkedValues('subscriptions', 'status')).toEqual(declared);
    for (const s of BILLING_SUBSCRIPTION_STATUSES) expect(SERVED_SUBSCRIPTION_STATUSES).toContain(s);
  });
});

// ── Part 3: the invoice lifecycle, through the webhook ────────────────────────

describe.skipIf(!dbUp)('invoice transitions', () => {
  let ctx: TestApp;
  let user: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
    user = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const billingWebhook = (event: unknown) => {
    const payload = JSON.stringify(event);
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: signed(payload),
      payload,
    });
  };
  const paymentsWebhook = (event: unknown) => {
    const payload = JSON.stringify(event);
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/stripe/webhook',
      headers: signed(payload),
      payload,
    });
  };

  const paidEvent = (stripeInvoiceId: string, over: Record<string, unknown> = {}) => ({
    id: `evt_${stripeInvoiceId}_${uniq()}`,
    type: 'invoice.paid',
    data: {
      object: {
        id: stripeInvoiceId,
        metadata: { user_id: user.id },
        amount_paid: 120_000,
        currency: 'usd',
        description: 'Annual retainer',
        ...over,
      },
    },
  });

  const invoiceReceipts = async (userId: string) =>
    (await listNotifications(ctx.pool, userId, {})).filter((n) => n.type === 'invoice_paid');

  it('records a settled invoice straight into its terminal status', async () => {
    const id = `in_born_paid_${uniq()}`;
    expect((await billingWebhook(paidEvent(id))).statusCode).toBe(200);
    const invoice = await findInvoiceByStripeId(ctx.pool, id);
    expect(invoice?.status).toBe('paid');
    expect(isTerminalInvoiceStatus(invoice!.status)).toBe(true);
  });

  it('refuses to create an invoice in a status that can only be reached', async () => {
    await expect(
      createInvoice(ctx.pool, {
        number: invoiceNumber(new Date().toISOString(), await nextInvoiceSequence(ctx.pool)),
        userId: user.id,
        amountCents: 1_000,
        currency: 'usd',
        // Not an initial status: an invoice voided before it existed records
        // nothing, and the CHECK cannot tell where a value came from.
        status: 'void' as InvoiceStatus,
        lineItems: [],
        stripeInvoiceId: `in_void_at_birth_${uniq()}`,
      }),
    ).rejects.toThrow(/not a status an invoice can be created in/);
  });

  it('records one invoice and one receipt for the pair of settlement events', async () => {
    // Stripe emits `invoice.paid` *and* `invoice.payment_succeeded` for one
    // payment, with distinct event ids the ledger cannot collapse, so both
    // reach the handler and both are entitled to act.
    const subscriber = await seedUser(ctx, { roles: ['valuation_user'] });
    const id = `in_event_pair_${uniq()}`;
    const object = {
      id,
      metadata: { user_id: subscriber.id },
      amount_paid: 2_000_000,
      currency: 'usd',
      description: 'Annual retainer',
    };

    const [a, b] = await Promise.all([
      billingWebhook({ id: `evt_paid_${uniq()}`, type: 'invoice.paid', data: { object } }),
      billingWebhook({
        id: `evt_succeeded_${uniq()}`,
        type: 'invoice.payment_succeeded',
        data: { object },
      }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);

    const { rows } = await ctx.pool.query<{ number: string }>(
      'SELECT number FROM invoices WHERE stripe_invoice_id = $1',
      [id],
    );
    expect(rows).toHaveLength(1);

    const receipts = await invoiceReceipts(subscriber.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.title).toContain(rows[0]!.number);
  });

  /**
   * The regression this file was opened for, staged rather than hoped for.
   *
   * `invoice.paid` decided whether the payment was news with a read
   * (`findInvoiceByStripeId`) taken before the write, which is the same
   * read-then-write migration 0096 removed from the numbering one line down.
   * Two deliveries of one payment — Stripe sends `invoice.paid` and
   * `invoice.payment_succeeded` together, and redelivers both — can each read
   * "not seen", each allocate a sequence number, and each reach the insert.
   *
   * `createInvoice` survives that: the ON CONFLICT declines the loser's insert
   * and hands back the row already on file. The announcement did not. It ran on
   * both paths and quoted the *local* number rather than the stored one, so the
   * subscriber got two receipts for one renewal and one of them named an
   * invoice that exists nowhere — the loser's allocation, discarded by the
   * conflict, out of a sequence an auditor reads as a count of what was billed.
   *
   * Two overlapping `inject`s do not reproduce it: the webhook's awaits happen
   * to serialise (see the R57 note on staging races in this suite). So the
   * window is staged where it actually is — the other delivery commits its row
   * while this one sits between its read and its write, which is precisely the
   * state the losing delivery finds. Everything after that is the real handler.
   */
  it('announces nothing when another delivery of the same payment got there first', async () => {
    const subscriber = await seedUser(ctx, { roles: ['valuation_user'] });
    const id = `in_lost_race_${uniq()}`;
    const winnersNumber = `INV-RACE-${uniq()}`;

    const original = ctx.pool.query.bind(ctx.pool);
    let staged = false;
    (ctx.pool as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string })?.text ?? '');
      const result = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
      // After the sequence has been allocated and before the invoice is
      // inserted — the one instant at which the two deliveries are both live.
      if (!staged && sql.includes('INSERT INTO invoice_sequences')) {
        staged = true;
        await (original as (...a: unknown[]) => Promise<unknown>)(
          `INSERT INTO invoices (id, user_id, number, amount_cents, currency, status,
                                 issued_at, line_items, stripe_invoice_id)
           VALUES ($1, $2, $3, $4, 'usd', 'paid', now(), '[]', $5)`,
          [newUlid(), subscriber.id, winnersNumber, 2_000_000, id],
        );
      }
      return result;
    };

    try {
      const res = await billingWebhook({
        id: `evt_loser_${uniq()}`,
        type: 'invoice.payment_succeeded',
        data: {
          object: { id, metadata: { user_id: subscriber.id }, amount_paid: 2_000_000, currency: 'usd' },
        },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      (ctx.pool as unknown as { query: unknown }).query = original;
    }

    // One invoice, and it is the one that won.
    const { rows } = await ctx.pool.query<{ number: string }>(
      'SELECT number FROM invoices WHERE stripe_invoice_id = $1',
      [id],
    );
    expect(rows.map((r) => r.number)).toEqual([winnersNumber]);

    // The losing delivery says nothing. It has no invoice to name: the number
    // it allocated was never written, so a receipt quoting it would send the
    // subscriber to a billing page that has never heard of it.
    expect(await invoiceReceipts(subscriber.id)).toEqual([]);
  });

  it('sends nothing at all on the second delivery of a settlement', async () => {
    const subscriber = await seedUser(ctx, { roles: ['valuation_user'] });
    const id = `in_sequential_pair_${uniq()}`;
    const object = { id, metadata: { user_id: subscriber.id }, amount_paid: 9_900, currency: 'usd' };
    await billingWebhook({ id: `evt_p_${uniq()}`, type: 'invoice.paid', data: { object } });
    await billingWebhook({ id: `evt_s_${uniq()}`, type: 'invoice.payment_succeeded', data: { object } });
    expect(await invoiceReceipts(subscriber.id)).toHaveLength(1);
  });

  it('leaves a paid invoice paid when money goes back out', async () => {
    // A Stripe refund is an amount, not a state: the invoice stays `paid` and
    // `refunded_cents` carries what came back. Recording it as a status change
    // would say something Stripe does not, and would lose the partial case.
    const id = `in_refund_keeps_status_${uniq()}`;
    await billingWebhook(paidEvent(id, { amount_paid: 100_000 }));
    const res = await paymentsWebhook({
      id: `evt_refund_${uniq()}`,
      type: 'charge.refunded',
      data: { object: { id: `ch_${uniq()}`, invoice: id, amount_refunded: 100_000 } },
    });
    expect(res.statusCode).toBe(200);

    const invoice = await findInvoiceByStripeId(ctx.pool, id);
    expect(invoice?.status).toBe('paid');
    expect(Number(invoice?.refunded_cents)).toBe(100_000);
    // ...and the machine agrees that this is not a move it could have made.
    expect(canTransitionInvoice('paid', 'void')).toBe(false);
  });

  it('does not walk a refund total backwards when partials arrive reversed', async () => {
    const id = `in_partial_reorder_${uniq()}`;
    await billingWebhook(paidEvent(id, { amount_paid: 100_000 }));
    // The later, larger running total first; then the earlier, smaller one.
    await paymentsWebhook({
      id: `evt_r2_${uniq()}`,
      type: 'charge.refunded',
      data: { object: { id: `ch_${uniq()}`, invoice: id, amount_refunded: 60_000 } },
    });
    await paymentsWebhook({
      id: `evt_r1_${uniq()}`,
      type: 'charge.refunded',
      data: { object: { id: `ch_${uniq()}`, invoice: id, amount_refunded: 25_000 } },
    });
    expect(Number((await findInvoiceByStripeId(ctx.pool, id))?.refunded_cents)).toBe(60_000);
  });

  it('acts on none of the invoice events that are not a settlement', async () => {
    // Every other invoice event Stripe sends about an invoice we hold. None is
    // handled, and none may move a terminal row — a paid invoice that a later
    // `invoice.voided` re-opened would drop out of the revenue rollup, which
    // sums over `status = 'paid'`.
    const id = `in_untouched_${uniq()}`;
    await billingWebhook(paidEvent(id, { amount_paid: 45_000 }));
    const before = await findInvoiceByStripeId(ctx.pool, id);

    for (const type of [
      'invoice.created',
      'invoice.finalized',
      'invoice.voided',
      'invoice.marked_uncollectible',
      'invoice.updated',
    ]) {
      const res = await billingWebhook({
        id: `evt_${type}_${uniq()}`,
        type,
        data: { object: { id, metadata: { user_id: user.id }, status: 'void' } },
      });
      expect(res.statusCode, type).toBe(200);
    }

    const after = await findInvoiceByStripeId(ctx.pool, id);
    expect(after?.status).toBe(before?.status);
    expect(Number(after?.amount_cents)).toBe(Number(before?.amount_cents));
    expect(after?.number).toBe(before?.number);
  });

  it('does not re-open a paid invoice when a later payment fails', async () => {
    const id = `in_paid_then_failed_${uniq()}`;
    await billingWebhook(paidEvent(id, { amount_paid: 33_000 }));
    await billingWebhook({
      id: `evt_failed_${uniq()}`,
      type: 'invoice.payment_failed',
      data: { object: { id, amount_due: 33_000 } },
    });
    expect((await findInvoiceByStripeId(ctx.pool, id))?.status).toBe('paid');
  });

  it('records no invoice at all for a settlement it cannot attribute', async () => {
    const id = `in_unattributed_${uniq()}`;
    const res = await billingWebhook({
      id: `evt_orphan_${uniq()}`,
      type: 'invoice.paid',
      data: { object: { id, subscription: 'sub_never_seen', amount_paid: 1_000 } },
    });
    expect(res.statusCode).toBe(200);
    expect(await findInvoiceByStripeId(ctx.pool, id)).toBeNull();
  });
});

// ── Part 4: the subscription lifecycle ───────────────────────────────────────

describe.skipIf(!dbUp)('subscription transitions', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  });
  afterAll(async () => ctx?.teardown());

  const deliver = (event: unknown) => {
    const payload = JSON.stringify(event);
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: signed(payload),
      payload,
    });
  };

  const subRow = async (stripeId: string) => {
    const { rows } = await ctx.pool.query<{ status: string; canceled_at: Date | null }>(
      'SELECT status, canceled_at FROM subscriptions WHERE stripe_subscription_id = $1',
      [stripeId],
    );
    return rows[0] ?? null;
  };

  const subscriptionEvent = (userId: string, stripeId: string, status: string) => ({
    id: `evt_sub_${uniq()}`,
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: stripeId,
        status,
        metadata: { user_id: userId, plan_tier: 'annual_retainer' },
        current_period_start: Math.floor(Date.now() / 1000),
      },
    },
  });

  it('walks the whole live ladder: trialing → active → past_due → active', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const stripeId = `sub_ladder_${uniq()}`;

    await deliver(subscriptionEvent(user.id, stripeId, 'trialing'));
    expect((await subRow(stripeId))?.status).toBe('trialing');

    await deliver(subscriptionEvent(user.id, stripeId, 'active'));
    expect((await subRow(stripeId))?.status).toBe('active');

    // Dunning, from the invoice side rather than the subscription side, so a
    // subscription carrying no metadata still lapses visibly.
    await deliver({
      id: `evt_fail_${uniq()}`,
      type: 'invoice.payment_failed',
      data: { object: { id: `in_${uniq()}`, subscription: stripeId, amount_due: 2_000_000 } },
    });
    expect((await subRow(stripeId))?.status).toBe('past_due');

    // Recovery. `past_due` is served but not billed, so getting back out of it
    // is the transition that restores the MRR line.
    await deliver(subscriptionEvent(user.id, stripeId, 'active'));
    expect((await subRow(stripeId))?.status).toBe('active');
    expect((await subRow(stripeId))?.canceled_at).toBeNull();
  });

  it('cancels, and stays cancelled against every event that would undo it', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const stripeId = `sub_terminal_${uniq()}`;
    await deliver(subscriptionEvent(user.id, stripeId, 'active'));
    await deliver({
      id: `evt_del_${uniq()}`,
      type: 'customer.subscription.deleted',
      data: { object: { id: stripeId } },
    });
    const cancelled = await subRow(stripeId);
    expect(cancelled?.status).toBe('canceled');
    expect(cancelled?.canceled_at).not.toBeNull();

    // Every other writer of subscription state, each of which used to be able
    // to put a cancelled account back into a billable one.
    await deliver(subscriptionEvent(user.id, stripeId, 'active'));
    await deliver({
      id: `evt_fail_after_${uniq()}`,
      type: 'invoice.payment_failed',
      data: { object: { id: `in_${uniq()}`, subscription: stripeId, amount_due: 100 } },
    });
    await deliver({
      id: `evt_checkout_${uniq()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_${uniq()}`,
          mode: 'subscription',
          payment_status: 'paid',
          subscription: stripeId,
          metadata: { user_id: user.id, plan_tier: 'annual_retainer' },
        },
      },
    });
    expect((await subRow(stripeId))?.status).toBe('canceled');
  });

  /**
   * `canceled_at` is stamped once and never moved.
   *
   * Cancellation has two writers — `customer.subscription.updated` carrying
   * `status: 'canceled'`, and `customer.subscription.deleted` — and Stripe
   * sends both for one cancellation without ordering them. `cancelSubscription`
   * assigned `now()` unconditionally, so whichever landed second restated when
   * the customer left, and a redelivery days later restated it again. That date
   * is what the data export and any final-period reconciliation read.
   */
  it('does not restate when a customer left, whichever event closes the account', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const stripeId = `sub_canceled_at_${uniq()}`;
    await deliver(subscriptionEvent(user.id, stripeId, 'active'));

    // The update says cancelled first...
    await deliver(subscriptionEvent(user.id, stripeId, 'canceled'));
    const first = await subRow(stripeId);
    expect(first?.status).toBe('canceled');
    expect(first?.canceled_at).not.toBeNull();

    // ...then the deletion, and then a redelivery of it.
    await deliver({
      id: `evt_del_a_${uniq()}`,
      type: 'customer.subscription.deleted',
      data: { object: { id: stripeId } },
    });
    await deliver({
      id: `evt_del_b_${uniq()}`,
      type: 'customer.subscription.deleted',
      data: { object: { id: stripeId } },
    });

    const last = await subRow(stripeId);
    expect(last?.status).toBe('canceled');
    expect(last?.canceled_at?.getTime()).toBe(first?.canceled_at?.getTime());
  });

  it('is a no-op at the repo, not an error, for a subscription id we never issued', async () => {
    expect(await cancelSubscription(ctx.pool, `sub_unknown_${uniq()}`)).toBeNull();
  });

  it('stamps a cancellation once even when the repo is called twice directly', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const stripeId = `sub_double_cancel_${uniq()}`;
    await upsertSubscription(ctx.pool, {
      userId: user.id,
      planTier: 'annual_retainer',
      stripeSubscriptionId: stripeId,
    });
    const first = await cancelSubscription(ctx.pool, stripeId);
    const second = await cancelSubscription(ctx.pool, stripeId);
    expect(second?.status).toBe('canceled');
    expect(second?.canceled_at?.getTime()).toBe(first?.canceled_at?.getTime());
  });

  it('keeps one served subscription per user across the whole ladder', async () => {
    // The partial unique index (`subscriptions_one_active_per_user`) is what
    // makes "the user's subscription" a well-defined thing for the quota
    // check; a cancelled row may coexist with it, and nothing else may.
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const stripeId = `sub_one_served_${uniq()}`;
    await deliver(subscriptionEvent(user.id, stripeId, 'active'));
    await deliver(subscriptionEvent(user.id, stripeId, 'past_due'));
    await deliver({
      id: `evt_del_${uniq()}`,
      type: 'customer.subscription.deleted',
      data: { object: { id: stripeId } },
    });
    const next = `sub_one_served_b_${uniq()}`;
    await deliver(subscriptionEvent(user.id, next, 'active'));

    const { rows } = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM subscriptions
        WHERE user_id = $1 AND status = ANY($2::text[])`,
      [user.id, [...SERVED_SUBSCRIPTION_STATUSES]],
    );
    expect(rows[0]!.n).toBe('1');
  });
});
