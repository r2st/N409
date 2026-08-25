import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { formatDate, formatMoney } from '../lib/format';
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
  /*
   * The catch here used to say "price stays hidden", which is true of the first
   * load and false of every one after it. This quote is re-fetched whenever an
   * add-on is toggled, so a failed *re*-quote did not hide the price — it left
   * the previous one on screen, itemised and labelled Total, beside checkboxes
   * that no longer matched it. Showing a client the wrong figure on the panel
   * they are about to pay from is the one outcome worth being loud about, so
   * the stale quote is dropped and the absence is explained.
   */
  const [quoteFailed, setQuoteFailed] = useState(false);
  const [express, setExpress] = useState(false);
  const [qsbsLetter, setQsbsLetter] = useState(false);

  const unpaid = valuation.paid_status === 'unpaid';

  // Re-quoted on every tick, from the same `quotePrice` the checkout uses, so
  // the figure on the button is by construction the figure Stripe charges.
  // Computing the add-on total in the browser would let the two disagree the
  // first time a price moves.
  useEffect(() => {
    if (!unpaid) return;
    let cancelled = false;
    const query = new URLSearchParams({
      express: String(express),
      qsbs_letter: String(qsbsLetter),
    });
    void api<{ quote: PaymentQuote }>(`/valuations/${valuation.id}/payments/quote?${query}`)
      .then((res) => {
        if (cancelled) return;
        setQuote(res.quote);
        setQuoteFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setQuote(null);
        setQuoteFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [valuation.id, unpaid, express, qsbsLetter]);

  if (!unpaid) return null;

  const checkout = async () => {
    setError(null);
    setBusy(true);
    try {
      const { checkout_url } = await api<{ checkout_url: string }>(
        `/valuations/${valuation.id}/payments/checkout`,
        // Flags, not the total: the server prices them. A tampered amount
        // cannot buy express delivery for nothing.
        { method: 'POST', body: { express, qsbs_letter: qsbsLetter } },
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

  // The QSBS letter is already inside a QSBS engagement, so the server refuses
  // to charge for it. Hiding the checkbox is better than offering one that
  // silently does nothing.
  const qsbsAddonApplies = valuation.kind !== 'qsbs';

  return (
    <section className="rounded-lg border border-amber-200 bg-amber-50 p-6 shadow-card">
      <h2 className="overline mb-2 text-amber-800">Payment</h2>
      {error && (
        <div className="mb-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <p className="text-sm text-amber-900">
        This valuation is unpaid. Work starts once payment is received.
      </p>

      <div className="mt-4 space-y-2">
        <label className="flex cursor-pointer items-start gap-2 text-sm text-amber-900">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={express}
            onChange={(e) => setExpress(e.target.checked)}
            data-testid="addon-express"
          />
          <span>
            <span className="font-semibold">Express delivery</span> — final report in 1 business day instead
            of 7.
          </span>
        </label>
        {qsbsAddonApplies && (
          <label className="flex cursor-pointer items-start gap-2 text-sm text-amber-900">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={qsbsLetter}
              onChange={(e) => setQsbsLetter(e.target.checked)}
              data-testid="addon-qsbs"
            />
            <span>
              <span className="font-semibold">QSBS attestation letter</span> — documentation supporting your
              §1202 qualified-small-business stock position.
            </span>
          </label>
        )}
      </div>

      {/* Itemised, because a single total is the number a client disputes.
          The band line only appears when the raise actually moved the price.

          `lines` and `delivery_days` are read defensively: during a rolling
          deploy this page can be served by a build newer than the API, and a
          quote without the new fields must degrade to a bare total rather than
          throw and blank the panel a client is trying to pay from. */}
      {quote && (
        <dl className="mt-4 border-t border-amber-200 pt-3 text-sm" data-testid="quote-lines">
          {(quote.lines ?? []).map((line) => (
            <div key={line.key} className="flex justify-between py-0.5 text-amber-900">
              <dt>{line.label}</dt>
              <dd className="tnum">{formatMoney(line.amount_cents, quote.currency)}</dd>
            </div>
          ))}
          <div className="mt-2 flex justify-between border-t border-amber-200 pt-2 font-semibold text-amber-900">
            <dt>Total</dt>
            <dd className="tnum text-lg" data-testid="payment-quote">
              {formatMoney(quote.amount_cents, quote.currency)}
            </dd>
          </div>
          {typeof quote.delivery_days === 'number' && (
            <p className="mt-2 text-xs text-amber-800">
              Final report in {quote.delivery_days} business {quote.delivery_days === 1 ? 'day' : 'days'}.
            </p>
          )}
        </dl>
      )}

      {quoteFailed && (
        <p className="mt-4 border-t border-amber-200 pt-3 text-sm text-amber-900">
          The price could not be worked out just now, so none is shown. Checkout still quotes it — the amount
          on the Stripe page is the amount you will be charged.
        </p>
      )}

      {/* Only ops ever see this: the API sends `test_mode` to nobody else, and
          withholds the checkout entirely from a client while it is true. The
          warning is worth the space because the page it leads to is
          indistinguishable from the real one — same Stripe domain, same card
          form — and the only way to find out afterwards is to notice that no
          money arrived. */}
      {quote?.test_mode && (
        <p
          className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800"
          data-testid="stripe-test-mode"
        >
          Stripe is in test mode. Checkout opens a real page but no money moves — only test cards are
          accepted. Clients are shown the invoice fallback instead of this button.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-4">
        {/* Retired first: it is the more specific of the two refusals, and the
            invoice-fallback wording below would promise an invoice for work
            nobody is going to send one for. `payable === false` rather than
            falsy, so an API older than the field still renders the button. */}
        {quote?.payable === false ? (
          <p className="ml-auto text-sm text-amber-800" data-testid="payment-not-payable">
            This engagement has been retired — it can no longer be paid for. Talk to us if that is wrong.
          </p>
        ) : quote && !quote.configured ? (
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
  refunded: 'bg-paper-200 text-ink-600',
};

const DISPUTE_STATUS_LABELS: Record<NonNullable<Payment['dispute_status']>, string> = {
  open: 'Chargeback under review',
  won: 'Chargeback resolved in our favour',
  lost: 'Chargeback upheld',
};

const toCents = (value: string | number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The one line under a payment that says what happened to the money.
 *
 * A refund is not visible in `status` alone: Stripe refunds are partial and
 * repeatable, so a row can be `succeeded` with a non-zero `refunded_cents` and
 * the customer has genuinely been sent money back. A dispute is not in `status`
 * at all — an open chargeback holds the funds without returning them, and only
 * a lost one promotes the row to `refunded`. Both facts already come back on
 * the payments endpoint; nothing rendered them, so the client's own record of
 * their refund was a table that still read "succeeded".
 */
function settlementNote(p: Payment): string | null {
  const refunded = toCents(p.refunded_cents);
  const parts: string[] = [];
  if (refunded > 0) {
    const full = refunded >= toCents(p.amount_cents);
    parts.push(
      `${full ? 'Refunded' : 'Partially refunded'} ${formatMoney(refunded, p.currency)}${
        p.refunded_at ? ` on ${formatDate(p.refunded_at)}` : ''
      }`,
    );
  }
  if (p.dispute_status) parts.push(DISPUTE_STATUS_LABELS[p.dispute_status]);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Past checkout attempts for this valuation — date, amount, status, receipt.
 * The API scopes rows (ops see all, clients their own valuations), so this
 * renders for everyone and simply hides when there is nothing to show.
 */
export function PaymentHistory({ valuation }: { valuation: Valuation }) {
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api<{ payments: Payment[] }>(`/valuations/${valuation.id}/payments`)
      .then((res) => {
        if (cancelled) return;
        setFailed(false);
        setPayments(res.payments);
      })
      .catch(() => {
        // Not `setPayments([])`: this section hides itself when there is
        // nothing to show, so a failed read took the whole payment record off
        // the page — and the reader most likely to open it is someone checking
        // whether a charge went through.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [valuation.id, valuation.paid_status]);

  if (failed) {
    return (
      <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <h2 className="overline mb-4 text-ink-400">Payment history</h2>
        <ErrorNote>Could not load the payment history.</ErrorNote>
      </section>
    );
  }
  if (!payments || payments.length === 0) return null;

  return (
    <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <h2 id="payment-history-heading" className="overline mb-4 text-ink-400">
        Payment history
      </h2>
      {/* The status column used to hold one short token, and the table was
          allowlisted as fitting a 375px phone on that measurement. A settlement
          note is a sentence ("Refunded $1,190.00 on 9 Jul · Chargeback upheld"),
          which does not fit that budget — so the table scrolls in its own box
          rather than pushing the page sideways, matching the invoice table. */}
      <div className="overflow-x-auto overscroll-x-contain">
        <table className="w-full min-w-[420px] text-left text-sm" aria-labelledby="payment-history-heading">
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
                <td className="tnum py-2.5 text-ink-800">{formatDate(p.created_at)}</td>
                <td className="tnum py-2.5 text-ink-900">{formatMoney(p.amount_cents, p.currency)}</td>
                <td className="py-2.5">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${
                      // An unknown status must still get a chip, not a bare
                      // `undefined` in the class list — the last time this list
                      // fell behind the database enum, that is what shipped.
                      PAYMENT_STATUS_STYLES[p.status] ?? 'bg-paper-200 text-ink-500'
                    }`}
                  >
                    {p.status}
                  </span>
                  {settlementNote(p) && (
                    <div className="mt-1 text-xs text-ink-500" data-testid="settlement-note">
                      {settlementNote(p)}
                    </div>
                  )}
                </td>
                {/* Two different documents, so both are offered rather than one
                    standing in for the other: Stripe's receipt proves the card
                    was charged, ours is the only one that says what the charge
                    was made of. A client querying an add-on needs the second. */}
                <td className="py-2.5 text-right">
                  <div className="flex flex-col items-end gap-0.5">
                    {p.status === 'succeeded' && (
                      <a
                        href={`/api/v1/valuations/${p.valuation_id}/payments/${p.id}/receipt.pdf`}
                        className="font-semibold text-bond-700 hover:underline"
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
                    {p.status !== 'succeeded' && !p.receipt_url && <span className="text-ink-400">—</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
