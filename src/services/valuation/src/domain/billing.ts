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

// ── What counts as a live subscription ───────────────────────────────────────

/**
 * The two questions the word "active" was being used for, separated.
 *
 * There were three answers in the codebase and no statement of any of them.
 * `findActiveSubscription` and `consumeValuation` — the pair that decides
 * whether an account is served and may spend quota — read
 * `('active','trialing','past_due')`. The ops dashboard's subscription count
 * read `status = 'active'`. The MRR beside it, on the same row of the same
 * screen, read `('active','trialing')`.
 *
 * So the three figures an operator reads together could not be reconciled with
 * each other: an MRR containing subscriptions the count next to it excluded,
 * and a count excluding accounts that were consuming a plan's valuations. The
 * gap is not cosmetic — `past_due` is the state dunning exists for, and a
 * screen that reports "3 active subscriptions" while five accounts are being
 * served is where a failed renewal goes unnoticed.
 *
 * Neither set is wrong; they answer different questions. Named here, once, so
 * that the answer to each is a decision rather than whatever the nearest query
 * happened to say.
 */

/**
 * Being served: quota is granted and work is done. Includes `past_due`,
 * because a renewal that has not cleared is a customer we have not yet cut
 * off — that is what dunning is for.
 */
export const SERVED_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'] as const;

/**
 * Contributing recurring revenue. Excludes `past_due`: money that has not
 * arrived is not revenue, and counting it is how MRR drifts above cash.
 */
export const BILLING_SUBSCRIPTION_STATUSES = ['active', 'trialing'] as const;

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

/**
 * Human money for line items / invoice display, from integer minor units.
 *
 * `Intl.NumberFormat` throws a `RangeError` on a currency code it cannot
 * parse, and every currency reaching this function came off a Stripe webhook as
 * `String(obj.currency ?? 'usd')` and was stored in a `text` column with no
 * constraint on it. So a code in any other shape was not a badly formatted
 * amount, it was an exception — thrown from the invoice PDF renderer, from the
 * refund notification, and from the dunning message, i.e. from three places
 * whose failure is a customer not being told something about their own money.
 *
 * The browser's formatter (web-frontend lib/format.moneyFormatter) has fallen
 * back rather than thrown since it was written, printing the amount with the
 * code beside it — which is what `Intl` itself does for a well-formed code it
 * does not recognise. This is the same rule on the server, so the two halves of
 * one figure cannot disagree about whether it is renderable.
 */
export function formatMoneyCents(cents: number, currency: string): string {
  const code = (currency || 'usd').trim().toUpperCase();
  try {
    const format = new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
    return format.format(cents / minorUnitScale(format));
  } catch {
    // A code `Intl` cannot parse: the amount is printed beside it rather than
    // withheld, and cents is the only scale left to assume.
    const plain = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
    return `${code} ${plain}`;
  }
}

/**
 * How many minor units make one major unit, for the currency a formatter was
 * built for.
 *
 * Not every currency has cents. Stripe reports an amount in the currency's own
 * minor unit, and for the zero-decimal currencies — JPY, KRW, VND, CLP, ISK and
 * a dozen more — that unit *is* the major unit: `amount: 100000` on a yen charge
 * is ¥100,000, not ¥1,000. Dividing by 100 regardless printed every one of them
 * at a hundredth of what was actually charged, and pinned two decimal places
 * onto a currency that has none. The three-decimal currencies (BHD, JOD, KWD,
 * OMR, TND) went the other way, printing a tenth of the amount.
 *
 * `Intl` already carries the exponent per currency, so it is read back off the
 * formatter rather than kept as a list here that would drift. Its default for a
 * well-formed code it does not recognise is two, which is the same assumption
 * the divide-by-100 made and the right one to keep.
 */
function minorUnitScale(format: Intl.NumberFormat): number {
  // Typed optional, always present for `style: 'currency'`; cents if not.
  const digits = format.resolvedOptions().maximumFractionDigits;
  return digits === undefined ? 100 : 10 ** digits;
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

// ── The invoice state machine ────────────────────────────────────────────────

/**
 * Every status an invoice row may hold, in lifecycle order.
 *
 * The same four words the column's CHECK constraint names (migration 0080),
 * written here so that queries, the PDF and the frontend read one list rather
 * than each restating it. {@link INVOICE_TRANSITIONS} is the other half: the
 * set of states was already stated in the schema, the edges between them were
 * stated nowhere at all.
 */
export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * Legal onward moves, per status. An empty list is terminal.
 *
 * Taken from Stripe's own invoice lifecycle, because Stripe is the authority on
 * every invoice this system records and a local machine that permitted more
 * would be describing a document we do not issue. A draft is finalised or
 * abandoned; an open invoice is paid or voided; and both endings are final —
 * Stripe will not void a paid invoice, and a voided one is never revived. Money
 * returned after payment is *not* an edge: a refund leaves the invoice `paid`
 * and comes off the charge, which is why it is recorded as an amount
 * (`refunded_cents`, migration 0169) rather than as a status.
 */
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ['open', 'void'],
  open: ['paid', 'void'],
  paid: [],
  void: [],
};

/**
 * The statuses a row may be *created* in.
 *
 * `void` is excluded because it is only ever reached from somewhere: an invoice
 * that was voided before it existed is not a record of anything. Enforced by
 * {@link INVOICE_STATUSES} plus this list rather than by the CHECK, which can
 * only see the value and not where it came from.
 */
export const INVOICE_INITIAL_STATUSES = ['draft', 'open', 'paid'] as const;

/**
 * The statuses this system actually produces, as opposed to those it permits.
 *
 * Exactly one, and stated out loud because the gap between this list and
 * {@link INVOICE_STATUSES} is the shape of the whole subsystem. Invoices are
 * not issued here; they are *recorded* here, by the `invoice.paid` /
 * `invoice.payment_succeeded` branch of the billing webhook, after Stripe has
 * already taken the money. A row is therefore born in its terminal state and
 * nothing ever writes to `status` again, so every edge in
 * {@link INVOICE_TRANSITIONS} is unexercised and `draft`, `open` and `void` are
 * unreachable.
 *
 * That is a real property to depend on — `billingSummary` nets revenue over
 * `status = 'paid'` and would silently omit an `open` row — and a fragile one
 * to leave implicit, since it holds only because no second writer exists. The
 * census in test/integration/billingStateMachine.test.ts asserts it against the
 * source, so adding one is a decision somebody has to make here rather than a
 * consequence they discover in a revenue line.
 */
export const INVOICE_REACHABLE_STATUSES = ['paid'] as const;

/**
 * May an invoice in `from` be moved to `to`? Same-status is not a move.
 *
 * Read by the census rather than by a handler, and deliberately so: there is no
 * transition surface to guard because nothing transitions an invoice — see
 * {@link INVOICE_REACHABLE_STATUSES}. What this and {@link INVOICE_TRANSITIONS}
 * are for is the moment somebody adds one, at which point the machine it has to
 * obey is written down instead of being inferred from the handler being added.
 */
export function canTransitionInvoice(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return INVOICE_TRANSITIONS[from].includes(to);
}

/** Nothing legally follows this status. */
export function isTerminalInvoiceStatus(status: InvoiceStatus): boolean {
  return INVOICE_TRANSITIONS[status].length === 0;
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
  /**
   * Money returned against this invoice (migration 0169). Optional because the
   * PDF is rendered from rows that predate the column, where 0 is correct.
   */
  refunded_cents?: number;
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

  // Bounded against the invoice for the same reason the SQL rollup is: Stripe's
  // refund total is authoritative, and a document is the wrong place to argue
  // with it by rendering a negative net.
  const refunded = Math.max(0, Math.min(inv.refunded_cents ?? 0, inv.amount_cents));
  const table =
    `<table><thead><tr><th>Description</th><th>Qty</th><th>Amount</th></tr></thead>` +
    `<tbody>${rows}<tr><th>Total</th><th></th><th>${formatMoneyCents(inv.amount_cents, inv.currency)}</th></tr>` +
    // The same refusal `receiptSections` makes below: an invoice that has been
    // refunded states it on its face and shows what is actually left. Rendering
    // the gross gives the customer a document saying they paid us money they
    // did not.
    (refunded > 0
      ? `<tr><td>Refunded</td><td></td><td>−${formatMoneyCents(refunded, inv.currency)}</td></tr>` +
        `<tr><th>Net paid</th><th></th><th>${formatMoneyCents(inv.amount_cents - refunded, inv.currency)}</th></tr>`
      : '') +
    `</tbody></table>`;

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

// ── "We have your money" ─────────────────────────────────────────────────────

/**
 * The confirmations sent when a payment actually settles.
 *
 * Everything else that can happen to a payment already tells somebody. A
 * declined renewal notifies the subscriber and the billing group, a refund and
 * a chargeback both alert ops, and a checkout that is never completed leaves a
 * `pending` row the pay panel keeps offering. Money *arriving* told nobody: the
 * payment was marked succeeded, the engagement flipped to paid, an invoice was
 * allocated a sequence number an auditor reads as a count of what was billed —
 * and the client's whole account of it was Stripe's own receipt, which states
 * one total and knows nothing about what that total was made of, or a PDF
 * behind a login they had to know to go and look for.
 *
 * Both messages state the figure and *name* the document rather than carrying
 * it. The receipt and the invoice are authenticated routes on purpose: a PDF
 * mailed to whatever address is on the account is a financial record that
 * outlives our control of it, and the itemisation is precisely the part that
 * gets argued about eighteen months later.
 *
 * Pure, and next to `receiptSections` rather than inline at the webhook,
 * because the figure in the sentence and the figure in the PDF have to be the
 * same figure. Both read the same cents off the same row.
 */
export interface SettlementMessage {
  subject: string;
  body: string;
  /** Values for a `communication_templates` override of the built-in copy. */
  vars: Record<string, string>;
}

/** A settled one-off engagement payment, in the words the payer gets. */
export function paymentReceivedMessage(r: {
  /** The engagement number the client already quotes. */
  reference: string;
  company_name: string;
  kind: string;
  amount_cents: number;
  currency: string;
  /** Bought next-business-day delivery. A property of the order, so it is stated. */
  express: boolean;
  /** Where the itemised receipt lives — an authenticated page, not an attachment. */
  receipt_link: string;
}): SettlementMessage {
  const amount = formatMoneyCents(r.amount_cents, r.currency);
  const kindLabel = r.kind.toUpperCase();
  const subject = `Payment received — ${kindLabel} valuation for ${r.company_name}`;
  const body =
    `We've received your payment of ${amount} for the ${kindLabel} valuation for ` +
    `${r.company_name} (engagement ${r.reference}).` +
    (r.express ? ' Express delivery was included in this order.' : '') +
    `\n\nThe itemised receipt is on the engagement's payment panel: ${r.receipt_link}` +
    `\n\nIf you were not expecting this charge, reply to this email and we will look into it.`;
  return {
    subject,
    body,
    vars: {
      company_name: r.company_name,
      // The engagement kind in both spellings the catalog declares. The label
      // is already computed for the subject line; a receipt template writing
      // "your {{kind_label}} valuation" had it rendered as literal braces
      // purely because this map did not pass on what the sentence above it
      // used.
      kind: r.kind,
      kind_label: kindLabel,
      valuation_number: r.reference,
      amount_paid: amount,
      receipt_link: r.receipt_link,
    },
  };
}

/** A settled subscription invoice, in the words the subscriber gets. */
export function invoicePaidMessage(r: {
  number: string;
  amount_cents: number;
  currency: string;
  period_start: string | null;
  period_end: string | null;
  invoice_link: string;
}): SettlementMessage {
  const amount = formatMoneyCents(r.amount_cents, r.currency);
  // A period is stated only when both ends of it are known. Half a period is
  // worse than none: "for the period starting 1 August" reads as a commitment
  // about when it stops, and the row does not say.
  const period = r.period_start && r.period_end ? `${day(r.period_start)} to ${day(r.period_end)}` : null;
  return {
    subject: `Invoice ${r.number} — payment received`,
    body:
      `Thank you — we've received your payment of ${amount}` +
      (period ? ` for the period ${period}` : '') +
      `.\n\nInvoice ${r.number} is on your billing page: ${r.invoice_link}`,
    vars: {
      invoice_number: r.number,
      amount_paid: amount,
      invoice_link: r.invoice_link,
      // Blank, not absent. The prose above states no period at all when it
      // knows only one end of one — half a period reads as a commitment the row
      // does not make — but an *absent* var is not the same thing as an empty
      // one to `renderTemplate`, which leaves a name nobody supplies verbatim.
      // So an ops-authored `invoice_receipt` override reading "for the period
      // {{invoice_period}}" previewed against the catalog's sample and was
      // delivered, on any invoice missing a period end, as literal braces. The
      // catalog's own wording for this variable is "blank unless both ends of
      // it are known"; this is that.
      invoice_period: period ?? '',
    },
  };
}

// ── What plan a subscription is actually on ──────────────────────────────────

/** A recurring price, in the three fields that identify a plan in the catalogue. */
export interface SubscriptionPrice {
  amount_cents: number;
  currency: string;
  interval: 'month' | 'year';
}

/**
 * The price a Stripe subscription object is actually billing, when it names one
 * unambiguously.
 *
 * `plan_tier` reaches this system as *metadata*, stamped onto the subscription
 * once by `createSubscriptionCheckoutSession` and never written again. A plan
 * change does not touch it: Stripe's hosted billing portal — which the portal
 * route exists to open, and whose advertised job is "cancel, change plan,
 * update the card" — swaps the subscription's *item* and leaves the metadata
 * exactly as the original checkout wrote it. So the
 * `customer.subscription.updated` that reports an upgrade carried the tier the
 * customer just left, `upsertSubscription` wrote it back over itself, and the
 * change was invisible here in both directions:
 *
 *   - a downgrade kept the larger `valuation_limit` the customer had stopped
 *     paying for, because quota is joined from `plan_tier`;
 *   - an upgrade went on refusing the thirteenth valuation with a 402 against
 *     the old limit, on an account now paying the unlimited tier;
 *
 * and on both, the Billing screen, the ops dashboard's MRR and the invoice PDF
 * all named the wrong plan. Nothing else on the event ever disagreed loudly
 * enough to notice, because nothing else read the item at all.
 *
 * The item is the authority Stripe bills from, so it is what the tier is
 * resolved against — see `findPlanByPrice`. Deliberately narrow about when it
 * will answer: exactly one item, quantity one, a whole-minor-unit amount and a
 * recurring interval the catalogue can hold. Every plan this product sells is
 * one item at quantity one, so anything else is a subscription assembled
 * outside this system, and guessing a tier for it would be worse than falling
 * back to what the metadata says.
 */
export function subscriptionPrice(obj: Record<string, unknown>): SubscriptionPrice | null {
  const items = obj.items as { data?: unknown } | undefined;
  const data = Array.isArray(items?.data) ? (items.data as Array<Record<string, unknown>>) : null;
  if (!data || data.length !== 1) return null;
  const item = data[0]!;
  const quantity = item.quantity;
  if (quantity !== undefined && quantity !== null && quantity !== 1) return null;
  const price = item.price as Record<string, unknown> | undefined;
  if (!price || typeof price !== 'object') return null;
  const amount = price.unit_amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) return null;
  const currency = price.currency;
  if (typeof currency !== 'string' || currency.trim() === '') return null;
  const recurring = price.recurring as Record<string, unknown> | undefined;
  const interval = recurring?.interval;
  if (interval !== 'month' && interval !== 'year') return null;
  return { amount_cents: amount, currency: currency.trim().toLowerCase(), interval };
}

/**
 * A subscription that has ended, in the words the subscriber gets.
 *
 * The one billing transition that told nobody. A failed renewal notifies the
 * subscriber and the billing group, a settled invoice sends a receipt, and a
 * cancellation — the transition that takes the plan's quota away, immediately,
 * because `findActiveSubscription` excludes 'canceled' — produced no
 * notification and no email at all. A customer who cancelled in Stripe's portal
 * and a customer whose subscription Stripe cancelled at the end of dunning got
 * the same silence, and the second of those had not decided anything.
 *
 * States what actually happened rather than thanking them: the plan by name,
 * the date it ended, and the two things that remain true and are the reason
 * support hears from them — work already delivered stays reachable, and the
 * billing page still opens the portal their old invoices live behind.
 *
 * Ops are not copied. A cancellation is already on the billing dashboard's
 * count and in the MRR beside it, and a notification per churned account is not
 * a thing anybody acts on individually.
 */
export function subscriptionCanceledMessage(r: {
  plan_name: string;
  /** When the subscription ended, as an ISO instant. */
  ended_at: string;
  billing_link: string;
}): SettlementMessage {
  const endedOn = day(r.ended_at);
  const subject = `Your ${r.plan_name} subscription has ended`;
  const body =
    `Your ${r.plan_name} subscription ended on ${endedOn}, and the plan's included ` +
    `valuations are no longer available.` +
    `\n\nValuations already delivered stay available on your account, and your past ` +
    `invoices are on the billing page: ${r.billing_link}` +
    `\n\nIf this was not what you intended, you can start a plan again from the same page.`;
  return {
    subject,
    body,
    vars: {
      plan_name: r.plan_name,
      subscription_ended_on: endedOn,
      invoice_link: r.billing_link,
    },
  };
}
