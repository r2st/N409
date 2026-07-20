import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { Button, EmptyState, ErrorNote, Field, Select, Spinner, TextInput } from '../components/ui';

/**
 * Debt Instruments (feature: Debt Valuation Engine). Bonds, term loans,
 * convertible notes and SAFEs valued by the debt engine (debt_valuation.py):
 * yield DCF with duration/convexity, credit-spread pricing, the
 * Tsiveriotis-Fernandes convertible tree, and SAFE cap/discount conversion.
 * Ops-only.
 */

type InstrumentType = 'bond' | 'term_loan' | 'convertible' | 'safe' | 'credit_spread';

const money = (v: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);

const TYPE_LABELS: Record<InstrumentType, string> = {
  bond: 'Bond',
  term_loan: 'Term loan',
  convertible: 'Convertible note',
  safe: 'SAFE',
  credit_spread: 'Credit-spread bond',
};

/** Per-type parameter fields (key, label, default). */
const PARAM_FIELDS: Record<InstrumentType, Array<{ key: string; label: string; def: string; bool?: boolean }>> = {
  bond: [
    { key: 'face', label: 'Face', def: '1000' },
    { key: 'coupon_rate', label: 'Coupon rate', def: '0.05' },
    { key: 'frequency', label: 'Freq/yr', def: '2' },
    { key: 'maturity_years', label: 'Maturity (y)', def: '5' },
    { key: 'market_yield', label: 'Market yield', def: '0.06' },
    { key: 'amortizing', label: 'Amortizing', def: 'false', bool: true },
  ],
  term_loan: [
    { key: 'principal', label: 'Principal', def: '1000000' },
    { key: 'coupon_rate', label: 'Coupon rate', def: '0.07' },
    { key: 'frequency', label: 'Freq/yr', def: '4' },
    { key: 'maturity_years', label: 'Maturity (y)', def: '5' },
    { key: 'market_yield', label: 'Market yield', def: '0.09' },
    { key: 'amortizing', label: 'Amortizing', def: 'true', bool: true },
  ],
  credit_spread: [
    { key: 'face', label: 'Face', def: '1000' },
    { key: 'coupon_rate', label: 'Coupon rate', def: '0.05' },
    { key: 'frequency', label: 'Freq/yr', def: '2' },
    { key: 'maturity_years', label: 'Maturity (y)', def: '5' },
  ],
  convertible: [
    { key: 'face', label: 'Face', def: '1000' },
    { key: 'coupon_rate', label: 'Coupon rate', def: '0.04' },
    { key: 'frequency', label: 'Freq/yr', def: '2' },
    { key: 'maturity_years', label: 'Maturity (y)', def: '5' },
    { key: 'conversion_ratio', label: 'Conversion ratio', def: '20' },
    { key: 'stock_price', label: 'Stock price', def: '40' },
    { key: 'volatility', label: 'Volatility', def: '0.4' },
    { key: 'risk_free_rate', label: 'Risk-free', def: '0.03' },
    { key: 'credit_spread', label: 'Credit spread', def: '0.02' },
    { key: 'dividend_yield', label: 'Dividend yield', def: '0' },
  ],
  safe: [
    { key: 'investment', label: 'Investment', def: '100000' },
    { key: 'valuation_cap', label: 'Valuation cap', def: '5000000' },
    { key: 'discount', label: 'Discount', def: '0.2' },
    { key: 'next_round_pre_money', label: 'Next round pre-money', def: '20000000' },
    { key: 'next_round_shares', label: 'Next round shares', def: '10000000' },
  ],
};

interface Instrument {
  id: string;
  name: string;
  instrument_type: InstrumentType;
  currency: string;
  params: Record<string, unknown>;
}
interface CreditTerms {
  rating: string | null;
  benchmark_yield: string | null;
  spread: string | null;
  seniority: string;
  secured: boolean;
}
interface Valuation {
  id: string;
  valuation_date: string;
  fair_value: string | null;
  result: Record<string, unknown>;
}

export function DebtInstrumentsPage() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState<{ name: string; instrument_type: InstrumentType; currency: string }>({ name: '', instrument_type: 'bond', currency: 'USD' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { instruments: i } = await api<{ instruments: Instrument[] }>('/debt/instruments');
      setInstruments(i);
      if (i.length > 0 && !selected) setSelected(i[0]!.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load instruments');
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const params: Record<string, unknown> = {};
      for (const f of PARAM_FIELDS[form.instrument_type]) params[f.key] = f.bool ? f.def === 'true' : Number(f.def);
      const { instrument } = await api<{ instrument: Instrument }>('/debt/instruments', {
        method: 'POST',
        body: { name: form.name, instrument_type: form.instrument_type, currency: form.currency.toUpperCase(), params },
      });
      setShowNew(false);
      setForm({ name: '', instrument_type: 'bond', currency: 'USD' });
      await load();
      setSelected(instrument.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create instrument');
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-1">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-800">Debt Instruments</h1>
          <p className="mt-1 text-sm text-ink-500">Fair-value bonds, term loans, convertible notes and SAFEs.</p>
        </div>
        <Button onClick={() => setShowNew((s) => !s)}>{showNew ? 'Cancel' : 'New instrument'}</Button>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      {showNew && (
        <form onSubmit={create} className="flex flex-wrap items-end gap-3 rounded-lg border border-paper-200 bg-white p-4">
          <Field label="Name"><TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
          <Field label="Type">
            <Select value={form.instrument_type} onChange={(e) => setForm({ ...form, instrument_type: e.target.value as InstrumentType })}>
              {(Object.keys(TYPE_LABELS) as InstrumentType[]).map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </Select>
          </Field>
          <Field label="Currency"><TextInput value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} className="w-20" /></Field>
          <Button type="submit">Create</Button>
        </form>
      )}

      {instruments.length === 0 ? (
        <EmptyState title="No instruments yet">Create a debt instrument to value it.</EmptyState>
      ) : (
        <div className="flex flex-wrap gap-2">
          {instruments.map((i) => (
            <button
              key={i.id}
              onClick={() => setSelected(i.id)}
              className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
                selected === i.id ? 'border-bond-600 bg-bond-50 text-bond-700' : 'border-paper-300 text-ink-600 hover:bg-paper-100'
              }`}
            >
              {i.name} <span className="text-ink-400">· {TYPE_LABELS[i.instrument_type]}</span>
            </button>
          ))}
        </div>
      )}

      {selected && <InstrumentDetail key={selected} instrumentId={selected} />}
    </div>
  );
}

function InstrumentDetail({ instrumentId }: { instrumentId: string }) {
  const [instrument, setInstrument] = useState<Instrument | null>(null);
  const [creditTerms, setCreditTerms] = useState<CreditTerms | null>(null);
  const [valuations, setValuations] = useState<Valuation[]>([]);
  const [params, setParams] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [sensitivity, setSensitivity] = useState<Array<{ shift: number; value: number }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await api<{ instrument: Instrument; credit_terms: CreditTerms | null; valuations: Valuation[] }>(`/debt/instruments/${instrumentId}`);
      setInstrument(d.instrument);
      setCreditTerms(d.credit_terms);
      setValuations(d.valuations);
      const p: Record<string, string> = {};
      for (const f of PARAM_FIELDS[d.instrument.instrument_type]) {
        const v = d.instrument.params[f.key];
        p[f.key] = f.bool ? String(v ?? f.def === 'true') : String(v ?? f.def);
      }
      setParams(p);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load instrument');
    }
  }, [instrumentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveParams = async () => {
    if (!instrument) return;
    setError(null);
    try {
      const parsed: Record<string, unknown> = {};
      for (const f of PARAM_FIELDS[instrument.instrument_type]) parsed[f.key] = f.bool ? params[f.key] === 'true' : Number(params[f.key]);
      await api(`/debt/instruments/${instrumentId}`, { method: 'PUT', body: { params: parsed } });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to save');
    }
  };

  const runValue = async (overrides: Record<string, unknown> = {}) => {
    const { result: r } = await api<{ result: Record<string, unknown> }>(`/debt/instruments/${instrumentId}/value`, {
      method: 'POST',
      body: { overrides },
    });
    return r;
  };

  const value = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveParams();
      setResult(await runValue());
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Valuation failed');
    } finally {
      setBusy(false);
    }
  };

  const runSensitivity = async () => {
    if (!instrument) return;
    setBusy(true);
    setError(null);
    try {
      await saveParams();
      const yieldKey = instrument.instrument_type === 'convertible' ? 'credit_spread' : instrument.instrument_type === 'safe' ? 'discount' : 'market_yield';
      const base = Number(params[yieldKey] ?? 0);
      const shifts = [-0.02, -0.01, 0, 0.01, 0.02];
      const rows: Array<{ shift: number; value: number }> = [];
      for (const s of shifts) {
        const r = await runValue({ [yieldKey]: Math.max(base + s, 0) });
        const fv = (r.fair_value ?? r.dirty_price) as number;
        rows.push({ shift: s, value: Number(fv) });
      }
      setSensitivity(rows);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Sensitivity failed');
    } finally {
      setBusy(false);
    }
  };

  if (!instrument) return <Spinner />;
  const cur = instrument.currency;

  return (
    <div className="space-y-5">
      {error && <ErrorNote>{error}</ErrorNote>}

      {/* Parameters */}
      <div className="rounded-lg border border-paper-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold text-ink-700">{TYPE_LABELS[instrument.instrument_type]} parameters</h3>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {PARAM_FIELDS[instrument.instrument_type].map((f) => (
            <Field key={f.key} label={f.label}>
              {f.bool ? (
                <Select value={params[f.key] ?? 'false'} onChange={(e) => setParams({ ...params, [f.key]: e.target.value })}>
                  <option value="false">No</option>
                  <option value="true">Yes</option>
                </Select>
              ) : (
                <TextInput value={params[f.key] ?? ''} onChange={(e) => setParams({ ...params, [f.key]: e.target.value })} />
              )}
            </Field>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <Button onClick={() => void value()} disabled={busy}>{busy ? 'Working…' : 'Value instrument'}</Button>
          <Button variant="secondary" onClick={() => void runSensitivity()} disabled={busy}>
            {instrument.instrument_type === 'safe' ? 'Discount' : instrument.instrument_type === 'convertible' ? 'Spread' : 'Yield'} sensitivity
          </Button>
        </div>
      </div>

      {/* Credit terms for credit_spread instruments */}
      {instrument.instrument_type === 'credit_spread' && <CreditTermsCard instrumentId={instrumentId} terms={creditTerms} onSaved={load} />}

      {/* Result */}
      {result && <ResultCard type={instrument.instrument_type} result={result} currency={cur} />}

      {/* Sensitivity table */}
      {sensitivity && (
        <div className="rounded-lg border border-paper-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold text-ink-700">Sensitivity</h3>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-paper-300 text-left text-xs uppercase text-ink-500"><th className="py-1.5">Shift</th><th className="py-1.5">Fair value</th></tr></thead>
            <tbody className="tnum">
              {sensitivity.map((r) => (
                <tr key={r.shift} className={`border-b border-paper-100 last:border-0 ${r.shift === 0 ? 'font-semibold' : ''}`}>
                  <td className="py-1.5">{r.shift > 0 ? '+' : ''}{(r.shift * 100).toFixed(0)} bps×100</td>
                  <td className="py-1.5">{money(r.value, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Valuation history */}
      {valuations.length > 0 && (
        <div className="rounded-lg border border-paper-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold text-ink-700">Valuation history</h3>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-paper-300 text-left text-xs uppercase text-ink-500"><th className="py-1.5">Date</th><th className="py-1.5">Fair value</th></tr></thead>
            <tbody className="tnum">
              {valuations.map((v) => (
                <tr key={v.id} className="border-b border-paper-100 last:border-0">
                  <td className="py-1.5">{v.valuation_date}</td>
                  <td className="py-1.5">{v.fair_value != null ? money(Number(v.fair_value), cur) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ResultCard({ type, result, currency }: { type: InstrumentType; result: Record<string, unknown>; currency: string }) {
  const num = (k: string) => (typeof result[k] === 'number' ? (result[k] as number) : null);
  const schedule = Array.isArray(result.schedule) ? (result.schedule as Array<Record<string, number>>) : null;
  return (
    <div className="space-y-4 rounded-lg border border-paper-300 bg-paper-50 p-5">
      <h3 className="text-base font-semibold text-ink-800">Valuation result</h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {num('fair_value') != null && <Metric label="Fair value" value={money(num('fair_value')!, currency)} accent />}
        {num('dirty_price') != null && <Metric label="Dirty price" value={money(num('dirty_price')!, currency)} accent />}
        {num('clean_price') != null && <Metric label="Clean price" value={money(num('clean_price')!, currency)} />}
        {num('accrued_interest') != null && <Metric label="Accrued interest" value={money(num('accrued_interest')!, currency)} />}
        {num('modified_duration') != null && <Metric label="Modified duration" value={num('modified_duration')!.toFixed(3)} />}
        {num('convexity') != null && <Metric label="Convexity" value={num('convexity')!.toFixed(2)} />}
        {num('all_in_yield') != null && <Metric label="All-in yield" value={`${(num('all_in_yield')! * 100).toFixed(2)}%`} />}
        {num('credit_spread') != null && <Metric label="Credit spread" value={`${(num('credit_spread')! * 100).toFixed(2)}%`} />}
        {/* Convertible decomposition */}
        {num('straight_debt_value') != null && <Metric label="Straight-debt value" value={money(num('straight_debt_value')!, currency)} />}
        {num('option_value') != null && <Metric label="Option value" value={money(num('option_value')!, currency)} />}
        {num('parity') != null && <Metric label="Conversion parity" value={money(num('parity')!, currency)} />}
        {/* SAFE */}
        {num('conversion_price') != null && <Metric label="Conversion price" value={money(num('conversion_price')!, currency)} />}
        {num('shares_received') != null && <Metric label="Shares received" value={num('shares_received')!.toLocaleString()} />}
        {num('ownership_pct') != null && <Metric label="Ownership" value={`${(num('ownership_pct')! * 100).toFixed(2)}%`} />}
        {typeof result.converted_via === 'string' && <Metric label="Converts via" value={result.converted_via as string} />}
        {num('moic') != null && <Metric label="MOIC" value={`${num('moic')!.toFixed(2)}×`} />}
      </div>

      {schedule && (
        <div>
          <h4 className="overline mb-2 text-ink-400">Cash-flow schedule</h4>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-paper-50"><tr className="border-b border-paper-300 text-left text-ink-500"><th className="py-1">#</th><th className="py-1">Year</th><th className="py-1">Interest</th><th className="py-1">Principal</th><th className="py-1">Cash flow</th><th className="py-1">Balance</th></tr></thead>
              <tbody className="tnum">
                {schedule.map((r) => (
                  <tr key={r.period} className="border-b border-paper-100 last:border-0">
                    <td className="py-1">{r.period}</td>
                    <td className="py-1">{r.t_years}</td>
                    <td className="py-1">{money(r.interest ?? 0, currency)}</td>
                    <td className="py-1">{money(r.principal ?? 0, currency)}</td>
                    <td className="py-1 font-medium">{money(r.amount ?? 0, currency)}</td>
                    <td className="py-1 text-ink-500">{money(r.balance ?? 0, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="text-xs text-ink-400">{type === 'convertible' ? 'Tsiveriotis-Fernandes decomposition — equity discounted at the risk-free rate, debt at the risky rate.' : 'Illustrative valuation. Not investment advice.'}</p>
    </div>
  );
}

function CreditTermsCard({ instrumentId, terms, onSaved }: { instrumentId: string; terms: CreditTerms | null; onSaved: () => void }) {
  const [form, setForm] = useState({
    rating: terms?.rating ?? 'BBB',
    benchmark_yield: terms?.benchmark_yield ?? '0.03',
    spread: terms?.spread ?? '',
    seniority: terms?.seniority ?? 'senior',
    secured: terms?.secured ?? false,
  });
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    try {
      await api(`/debt/instruments/${instrumentId}/credit-terms`, {
        method: 'PUT',
        body: {
          rating: form.rating || null,
          benchmark_yield: form.benchmark_yield ? Number(form.benchmark_yield) : null,
          spread: form.spread ? Number(form.spread) : null,
          seniority: form.seniority,
          secured: form.secured,
        },
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to save credit terms');
    }
  };

  return (
    <div className="rounded-lg border border-paper-200 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink-700">Credit terms</h3>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Rating"><TextInput value={form.rating} onChange={(e) => setForm({ ...form, rating: e.target.value })} placeholder="BBB" /></Field>
        <Field label="Benchmark yield"><TextInput value={form.benchmark_yield} onChange={(e) => setForm({ ...form, benchmark_yield: e.target.value })} /></Field>
        <Field label="Spread (blank → rating)"><TextInput value={form.spread} onChange={(e) => setForm({ ...form, spread: e.target.value })} /></Field>
        <Field label="Seniority">
          <Select value={form.seniority} onChange={(e) => setForm({ ...form, seniority: e.target.value })}>
            {['senior_secured', 'senior', 'subordinated', 'mezzanine'].map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-ink-600"><input type="checkbox" checked={form.secured} onChange={(e) => setForm({ ...form, secured: e.target.checked })} /> Secured</label>
        <Button variant="secondary" onClick={() => void save()}>Save credit terms</Button>
      </div>
    </div>
  );
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${accent ? 'border-bond-200 bg-bond-50' : 'border-paper-200 bg-white'}`}>
      <div className="overline text-ink-400">{label}</div>
      <div className={`tnum mt-1 text-base font-semibold ${accent ? 'text-bond-700' : 'text-ink-800'}`}>{value}</div>
    </div>
  );
}
