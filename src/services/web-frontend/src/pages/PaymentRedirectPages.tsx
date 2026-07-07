import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { formatMoney } from '../lib/format';
import type { Payment, Valuation } from '../lib/types';
import { Button, Spinner } from '../components/ui';

/**
 * Stripe redirect landing pages (P0 #2 phase A). The webhook — not this
 * redirect — is the source of truth, so the success page polls the valuation
 * until paid_status flips (webhook lag is usually < a few seconds), then
 * surfaces the receipt from the payments list.
 */

const POLL_MS = 2000;
const MAX_POLLS = 15; // ~30s before we stop and reassure instead

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-xl">
      <div className="mt-6 space-y-5 rounded-lg border border-paper-300 bg-white p-8 text-center shadow-card">
        {children}
      </div>
    </div>
  );
}

export function PaymentSuccessPage({ pollMs = POLL_MS }: { pollMs?: number }) {
  const [params] = useSearchParams();
  const valuationId = params.get('valuation');
  const [valuation, setValuation] = useState<Valuation | null>(null);
  const [receipt, setReceipt] = useState<Payment | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const polls = useRef(0);

  useEffect(() => {
    if (!valuationId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      polls.current += 1;
      try {
        const res = await api<{ valuation: Valuation }>(`/valuations/${valuationId}`);
        if (cancelled) return;
        if (res.valuation.paid_status !== 'unpaid') {
          setValuation(res.valuation);
          const { payments } = await api<{ payments: Payment[] }>(
            `/valuations/${valuationId}/payments`,
          );
          if (!cancelled) setReceipt(payments.find((p) => p.status === 'succeeded') ?? null);
          return;
        }
      } catch {
        // Transient — keep polling until the budget runs out.
      }
      if (cancelled) return;
      if (polls.current >= MAX_POLLS) {
        setTimedOut(true);
        return;
      }
      timer = setTimeout(() => void poll(), pollMs);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [valuationId, pollMs]);

  if (!valuationId) {
    return (
      <Shell>
        <h1 className="font-display text-2xl font-semibold text-ink-900">Payment received</h1>
        <p className="text-sm text-ink-600">Thanks — your payment is being processed.</p>
        <Link to="/dashboard" className="text-sm font-semibold text-bond-700 hover:underline">
          Go to dashboard
        </Link>
      </Shell>
    );
  }

  if (valuation) {
    return (
      <Shell>
        <div className="text-4xl">✅</div>
        <h1 className="font-display text-2xl font-semibold text-ink-900">Payment confirmed</h1>
        <p className="text-sm text-ink-600">
          {receipt ? (
            <>
              We received {formatMoney(receipt.amount_cents, receipt.currency)} for{' '}
              <span className="font-semibold">{valuation.company_name}</span>.
            </>
          ) : (
            <>
              Your payment for <span className="font-semibold">{valuation.company_name}</span> is in.
            </>
          )}{' '}
          Work on your valuation starts now.
        </p>
        {receipt?.receipt_url && (
          <a
            href={receipt.receipt_url}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-semibold text-bond-700 hover:underline"
          >
            View Stripe receipt ↗
          </a>
        )}
        <div className="flex justify-center gap-3">
          <Link to={`/valuations/${valuationId}`}>
            <Button>Open my valuation</Button>
          </Link>
          <Link
            to="/dashboard"
            className="inline-flex items-center rounded-md px-4 py-2 text-sm font-semibold text-ink-600 hover:text-ink-900"
          >
            Go to dashboard
          </Link>
        </div>
      </Shell>
    );
  }

  if (timedOut) {
    return (
      <Shell>
        <h1 className="font-display text-2xl font-semibold text-ink-900">Payment processing</h1>
        <p className="text-sm text-ink-600">
          Stripe accepted your payment, but our confirmation is taking longer than usual. The status
          on your valuation will update automatically — no action needed.
        </p>
        <div className="flex justify-center">
          <Link to={`/valuations/${valuationId}`}>
            <Button>Open my valuation</Button>
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <Spinner />
      <h1 className="font-display text-2xl font-semibold text-ink-900">Confirming your payment…</h1>
      <p className="text-sm text-ink-600">
        This usually takes a few seconds — we're waiting for Stripe's confirmation.
      </p>
    </Shell>
  );
}

export function PaymentCancelPage() {
  const [params] = useSearchParams();
  const valuationId = params.get('valuation');

  return (
    <Shell>
      <h1 className="font-display text-2xl font-semibold text-ink-900">Payment cancelled</h1>
      <p className="text-sm text-ink-600">
        No charge was made. You can pay any time from the valuation page — or skip it and we will
        settle by invoice instead.
      </p>
      <div className="flex justify-center gap-3">
        {valuationId ? (
          <Link to={`/valuations/${valuationId}`}>
            <Button>Back to my valuation</Button>
          </Link>
        ) : (
          <Link to="/valuations">
            <Button>Back to my valuations</Button>
          </Link>
        )}
        <Link
          to="/dashboard"
          className="inline-flex items-center rounded-md px-4 py-2 text-sm font-semibold text-ink-600 hover:text-ink-900"
        >
          Go to dashboard
        </Link>
      </div>
    </Shell>
  );
}
