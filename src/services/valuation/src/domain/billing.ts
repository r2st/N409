/**
 * Subscription billing domain (feature 7): plan-limit / usage logic and invoice
 * rendering. Pure functions so limit enforcement and invoice formatting are
 * unit-testable without Stripe or the DB.
 */

export interface PlanLimit {
  tier: string;
  name: string;
  valuation_limit: number | null; // null = unlimited
  price_cents: number;
  currency: string;
  interval: 'one_time' | 'month' | 'year';
}

export interface UsageState {
  valuation_limit: number | null;
  valuations_used: number;
}

export interface UsageView {
  limit: number | null;
  used: number;
  remaining: number | null; // null = unlimited
  unlimited: boolean;
  exhausted: boolean;
}

export function usageView(state: UsageState): UsageView {
  if (state.valuation_limit === null) {
    return { limit: null, used: state.valuations_used, remaining: null, unlimited: true, exhausted: false };
  }
  const remaining = Math.max(0, state.valuation_limit - state.valuations_used);
  return {
    limit: state.valuation_limit,
    used: state.valuations_used,
    remaining,
    unlimited: false,
    exhausted: remaining <= 0,
  };
}

/** Can this subscription consume one more valuation this period? */
export function canConsume(state: UsageState): boolean {
  return !usageView(state).exhausted;
}

/** Human money for line items / invoice display. */
export function formatMoneyCents(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

/**
 * Invoice number from an issue date + a monotonic sequence. Passed the sequence
 * so it stays pure (the repo supplies the next value). Format: INV-YYYYMM-NNNN.
 */
export function invoiceNumber(issuedAtIso: string, sequence: number): string {
  const ym = issuedAtIso.slice(0, 7).replace('-', '');
  return `INV-${ym}-${String(sequence).padStart(4, '0')}`;
}

export interface InvoiceLineItem {
  description: string;
  amount_cents: number;
  quantity?: number;
}

export interface InvoiceForRender {
  number: string;
  amount_cents: number;
  currency: string;
  status: string;
  issued_at: string;
  period_start: string | null;
  period_end: string | null;
  line_items: InvoiceLineItem[];
  bill_to: { name: string; email: string };
  plan_name?: string | null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

/**
 * Invoice → report-service section list (whitelisted HTML), so the same
 * renderReportPdf pipeline produces a clean invoice PDF.
 */
export function invoiceSections(inv: InvoiceForRender): Array<{ heading: string; html: string }> {
  const rows = inv.line_items
    .map(
      (li) =>
        `<tr><td>${esc(li.description)}</td><td>${li.quantity ?? 1}</td>` +
        `<td>${formatMoneyCents(li.amount_cents, inv.currency)}</td></tr>`,
    )
    .join('');

  const summary =
    `<p>Invoice <strong>${esc(inv.number)}</strong> — status: <strong>${esc(inv.status)}</strong></p>` +
    `<p>Billed to ${esc(inv.bill_to.name)} (${esc(inv.bill_to.email)})</p>` +
    (inv.plan_name ? `<p>Plan: ${esc(inv.plan_name)}</p>` : '') +
    `<p>Issued ${day(inv.issued_at)}` +
    (inv.period_start ? ` · Period ${day(inv.period_start)} – ${day(inv.period_end)}` : '') +
    `</p>`;

  const table =
    `<table><thead><tr><th>Description</th><th>Qty</th><th>Amount</th></tr></thead>` +
    `<tbody>${rows}<tr><th>Total</th><th></th><th>${formatMoneyCents(inv.amount_cents, inv.currency)}</th></tr></tbody></table>`;

  return [
    { heading: 'Invoice', html: summary },
    { heading: 'Line items', html: table },
  ];
}
