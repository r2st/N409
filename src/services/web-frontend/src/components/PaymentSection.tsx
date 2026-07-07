import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Valuation } from '../lib/types';
import { Button, ErrorNote } from './ui';

/**
 * Stripe checkout entry point (remaining-gaps §3 #1). Unpaid valuations get a
 * "Pay now" button that opens the Stripe-hosted checkout; the webhook flips
 * paid_status, so the badge updates on the next reload.
 */
export function PaymentSection({ valuation }: { valuation: Valuation }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (valuation.paid_status !== 'unpaid') return null;

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
        <Button className="ml-auto" disabled={busy} onClick={() => void checkout()}>
          {busy ? 'Opening checkout…' : 'Pay now'}
        </Button>
      </div>
    </section>
  );
}
