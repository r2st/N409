/**
 * Subscription billing domain (feature 7): plan-limit / usage logic and invoice
 * rendering. Pure functions so limit enforcement and invoice formatting are
 * unit-testable without Stripe or the DB.
 */

import { numberFormat } from './numberFormat.js';

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

/**
 * Every state a subscription row can be in (migration 0080's CHECK), as one
 * list rather than as the union of two sets that happen to cover it.
 *
 * `SERVED_` and `BILLING_` above answer *questions about* a status; this is the
 * vocabulary itself, and {@link SUBSCRIPTION_TRANSITIONS} beside it is the part
 * that had never been written down at all. Both the invoice machine and the
 * payments machine (domain/payments.ts) declare their edges; the subscription
 * one — the machine that decides whether an account is served — declared only
 * its states, in a CHECK constraint, with nothing saying which moves between
 * them are legal or which of them is an ending.
 */
export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'canceled'] as const;

/**
 * The legal moves, which are Stripe's moves.
 *
 * This platform does not decide a subscription's status; it mirrors one, and
 * every write comes off a `customer.subscription.*` event, a settled Checkout
 * Session, or a failed invoice. So the table below says what Stripe's own
 * lifecycle permits once projected through {@link STRIPE_STATUS_MAP}, and the
 * one edge that is *ours* is the absence of any row out of `canceled`.
 *
 * `active → trialing` is here because Stripe allows it — setting `trial_end`
 * on a live subscription puts it back into `trialing`, which is how a trial is
 * granted or extended from the dashboard — and a machine that called it illegal
 * would be describing a product rule nobody wrote instead of the system it
 * mirrors.
 *
 * No status lists itself: a redelivery of the state a subscription is already
 * in is not a transition, and the writers depend on that distinction —
 * `newly_canceled` exists precisely because 'canceled' arriving twice must fire
 * once. See `cancelSubscription` and `upsertSubscription`.
 */
export const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  trialing: ['active', 'past_due', 'canceled'],
  active: ['trialing', 'past_due', 'canceled'],
  past_due: ['active', 'trialing', 'canceled'],
  // Terminal, and terminal in Stripe too: a cancelled subscription cannot be
  // reactivated, and resubscribing issues a new subscription id. That is what
  // makes "already cancelled" never stale information whatever order events
  // arrive in, which is the invariant every writer of this column enforces.
  canceled: [],
};

/**
 * The statuses a row may be *created* in.
 *
 * All four, including the ending — deliberately, and it is the one place this
 * machine differs from the invoice one. A `customer.subscription.updated`
 * carrying `status: 'canceled'` for a subscription this platform has no row for
 * is a subscription it never carried, and recording it as cancelled is the
 * honest answer; refusing the insert would leave the account with no row at all
 * and the next event with nothing to conflict against. It is not *news*, which
 * is a separate question the write answers with `newly_canceled`.
 */
export const SUBSCRIPTION_INITIAL_STATUSES = SUBSCRIPTION_STATUSES;

/** Whether a subscription may move from one status to another. */
export function canTransitionSubscription(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return SUBSCRIPTION_TRANSITIONS[from].includes(to);
}

/** A status with no way out — the one property the writers actually enforce. */
export function isTerminalSubscriptionStatus(status: SubscriptionStatus): boolean {
  return SUBSCRIPTION_TRANSITIONS[status].length === 0;
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
 * Whether the counter beside the plan's limit is counting an earlier period
 * than the one the subscription is showing.
 *
 * The two are the same on every ordinary subscription, and they come apart on
 * exactly one transition — the one R240 added `quota_period_start` for. Stripe
 * advances `current_period_start` when it *raises* the renewal invoice, not
 * when the invoice settles, so a declined renewal arrives carrying the next
 * period and `past_due` together. The reset is gated on the money as well as
 * the date, so the period moves and the counter stays where the last paid
 * period left it.
 *
 * Which is right, and unreadable where it is shown. `/me/subscription` states
 * "9 of 12 valuations used" beside "Renews on <the new period's end>", and
 * those two figures are about different periods: the count belongs to a period
 * that has closed, and the allowance for the one being named has not been paid
 * for and does not exist yet. A subscriber with none left reads it as their
 * plan being spent with a month still to run, and nothing on the screen says
 * that settling the renewal is what brings the allowance back — the dunning
 * banner beside it talks about keeping the plan active and not about quota.
 *
 * The data export was given `quota_period_start` for precisely this reason
 * when the column was added (repos/dataExport.ts) and the screens were not, so
 * the fact was exportable and unstated on the two surfaces that show the pair.
 *
 * Compared as instants, and `Object.is` so two unparseable dates are not
 * reported as a disagreement. A row with neither period — a subscription
 * recorded from a Checkout Session before the subscription event lands — has
 * nothing to disagree about.
 */
export function quotaAwaitsRenewal(sub: {
  current_period_start: Date | string | null;
  quota_period_start: Date | string | null;
}): boolean {
  return !Object.is(periodInstant(sub.current_period_start), periodInstant(sub.quota_period_start));
}

function periodInstant(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return new Date(value).getTime();
}

/**
 * The 402 a subscriber reads when the plan's valuations are gone.
 *
 * It said: "Your plan's included valuations are used up for this period —
 * upgrade or purchase additional valuations to continue." Three things wrong
 * with that sentence, and the third is the one R240 created.
 *
 * It offers a remedy this product does not sell. There is no additional-
 * valuation purchase: `ADDON_KEYS` is express delivery and the QSBS letter,
 * both per-engagement extras on a checkout, and neither returns quota. A
 * subscriber told to buy more went looking for a control that has never
 * existed, and support had nothing to point at either.
 *
 * It states no figures. "Used up" is the one fact the caller already knows;
 * what decides whether they wait or pay is how many the plan includes and when
 * the next allowance starts, and both were on the row this was raised from.
 *
 * And on one account it is simply the wrong instruction. A declined renewal
 * advances `current_period_start` and leaves the counter on the last period
 * paid for ({@link quotaAwaitsRenewal}), so a subscriber in dunning hits this
 * refusal with nothing to upgrade *to* — the plan they hold is the plan they
 * want, and the allowance comes back when the renewal settles. Telling them to
 * upgrade sells a larger plan to fix a card that expired, and the Billing
 * screen has said the true thing beside the counter since R240 while the
 * refusal that actually blocks the work said this.
 *
 * `/billing` and not "Settings → Billing": billing is its own route, and the
 * remedy has to name a page that exists.
 */
export function planLimitDetail(r: {
  plan_name: string;
  valuation_limit: number | null;
  valuations_used: number;
  /** When the current period ends, from the subscription row. */
  current_period_end: Date | string | null;
  /** {@link quotaAwaitsRenewal} for this subscription. */
  awaiting_renewal: boolean;
}): string {
  const included =
    typeof r.valuation_limit === 'number' && Number.isFinite(r.valuation_limit)
      ? `all ${r.valuation_limit} valuations included in ${r.plan_name}`
      : `the valuations included in ${r.plan_name}`;

  if (r.awaiting_renewal) {
    // No period date here on purpose. The one this row carries is the *new*
    // period Stripe opened when it raised the renewal invoice, and naming it
    // would promise an allowance on a date that arrives only if the payment
    // does — which is the pair of figures R240 found unreadable in the first
    // place.
    return (
      `You have used ${included}, and the next allowance starts when your renewal payment goes ` +
      `through — it was declined, so the period has moved and the count has not. Update your ` +
      `card on the billing page (/billing) and the included valuations come back with it.`
    );
  }

  const renews = periodDay(r.current_period_end);
  return (
    `You have used ${included} for this billing period` +
    (renews ? `, and the next allowance starts on ${renews}` : '') +
    `. To start one before then, move to a plan with a higher limit from the billing page ` +
    `(/billing) — there is no separate top-up to buy.`
  );
}

/** A period boundary as a plain day, or null when the row does not carry one. */
function periodDay(value: Date | string | null | undefined): string | null {
  const instant = periodInstant(value);
  if (instant === null || !Number.isFinite(instant)) return null;
  return new Date(instant).toISOString().slice(0, 10);
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
    const format = numberFormat('en-US', { style: 'currency', currency: code });
    return format.format(cents / minorUnitScale(format));
  } catch {
    // A code `Intl` cannot parse: the amount is printed beside it rather than
    // withheld, and cents is the only scale left to assume.
    const plain = numberFormat('en-US', {
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

/**
 * What an invoice was actually made of, from the Stripe invoice object.
 *
 * This was one line, always: `{ description: obj.description ?? 'Subscription',
 * amount_cents: <the whole invoice> }`. A Stripe invoice's top-level
 * `description` is null unless somebody set one, so in practice every invoice
 * this system has ever recorded says "Subscription" for the total and nothing
 * else — and `line_items` exists precisely so the PDF can itemise a charge
 * eighteen months after the fact.
 *
 * The case where that costs something real is a plan change mid-cycle. Stripe
 * prorates it as two lines — the unused time on the plan being left, as a
 * credit, and the remaining time on the plan being joined — and the customer's
 * whole explanation of an amount they did not expect is those two lines. Netted
 * into one figure labelled "Subscription", the invoice cannot answer the only
 * question anybody asks it.
 *
 * The breakdown is recorded only when it is a breakdown *of this amount*:
 * every line a whole number of minor units, and their sum equal to what was
 * charged. Stripe's own `amount_paid` is the authority on the charge and is
 * what the PDF totals, so lines that do not add up to it — an applied credit
 * balance, a partial payment — would render a table whose rows contradict its
 * own total. In that case the single summary line is still the honest answer:
 * one figure, correctly labelled, rather than an itemisation that argues with
 * itself.
 */
const MAX_INVOICE_LINES = 50;

export function invoiceLineItems(
  obj: Record<string, unknown>,
  amountCents: number,
  fallbackDescription: string,
): InvoiceLineItem[] {
  const summary: InvoiceLineItem[] = [{ description: fallbackDescription, amount_cents: amountCents }];
  const lines = obj.lines as { data?: unknown } | undefined;
  const data = Array.isArray(lines?.data) ? (lines.data as Array<Record<string, unknown>>) : null;
  if (!data || data.length === 0 || data.length > MAX_INVOICE_LINES) return summary;

  const items: InvoiceLineItem[] = [];
  let sum = 0;
  for (const line of data) {
    if (!line || typeof line !== 'object') return summary;
    const amount = line.amount;
    if (typeof amount !== 'number' || !Number.isInteger(amount)) return summary;
    const description =
      typeof line.description === 'string' && line.description.trim() !== ''
        ? line.description.trim()
        : fallbackDescription;
    const quantity =
      typeof line.quantity === 'number' && Number.isInteger(line.quantity) && line.quantity > 0
        ? line.quantity
        : undefined;
    items.push(
      quantity === undefined
        ? { description, amount_cents: amount }
        : { description, amount_cents: amount, quantity },
    );
    sum += amount;
  }
  return sum === amountCents ? items : summary;
}

/**
 * A trial about to end, in the words the subscriber gets.
 *
 * Stripe sends `customer.subscription.trial_will_end` three days before a trial
 * converts, and nothing handled it. A trial is a `trialing` subscription here —
 * a served status, with the plan's full quota — and the first thing the
 * subscriber heard about its ending was a card charge, or, where no card was on
 * file, the quota simply stopping. Both are the same silence the cancellation
 * notice was added for, on the transition a customer is most likely to want to
 * act before.
 *
 * States the two facts that decide what they do: the day it converts, and what
 * they will be charged. The amount comes off the plan catalogue rather than the
 * event, so it is the figure the Billing screen shows beside it.
 */
export function trialEndingMessage(r: {
  plan_name: string;
  /** When the trial converts, as an ISO instant. */
  trial_ends_at: string;
  price_cents: number;
  currency: string;
  billing_link: string;
}): SettlementMessage {
  const endsOn = day(r.trial_ends_at);
  const price = formatMoneyCents(r.price_cents, r.currency);
  const subject = `Your ${r.plan_name} trial ends on ${endsOn}`;
  const body =
    `Your ${r.plan_name} trial ends on ${endsOn}. Unless you cancel before then, ` +
    `the plan continues and you will be charged ${price}.` +
    `\n\nYou can change the plan, add or replace a card, or cancel from your billing ` +
    `page: ${r.billing_link}` +
    `\n\nIf there is no card on file when the trial ends, the plan will not continue ` +
    `and the included valuations stop being available.`;
  return {
    subject,
    body,
    vars: {
      plan_name: r.plan_name,
      trial_ends_on: endsOn,
      plan_price: price,
      invoice_link: r.billing_link,
    },
  };
}

// ── Stripe's subscription statuses, and what each one means here ─────────────

/**
 * Every status a Stripe subscription can hold.
 *
 * The local mapping was a short if-chain ending in `return 'past_due'`, with a
 * trailing comment listing three statuses it was standing in for. Stripe has
 * eight, and the two the comment did not name are the two that matter:
 *
 * - `unpaid` is where dunning *ends* on a Stripe account configured to keep the
 *   subscription rather than cancel it. Every retry has been made and none
 *   worked; nothing further is coming.
 * - `paused` is not a dunning state at all. It is a subscription with
 *   collection paused, or a trial that ended with no payment method under
 *   `pause` end-behaviour. Nothing is owed and nothing is being retried.
 *
 * Both fell into 'past_due', which is a served status — so an account in either
 * keeps the plan's full quota indefinitely, and the Billing screen tells the
 * subscriber their last payment did not go through, which in the `paused` case
 * never happened. That is the whole answer to "is there a grace period": there
 * is, it is `past_due`, and it has no end. Bounding it is a policy decision
 * with revenue consequences and is not made here; naming it is, so that the
 * next status Stripe adds is a decision somebody takes rather than a default
 * they inherit.
 *
 * The list is declared and the mapping is total over it, held by a census, so a
 * status can no longer arrive unconsidered.
 */
export const STRIPE_SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;
export type StripeSubscriptionStatus = (typeof STRIPE_SUBSCRIPTION_STATUSES)[number];

/**
 * The four this schema holds — the same list {@link SUBSCRIPTION_STATUSES}
 * declares, spelled once so a status cannot be added to the machine and not to
 * the mapping's range, or the other way about.
 */
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export type LocalSubscriptionStatus = SubscriptionStatus;

/**
 * Stripe's status → the four this schema holds (migration 0080).
 *
 * `incomplete` and `incomplete_expired` are the two halves of a subscription
 * whose first payment never cleared: the first is still recoverable and is held
 * where a failed renewal is held, the second is Stripe's own terminal verdict
 * on it. `unpaid` and `paused` are the two documented above — served, for want
 * of a status that says otherwise, and each an entry in this table rather than
 * a fallthrough so the reading is visible.
 */
export const STRIPE_STATUS_MAP: Record<StripeSubscriptionStatus, LocalSubscriptionStatus> = {
  incomplete: 'past_due',
  incomplete_expired: 'canceled',
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  canceled: 'canceled',
  unpaid: 'past_due',
  paused: 'past_due',
};

/**
 * The local status for whatever Stripe said, including something it has not
 * said yet.
 *
 * An unknown status is held as `past_due` — the same reading the if-chain gave
 * it, and the conservative one: it neither hands over a plan (`active`) nor
 * ends a subscription that may well be live (`canceled`). It is *logged* by the
 * caller, which the fallthrough could not be, because a status nobody has
 * considered being served is exactly the thing worth finding out about.
 */
export function localSubscriptionStatus(stripe: string): {
  status: LocalSubscriptionStatus;
  known: boolean;
} {
  const mapped = (STRIPE_STATUS_MAP as Record<string, LocalSubscriptionStatus>)[stripe];
  return mapped ? { status: mapped, known: true } : { status: 'past_due', known: false };
}
