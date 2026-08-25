import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isOps } from '../lib/rbac';
import { formatCents, formatDate } from '../lib/format';
import { Button, EmptyState, ErrorNote, Spinner } from './ui';

interface Plan {
  tier: string;
  name: string;
  valuation_limit: number | null;
  price_cents: number;
  currency: string;
  interval: 'one_time' | 'month' | 'year';
}
interface Usage {
  limit: number | null;
  used: number;
  remaining: number | null;
  unlimited: boolean;
  exhausted: boolean;
}
interface Subscription {
  id: string;
  plan_tier: string;
  status: string;
  current_period_end: string | null;
}
interface Invoice {
  id: string;
  number: string;
  amount_cents: number;
  currency: string;
  status: string;
  issued_at: string;
  /**
   * Money returned against this invoice (migration 0169). Optional because a
   * row written before the column existed has neither field, and 0 is the
   * right reading of that.
   */
  refunded_cents?: number | string | null;
  refunded_at?: string | null;
}
interface MySub {
  subscription: Subscription | null;
  plan: Plan | null;
  usage: Usage | null;
  invoices: Invoice[];
  /** A Stripe customer exists and payments are configured. */
  portal_available?: boolean;
}

/** Statuses where the subscription needs the customer's attention, not ours. */
const NEEDS_ATTENTION = new Set(['past_due', 'unpaid', 'incomplete']);

/**
 * The one line under an invoice that says the money came back.
 *
 * A Stripe refund does not move an invoice's status — the invoice stays `paid`
 * and the money comes off the charge — so `status` alone cannot say it, and
 * partial refunds are not a status at all. The invoice PDF this same row links
 * to has stated "Refunded / Net paid" since migration 0169 (domain/billing
 * .invoiceSections) and both fields already arrive on `/me/subscription`;
 * nothing here rendered them, so a customer comparing their card statement
 * against this table read a full charge that had been partly returned. This is
 * the same omission `settlementNote` closed on the engagement payments table.
 *
 * Bounded against the invoice for the reason the SQL rollup and the PDF are:
 * Stripe's refund total is authoritative, and a screen is the wrong place to
 * argue with it by printing a negative net.
 */
export function invoiceRefundNote(inv: Invoice): string | null {
  const amount = Number(inv.amount_cents);
  const raw = Number(inv.refunded_cents ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const refunded = Number.isFinite(amount) ? Math.min(raw, amount) : raw;
  const full = Number.isFinite(amount) && refunded >= amount;
  const when = inv.refunded_at ? ` on ${formatDate(inv.refunded_at)}` : '';
  const net = Number.isFinite(amount) ? ` · net ${formatCents(amount - refunded, inv.currency)}` : '';
  return `${full ? 'Refunded' : 'Partially refunded'} ${formatCents(refunded, inv.currency)}${when}${net}`;
}

const money = (cents: number, currency = 'usd') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
const per = (i: string) => (i === 'year' ? '/yr' : i === 'month' ? '/mo' : '');

/**
 * A recurring tier bills one amount; the one-time tier is a single catalogue
 * row covering a price list that differs by product ($990 for an SMB opinion,
 * $1,190 for a 409A, $1,490 for ASC 718/820). Quoting it flat made this card
 * disagree with the Stripe page one click later, so it renders as a floor.
 * Mirrors `isEntryPrice` in the valuation service's billing domain.
 */
const isEntryPrice = (interval: Plan['interval']) => interval === 'one_time';

/**
 * Subscription & retainer billing (feature 7): plan selection, current
 * subscription + usage, invoice list, and — for ops — an admin billing
 * dashboard summarising all subscriptions and invoices.
 */
export function SubscriptionSection() {
  const { user } = useAuth();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [mine, setMine] = useState<MySub | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ plans: p }, m] = await Promise.all([
        api<{ plans: Plan[] }>('/billing/plans'),
        api<MySub>('/me/subscription'),
      ]);
      setPlans(p);
      setMine(m);
    } catch {
      setError('Could not load subscription details.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const subscribe = async (tier: string) => {
    setError(null);
    setBusy(tier);
    try {
      const { checkout_url } = await api<{ checkout_url: string }>('/billing/subscribe', {
        method: 'POST',
        body: { plan_tier: tier },
      });
      window.location.href = checkout_url;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start checkout.');
      setBusy(null);
    }
  };

  /**
   * Hands the customer to Stripe's hosted portal to cancel, change plan, or
   * replace a card. Deliberately a redirect rather than screens of our own:
   * card details never touch this app, and "cancel" being one click away is
   * both the honest thing and, increasingly, the required one.
   */
  const openPortal = async () => {
    setError(null);
    setBusy('portal');
    try {
      const { portal_url } = await api<{ portal_url: string }>('/billing/portal', { method: 'POST' });
      window.location.href = portal_url;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open billing management.');
      setBusy(null);
    }
  };

  // Before the spinner, not after: the load sets an error and leaves `mine`
  // null, so an error rendered only in the loaded markup below is one the
  // customer never sees — the billing section just spins.
  if (error && !mine) return <ErrorNote>{error}</ErrorNote>;
  if (!mine) return <Spinner />;

  return (
    <section className="mt-10">
      <h2 className="font-display text-xl font-semibold text-ink-900">Subscription</h2>
      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {mine.subscription ? (
        <div className="mt-4 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-semibold text-ink-900">
              {mine.plan?.name ?? mine.subscription.plan_tier}
            </span>
            <span className="rounded-full bg-bond-50 px-2.5 py-0.5 text-xs font-semibold text-bond-700">
              {mine.subscription.status}
            </span>
          </div>
          {mine.usage && (
            <div className="mt-3 text-sm text-ink-600" data-testid="usage">
              {mine.usage.unlimited ? (
                <>Unlimited valuations · {mine.usage.used} used this period</>
              ) : (
                <>
                  {mine.usage.used} of {mine.usage.limit} valuations used ·{' '}
                  <strong className={mine.usage.exhausted ? 'text-red-600' : 'text-ink-900'}>
                    {mine.usage.remaining} remaining
                  </strong>
                </>
              )}
            </div>
          )}
          {/* A declined renewal is nearly always an expired card, so say what
              happened and put the fix one click away rather than leaving the
              account to lapse. */}
          {NEEDS_ATTENTION.has(mine.subscription.status) && (
            <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
              Your last payment did not go through. Update your payment method to keep your plan active.
            </p>
          )}
          {mine.portal_available && (
            <div className="mt-4 flex flex-wrap gap-3">
              <Button variant="secondary" disabled={busy === 'portal'} onClick={() => void openPortal()}>
                {busy === 'portal' ? 'Opening…' : 'Manage subscription'}
              </Button>
              <span className="self-center text-xs text-ink-400">
                Update your card, change plan, or cancel — handled securely by Stripe.
              </span>
            </div>
          )}
        </div>
      ) : plans.length === 0 ? (
        /* A configured Stripe catalogue is what fills this grid, and an
           unconfigured one is a real deployment state rather than a bug — so
           the empty response used to render the heading above and then nothing
           at all, which reads as a page that failed to finish. */
        <EmptyState title="No plans available right now">
          Subscription plans aren’t published yet. Contact us and we’ll set your account up directly.
        </EmptyState>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {plans.map((p) => (
            <div key={p.tier} className="rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
              <div className="font-semibold text-ink-900">{p.name}</div>
              <div className="tnum mt-2 font-display text-2xl font-semibold text-ink-900">
                {isEntryPrice(p.interval) && (
                  <span className="mr-1 text-sm font-normal text-ink-400">From</span>
                )}
                {money(p.price_cents, p.currency)}
                <span className="text-sm font-normal text-ink-400">{per(p.interval)}</span>
              </div>
              <div className="mt-1 text-sm text-ink-400">
                {p.valuation_limit === null ? 'Unlimited valuations' : `${p.valuation_limit} valuations`}
              </div>
              {isEntryPrice(p.interval) && (
                <p className="mt-1 text-xs text-ink-400" data-testid="entry-price-note">
                  Priced per valuation — the exact amount is shown before you pay.
                </p>
              )}
              {p.interval !== 'one_time' && (
                <Button className="mt-4 w-full" disabled={busy === p.tier} onClick={() => subscribe(p.tier)}>
                  {busy === p.tier ? 'Redirecting…' : 'Subscribe'}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {mine.invoices.length > 0 && (
        <div className="mt-6">
          <h3 id="invoices-heading" className="overline mb-2 text-ink-400">
            Invoices
          </h3>
          <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
            <table className="w-full min-w-[480px] text-sm" aria-labelledby="invoices-heading">
              <thead>
                <tr className="sr-only">
                  <th scope="col">Invoice</th>
                  <th scope="col">Status</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Download</th>
                </tr>
              </thead>
              <tbody>
                {mine.invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-paper-200 last:border-0">
                    <td className="px-4 py-2.5 font-semibold text-ink-800">{inv.number}</td>
                    <td className="px-4 py-2.5 text-ink-500">
                      {inv.status}
                      {invoiceRefundNote(inv) && (
                        <div className="mt-1 text-xs text-ink-500" data-testid="invoice-refund-note">
                          {invoiceRefundNote(inv)}
                        </div>
                      )}
                    </td>
                    <td className="tnum px-4 py-2.5 text-right text-ink-900">
                      {money(inv.amount_cents, inv.currency)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <a
                        className="text-sm font-semibold text-bond-600 hover:text-bond-700"
                        href={`/api/v1/billing/invoices/${inv.id}/pdf`}
                      >
                        PDF
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {isOps(user) && <AdminBillingDashboard />}
    </section>
  );
}

interface AdminSub {
  id: string;
  email: string;
  plan_name: string;
  status: string;
  valuations_used: number;
  valuation_limit: number | null;
}
interface AdminBilling {
  subscriptions: AdminSub[];
  invoices: Array<{
    id: string;
    number: string;
    email: string;
    amount_cents: number;
    currency: string;
    status: string;
  }>;
  summary: {
    active: number;
    trialing: number;
    past_due: number;
    served: number;
    mrr_cents: number;
    gross_cents: number;
    refunded_cents: number;
    collected_cents: number;
    month_start: string;
    month_collected_cents: number;
    prev_month_collected_cents: number;
  };
}

function AdminBillingDashboard() {
  const [data, setData] = useState<AdminBilling | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<AdminBilling>('/admin/billing')
      .then(setData)
      .catch((err: unknown) => {
        /*
         * 403 is the one failure that means "this reader should not be seeing
         * this section at all". `isOps` is a client-side read of the token, so
         * the server is the authority, and the section removing itself without
         * comment is the right answer — that is what the empty catch was for.
         *
         * Every other failure is the opposite: the reader is entitled to the
         * dashboard and it is not there. Discarding those took MRR, the active
         * count and the whole invoice table off the page with nothing left
         * behind, so what it read as was "ops has no billing view" rather than
         * "one request did not come back".
         */
        if (err instanceof ApiError && err.status === 403) return;
        setError(err instanceof ApiError ? err.message : 'Could not load the billing dashboard.');
      });
  }, []);
  if (error) {
    return (
      <div className="mt-10" data-testid="admin-billing">
        <h3 className="font-display text-lg font-semibold text-ink-900">Billing dashboard (ops)</h3>
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      </div>
    );
  }
  if (!data) return null;
  return (
    <div className="mt-10" data-testid="admin-billing">
      <h3 className="font-display text-lg font-semibold text-ink-900">Billing dashboard (ops)</h3>
      <div className="mt-3 flex flex-wrap gap-6 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        {/* Broken out because one "active" figure could not be reconciled with
            the MRR beside it: the count read `status = 'active'` and the MRR
            summed `active` + `trialing`. Served is the three counts together —
            every account consuming a plan's quota — and is the number to read
            against "how many customers are we carrying". */}
        <Metric label="Active" value={String(data.summary.active)} />
        <Metric label="Trialing" value={String(data.summary.trialing)} />
        <Metric label="Past due" value={String(data.summary.past_due)} />
        <Metric label="Served" value={String(data.summary.served)} />
        <Metric label="MRR (active + trialing)" value={money(data.summary.mrr_cents)} />
        {/* Net of refunds. Gross was the figure until invoices could record
            one at all — a revenue line a customer could disprove from their own
            card statement, which is the lesson the engagement side learned
            first (domain/payments.collectedTotals). The refunded figure is
            shown beside it rather than folded away, because "collected went
            down" is a question ops has to be able to answer. */}
        <Metric label="Collected (net, all time)" value={money(data.summary.collected_cents)} />
        {data.summary.refunded_cents > 0 && (
          <Metric label="Refunded" value={money(data.summary.refunded_cents)} />
        )}
        {/* Every revenue figure on this screen used to be since-the-beginning,
            which cannot answer the question ops opens it with. This one is the
            same definition windowed — a refund comes off the month the invoice
            was paid in — so it reconciles against the total beside it instead
            of being a second answer to the same word. */}
        <Metric
          label={`Collected in ${monthLabel(data.summary.month_start)}`}
          value={money(data.summary.month_collected_cents)}
          note={monthDelta(data.summary.month_collected_cents, data.summary.prev_month_collected_cents)}
        />
      </div>
      <div className="mt-4 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
        <table className="w-full min-w-[560px] text-sm">
          <caption className="sr-only">Subscribers</caption>
          <thead>
            <tr className="border-b border-paper-300 text-left">
              <th className="overline px-4 py-3 font-semibold text-ink-400">Customer</th>
              <th className="overline px-4 py-3 font-semibold text-ink-400">Plan</th>
              <th className="overline px-4 py-3 font-semibold text-ink-400">Status</th>
              <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Usage</th>
            </tr>
          </thead>
          <tbody>
            {data.subscriptions.map((s) => (
              <tr key={s.id} className="border-b border-paper-200 last:border-0">
                <td className="px-4 py-2.5 text-ink-800">{s.email}</td>
                <td className="px-4 py-2.5 text-ink-600">{s.plan_name}</td>
                <td className="px-4 py-2.5 text-ink-600">{s.status}</td>
                <td className="tnum px-4 py-2.5 text-right text-ink-900">
                  {s.valuations_used}
                  {s.valuation_limit === null ? '' : ` / ${s.valuation_limit}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return (
    <div>
      <div className="overline text-ink-400">{label}</div>
      <div className="tnum mt-1 font-display text-2xl font-semibold text-ink-900">{value}</div>
      {note ? <div className="tnum mt-0.5 text-xs text-ink-500">{note}</div> : null}
    </div>
  );
}

/**
 * `2026-08-01` → `August`. Parsed by hand rather than through `new Date(...)`:
 * the server states this boundary in UTC, and a Date built from the string and
 * formatted locally prints the month before it for every reader west of
 * Greenwich on the first of the month — the same off-by-a-day this codebase has
 * already fixed twice on date columns.
 */
export function monthLabel(monthStart: string): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(monthStart);
  if (!match) return 'this month';
  const month = Number(match[2]) - 1;
  const names = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return names[month] ?? 'this month';
}

/**
 * The month against the one before it. A revenue figure with no direction is a
 * number an operator has to go and find last month's copy of to read at all.
 *
 * Nothing is printed when the previous month collected nothing: "up ∞%" is not
 * a fact, and a first month of trading has nothing to compare against.
 */
export function monthDelta(current: number, previous: number): string | null {
  if (previous <= 0) return null;
  const change = Math.round(((current - previous) / previous) * 100);
  const sign = change > 0 ? '+' : '';
  return `${sign}${change}% vs last month`;
}
