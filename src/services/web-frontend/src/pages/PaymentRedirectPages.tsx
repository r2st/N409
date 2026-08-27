import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { formatCents } from '../lib/format';
import type { Payment, Valuation } from '../lib/types';
import { loadDraft } from '../lib/onboardingDraft';
import { Button, Spinner } from '../components/ui';

/**
 * Stripe redirect landing pages (P0 #2 phase A). The webhook — not this
 * redirect — is the source of truth, so the success page polls the valuation
 * until paid_status flips (webhook lag is usually < a few seconds), then
 * surfaces the receipt from the payments list.
 */

const POLL_MS = 2000;
const MAX_POLLS = 15; // ~30s before we stop and reassure instead

/**
 * Whether this redirect is the return leg of the guided onboarding funnel.
 *
 * The funnel writes its draft parked on the *uploads* step immediately before
 * `window.location.assign(checkout_url)`, and says why in a comment on that
 * line: "Parked on the uploads step, which is where a client who has just paid
 * — or just cancelled — should land." Nothing ever took them there. Stripe
 * returns to these two pages, and both offered the valuation page and the
 * dashboard, so the funnel a client was halfway through simply ended at the
 * payment step, with its six-document checklist never shown and its saved
 * place used only if the client happened to press the browser's back button.
 *
 * Matched on the valuation id rather than on the draft merely existing: a
 * client can have a funnel open for one company and be paying an invoice for
 * another from the billing page, and sending them into the wrong request is
 * worse than the dead end this closes.
 */
function resumesOnboarding(valuationId: string | null): boolean {
  if (!valuationId) return false;
  return loadDraft()?.valuation.id === valuationId;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-xl">
      <div className="mt-6 space-y-5 rounded-lg border border-paper-300 bg-surface p-8 text-center shadow-card">
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
          const { payments } = await api<{ payments: Payment[] }>(`/valuations/${valuationId}/payments`);
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
              We received {formatCents(receipt.amount_cents, receipt.currency)} for{' '}
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
        <div className="flex flex-wrap justify-center gap-3">
          {resumesOnboarding(valuationId) ? (
            <>
              {/* Back into the funnel they were in, on the step it parked
                  itself on. Uploading is also the single most useful thing
                  they can do next — the draft waits on those documents. */}
              <Link to="/onboarding">
                <Button>Continue — upload your documents</Button>
              </Link>
              <Link
                to={`/valuations/${valuationId}`}
                className="inline-flex items-center rounded-md px-4 py-2 text-sm font-semibold text-ink-600 hover:text-ink-900"
              >
                Skip for now
              </Link>
            </>
          ) : (
            <>
              <Link to={`/valuations/${valuationId}`}>
                <Button>Open my valuation</Button>
              </Link>
              <Link
                to="/dashboard"
                className="inline-flex items-center rounded-md px-4 py-2 text-sm font-semibold text-ink-600 hover:text-ink-900"
              >
                Go to dashboard
              </Link>
            </>
          )}
        </div>
      </Shell>
    );
  }

  if (timedOut) {
    return (
      <Shell>
        <h1 className="font-display text-2xl font-semibold text-ink-900">Payment processing</h1>
        <p className="text-sm text-ink-600">
          Stripe accepted your payment, but our confirmation is taking longer than usual. The status on your
          valuation will update automatically — no action needed.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          {/* The confirmation is late, not the request. Someone mid-funnel
              still has documents to give us, and waiting for a webhook is not
              a reason to strand them here. */}
          {resumesOnboarding(valuationId) ? (
            <Link to="/onboarding">
              <Button>Continue — upload your documents</Button>
            </Link>
          ) : (
            <Link to={`/valuations/${valuationId}`}>
              <Button>Open my valuation</Button>
            </Link>
          )}
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
        No charge was made. You can pay any time from the valuation page — or skip it and we will settle by
        invoice instead.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        {/*
         * The case the funnel parked for most explicitly. A client who backed
         * out of the card form has not abandoned the request — the funnel's own
         * payment step offers "Skip for now" as an ordinary choice — and
         * cancelling used to be the one action that dropped them out of it.
         */}
        {resumesOnboarding(valuationId) ? (
          <>
            <Link to="/onboarding">
              <Button>Continue without paying now</Button>
            </Link>
            <Link
              to={`/valuations/${valuationId}`}
              className="inline-flex items-center rounded-md px-4 py-2 text-sm font-semibold text-ink-600 hover:text-ink-900"
            >
              Back to my valuation
            </Link>
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
    </Shell>
  );
}
