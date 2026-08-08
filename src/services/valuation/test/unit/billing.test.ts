import { describe, it, expect } from 'vitest';
import {
  canConsume,
  invoiceNumber,
  invoiceSections,
  receiptSections,
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

  it('escapes a company name into HTML the report sanitizer accepts', () => {
    const sections = receiptSections({ ...base, company_name: 'Ben & Co <script>alert(1)</script>' });
    const out = sections.map((s) => s.html).join('');
    expect(out).toContain('Ben &amp; Co');
    expect(out).not.toContain('<script>');
    for (const s of sections) expect(sanitizeHtml(s.html)).toBe(s.html);
  });
});
