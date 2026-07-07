import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, apiUpload, ApiError } from '../lib/api';
import { formatMoney, KIND_LABELS } from '../lib/format';
import { DOCUMENT_KIND_LABELS, type DocumentKind } from '../lib/pipeline';
import { VALUATION_KINDS, type PaymentQuote, type Valuation, type ValuationKind } from '../lib/types';
import { Button, ErrorNote, Field, Select, TextInput } from '../components/ui';

/**
 * Client onboarding funnel (remaining-gaps §3 #2 / §6 P0 #3) — the guided
 * request → pay → upload → track flow, built on the existing valuation,
 * payment and document APIs. Deliberately linear: one decision per screen.
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
                ? 'bg-bond-600 text-white'
                : i === current
                  ? 'bg-ink-900 text-white'
                  : 'bg-paper-200 text-ink-400'
            }`}
          >
            {i < current ? '✓' : i + 1}
          </span>
          <span
            className={`text-sm font-semibold ${i === current ? 'text-ink-900' : 'text-ink-400'}`}
          >
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
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [valuation, setValuation] = useState<Valuation | null>(null);
  const [quote, setQuote] = useState<PaymentQuote | null>(null);
  const [paymentNote, setPaymentNote] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<Record<string, string[]>>({});
  const [docKind, setDocKind] = useState<DocumentKind>('cap_table');

  const [form, setForm] = useState({
    company_name: '',
    kind: '409a' as ValuationKind,
    currency: 'USD',
  });

  // ── Step 1: create the engagement ────────────────────────────────────────
  const createValuation = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ valuation: Valuation }>('/valuations', {
        method: 'POST',
        body: {
          kind: form.kind,
          company_name: form.company_name.trim(),
          currency: form.currency.trim().toUpperCase() || 'USD',
        },
      });
      setValuation(res.valuation);
      setStep(1);
      // Price transparency on the payment step — best effort, never blocks.
      void api<{ quote: PaymentQuote }>(`/valuations/${res.valuation.id}/payments/quote`)
        .then(({ quote: q }) => setQuote(q))
        .catch(() => {});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the valuation request.');
    } finally {
      setBusy(false);
    }
  };

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
      window.location.assign(checkout_url);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setPaymentNote('Online payment is not available yet — we will send an invoice instead.');
        setStep(2);
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not start the checkout.');
      }
      setBusy(false);
    }
  };

  // ── Step 3: uploads ───────────────────────────────────────────────────────
  const upload = async (files: FileList | null) => {
    if (!valuation || !files || files.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const data = new FormData();
        data.append('kind', docKind);
        data.append('file', file);
        await apiUpload(`/valuations/${valuation.id}/documents`, data);
      }
      setUploaded((u) => ({
        ...u,
        [docKind]: [...(u[docKind] ?? []), ...Array.from(files).map((f) => f.name)],
      }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed.');
    } finally {
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
      {error && <div className="mt-5"><ErrorNote>{error}</ErrorNote></div>}

      {step === 0 && (
        <form
          onSubmit={createValuation}
          className="mt-6 space-y-5 rounded-lg border border-paper-300 bg-white p-6 shadow-card"
        >
          <Field label="Company legal name">
            <TextInput
              value={form.company_name}
              onChange={(e) => setForm((f) => ({ ...f, company_name: e.target.value }))}
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
            <Field label="Currency">
              <TextInput
                value={form.currency}
                onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
                maxLength={3}
                required
              />
            </Field>
          </div>
          <Button type="submit" disabled={busy || !form.company_name.trim()}>
            {busy ? 'Creating…' : 'Continue →'}
          </Button>
        </form>
      )}

      {step === 1 && valuation && (
        <div className="mt-6 space-y-5 rounded-lg border border-paper-300 bg-white p-6 shadow-card">
          <p className="text-sm text-ink-800">
            Your {KIND_LABELS[valuation.kind]} request for{' '}
            <span className="font-semibold">{valuation.company_name}</span> is in. Pay now to move it
            to the front of the queue — or skip and settle by invoice later.
          </p>
          {quote && (
            <p className="text-sm text-ink-800" data-testid="onboarding-quote">
              {KIND_LABELS[valuation.kind]}:{' '}
              <span className="tnum text-lg font-semibold text-ink-900">
                {formatMoney(quote.amount_cents, quote.currency)}
              </span>
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <Button disabled={busy} onClick={() => void checkout()}>
              {busy
                ? 'Opening checkout…'
                : quote
                  ? `Pay ${formatMoney(quote.amount_cents, quote.currency)} with card`
                  : 'Pay now with card'}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setStep(2)}>
              Skip for now →
            </Button>
          </div>
        </div>
      )}

      {step === 2 && valuation && (
        <div className="mt-6 space-y-5 rounded-lg border border-paper-300 bg-white p-6 shadow-card">
          {paymentNote && (
            <p className="rounded-md border border-sky-200 bg-sky-50 px-3.5 py-2.5 text-sm text-sky-900">
              {paymentNote}
            </p>
          )}
          <p className="text-sm text-ink-800">
            Upload what you have — the more we get now, the faster the draft. You can always add more
            from the workspace later.
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
            <label className="inline-flex cursor-pointer items-center rounded-md border border-ink-300 bg-white px-4 py-2 text-sm font-semibold text-ink-800 shadow-sm hover:border-bond-600">
              {busy ? 'Uploading…' : 'Choose files…'}
              <input
                type="file"
                multiple
                className="hidden"
                disabled={busy}
                onChange={(e) => void upload(e.target.files)}
              />
            </label>
          </div>
          <div className="flex justify-end">
            <Button disabled={busy} onClick={() => setStep(3)}>
              {uploadedCount > 0 ? 'Finish →' : 'Skip uploads for now →'}
            </Button>
          </div>
        </div>
      )}

      {step === 3 && valuation && (
        <div className="mt-6 space-y-5 rounded-lg border border-paper-300 bg-white p-6 text-center shadow-card">
          <div className="text-4xl">🎉</div>
          <h2 className="font-display text-2xl font-semibold text-ink-900">
            Your request is in, {valuation.company_name}
          </h2>
          <p className="text-sm text-ink-600">
            {uploadedCount > 0
              ? `${uploadedCount} document${uploadedCount === 1 ? '' : 's'} received. `
              : ''}
            Our analysts pick it up from here — you'll get an email at every milestone, and you can
            track progress or chat with us any time from your workspace.
          </p>
          <div className="flex justify-center gap-3">
            <Button onClick={() => navigate(`/valuations/${valuation.id}`)}>Open my valuation</Button>
            <Link
              to="/dashboard"
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
