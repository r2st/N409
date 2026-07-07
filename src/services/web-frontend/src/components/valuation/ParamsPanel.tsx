import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { weightsProblem, type ValuationParams } from '../../lib/pipeline';
import { Button, ErrorNote, Field, Select, Spinner, TextInput } from '../ui';

interface FormState {
  weight_asset: string;
  weight_opm: string;
  weight_income: string;
  weight_market: string;
  dloc: string;
  dlom_method: string;
  dlom_qualitative: string;
  revenue_status: string;
  exit_timeline: string;
  last_round_date: string;
  runway_months: string;
  market_method: string;
  market_horizon: string;
  asset_method: string;
  business_overview: string;
}

const str = (v: string | number | null) => (v === null || v === undefined ? '' : String(v));

function fromParams(p: ValuationParams): FormState {
  return {
    weight_asset: str(p.weight_asset),
    weight_opm: str(p.weight_opm),
    weight_income: str(p.weight_income),
    weight_market: str(p.weight_market),
    dloc: str(p.dloc),
    dlom_method: p.dlom_method ?? '',
    dlom_qualitative: str(p.dlom_qualitative),
    revenue_status: p.revenue_status ?? '',
    exit_timeline: p.exit_timeline?.slice(0, 10) ?? '',
    last_round_date: p.last_round_date?.slice(0, 10) ?? '',
    runway_months: str(p.runway_months),
    market_method: p.market_method ?? '',
    market_horizon: p.market_horizon ?? '',
    asset_method: p.asset_method ?? '',
    business_overview: p.business_overview ?? '',
  };
}

const WEIGHTS: Array<{ key: keyof FormState; label: string }> = [
  { key: 'weight_asset', label: 'Asset approach' },
  { key: 'weight_opm', label: 'OPM backsolve' },
  { key: 'weight_income', label: 'Income (DCF)' },
  { key: 'weight_market', label: 'Market (comps)' },
];

/** Finance methodology editor — approach weights, DLOM/DLOC, timelines. Ops-only. */
export function ParamsPanel({ valuationId, readOnly }: { valuationId: string; readOnly: boolean }) {
  const [params, setParams] = useState<ValuationParams | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { params: p } = await api<{ params: ValuationParams }>(`/valuations/${valuationId}/params`);
      setParams(p);
      setForm(fromParams(p));
    } catch {
      setError('Could not load valuation params.');
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!form || !params) return error ? <ErrorNote>{error}</ErrorNote> : <Spinner />;

  const weightsIssue = weightsProblem({
    asset: form.weight_asset,
    opm: form.weight_opm,
    income: form.weight_income,
    market: form.weight_market,
  });
  const qualitativeMissing = form.dlom_method === 'qualitative' && form.dlom_qualitative.trim() === '';

  const set = (key: keyof FormState) => (value: string) => {
    setSaved(false);
    setForm((f) => (f ? { ...f, [key]: value } : f));
  };

  const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (weightsIssue || qualitativeMissing) return;
    setError(null);
    setBusy(true);
    try {
      const body = {
        weight_asset: numOrNull(form.weight_asset),
        weight_opm: numOrNull(form.weight_opm),
        weight_income: numOrNull(form.weight_income),
        weight_market: numOrNull(form.weight_market),
        dloc: numOrNull(form.dloc),
        dlom_method: form.dlom_method || null,
        dlom_qualitative: numOrNull(form.dlom_qualitative),
        revenue_status: form.revenue_status || null,
        exit_timeline: form.exit_timeline || null,
        last_round_date: form.last_round_date || null,
        runway_months: numOrNull(form.runway_months),
        market_method: form.market_method || null,
        market_horizon: form.market_horizon || null,
        asset_method: form.asset_method || null,
        business_overview: form.business_overview.trim() || null,
      };
      const { params: updated } = await api<{ params: ValuationParams }>(
        `/valuations/${valuationId}/params`,
        { method: 'PATCH', body },
      );
      setParams(updated);
      setForm(fromParams(updated));
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save params.');
    } finally {
      setBusy(false);
    }
  };

  const weightTotal = [form.weight_asset, form.weight_opm, form.weight_income, form.weight_market]
    .map((v) => Number(v) || 0)
    .reduce((a, b) => a + b, 0);

  return (
    <form onSubmit={save} className="space-y-6">
      {error && <ErrorNote>{error}</ErrorNote>}
      {saved && (
        <div className="rounded-md border border-bond-200 bg-bond-50 px-3.5 py-2.5 text-sm text-bond-700">
          Methodology saved.
        </div>
      )}

      <section className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
        <div className="mb-5 flex items-baseline justify-between">
          <h3 className="overline text-ink-400">Approach weights</h3>
          <span
            className={`tnum text-sm font-semibold ${weightsIssue ? 'text-red-600' : 'text-bond-700'}`}
            data-testid="weight-total"
          >
            Σ {weightTotal.toFixed(4)}
          </span>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {WEIGHTS.map(({ key, label }) => (
            <Field key={key} label={label}>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  disabled={readOnly}
                  value={Number(form[key]) || 0}
                  onChange={(e) => set(key)(e.target.value)}
                  className="flex-1 accent-bond-600"
                  aria-label={`${label} weight slider`}
                />
                <TextInput
                  type="number"
                  min={0}
                  max={1}
                  step={0.0001}
                  disabled={readOnly}
                  value={form[key]}
                  onChange={(e) => set(key)(e.target.value)}
                  className="w-24"
                  aria-label={`${label} weight`}
                />
              </div>
            </Field>
          ))}
        </div>
        {weightsIssue && <p className="mt-3 text-sm font-medium text-red-600">{weightsIssue}</p>}
      </section>

      <section className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
        <h3 className="overline mb-5 text-ink-400">Discounts</h3>
        <div className="grid gap-5 sm:grid-cols-3">
          <Field label="DLOC (fraction)" hint="Discount for lack of control, 0–1.">
            <TextInput
              type="number"
              min={0}
              max={1}
              step={0.01}
              disabled={readOnly}
              value={form.dloc}
              onChange={(e) => set('dloc')(e.target.value)}
            />
          </Field>
          <Field label="DLOM method" hint="Chaffee/Finnerty are computed by the engine.">
            <Select
              disabled={readOnly}
              value={form.dlom_method}
              onChange={(e) => set('dlom_method')(e.target.value)}
            >
              <option value="">Not set</option>
              <option value="chaffee">Chaffee (protective put)</option>
              <option value="finnerty">Finnerty (average-strike put)</option>
              <option value="qualitative">Qualitative</option>
            </Select>
          </Field>
          {form.dlom_method === 'qualitative' && (
            <Field label="Qualitative DLOM (fraction)" error={qualitativeMissing ? 'Required for the qualitative method.' : null}>
              <TextInput
                type="number"
                min={0}
                max={1}
                step={0.01}
                disabled={readOnly}
                value={form.dlom_qualitative}
                onChange={(e) => set('dlom_qualitative')(e.target.value)}
              />
            </Field>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
        <h3 className="overline mb-5 text-ink-400">Company profile</h3>
        <div className="grid gap-5 sm:grid-cols-3">
          <Field label="Revenue status">
            <Select
              disabled={readOnly}
              value={form.revenue_status}
              onChange={(e) => set('revenue_status')(e.target.value)}
            >
              <option value="">Not set</option>
              <option value="pre_revenue">Pre-revenue</option>
              <option value="post_revenue">Post-revenue</option>
            </Select>
          </Field>
          <Field label="Expected exit" hint="Drives time-to-liquidity in OPM & DLOM.">
            <TextInput
              type="date"
              disabled={readOnly}
              value={form.exit_timeline}
              onChange={(e) => set('exit_timeline')(e.target.value)}
            />
          </Field>
          <Field label="Last round date">
            <TextInput
              type="date"
              disabled={readOnly}
              value={form.last_round_date}
              onChange={(e) => set('last_round_date')(e.target.value)}
            />
          </Field>
          <Field label="Runway (months)">
            <TextInput
              type="number"
              min={0}
              max={600}
              disabled={readOnly}
              value={form.runway_months}
              onChange={(e) => set('runway_months')(e.target.value)}
            />
          </Field>
          <Field label="Market metric">
            <Select
              disabled={readOnly}
              value={form.market_method}
              onChange={(e) => set('market_method')(e.target.value)}
            >
              <option value="">Not set</option>
              <option value="revenue">Revenue multiple</option>
              <option value="ebitda">EBITDA multiple</option>
            </Select>
          </Field>
          <Field label="Market horizon">
            <Select
              disabled={readOnly}
              value={form.market_horizon}
              onChange={(e) => set('market_horizon')(e.target.value)}
            >
              <option value="">Not set</option>
              <option value="ltm">Last twelve months</option>
              <option value="ntm">Next twelve months</option>
            </Select>
          </Field>
          <Field label="Asset method">
            <Select
              disabled={readOnly}
              value={form.asset_method}
              onChange={(e) => set('asset_method')(e.target.value)}
            >
              <option value="">Not set</option>
              <option value="nav">Net asset value</option>
              <option value="cost_to_replicate">Cost to replicate</option>
            </Select>
          </Field>
        </div>
        <Field label="Business overview">
          <textarea
            disabled={readOnly}
            value={form.business_overview}
            onChange={(e) => set('business_overview')(e.target.value)}
            rows={3}
            maxLength={20000}
            placeholder="One paragraph on what the company does — feeds the comparables pipeline."
            className="mt-1 w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-300 focus:border-bond-600 focus:ring-2 focus:ring-bond-600/20 focus:outline-none"
          />
        </Field>
      </section>

      {!readOnly && (
        <Button type="submit" disabled={busy || Boolean(weightsIssue) || qualitativeMissing}>
          {busy ? 'Saving…' : 'Save methodology'}
        </Button>
      )}
    </form>
  );
}
