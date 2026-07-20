import { describe, it, expect } from 'vitest';
import {
  canConsume,
  invoiceNumber,
  invoiceSections,
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
