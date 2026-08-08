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

/**
 * Is this plan's `price_cents` an entry price rather than the price?
 *
 * A recurring tier bills one amount, so its figure is exact. The `one_time`
 * tier is a single catalogue row standing in for the whole per-valuation price
 * list, and that list differs by product — routes/payments.ts prices a 409A at
 * $1,190, an SMB opinion at $990, an ASC 718 or 820 at $1,490. There is no one
 * number, so quoting the row as a flat price makes the Billing screen disagree
 * with the Stripe page the customer reaches next; it read "$2,000.00" against a
 * $1,190 charge until migration 0100.
 *
 * Callers render a floor ("From $990.00") when this is true. Keyed on the
 * interval rather than the tier name so a second one-time product added to the
 * catalogue inherits the treatment instead of re-opening the same gap.
 */
export function isEntryPrice(plan: Pick<PlanLimit, 'interval'>): boolean {
  return plan.interval === 'one_time';
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
/**
 * The YYYYMM bucket an invoice number is sequenced within.
 *
 * Shared with the sequence allocator (`nextInvoiceSequence`) so the counter and
 * the number it feeds cannot disagree about which month a given invoice is in.
 */
export function invoicePeriod(issuedAtIso: string): string {
  return issuedAtIso.slice(0, 7).replace('-', '');
}

export function invoiceNumber(issuedAtIso: string, sequence: number): string {
  return `INV-${invoicePeriod(issuedAtIso)}-${String(sequence).padStart(4, '0')}`;
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

// ── One-off engagement receipts ──────────────────────────────────────────────

/** A payment, reduced to what a receipt has to state. */
export interface ReceiptForRender {
  /** Receipt number — the valuation's number, which the client already quotes. */
  reference: string;
  company_name: string;
  amount_cents: number;
  currency: string;
  paid_at: string | null;
  /** The quote as sold. Empty for a row predating the itemised breakdown. */
  lines: InvoiceLineItem[];
  refunded_cents: number;
  dispute_status: string | null;
  express: boolean;
}

/**
 * Receipt → report-service section list, through the same PDF pipeline as an
 * invoice.
 *
 * A one-off engagement is paid at a Stripe Checkout page, and the only record
 * the client kept of it was Stripe's own receipt — which states a single total
 * and knows nothing about what that total was made of. Migration 0108 started
 * storing the quote as sold precisely so the charge could be itemised after the
 * fact; this is the reader it was stored for. Without it the breakdown is
 * written and never shown, and a client asking "what was the extra $500 for?"
 * gets an answer reconstructed by hand from today's price list.
 *
 * Two things this refuses to do quietly:
 *
 * A refunded or charged-back payment states the refund on its face and shows
 * what is actually left. A receipt for the gross is a document the client can
 * hold up to say they paid us money they did not, and the billing rollup
 * already learned this lesson by summing succeeded rows gross.
 *
 * A row with no stored breakdown gets one line for the whole amount rather than
 * a breakdown synthesised from current prices. Prices move; a refund argued
 * eighteen months from now is about the ladder in force on the day, and an
 * invented itemisation would be indistinguishable from a real one.
 */
export function receiptSections(r: ReceiptForRender): Array<{ heading: string; html: string }> {
  const net = r.amount_cents - r.refunded_cents;
  const lines =
    r.lines.length > 0 ? r.lines : [{ description: 'Valuation engagement', amount_cents: r.amount_cents }];

  const summary =
    `<p>Receipt <strong>${esc(r.reference)}</strong> for ${esc(r.company_name)}</p>` +
    `<p>Paid ${day(r.paid_at)}` +
    (r.express ? ' · Express delivery — 1 business day' : '') +
    `</p>`;

  const rows = lines
    .map(
      (li) =>
        `<tr><td>${esc(li.description)}</td>` +
        `<td>${formatMoneyCents(li.amount_cents, r.currency)}</td></tr>`,
    )
    .join('');

  const table =
    `<table><thead><tr><th>Description</th><th>Amount</th></tr></thead><tbody>${rows}` +
    `<tr><th>Total charged</th><th>${formatMoneyCents(r.amount_cents, r.currency)}</th></tr>` +
    (r.refunded_cents > 0
      ? `<tr><td>Refunded</td><td>−${formatMoneyCents(r.refunded_cents, r.currency)}</td></tr>` +
        `<tr><th>Net paid</th><th>${formatMoneyCents(net, r.currency)}</th></tr>`
      : '') +
    `</tbody></table>`;

  const sections = [
    { heading: 'Receipt', html: summary },
    { heading: 'Line items', html: table },
  ];

  // A chargeback is not a refund and must not read as one: the money is held
  // pending the dispute, and a client owed an explanation gets the status
  // rather than a document that quietly still says "paid".
  if (r.dispute_status) {
    sections.push({
      heading: 'Dispute',
      html: `<p>This payment is subject to a dispute — status: <strong>${esc(r.dispute_status)}</strong>.</p>`,
    });
  }
  return sections;
}
