import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, apiUpload, ApiError } from '../lib/api';
import { all, pattern, required, useFormValidation } from '../lib/useFormValidation';
import { formatCents, KIND_LABELS } from '../lib/format';
import { DOCUMENT_KIND_LABELS, type DocumentKind } from '../lib/pipeline';
import { clearDraft, loadDraft, saveDraft } from '../lib/onboardingDraft';
import { VALUATION_KINDS, type PaymentQuote, type Valuation, type ValuationKind } from '../lib/types';
import { Button, ErrorNote, Field, Select, TextInput } from '../components/ui';

/**
 * Client onboarding funnel (remaining-gaps §3 #2 / §6 P0 #3) — the guided
 * request → pay → upload → track flow, built on the existing valuation,
 * payment and document APIs. Deliberately linear: one decision per screen.
 *
 * Progress is persisted per step (see `lib/onboardingDraft`), because one of
 * the steps navigates the browser to Stripe and the client has to come back to
 * the funnel they were in rather than to an empty first screen.
 */

const STEPS = ['Your company', 'Payment', 'Documents', 'All set'] as const;

/** The uploads most engagements need — mirrored from the AI missing-data checklist. */
const CHECKLIST: DocumentKind[] = [
  'cap_table',
  'income_statement',
  'balance_sheet',
  'projections',
  'articles_of_incorporation',
  'option_grants',
];

function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-2">
      {STEPS.map((label, i) => (
        <li key={label} className="flex items-center gap-2">
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
              i < current
                ? 'bg-bond-600 text-bond-fg'
                : i === current
                  ? 'bg-ink-900 text-paper-50'
                  : 'bg-paper-200 text-ink-500'
            }`}
          >
            {i < current ? '✓' : i + 1}
          </span>
          <span className={`text-sm font-semibold ${i === current ? 'text-ink-900' : 'text-ink-400'}`}>
            {label}
          </span>
          {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-paper-300" />}
        </li>
      ))}
    </ol>
  );
}

export function OnboardingPage() {
  const navigate = useNavigate();
  // Read once, synchronously, during the first render. An effect would paint
  // the empty first screen before restoring, which is the flash of "we lost
  // your request" this exists to prevent.
  const [restored] = useState(() => loadDraft());
  const [step, setStep] = useState(restored?.step ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [valuation, setValuation] = useState<Valuation | null>(restored?.valuation ?? null);
  const [quote, setQuote] = useState<PaymentQuote | null>(null);
  /** The price could not be fetched — distinct from there not being one. */
  const [quoteFailed, setQuoteFailed] = useState(false);
  const [paymentNote, setPaymentNote] = useState<string | null>(restored?.paymentNote ?? null);
  const [uploaded, setUploaded] = useState<Record<string, string[]>>(restored?.uploaded ?? {});
  const [docKind, setDocKind] = useState<DocumentKind>('cap_table');

  const [form, setForm] = useState({
    company_name: restored?.valuation.company_name ?? '',
    kind: (restored?.valuation.kind as ValuationKind | undefined) ?? '409a',
    currency: restored?.valuation.currency ?? 'USD',
  });

  /** Persist after every step that changes something worth coming back to. */
  const remember = (next: {
    step: number;
    valuation: Valuation;
    uploaded?: Record<string, string[]>;
    paymentNote?: string | null;
  }) => {
    saveDraft({
      step: next.step,
      valuation: next.valuation,
      uploaded: next.uploaded ?? uploaded,
      paymentNote: next.paymentNote ?? paymentNote,
    });
  };

  // The quote is not part of the draft — it is a live price, and a resumed
  // wizard must show today's, not the one cached before the tab was closed.
  useEffect(() => {
    if (!valuation || step !== 1) return;
    let live = true;
    void api<{ quote: PaymentQuote }>(`/valuations/${valuation.id}/payments/quote`)
      .then(({ quote: q }) => {
        if (!live) return;
        setQuote(q);
        setQuoteFailed(false);
      })
      // The button below still opens checkout and Stripe still quotes the real
      // figure, so this is not fatal — but a pay screen that shows no price and
      // does not say why is asking someone to start a payment blind.
      .catch(() => live && setQuoteFailed(true));
    return () => {
      live = false;
    };
  }, [valuation, step]);

  // ── Step 1: create the engagement ────────────────────────────────────────
  /*
   * The same two rules the ops-side new-valuation form carries, because this is
   * the same POST. Worth more here: the client filling this in is not an
   * analyst who knows what the box wants, and the first screen of the funnel is
   * the worst place to hand someone a server 422 for "USDollars".
   */
  const { errorFor, blurHandler, handleSubmit } = useFormValidation(form, {
    company_name: required('company_name', 'Company legal name'),
    currency: all(
      required('currency', 'Currency'),
      pattern('currency', /[A-Za-z]{3}/, 'Currency must be a three-letter ISO 4217 code, like USD.'),
    ),
  });

  const createValuation = handleSubmit(async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ valuation: Valuation }>('/valuations', {
        method: 'POST',
        body: {
          kind: form.kind,
          company_name: form.company_name.trim(),
          currency: form.currency.trim().toUpperCase(),
        },
      });
      setValuation(res.valuation);
      setStep(1);
      // Written before anything else can go wrong: the valuation now exists
      // server-side, and from here on losing track of it means the client
      // creates a duplicate.
      remember({ step: 1, valuation: res.valuation });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the valuation request.');
    } finally {
      setBusy(false);
    }
  });

  // ── Step 2: Stripe checkout (optional — invoice fallback) ───────────────
  const checkout = async () => {
    if (!valuation) return;
    setError(null);
    setBusy(true);
    try {
      const { checkout_url } = await api<{ checkout_url: string }>(
        `/valuations/${valuation.id}/payments/checkout`,
        { method: 'POST', body: {} },
      );
      // Save before leaving, not after: the assign never returns, so anything
      // written below it never runs. Parked on the uploads step, which is where
      // a client who has just paid — or just cancelled — should land.
      remember({ step: 2, valuation });
      window.location.assign(checkout_url);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        const note = 'Online payment is not available yet — we will send an invoice instead.';
        setPaymentNote(note);
        setStep(2);
        remember({ step: 2, valuation, paymentNote: note });
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not start the checkout.');
      }
      setBusy(false);
    }
  };

  // ── Step 3: uploads ───────────────────────────────────────────────────────
  const upload = async (files: File[]) => {
    if (!valuation || files.length === 0) return;
    setError(null);
    setBusy(true);
    // Recorded one file at a time rather than as a batch at the end. The ticks
    // were only written once the whole loop had run, so a failure on the third
    // of five files discarded the names of the two already sitting on the
    // server — and a client resuming the wizard uploaded the same cap table
    // twice, which is the single thing the ticks exist to prevent.
    const landed: string[] = [];
    try {
      for (const file of files) {
        const data = new FormData();
        data.append('kind', docKind);
        data.append('file', file);
        await apiUpload(`/valuations/${valuation.id}/documents`, data);
        landed.push(file.name);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed.');
    } finally {
      if (landed.length > 0) {
        setUploaded((u) => {
          const next = { ...u, [docKind]: [...(u[docKind] ?? []), ...landed] };
          // The files are on the server either way; the ticks are what a
          // resumed wizard needs.
          remember({ step: 2, valuation, uploaded: next });
          return next;
        });
      }
      setBusy(false);
    }
  };

  const uploadedCount = Object.values(uploaded).flat().length;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="overline text-ink-400">New valuation request</div>
      <h1 className="mt-1 mb-6 font-display text-3xl font-semibold text-ink-900">
        Let's get your valuation started
      </h1>
      <Stepper current={step} />
      {/*
       * Say so when the wizard has picked a request back up. Silently landing
       * on step 3 with someone else's company name in the header reads as a
       * bug; naming it turns the same screen into a reassurance — and tells a
       * client returning from a cancelled checkout that nothing was lost.
       */}
      {restored && (
        <p
          data-testid="onboarding-resumed"
          className="mt-5 rounded-md border border-sky-200 bg-sky-50 px-3.5 py-2.5 text-sm text-sky-900"
        >
          Picking up where you left off — your request for{' '}
          <span className="font-semibold">{restored.valuation.company_name}</span> is saved.
        </p>
      )}
      {error && (
        <div className="mt-5">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {step === 0 && (
        <form
          onSubmit={createValuation}
          className="mt-6 space-y-5 rounded-lg border border-paper-300 bg-surface p-6 shadow-card"
          noValidate
        >
          <Field label="Company legal name" error={errorFor('company_name')}>
            <TextInput
              value={form.company_name}
              onChange={(e) => setForm((f) => ({ ...f, company_name: e.target.value }))}
              onBlur={blurHandler('company_name')}
              required
              maxLength={300}
              placeholder="Acme Robotics, Inc."
            />
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="What do you need?" hint="Most startups issuing options need a 409A.">
              <Select
                value={form.kind}
                onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as ValuationKind }))}
              >
                {VALUATION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Currency" error={errorFor('currency')}>
              <TextInput
                value={form.currency}
                onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
                onBlur={blurHandler('currency')}
                maxLength={3}
                required
              />
            </Field>
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Continue →'}
          </Button>
        </form>
      )}

      {step === 1 && valuation && (
        <div className="mt-6 space-y-5 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <p className="text-sm text-ink-800">
            Your {KIND_LABELS[valuation.kind]} request for{' '}
            <span className="font-semibold">{valuation.company_name}</span> is in. Pay now to move it to the
            front of the queue — or skip and settle by invoice later.
          </p>
          {quote && (
            <p className="text-sm text-ink-800" data-testid="onboarding-quote">
              {KIND_LABELS[valuation.kind]}:{' '}
              <span className="tnum text-lg font-semibold text-ink-900">
                {formatCents(quote.amount_cents, quote.currency)}
              </span>
            </p>
          )}
          {quoteFailed && (
            <p className="text-sm text-ink-500">
              The price could not be worked out just now, so none is shown here. Checkout still quotes it —
              the amount on the payment page is the amount you will be charged.
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <Button disabled={busy} onClick={() => void checkout()}>
              {busy
                ? 'Opening checkout…'
                : quote
                  ? `Pay ${formatCents(quote.amount_cents, quote.currency)} with card`
                  : 'Pay now with card'}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setStep(2);
                remember({ step: 2, valuation });
              }}
            >
              Skip for now →
            </Button>
          </div>
        </div>
      )}

      {step === 2 && valuation && (
        <div className="mt-6 space-y-5 rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          {paymentNote && (
            <p className="rounded-md border border-sky-200 bg-sky-50 px-3.5 py-2.5 text-sm text-sky-900">
              {paymentNote}
            </p>
          )}
          <p className="text-sm text-ink-800">
            Upload what you have — the more we get now, the faster the draft. You can always add more from the
            workspace later.
          </p>
          <ul className="grid gap-1.5 text-sm text-ink-600 sm:grid-cols-2">
            {CHECKLIST.map((k) => (
              <li key={k} className="flex items-center gap-2">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${uploaded[k]?.length ? 'bg-bond-500' : 'bg-paper-400'}`}
                />
                {DOCUMENT_KIND_LABELS[k]}
                {uploaded[k]?.length ? (
                  <span className="text-xs text-bond-700">({uploaded[k]!.length})</span>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-56">
              <Field label="Document type">
                <Select value={docKind} onChange={(e) => setDocKind(e.target.value as DocumentKind)}>
                  {Object.entries(DOCUMENT_KIND_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <label className="inline-flex cursor-pointer items-center rounded-md border border-ink-300 bg-surface px-4 py-2 text-sm font-semibold text-ink-800 shadow-sm hover:border-bond-600">
              {busy ? 'Uploading…' : 'Choose files…'}
              <input
                type="file"
                multiple
                className="hidden"
                disabled={busy}
                onChange={(e) => {
                  // Snapshot the picks and hand the input back empty. Left as
                  // it was, re-choosing the *same* file fires no change event —
                  // so the obvious way to retry a failed upload, picking it
                  // again, was a control that did nothing.
                  const picked = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  void upload(picked);
                }}
              />
            </label>
          </div>
          <div className="flex justify-end">
            <Button
              disabled={busy}
              onClick={() => {
                setStep(3);
                remember({ step: 3, valuation });
              }}
            >
              {uploadedCount > 0 ? 'Finish →' : 'Skip uploads for now →'}
            </Button>
          </div>
        </div>
      )}

      {step === 3 && valuation && (
        <div className="mt-6 space-y-5 rounded-lg border border-paper-300 bg-surface p-6 text-center shadow-card">
          <div className="text-4xl">🎉</div>
          <h2 className="font-display text-2xl font-semibold text-ink-900">
            Your request is in, {valuation.company_name}
          </h2>
          <p className="text-sm text-ink-600">
            {uploadedCount > 0 ? `${uploadedCount} document${uploadedCount === 1 ? '' : 's'} received. ` : ''}
            Our analysts pick it up from here — you'll get an email at every milestone, and you can track
            progress or chat with us any time from your workspace.
          </p>
          <div className="flex justify-center gap-3">
            {/*
             * The draft is dropped when the client leaves the funnel, not on
             * reaching this screen: they may still refresh it, and "your
             * request is in" with no valuation to open would be the same
             * amnesia one screen later.
             */}
            <Button
              onClick={() => {
                clearDraft();
                navigate(`/valuations/${valuation.id}`);
              }}
            >
              Open my valuation
            </Button>
            <Link
              to="/dashboard"
              onClick={() => clearDraft()}
              className="inline-flex items-center rounded-md px-4 py-2 text-sm font-semibold text-ink-600 hover:text-ink-900"
            >
              Go to dashboard
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
