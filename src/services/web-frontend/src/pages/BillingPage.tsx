import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { HelpIcon } from '../components/HelpIcon';
import { useAuth } from '../lib/auth';
import { isOps, isPartner } from '../lib/rbac';
import { formatDateTime, formatChargedCents } from '../lib/format';
import { hasSettled, itemisedReceiptHref } from '../lib/receipts';
import {
  EmptyState,
  KindBadge,
  ListTruncationNote,
  LoadError,
  Spinner,
  StatCard,
  SuccessNote,
  useRetry,
} from '../components/ui';
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
  /** Both caps travel with the rows; see BILLING_PAYMENT_PAGE_LIMIT. */
  payments_truncated: boolean;
  unpaid_truncated: boolean;
  totals: {
    gross_cents: number;
    refunded_cents: number;
    paid_cents: number;
    succeeded_count: number;
    refunded_count: number;
    payment_count: number;
    /**
     * The currency the three money figures are in. Optional because a response
     * written before the field existed does not carry it, and the formatter's
     * own default is what those figures were already printed as.
     */
    currency?: string;
    /** They span more than one currency, so they are a running number rather
     * than an amount — see `collectedTotals`. */
    mixed_currency?: boolean;
  };
}

const STATUS_TONES: Record<BillingPayment['status'], string> = {
  succeeded: 'bg-bond-50 text-bond-700 ring-bond-200',
  pending: 'bg-sky-50 text-sky-800 ring-sky-200',
  failed: 'bg-red-50 text-red-700 ring-red-200',
  expired: 'bg-paper-200 text-ink-500 ring-ink-200',
  refunded: 'bg-amber-50 text-amber-800 ring-amber-200',
};

const num = (v: string | number | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** P2 #13 — account-level billing: payment history with receipts, totals,
 * and a pay-now path for unpaid engagements. Server-side scoped per role. */
/**
 * What Stripe's return leg says, on the page it now returns to.
 *
 * A subscription checkout used to come back to `/settings?billing=success`,
 * a route with no subscription card on it that reads no query parameter, so
 * the two outcomes a customer most wants confirmed — the plan started, or it
 * did not — were both rendered as nothing at all. The redirects were moved to
 * this page (routes/billing.ts) and this is the half that speaks.
 *
 * The success line is deliberately provisional. Stripe's redirect is not the
 * event that starts a plan — `customer.subscription.created` is, and it may be
 * seconds behind — so the card below can still be empty while this is on
 * screen, and a sentence promising an active plan beside an empty card is
 * worse than one that says the payment went through and the plan follows.
 */
function subscriptionReturnNote(
  outcome: string | null,
): { tone: 'success' | 'neutral'; text: string } | null {
  if (outcome === 'success') {
    return {
      tone: 'success',
      text:
        'Payment accepted — your subscription is being set up and appears below within a minute. ' +
        'Reload the page if it has not.',
    };
  }
  // Not a success and not a failure: the customer chose this, nothing went
  // wrong, and nothing was charged. A green tick would congratulate them for
  // not subscribing and a red note would report a fault that did not happen.
  if (outcome === 'canceled') {
    return {
      tone: 'neutral',
      text: 'Checkout was cancelled, so no plan was started and you have not been charged.',
    };
  }
  return null;
}

function SubscriptionReturnNote({ note }: { note: { tone: 'success' | 'neutral'; text: string } }) {
  return (
    <div className="mt-4" data-testid="subscription-return-note">
      {note.tone === 'success' ? (
        <SuccessNote>{note.text}</SuccessNote>
      ) : (
        <div
          role="status"
          className="rounded-md border border-paper-300 bg-paper-100 px-3.5 py-2.5 text-sm text-ink-600"
        >
          {note.text}
        </div>
      )}
    </div>
  );
}

export function BillingPage() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const returnNote = subscriptionReturnNote(params.get('subscription'));
  const [billing, setBilling] = useState<Billing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));

  useEffect(() => {
    api<{ billing: Billing }>('/me/billing')
      .then((d) => setBilling(d.billing))
      .catch(() => setError('Could not load your billing history.'));
  }, [token]);

  /*
   * The return note outlives both gates. It confirms a payment the customer
   * has just made and it depends on nothing this page reads, so a billing
   * history that fails to load — or has not arrived yet — must not swallow it:
   * the one moment a subscriber most needs to be told the charge went through
   * is the moment they would otherwise be looking at a bare load error.
   */
  if (error)
    return (
      <div>
        {returnNote && <SubscriptionReturnNote note={returnNote} />}
        <LoadError message={error} {...retryProps} />
      </div>
    );
  if (!billing)
    return (
      <div>
        {returnNote && <SubscriptionReturnNote note={returnNote} />}
        <Spinner />
      </div>
    );

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

      {returnNote && <SubscriptionReturnNote note={returnNote} />}

      {/* "Total paid" is net of refunds and lost chargebacks, so the refunded
          figure is shown beside it rather than left to be inferred from a
          number that no longer matches the sum of the rows below. */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total paid"
          value={formatChargedCents(billing.totals.paid_cents, billing.totals.currency)}
          accent
        />
        <StatCard label="Completed payments" value={billing.totals.succeeded_count} />
        {billing.totals.refunded_cents > 0 && (
          <StatCard
            label="Refunded"
            value={formatChargedCents(billing.totals.refunded_cents, billing.totals.currency)}
          />
        )}
        <StatCard
          label="Unpaid engagements"
          /* The one stat on this page taken from `rows.length` rather than from
             a server-side aggregate, so it is the one that becomes a wrong
             number rather than a short list when the page caps. */
          value={
            billing.unpaid_truncated
              ? `${billing.unpaid_valuations.length}+`
              : billing.unpaid_valuations.length
          }
        />
      </div>
      {/* The three figures above are sums of integer minor units, and minor
          units only mean anything inside one currency — Stripe reports ¥100,000
          and $1,000.00 as the same 100000. `valuations.currency` is chosen per
          engagement, so a client holding a dollar engagement and a euro one is
          an ordinary account; the cards were printed as dollars regardless,
          while every row in the table below was rendered in its own currency
          and visibly did not add up to them. */}
      {billing.totals.mixed_currency && (
        <p className="mt-3 text-sm text-amber-900" role="status" data-testid="mixed-currency-note">
          Your engagements are billed in more than one currency, so these totals add each payment’s minor
          units together rather than converting them. The table below shows what each payment was actually
          charged in.
        </p>
      )}

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
                  {formatChargedCents(v.amount_cents, v.currency)}
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
          {/* An unpaid engagement past this cap has no checkout button anywhere
              in the product, so the note has to name the way to reach it. */}
          <ListTruncationNote
            truncated={billing.unpaid_truncated}
            shown={billing.unpaid_valuations.length}
            noun="unpaid engagements"
            hint="open the remaining ones from the valuations list"
          />
        </section>
      )}

      <section className="mt-8">
        <h2 className="overline mb-3 text-ink-400">Payment history</h2>
        {billing.payments.length === 0 ? (
          <EmptyState title="No payments yet">
            Payments appear here as soon as a checkout completes.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
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
                      {formatChargedCents(p.amount_cents, p.currency)}
                      {/* A partial refund leaves the row 'succeeded', so the
                          amount alone would overstate what was actually kept. */}
                      {p.status !== 'refunded' && num(p.refunded_cents) > 0 && (
                        <div className="text-xs font-normal text-amber-700">
                          −{formatChargedCents(num(p.refunded_cents), p.currency)} refunded
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
                    {/* Both documents, as the engagement's own payment panel
                        already offers them. Stripe's receipt proves the card
                        was charged and states one gross figure; ours is the
                        only one that says what the charge was made of and what
                        is left after a refund. This column offered Stripe's
                        alone — so the itemised receipt was unreachable from the
                        page that lists every payment the client has made, and a
                        row whose `receipt_url` had not resolved yet showed a
                        dash where a receipt existed. */}
                    <td className="px-5 py-3.5">
                      <div className="flex flex-col gap-0.5">
                        {hasSettled(p.status) && (
                          <a
                            href={itemisedReceiptHref(p)}
                            className="text-xs font-semibold text-bond-600 hover:text-bond-700"
                          >
                            Itemised PDF
                          </a>
                        )}
                        {p.receipt_url && (
                          <a
                            href={p.receipt_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-ink-500 hover:underline"
                          >
                            Stripe receipt ↗
                          </a>
                        )}
                        {!hasSettled(p.status) && !p.receipt_url && (
                          <span className="text-xs text-ink-400">—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* "Total paid" above is summed from these rows, so a capped history is
            a total that is less money than has actually been paid. */}
        <ListTruncationNote
          truncated={billing.payments_truncated}
          shown={billing.payments.length}
          noun="payments"
          hint="the totals above cover only the payments listed"
        />
      </section>

      {/* Feature 7: recurring subscription / retainer billing + invoices */}
      <SubscriptionSection />
    </div>
  );
}
