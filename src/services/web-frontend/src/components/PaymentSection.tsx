import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { formatMoney } from '../lib/format';
import type { Payment, PaymentQuote, Valuation } from '../lib/types';
import { Button, ErrorNote } from './ui';

/**
 * Stripe checkout entry point (remaining-gaps §3 #1). Unpaid valuations get a
 * "Pay now" panel showing the exact list price (payments/quote) before the
 * Stripe-hosted page opens; the webhook flips paid_status, and the redirect
 * lands on /payment/success which polls for it.
 */
export function PaymentSection({ valuation }: { valuation: Valuation }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<PaymentQuote | null>(null);

  const unpaid = valuation.paid_status === 'unpaid';

  useEffect(() => {
    if (!unpaid) return;
    let cancelled = false;
    void api<{ quote: PaymentQuote }>(`/valuations/${valuation.id}/payments/quote`)
      .then((res) => {
        if (!cancelled) setQuote(res.quote);
      })
      .catch(() => {
        // Price stays hidden; the checkout button still works.
      });
    return () => {
      cancelled = true;
    };
  }, [valuation.id, unpaid]);

  if (!unpaid) return null;

  const checkout = async () => {
    setError(null);
    setBusy(true);
    try {
      const { checkout_url } = await api<{ checkout_url: string }>(
        `/valuations/${valuation.id}/payments/checkout`,
        { method: 'POST', body: {} },
      );
      window.location.assign(checkout_url);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 503
          ? 'Online payment is not available yet — we will invoice you instead.'
          : err instanceof ApiError
            ? err.message
            : 'Could not start the checkout.',
      );
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-amber-200 bg-amber-50 p-6 shadow-card">
      <h2 className="overline mb-2 text-amber-800">Payment</h2>
      {error && <div className="mb-3"><ErrorNote>{error}</ErrorNote></div>}
      <div className="flex flex-wrap items-center gap-4">
        <p className="text-sm text-amber-900">
          This valuation is unpaid. Work starts once payment is received.
        </p>
        {quote && (
          <p className="tnum text-lg font-semibold text-amber-900" data-testid="payment-quote">
            {formatMoney(quote.amount_cents, quote.currency)}
          </p>
        )}
        {quote && !quote.configured ? (
          <p className="ml-auto text-sm text-amber-800">
            Online payment is not available yet — we will invoice you instead.
          </p>
        ) : (
          <Button className="ml-auto" disabled={busy} onClick={() => void checkout()}>
            {busy
              ? 'Opening checkout…'
              : quote
                ? `Pay ${formatMoney(quote.amount_cents, quote.currency)} now`
                : 'Pay now'}
          </Button>
        )}
      </div>
    </section>
  );
}

const PAYMENT_STATUS_STYLES: Record<Payment['status'], string> = {
  pending: 'bg-amber-100 text-amber-800',
  succeeded: 'bg-bond-100 text-bond-800',
  failed: 'bg-red-100 text-red-800',
  expired: 'bg-paper-200 text-ink-500',
};

/**
 * Past checkout attempts for this valuation — date, amount, status, receipt.
 * The API scopes rows (ops see all, clients their own valuations), so this
 * renders for everyone and simply hides when there is nothing to show.
 */
export function PaymentHistory({ valuation }: { valuation: Valuation }) {
  const [payments, setPayments] = useState<Payment[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<{ payments: Payment[] }>(`/valuations/${valuation.id}/payments`)
      .then((res) => {
        if (!cancelled) setPayments(res.payments);
      })
      .catch(() => {
        if (!cancelled) setPayments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [valuation.id, valuation.paid_status]);

  if (!payments || payments.length === 0) return null;

  return (
    <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <h2 className="overline mb-4 text-ink-400">Payment history</h2>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-paper-300 text-xs text-ink-400">
            <th className="pb-2 font-semibold">Date</th>
            <th className="pb-2 font-semibold">Amount</th>
            <th className="pb-2 font-semibold">Status</th>
            <th className="pb-2 text-right font-semibold">Receipt</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => (
            <tr key={p.id} className="border-b border-paper-200 last:border-0">
              <td className="tnum py-2.5 text-ink-800">
                {new Date(p.created_at).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </td>
              <td className="tnum py-2.5 text-ink-900">{formatMoney(p.amount_cents, p.currency)}</td>
              <td className="py-2.5">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${PAYMENT_STATUS_STYLES[p.status]}`}
                >
                  {p.status}
                </span>
              </td>
              <td className="py-2.5 text-right">
                {p.receipt_url ? (
                  <a
                    href={p.receipt_url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-semibold text-bond-700 hover:underline"
                  >
                    View receipt ↗
                  </a>
                ) : (
                  <span className="text-ink-400">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
