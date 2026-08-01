import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { HelpIcon } from '../components/HelpIcon';
import { KIND_LABELS } from '../lib/format';
import { VALUATION_KINDS } from '../lib/types';
import type { Valuation, ValuationKind } from '../lib/types';
import { Button, ErrorNote, Field, TextInput } from '../components/ui';
import { COMPANY_HINT_KEY } from './RegisterPage';

const KIND_BLURBS: Partial<Record<ValuationKind, string>> = {
  '409a': 'Common-stock FMV for option grants — the core product.',
  fmv: 'General fair-market-value opinion.',
  '718': 'Stock-based compensation expense (US GAAP).',
  '820': 'Fair-value measurement (US GAAP).',
  gifts: 'Gift & estate-tax valuations.',
  qsbs: 'Qualified Small Business Stock attestation.',
  csop: 'UK Company Share Option Plan.',
  emi: 'UK Enterprise Management Incentive.',
  ifrs2: 'Share-based payment (IFRS).',
  ppa: 'Purchase price allocation.',
  goodwill: 'Goodwill impairment testing.',
  esop: 'Employee stock ownership plan.',
  ip: 'Intellectual-property valuation.',
};

const FEATURED: ValuationKind[] = ['409a', 'fmv', '718', 'qsbs'];

export function NewValuationPage() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<ValuationKind>('409a');
  const [showAll, setShowAll] = useState(false);
  const [company, setCompany] = useState(() => localStorage.getItem(COMPANY_HINT_KEY) ?? '');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const kinds = showAll ? [...VALUATION_KINDS] : FEATURED;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ valuation: Valuation }>('/valuations', {
        method: 'POST',
        body: {
          kind,
          company_name: company.trim(),
          currency: currency.trim().toUpperCase() || undefined,
        },
      });
      localStorage.removeItem(COMPANY_HINT_KEY);
      navigate(`/valuations/${res.valuation.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the valuation.');
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <div className="overline flex items-center gap-1.5 text-ink-400">
        New engagement
        <HelpIcon article="creating-a-valuation" />
      </div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Start a valuation</h1>
      <p className="mt-1 text-sm text-ink-400">
        Choose the opinion you need — an analyst-reviewed, engine-computed report follows.
      </p>

      <form onSubmit={submit} className="mt-8 space-y-8">
        <ErrorNote>{error}</ErrorNote>

        <fieldset>
          <legend className="overline mb-3 text-ink-400">Valuation type</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {kinds.map((k) => (
              <button
                type="button"
                key={k}
                onClick={() => setKind(k)}
                aria-pressed={kind === k}
                className={`cursor-pointer rounded-lg border p-4 text-left transition-all ${
                  kind === k
                    ? 'border-bond-600 bg-bond-50 ring-2 ring-bond-600/25'
                    : 'border-paper-300 bg-surface hover:border-ink-300'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-display text-[1.02rem] font-semibold text-ink-900">
                    {KIND_LABELS[k]}
                  </span>
                  {kind === k && (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-bond-600 text-bond-fg">
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                      >
                        <path d="M5 13l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-ink-400">{KIND_BLURBS[k]}</p>
              </button>
            ))}
          </div>
          {!showAll && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-3 cursor-pointer text-sm font-semibold text-bond-600 hover:text-bond-700"
            >
              Show all {VALUATION_KINDS.length} valuation types →
            </button>
          )}
        </fieldset>

        <div className="grid gap-5 sm:grid-cols-[1fr_8rem]">
          <Field label="Company legal name">
            <TextInput
              required
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Acme, Inc."
              maxLength={300}
            />
          </Field>
          <Field label="Currency" hint="ISO 4217">
            <TextInput
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              maxLength={3}
              placeholder="USD"
              className="uppercase"
            />
          </Field>
        </div>

        <div className="flex gap-3">
          <Button type="submit" disabled={busy || !company.trim() || currency.trim().length !== 3}>
            {busy ? 'Creating…' : 'Create valuation'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => navigate(-1)}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
