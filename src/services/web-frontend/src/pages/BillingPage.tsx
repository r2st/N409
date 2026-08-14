import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { HelpIcon } from '../components/HelpIcon';
import { useAuth } from '../lib/auth';
import { isOps, isPartner } from '../lib/rbac';
import { formatDateTime, formatMoney } from '../lib/format';
import { EmptyState, ErrorNote, KindBadge, Spinner, StatCard } from '../components/ui';
import { SubscriptionSection } from '../components/SubscriptionSection';
import type { ValuationKind } from '../lib/types';

interface BillingPayment {
  id: string;
  valuation_id: string;
  valuation_number: string;
  company_name: string;
  kind: string;
  amount_cents: string | number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed' | 'expired' | 'refunded';
  receipt_url: string | null;
  refunded_cents: string | number;
  dispute_status: 'open' | 'won' | 'lost' | null;
  created_at: string;
}

interface UnpaidValuation {
  id: string;
  number: string;
  company_name: string;
  kind: string;
  currency: string;
  amount_cents: number;
}

interface Billing {
  payments: BillingPayment[];
  unpaid_valuations: UnpaidValuation[];
  totals: {
    gross_cents: number;
    refunded_cents: number;
    paid_cents: number;
    succeeded_count: number;
    refunded_count: number;
    payment_count: number;
  };
}

const STATUS_TONES: Record<BillingPayment['status'], string> = {
  succeeded: 'bg-bond-50 text-bond-700 ring-bond-200',
  pending: 'bg-sky-50 text-sky-800 ring-sky-200',
  failed: 'bg-red-50 text-red-700 ring-red-200',
  expired: 'bg-paper-200 text-ink-400 ring-ink-200',
  refunded: 'bg-amber-50 text-amber-800 ring-amber-200',
};

const num = (v: string | number | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** P2 #13 — account-level billing: payment history with receipts, totals,
 * and a pay-now path for unpaid engagements. Server-side scoped per role. */
export function BillingPage() {
  const { user } = useAuth();
  const [billing, setBilling] = useState<Billing | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ billing: Billing }>('/me/billing')
      .then((d) => setBilling(d.billing))
      .catch(() => setError('Could not load your billing history.'));
  }, []);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!billing) return <Spinner />;

  const scopeNote = isOps(user)
    ? 'Showing payments across all engagements (operations view).'
    : isPartner(user)
      ? "Showing your organisation's payments."
      : 'Showing payments for your valuations.';

  return (
    <div>
      <div className="overline flex items-center gap-1.5 text-ink-400">
        Account
        <HelpIcon article="billing-overview" />
      </div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Billing</h1>
      <p className="mt-2 text-sm text-ink-500">{scopeNote}</p>

      {/* "Total paid" is net of refunds and lost chargebacks, so the refunded
          figure is shown beside it rather than left to be inferred from a
          number that no longer matches the sum of the rows below. */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total paid" value={formatMoney(billing.totals.paid_cents)} accent />
        <StatCard label="Completed payments" value={billing.totals.succeeded_count} />
        {billing.totals.refunded_cents > 0 && (
          <StatCard label="Refunded" value={formatMoney(billing.totals.refunded_cents)} />
        )}
        <StatCard label="Unpaid engagements" value={billing.unpaid_valuations.length} />
      </div>

      {billing.unpaid_valuations.length > 0 && (
        <section className="mt-8">
          <h2 className="overline mb-3 text-ink-400">Unpaid engagements</h2>
          <ul className="divide-y divide-paper-200 rounded-lg border border-paper-300 bg-surface shadow-card">
            {billing.unpaid_valuations.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <KindBadge kind={v.kind as ValuationKind} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-ink-900">{v.company_name}</div>
                  <div className="tnum text-xs text-ink-400">#{v.number}</div>
                </div>
                <div className="tnum ml-auto text-sm font-semibold text-ink-800">
                  {formatMoney(v.amount_cents, v.currency)}
                </div>
                <Link
                  to={`/valuations/${v.id}`}
                  className="rounded-md bg-bond-600 px-3.5 py-1.5 text-xs font-semibold text-bond-fg hover:bg-bond-700"
                >
                  Pay now →
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <h2 className="overline mb-3 text-ink-400">Payment history</h2>
        {billing.payments.length === 0 ? (
          <EmptyState title="No payments yet">
            Payments appear here as soon as a checkout completes.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card">
            <table className="w-full min-w-[720px] text-sm" aria-label="Payment history">
              <thead>
                <tr className="border-b border-paper-300 text-left">
                  <th className="overline px-5 py-3 font-semibold text-ink-400">Date</th>
                  <th className="overline px-5 py-3 font-semibold text-ink-400">Valuation</th>
                  <th className="overline px-5 py-3 font-semibold text-ink-400">Amount</th>
                  <th className="overline px-5 py-3 font-semibold text-ink-400">Status</th>
                  <th className="overline px-5 py-3 font-semibold text-ink-400">Receipt</th>
                </tr>
              </thead>
              <tbody>
                {billing.payments.map((p) => (
                  <tr key={p.id} className="border-b border-paper-200 last:border-0">
                    <td className="tnum px-5 py-3.5 whitespace-nowrap text-ink-600">
                      {formatDateTime(p.created_at)}
                    </td>
                    <td className="px-5 py-3.5">
                      <Link
                        to={`/valuations/${p.valuation_id}`}
                        className="font-medium text-bond-600 hover:text-bond-700"
                      >
                        {p.company_name}
                      </Link>
                      <span className="tnum ml-1.5 text-xs text-ink-400">
                        #{p.valuation_number} · {p.kind.toUpperCase()}
                      </span>
                    </td>
                    <td className="tnum px-5 py-3.5 font-semibold text-ink-800">
                      {formatMoney(p.amount_cents, p.currency)}
                      {/* A partial refund leaves the row 'succeeded', so the
                          amount alone would overstate what was actually kept. */}
                      {p.status !== 'refunded' && num(p.refunded_cents) > 0 && (
                        <div className="text-xs font-normal text-amber-700">
                          −{formatMoney(num(p.refunded_cents), p.currency)} refunded
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${STATUS_TONES[p.status] ?? STATUS_TONES.expired}`}
                      >
                        {p.status}
                      </span>
                      {p.dispute_status === 'open' && (
                        <span className="ml-1.5 inline-flex items-center rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-red-200 ring-inset">
                          disputed
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      {p.receipt_url ? (
                        <a
                          href={p.receipt_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs font-semibold text-bond-600 hover:text-bond-700"
                        >
                          View receipt ↗
                        </a>
                      ) : (
                        <span className="text-xs text-ink-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Feature 7: recurring subscription / retainer billing + invoices */}
      <SubscriptionSection />
    </div>
  );
}
