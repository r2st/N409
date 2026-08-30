import { describe, it, expect } from 'vitest';
import {
  canConsume,
  invoiceLineItems,
  invoiceNumber,
  invoicePaidMessage,
  invoiceSections,
  paymentReceivedMessage,
  planLimitDetail,
  quotaAwaitsRenewal,
  receiptSections,
  receiptStatusLabel,
  usageView,
} from '../../src/domain/billing.js';
import { sanitizeHtml } from '../../src/domain/report.js';

describe('usage / plan limits (feature 7)', () => {
  it('computes remaining and exhaustion for a limited plan', () => {
    expect(usageView({ valuation_limit: 12, valuations_used: 5 })).toMatchObject({
      remaining: 7,
      unlimited: false,
      exhausted: false,
    });
    expect(usageView({ valuation_limit: 12, valuations_used: 12 })).toMatchObject({
      remaining: 0,
      exhausted: true,
    });
  });

  it('treats a null limit as unlimited', () => {
    const v = usageView({ valuation_limit: null, valuations_used: 999 });
    expect(v.unlimited).toBe(true);
    expect(v.exhausted).toBe(false);
    expect(canConsume({ valuation_limit: null, valuations_used: 999 })).toBe(true);
  });

  it('blocks consumption once exhausted', () => {
    expect(canConsume({ valuation_limit: 1, valuations_used: 1 })).toBe(false);
    expect(canConsume({ valuation_limit: 1, valuations_used: 0 })).toBe(true);
  });

  /**
   * Which period the counter beside the limit is counting. The two dates agree
   * on every ordinary subscription and come apart on exactly one transition —
   * a renewal Stripe has raised and nobody has paid — which is when the used
   * count and the renewal date on the same card stop being about the same
   * period.
   */
  describe('quotaAwaitsRenewal', () => {
    const paid = new Date('2027-01-01T00:00:00.000Z');
    const raised = new Date('2027-02-01T00:00:00.000Z');

    it('is false while the counter is counting the period on the row', () => {
      expect(quotaAwaitsRenewal({ current_period_start: paid, quota_period_start: paid })).toBe(false);
    });

    it('is true once the period has moved and the counter has not', () => {
      expect(quotaAwaitsRenewal({ current_period_start: raised, quota_period_start: paid })).toBe(true);
    });

    it('reads the two spellings of one instant as one instant', () => {
      expect(quotaAwaitsRenewal({ current_period_start: paid.toISOString(), quota_period_start: paid })).toBe(
        false,
      );
    });

    it('has nothing to disagree about on a subscription with no period yet', () => {
      expect(quotaAwaitsRenewal({ current_period_start: null, quota_period_start: null })).toBe(false);
      // One end known and not the other still is a disagreement: the counter is
      // not counting the period the row is showing.
      expect(quotaAwaitsRenewal({ current_period_start: paid, quota_period_start: null })).toBe(true);
    });

    it('does not report two unreadable dates as a disagreement', () => {
      expect(
        quotaAwaitsRenewal({ current_period_start: 'not a date', quota_period_start: 'not a date either' }),
      ).toBe(false);
    });
  });
});

describe('invoices', () => {
  it('formats an invoice number from the issue month + sequence', () => {
    expect(invoiceNumber('2026-07-20T00:00:00.000Z', 7)).toBe('INV-202607-0007');
  });

  it('renders whitelisted invoice sections that survive the report sanitizer', () => {
    const sections = invoiceSections({
      number: 'INV-202607-0001',
      amount_cents: 2_000_000,
      currency: 'usd',
      status: 'paid',
      issued_at: '2026-07-20T00:00:00.000Z',
      period_start: '2026-07-01T00:00:00.000Z',
      period_end: '2027-06-30T00:00:00.000Z',
      line_items: [{ description: 'Annual retainer', amount_cents: 2_000_000 }],
      bill_to: { name: 'Acme', email: 'a@acme.com' },
      plan_name: 'Annual retainer',
    });
    const html = sections.map((s) => s.html).join('');
    expect(html).toContain('$20,000.00');
    expect(html).toContain('INV-202607-0001');
    for (const s of sections) expect(sanitizeHtml(s.html)).toBe(s.html);
  });
});

describe('engagement receipts', () => {
  const base = {
    reference: 'V-2026-0042',
    company_name: 'Northwind Robotics, Inc.',
    amount_cents: 219_000,
    currency: 'USD',
    paid_at: '2026-07-20T09:30:00.000Z',
    lines: [
      { description: '409A valuation', amount_cents: 119_000 },
      { description: '$1M – $5M raised', amount_cents: 50_000 },
      { description: 'Express delivery — 1 business day', amount_cents: 50_000 },
    ],
    refunded_cents: 0,
    dispute_status: null,
    express: true,
  };

  const html = (r = base) =>
    receiptSections(r)
      .map((s) => s.html)
      .join('');

  it('itemises the quote as sold, and totals to what was charged', () => {
    const out = html();
    expect(out).toContain('409A valuation');
    expect(out).toContain('$1M – $5M raised');
    expect(out).toContain('$1,190.00');
    expect(out).toContain('$500.00');
    expect(out).toContain('$2,190.00');
    expect(out).toContain('V-2026-0042');
  });

  it('names the express SLA the client paid for', () => {
    expect(html()).toContain('Express delivery');
    expect(html({ ...base, express: false, lines: base.lines.slice(0, 2) })).not.toContain(
      'Express delivery',
    );
  });

  it('states a refund and the net rather than the gross', () => {
    // A receipt for the gross is a document a refunded client can hold up to
    // say they paid us money they did not.
    const out = html({ ...base, refunded_cents: 50_000 });
    expect(out).toContain('Refunded');
    expect(out).toContain('−$500.00');
    expect(out).toContain('Net paid');
    expect(out).toContain('$1,690.00');
  });

  it('says nothing about refunds when there were none', () => {
    expect(html()).not.toContain('Refunded');
    expect(html()).not.toContain('Net paid');
  });

  it('gives a row sold before the breakdown existed one honest line', () => {
    // Never a breakdown synthesised from today's prices — it would be
    // indistinguishable from one that was actually agreed.
    const out = html({ ...base, lines: [], amount_cents: 119_000, express: false });
    expect(out).toContain('Valuation engagement');
    expect(out).toContain('$1,190.00');
    expect(out).not.toContain('raised');
  });

  it('reports a dispute as a dispute, not as a refund', () => {
    const sections = receiptSections({ ...base, dispute_status: 'needs_response' });
    const headings = sections.map((s) => s.heading);
    expect(headings).toContain('Dispute');
    expect(sections.map((s) => s.html).join('')).toContain('needs_response');
  });

  /**
   * `dispute_status` is written once per verdict and never cleared, so all
   * three values are permanent properties of the row — and the receipt printed
   * every one of them through a single present-tense sentence. A chargeback we
   * *won* therefore left the client holding a document that read as an
   * unresolved problem for good, over money they had paid and we had kept.
   */
  describe('chargeback verdicts', () => {
    const dispute = (status: string) =>
      receiptSections({ ...base, dispute_status: status })
        .filter((s) => s.heading === 'Dispute')
        .map((s) => s.html)
        .join('');

    it('says an open case is still open and the money is held', () => {
      const out = dispute('open');
      expect(out).toContain('still under review');
      expect(out).toContain('held');
      expect(out).not.toContain('resolved in our favour');
    });

    it('says a case we won is closed and the payment stands', () => {
      const out = dispute('won');
      expect(out).toContain('resolved in our favour');
      expect(out).toContain('The payment stands');
      // The tense is the whole bug: not "is subject to a dispute".
      expect(out).not.toContain('is subject to');
    });

    it('says a case we lost returned the money', () => {
      const out = dispute('lost');
      expect(out).toContain('upheld');
      expect(out).toContain('returned');
    });

    it('describes a verdict it has no wording for rather than dropping it', () => {
      // The column is text and Stripe's vocabulary is wider than ours; a
      // verdict this build cannot phrase is still a fact about the money.
      expect(dispute('warning_needs_response')).toContain('warning_needs_response');
    });
  });

  /**
   * The heading was `dispute_status ? 'disputed' : 'paid'` — one column
   * answering a question that takes two, and answering it wrongly for both
   * closed verdicts.
   */
  describe('receiptStatusLabel', () => {
    it('heads an ordinary settled payment paid', () => {
      expect(receiptStatusLabel({ payment_status: 'succeeded', dispute_status: null })).toBe('paid');
    });

    it('heads a refunded payment refunded, not paid', () => {
      expect(receiptStatusLabel({ payment_status: 'refunded', dispute_status: null })).toBe('refunded');
    });

    it('heads a live chargeback disputed, whatever the row says', () => {
      expect(receiptStatusLabel({ payment_status: 'succeeded', dispute_status: 'open' })).toBe('disputed');
    });

    it('heads a chargeback we won paid — the case is closed and we kept it', () => {
      expect(receiptStatusLabel({ payment_status: 'succeeded', dispute_status: 'won' })).toBe('paid');
    });

    it('heads a chargeback we lost as one, rather than as an open dispute', () => {
      // A lost dispute returns the whole amount and moves the row to
      // 'refunded'; "disputed" describes neither half of that.
      expect(receiptStatusLabel({ payment_status: 'refunded', dispute_status: 'lost' })).toBe('charged back');
    });

    it('treats an unrecognised verdict as live rather than as settled', () => {
      // The damaging way to guess wrong is to head a receipt "paid" over a case
      // that is still running — the same asymmetry `disputeStatusOf` makes.
      expect(receiptStatusLabel({ payment_status: 'succeeded', dispute_status: 'under_review' })).toBe(
        'disputed',
      );
    });
  });

  it('escapes a company name into HTML the report sanitizer accepts', () => {
    const sections = receiptSections({ ...base, company_name: 'Ben & Co <script>alert(1)</script>' });
    const out = sections.map((s) => s.html).join('');
    expect(out).toContain('Ben &amp; Co');
    expect(out).not.toContain('<script>');
    for (const s of sections) expect(sanitizeHtml(s.html)).toBe(s.html);
  });
});

/**
 * The confirmations a settlement sends. These are the only place the platform
 * states a figure to the person who was charged outside a PDF, so what they say
 * about the money is asserted rather than assumed.
 */
describe('settlement confirmations', () => {
  const payment = {
    reference: '1766',
    company_name: 'Northwind Robotics, Inc.',
    kind: '409a',
    amount_cents: 119_000,
    currency: 'usd',
    express: false,
    receipt_link: 'https://app.n409.local/valuations/01JQ',
  };

  it('states the amount charged, in the currency it was charged in', () => {
    expect(paymentReceivedMessage(payment).body).toContain('$1,190.00');
    expect(paymentReceivedMessage({ ...payment, currency: 'eur' }).body).toContain('€1,190.00');
  });

  it('names the engagement in the subject, so a client with several can tell them apart', () => {
    const m = paymentReceivedMessage(payment);
    expect(m.subject).toContain('409A');
    expect(m.subject).toContain('Northwind Robotics, Inc.');
    expect(m.body).toContain('1766');
  });

  it('points at the receipt rather than carrying it', () => {
    const m = paymentReceivedMessage(payment);
    expect(m.body).toContain(payment.receipt_link);
    expect(m.vars.receipt_link).toBe(payment.receipt_link);
  });

  it('mentions express only when express was bought', () => {
    expect(paymentReceivedMessage(payment).body).not.toContain('Express');
    expect(paymentReceivedMessage({ ...payment, express: true }).body).toContain('Express');
  });

  it('supplies every variable it interpolates for a template override', () => {
    const m = paymentReceivedMessage(payment);
    expect(Object.keys(m.vars).sort()).toEqual([
      'amount_paid',
      'company_name',
      'kind',
      'kind_label',
      'receipt_link',
      'valuation_number',
    ]);
    expect(m.vars.amount_paid).toBe('$1,190.00');
    // Both spellings of the kind, because the built-in subject line uses one of
    // them and an override writing "your {{kind_label}} valuation" had it
    // delivered as literal braces.
    expect(m.vars.kind_label).toBe('409A');
  });

  const invoice = {
    number: 'INV-202608-0007',
    amount_cents: 9_900,
    currency: 'usd',
    period_start: '2026-08-01T00:00:00.000Z',
    period_end: '2026-09-01T00:00:00.000Z',
    invoice_link: 'https://app.n409.local/billing',
    plan_name: 'Annual retainer',
  };

  it('states the invoice number, the amount and the period', () => {
    const m = invoicePaidMessage(invoice);
    expect(m.subject).toContain('INV-202608-0007');
    expect(m.body).toContain('$99.00');
    expect(m.body).toContain('2026-08-01 to 2026-09-01');
    expect(m.body).toContain(invoice.invoice_link);
  });

  it('states no period at all rather than half of one', () => {
    // "for the period starting 1 August" reads as a claim about when it stops,
    // and a row with one end missing does not say.
    for (const half of [{ period_end: null }, { period_start: null }]) {
      const m = invoicePaidMessage({ ...invoice, ...half });
      expect(m.body).not.toContain('period');
      expect(m.body).toContain('$99.00');
      // Blank rather than absent, which is not the same thing downstream: an
      // ops-authored override of this copy is run through `renderTemplate`,
      // which leaves a name nobody supplies as literal braces. The catalog
      // promises this variable is "blank unless both ends of it are known".
      expect(m.vars.invoice_period).toBe('');
    }
  });
});

describe('an invoice that has been refunded', () => {
  const base = {
    number: 'INV-202608-0007',
    amount_cents: 100_000,
    currency: 'usd',
    status: 'paid',
    issued_at: '2026-08-01T00:00:00.000Z',
    period_start: null,
    period_end: null,
    line_items: [{ description: 'Annual retainer', amount_cents: 100_000 }],
    bill_to: { name: 'Northwind Robotics, Inc.', email: 'cfo@northwind.example' },
  };

  it('states the refund and what is actually left', () => {
    // The same refusal receiptSections makes on the engagement side: rendering
    // the gross gives a customer a document saying they paid us money they did
    // not.
    const html = invoiceSections({ ...base, refunded_cents: 30_000 })
      .map((s) => s.html)
      .join('');
    expect(html).toContain('Refunded');
    expect(html).toContain('$300.00');
    expect(html).toContain('Net paid');
    expect(html).toContain('$700.00');
    // The gross stays on the face of it — it is what was billed.
    expect(html).toContain('$1,000.00');
  });

  it('says nothing about refunds when there have been none', () => {
    for (const inv of [base, { ...base, refunded_cents: 0 }]) {
      const html = invoiceSections(inv)
        .map((s) => s.html)
        .join('');
      expect(html).not.toContain('Refunded');
      expect(html).not.toContain('Net paid');
    }
  });

  it('never renders a negative net from a refund total above the invoice', () => {
    // Stripe's figure is authoritative and a document is the wrong place to
    // argue with it.
    const html = invoiceSections({ ...base, refunded_cents: 250_000 })
      .map((s) => s.html)
      .join('');
    expect(html).not.toContain('-$');
    expect(html).toContain('$0.00');
  });

  it('stays inside what the report sanitizer accepts', () => {
    for (const s of invoiceSections({ ...base, refunded_cents: 30_000 })) {
      expect(sanitizeHtml(s.html)).toBe(s.html);
    }
  });
});

describe('invoiceLineItems — what an invoice was made of', () => {
  const proration = {
    lines: {
      data: [
        { description: 'Unused time on Annual retainer after 30 Aug 2026', amount: -1_400_000 },
        { description: 'Remaining time on Enterprise after 30 Aug 2026', amount: 3_400_000 },
      ],
    },
  };

  it('itemises a mid-cycle plan change instead of netting it into one figure', () => {
    expect(invoiceLineItems(proration, 2_000_000, 'Subscription')).toEqual([
      { description: 'Unused time on Annual retainer after 30 Aug 2026', amount_cents: -1_400_000 },
      { description: 'Remaining time on Enterprise after 30 Aug 2026', amount_cents: 3_400_000 },
    ]);
  });

  it('falls back to one summary line when the lines do not add up to what was charged', () => {
    // An applied credit balance: the charge is real, the itemisation is not an
    // itemisation of it, and a table whose rows contradict its own total is
    // worse than one honest figure.
    expect(invoiceLineItems(proration, 500_000, 'Subscription')).toEqual([
      { description: 'Subscription', amount_cents: 500_000 },
    ]);
  });

  it('falls back for an invoice with no lines at all', () => {
    expect(invoiceLineItems({}, 240_000, 'Subscription')).toEqual([
      { description: 'Subscription', amount_cents: 240_000 },
    ]);
    expect(invoiceLineItems({ lines: { data: [] } }, 240_000, 'Subscription')).toEqual([
      { description: 'Subscription', amount_cents: 240_000 },
    ]);
  });

  it('falls back rather than storing an amount that is not whole minor units', () => {
    const bad = {
      lines: {
        data: [
          { description: 'Odd', amount: 1.5 },
          { description: 'Odd', amount: 2.5 },
        ],
      },
    };
    expect(invoiceLineItems(bad, 4, 'Subscription')).toEqual([
      { description: 'Subscription', amount_cents: 4 },
    ]);
  });

  it('names a line with no description of its own after the invoice', () => {
    const unnamed = { lines: { data: [{ amount: 240_000 }] } };
    expect(invoiceLineItems(unnamed, 240_000, 'Annual retainer')).toEqual([
      { description: 'Annual retainer', amount_cents: 240_000 },
    ]);
  });

  it('carries a quantity through when the line states a real one', () => {
    const seats = { lines: { data: [{ description: 'Seats', amount: 240_000, quantity: 4 }] } };
    expect(invoiceLineItems(seats, 240_000, 'Subscription')).toEqual([
      { description: 'Seats', amount_cents: 240_000, quantity: 4 },
    ]);
  });
});

/**
 * The refusal a subscriber reads when the plan's valuations are gone.
 *
 * Pinned as prose because prose is the whole of what this problem carries: the
 * type and status say "plan limit" and nothing about what to do, and the three
 * things asserted here are the three the old sentence got wrong — a remedy this
 * product sells, the figures the row already had, and the one account for which
 * upgrading is the wrong instruction.
 */
describe('planLimitDetail', () => {
  const base = {
    plan_name: 'Retainer',
    valuation_limit: 12,
    valuations_used: 12,
    current_period_end: new Date('2026-09-30T00:00:00Z'),
    awaiting_renewal: false,
  };

  it('states the plan, the limit and when the allowance returns', () => {
    const detail = planLimitDetail(base);
    expect(detail).toContain('all 12 valuations included in Retainer');
    expect(detail).toContain('2026-09-30');
    expect(detail).toContain('/billing');
  });

  it('never offers the add-on purchase this product does not sell', () => {
    for (const awaiting of [false, true]) {
      const detail = planLimitDetail({ ...base, awaiting_renewal: awaiting });
      expect(detail).not.toMatch(/purchase additional|buy more|top-?up to buy more/i);
    }
    // The one mention of a top-up is the sentence saying there is not one.
    expect(planLimitDetail(base)).toContain('no separate top-up to buy');
  });

  it('sends a subscriber in dunning to their card, not to a larger plan', () => {
    const detail = planLimitDetail({ ...base, awaiting_renewal: true });
    expect(detail).toContain('renewal payment');
    expect(detail).toContain('Update your card');
    expect(detail).not.toMatch(/higher limit/i);
    // The advanced period is the one figure this branch must not promise: it
    // arrives only if the payment does.
    expect(detail).not.toContain('2026-09-30');
  });

  it('drops the figures it does not have and keeps the remedy', () => {
    const detail = planLimitDetail({
      ...base,
      plan_name: 'your plan',
      valuation_limit: null,
      current_period_end: null,
    });
    expect(detail).toContain('the valuations included in your plan');
    expect(detail).not.toContain('undefined');
    expect(detail).not.toContain('null');
    expect(detail).not.toContain('NaN');
    expect(detail).toContain('/billing');
  });

  it('names no page the app does not route', () => {
    // "Settings → Billing" was the standing instruction in this area and there
    // is no billing panel on /settings; billing is its own route.
    for (const awaiting of [false, true]) {
      expect(planLimitDetail({ ...base, awaiting_renewal: awaiting })).not.toMatch(
        /Settings ?(→|->) ?Billing/,
      );
    }
  });
});
