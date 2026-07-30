import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { Button, EmptyState, ErrorNote, Field, InfoTooltip, Select, Spinner, TextInput } from '../components/ui';
import { HelpIcon } from '../components/HelpIcon';

/**
 * ASC 820 Fund Portfolio (feature: ASC 820 Fund Holdings). Distinct from the
 * corporate-group consolidation on /portfolio: here an investment fund marks a
 * portfolio of positions to fair value, levels them (ASC 820 1/2/3), rolls them
 * into NAV and distributes through an LP waterfall. Ops-only.
 */

const money = (v: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);

interface Fund {
  id: string;
  name: string;
  fund_type: string;
  currency: string;
  vintage_year: number | null;
}
interface Mark {
  id: string;
  measurement_date: string;
  method: string;
  fair_value: string;
  level: number;
}
interface Position {
  id: string;
  company_name: string;
  security_type: string;
  quantity: string;
  cost_basis: string;
  mark_method: string;
  latest_mark: Mark | null;
}
interface LpTerms {
  committed_capital: string;
  contributed_capital: string;
  preferred_return_rate: string;
  carry_pct: string;
  gp_catch_up: boolean;
}
interface FundDetail {
  fund: Fund;
  lp_terms: LpTerms | null;
  positions: Position[];
}
interface Nav {
  net_asset_value: number;
  gross_asset_value: number;
  total_cost_basis: number;
  total_unrealized_gain: number;
  liabilities: number;
  level_breakdown: { level_1: number; level_2: number; level_3: number };
}
interface Waterfall {
  distributable: number;
  lp_distribution: number;
  gp_distribution: number;
  clawback_owed: number;
  tiers: Record<string, number>;
}

export function FundPortfolioPage() {
  const [funds, setFunds] = useState<Fund[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', fund_type: 'vc', currency: 'USD', vintage_year: '2024' });

  const loadFunds = useCallback(async () => {
    setLoading(true);
    try {
      const { funds: f } = await api<{ funds: Fund[] }>('/funds');
      setFunds(f);
      if (f.length > 0 && !selected) setSelected(f[0]!.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load funds');
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    void loadFunds();
  }, [loadFunds]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const { fund } = await api<{ fund: Fund }>('/funds', {
        method: 'POST',
        body: {
          name: form.name,
          fund_type: form.fund_type,
          currency: form.currency.toUpperCase(),
          vintage_year: form.vintage_year ? Number(form.vintage_year) : null,
        },
      });
      setShowCreate(false);
      setForm({ name: '', fund_type: 'vc', currency: 'USD', vintage_year: '2024' });
      await loadFunds();
      setSelected(fund.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create fund');
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-1">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-ink-800">
            Fund Portfolios
            <HelpIcon article="fund-holdings-overview" label="Help: Fund holdings & ASC 820" />
          </h1>
          <p className="mt-1 text-sm text-ink-500">ASC 820 fair-value marks, NAV and LP waterfall for investment funds.</p>
        </div>
        <Button onClick={() => setShowCreate((s) => !s)}>{showCreate ? 'Cancel' : 'New fund'}</Button>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      {showCreate && (
        <form onSubmit={create} className="flex flex-wrap items-end gap-3 rounded-lg border border-paper-200 bg-surface p-4">
          <Field label="Fund name"><TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
          <Field label="Type">
            <Select value={form.fund_type} onChange={(e) => setForm({ ...form, fund_type: e.target.value })}>
              <option value="vc">Venture</option>
              <option value="pe">Private equity</option>
              <option value="credit">Credit</option>
              <option value="growth">Growth</option>
              <option value="other">Other</option>
            </Select>
          </Field>
          <Field label="Currency"><TextInput value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} className="w-20" /></Field>
          <Field label="Vintage"><TextInput value={form.vintage_year} onChange={(e) => setForm({ ...form, vintage_year: e.target.value })} className="w-24" /></Field>
          <Button type="submit">Create</Button>
        </form>
      )}

      {funds.length === 0 ? (
        <EmptyState title="No funds yet">Create a fund to start marking its portfolio to fair value.</EmptyState>
      ) : (
        <div className="flex flex-wrap gap-2">
          {funds.map((f) => (
            <button
              key={f.id}
              onClick={() => setSelected(f.id)}
              className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
                selected === f.id ? 'border-bond-600 bg-bond-50 text-bond-700' : 'border-paper-300 text-ink-600 hover:bg-paper-100'
              }`}
            >
              {f.name} <span className="text-ink-400">· {f.fund_type.toUpperCase()}</span>
            </button>
          ))}
        </div>
      )}

      {selected && <FundDetailView key={selected} fundId={selected} />}
    </div>
  );
}

function FundDetailView({ fundId }: { fundId: string }) {
  const [detail, setDetail] = useState<FundDetail | null>(null);
  const [nav, setNav] = useState<Nav | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPos, setShowPos] = useState(false);
  const [posForm, setPosForm] = useState({ company_name: '', security_type: 'preferred', quantity: '0', cost_basis: '0', mark_method: 'cost' });

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await api<FundDetail>(`/funds/${fundId}`);
      setDetail(d);
      if (d.positions.length > 0) {
        const navRes = await api<{ nav: Nav }>(`/funds/${fundId}/nav`);
        setNav(navRes.nav);
      } else {
        setNav(null);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load fund');
    }
  }, [fundId]);

  useEffect(() => {
    void load();
  }, [load]);

  const addPosition = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api(`/funds/${fundId}/positions`, {
        method: 'POST',
        body: {
          company_name: posForm.company_name,
          security_type: posForm.security_type,
          quantity: Number(posForm.quantity),
          cost_basis: Number(posForm.cost_basis),
          mark_method: posForm.mark_method,
        },
      });
      setShowPos(false);
      setPosForm({ company_name: '', security_type: 'preferred', quantity: '0', cost_basis: '0', mark_method: 'cost' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add position');
    }
  };

  if (!detail) return <Spinner />;
  const { fund, positions } = detail;
  const cur = fund.currency;

  return (
    <div className="space-y-5">
      {error && <ErrorNote>{error}</ErrorNote>}

      {/* NAV summary */}
      {nav && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <SummaryCard label="Net asset value" value={money(nav.net_asset_value, cur)} accent />
          <SummaryCard label="Gross asset value" value={money(nav.gross_asset_value, cur)} />
          <SummaryCard label="Cost basis" value={money(nav.total_cost_basis, cur)} />
          <SummaryCard label="Unrealized gain" value={money(nav.total_unrealized_gain, cur)} />
        </div>
      )}

      {/* ASC 820 hierarchy disclosure */}
      {nav && (
        <div className="rounded-lg border border-paper-200 bg-surface p-4">
          <h3 className="mb-2 text-sm font-semibold text-ink-700">ASC 820 fair-value hierarchy</h3>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-paper-300 text-left text-xs uppercase text-ink-500"><th className="py-1.5">Level 1 (quoted)</th><th className="py-1.5">Level 2 (observable)</th><th className="py-1.5">Level 3 (unobservable)</th></tr></thead>
            <tbody className="tnum"><tr><td className="py-1.5">{money(nav.level_breakdown.level_1, cur)}</td><td className="py-1.5">{money(nav.level_breakdown.level_2, cur)}</td><td className="py-1.5">{money(nav.level_breakdown.level_3, cur)}</td></tr></tbody>
          </table>
        </div>
      )}

      {/* Positions */}
      <div className="rounded-lg border border-paper-200 bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink-700">Positions</h3>
          <Button variant="secondary" onClick={() => setShowPos((s) => !s)}>{showPos ? 'Cancel' : 'Add position'}</Button>
        </div>
        {showPos && (
          <form onSubmit={addPosition} className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
            <Field label="Company"><TextInput value={posForm.company_name} onChange={(e) => setPosForm({ ...posForm, company_name: e.target.value })} required /></Field>
            <Field label="Security">
              <Select value={posForm.security_type} onChange={(e) => setPosForm({ ...posForm, security_type: e.target.value })}>
                {['common', 'preferred', 'safe', 'note', 'warrant', 'other'].map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </Field>
            <Field
              label="Default mark method"
              tooltip="Sets the ASC 820 fair-value level: Market = Level 1 (quoted price), Last round = Level 2 (observable), Calibrated OPM and Cost = Level 3 (model / unobservable). Level 3 marks get the most auditor scrutiny."
            >
              <Select value={posForm.mark_method} onChange={(e) => setPosForm({ ...posForm, mark_method: e.target.value })}>
                <option value="cost">Cost</option>
                <option value="market">Market (L1)</option>
                <option value="last_round">Last round (L2)</option>
                <option value="calibrated_opm">Calibrated OPM (L3)</option>
              </Select>
            </Field>
            <Field label="Quantity"><TextInput value={posForm.quantity} onChange={(e) => setPosForm({ ...posForm, quantity: e.target.value })} /></Field>
            <Field label="Cost basis"><TextInput value={posForm.cost_basis} onChange={(e) => setPosForm({ ...posForm, cost_basis: e.target.value })} /></Field>
            <div className="flex items-end"><Button type="submit">Add</Button></div>
          </form>
        )}
        {positions.length === 0 ? (
          <p className="text-sm text-ink-400">No positions. Add a holding to mark it to fair value.</p>
        ) : (
          <div className="space-y-2">
            {positions.map((p) => (
              <PositionRow key={p.id} fundId={fundId} position={p} currency={cur} onChange={load} />
            ))}
          </div>
        )}
      </div>

      <WaterfallCard fundId={fundId} lpTerms={detail.lp_terms} currency={cur} onSaved={load} />
    </div>
  );
}

function PositionRow({ fundId, position, currency, onChange }: { fundId: string; position: Position; currency: string; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [marks, setMarks] = useState<Mark[] | null>(null);
  const [markForm, setMarkForm] = useState({ measurement_date: '2026-03-31', method: 'market', quantity: position.quantity, quoted_price: '', round_price_per_share: '', model_value: '' });
  const [error, setError] = useState<string | null>(null);

  const loadMarks = useCallback(async () => {
    const { marks: m } = await api<{ marks: Mark[] }>(`/funds/${fundId}/positions/${position.id}/marks`);
    setMarks(m);
  }, [fundId, position.id]);

  const toggle = () => {
    setOpen((o) => !o);
    if (!marks) void loadMarks();
  };

  const addMark = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const body: Record<string, unknown> = { measurement_date: markForm.measurement_date, method: markForm.method };
      if (markForm.method === 'market') { body.quantity = Number(markForm.quantity); body.quoted_price = Number(markForm.quoted_price); }
      else if (markForm.method === 'last_round') { body.quantity = Number(markForm.quantity); body.round_price_per_share = Number(markForm.round_price_per_share); }
      else if (markForm.method === 'calibrated_opm') { body.model_value = Number(markForm.model_value); }
      await api(`/funds/${fundId}/positions/${position.id}/marks`, { method: 'POST', body });
      await loadMarks();
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record mark');
    }
  };

  const lm = position.latest_mark;
  return (
    <div className="rounded-md border border-paper-200">
      <button onClick={toggle} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-paper-50">
        <span className="font-medium text-ink-700">{position.company_name}<span className="ml-2 text-xs text-ink-400">{position.security_type}</span></span>
        <span className="tnum text-ink-600">{lm ? `${money(Number(lm.fair_value), currency)} · L${lm.level}` : `cost ${money(Number(position.cost_basis), currency)}`}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-paper-200 p-3">
          {error && <ErrorNote>{error}</ErrorNote>}
          <form onSubmit={addMark} className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Field label="Date" tooltip="Measurement date for this mark. For a calibrated OPM, this is the calibration date the model is anchored to — usually the last observable transaction, such as the round the fund invested in."><TextInput value={markForm.measurement_date} onChange={(e) => setMarkForm({ ...markForm, measurement_date: e.target.value })} /></Field>
            <Field label="Method">
              <Select value={markForm.method} onChange={(e) => setMarkForm({ ...markForm, method: e.target.value })}>
                <option value="market">Market (L1)</option>
                <option value="last_round">Last round (L2)</option>
                <option value="calibrated_opm">Calibrated (L3)</option>
                <option value="cost">Cost (L3)</option>
              </Select>
            </Field>
            {markForm.method === 'market' && <Field label="Quoted price"><TextInput value={markForm.quoted_price} onChange={(e) => setMarkForm({ ...markForm, quoted_price: e.target.value })} /></Field>}
            {markForm.method === 'last_round' && <Field label="Round price/sh"><TextInput value={markForm.round_price_per_share} onChange={(e) => setMarkForm({ ...markForm, round_price_per_share: e.target.value })} /></Field>}
            {markForm.method === 'calibrated_opm' && <Field label="Model value"><TextInput value={markForm.model_value} onChange={(e) => setMarkForm({ ...markForm, model_value: e.target.value })} /></Field>}
            <div className="flex items-end"><Button type="submit" variant="secondary">Record mark</Button></div>
          </form>
          <div>
            <h5 className="overline mb-1 text-ink-400">Mark history</h5>
            {!marks ? <Spinner /> : marks.length === 0 ? <p className="text-xs text-ink-400">No marks yet.</p> : (
              <table className="w-full text-xs">
                <thead><tr className="border-b border-paper-200 text-left text-ink-500"><th className="py-1">Date</th><th className="py-1">Method</th><th className="py-1">Level</th><th className="py-1">Fair value</th></tr></thead>
                <tbody className="tnum">{marks.map((m) => <tr key={m.id} className="border-b border-paper-100 last:border-0"><td className="py-1">{m.measurement_date}</td><td className="py-1">{m.method}</td><td className="py-1">L{m.level}</td><td className="py-1">{money(Number(m.fair_value), currency)}</td></tr>)}</tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function WaterfallCard({ fundId, lpTerms, currency, onSaved }: { fundId: string; lpTerms: LpTerms | null; currency: string; onSaved: () => void }) {
  const [terms, setTerms] = useState({
    committed_capital: lpTerms?.committed_capital ?? '0',
    contributed_capital: lpTerms?.contributed_capital ?? '0',
    preferred_return_rate: lpTerms?.preferred_return_rate ?? '0.08',
    carry_pct: lpTerms?.carry_pct ?? '0.2',
    gp_catch_up: lpTerms?.gp_catch_up ?? true,
  });
  const [distributable, setDistributable] = useState('0');
  const [years, setYears] = useState('1');
  const [result, setResult] = useState<Waterfall | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    try {
      await api(`/funds/${fundId}/lp-terms`, {
        method: 'PUT',
        body: {
          committed_capital: Number(terms.committed_capital),
          contributed_capital: Number(terms.contributed_capital),
          preferred_return_rate: Number(terms.preferred_return_rate),
          carry_pct: Number(terms.carry_pct),
          gp_catch_up: terms.gp_catch_up,
        },
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to save LP terms');
    }
  };

  const run = async () => {
    setError(null);
    try {
      const { waterfall } = await api<{ waterfall: Waterfall }>(`/funds/${fundId}/waterfall`, {
        method: 'POST',
        body: { distributable: Number(distributable), years: Number(years) },
      });
      setResult(waterfall);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to run waterfall');
    }
  };

  return (
    <div className="rounded-lg border border-paper-200 bg-surface p-4">
      <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink-700">
        LP waterfall calculator
        <InfoTooltip
          label="About the LP waterfall"
          text="Distributes proceeds through the standard tiers, in order: return of capital to LPs, the preferred return (hurdle), an optional GP catch-up, then the carry split. Any GP overpayment across the fund’s life shows as a clawback."
        />
      </h3>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Committed"><TextInput value={terms.committed_capital} onChange={(e) => setTerms({ ...terms, committed_capital: e.target.value })} /></Field>
        <Field label="Contributed"><TextInput value={terms.contributed_capital} onChange={(e) => setTerms({ ...terms, contributed_capital: e.target.value })} /></Field>
        <Field label="Pref return" tooltip="The LP hurdle rate (e.g. 0.08 = 8%). LPs earn this preferred return on contributed capital before the GP shares in profits."><TextInput value={terms.preferred_return_rate} onChange={(e) => setTerms({ ...terms, preferred_return_rate: e.target.value })} /></Field>
        <Field label="Carry" tooltip="The GP’s carried-interest percentage — its share of profits above the hurdle (e.g. 0.20 = 20%, the ‘20’ in a 20% carry / 80% LP split)."><TextInput value={terms.carry_pct} onChange={(e) => setTerms({ ...terms, carry_pct: e.target.value })} /></Field>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 text-sm text-ink-600"><input type="checkbox" checked={terms.gp_catch_up} onChange={(e) => setTerms({ ...terms, gp_catch_up: e.target.checked })} /> GP catch-up</label>
        <Button variant="secondary" onClick={() => void save()}>Save LP terms</Button>
        <Field label="Distributable"><TextInput value={distributable} onChange={(e) => setDistributable(e.target.value)} /></Field>
        <Field label="Years"><TextInput value={years} onChange={(e) => setYears(e.target.value)} className="w-16" /></Field>
        <Button onClick={() => void run()}>Run waterfall</Button>
      </div>
      {result && (
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
          <SummaryCard label="To LPs" value={money(result.lp_distribution, currency)} accent />
          <SummaryCard label="To GP (carry)" value={money(result.gp_distribution, currency)} />
          <SummaryCard label="Clawback owed" value={money(result.clawback_owed, currency)} />
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${accent ? 'border-bond-200 bg-bond-50' : 'border-paper-200 bg-surface'}`}>
      <div className="overline text-ink-400">{label}</div>
      <div className={`tnum mt-1 text-lg font-semibold ${accent ? 'text-bond-700' : 'text-ink-800'}`}>{value}</div>
    </div>
  );
}
