import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isOps } from '../lib/rbac';
import { Button, ErrorNote, Spinner } from './ui';

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
          <h3 className="overline mb-2 text-ink-400">Invoices</h3>
          <div className="overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card">
            <table className="w-full min-w-[480px] text-sm">
              <tbody>
                {mine.invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-paper-200 last:border-0">
                    <td className="px-4 py-2.5 font-semibold text-ink-800">{inv.number}</td>
                    <td className="px-4 py-2.5 text-ink-500">{inv.status}</td>
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
  summary: { active: number; mrr_cents: number; collected_cents: number };
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
        <Metric label="Active subscriptions" value={String(data.summary.active)} />
        <Metric label="MRR" value={money(data.summary.mrr_cents)} />
        <Metric label="Collected" value={money(data.summary.collected_cents)} />
      </div>
      <div className="mt-4 overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card">
        <table className="w-full min-w-[560px] text-sm">
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="overline text-ink-400">{label}</div>
      <div className="tnum mt-1 font-display text-2xl font-semibold text-ink-900">{value}</div>
    </div>
  );
}
