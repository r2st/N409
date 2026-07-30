import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { formatMoney, formatNumber } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { isOps } from '../../lib/rbac';
import { useWorkspace } from './ValuationWorkspace';
import { Button, EmptyState, ErrorNote, Field, InfoTooltip, Select, Spinner, TextInput } from '../../components/ui';
import { HelpIcon } from '../../components/HelpIcon';

/**
 * ASC 718 stock-based-compensation workspace (feature: ASC 718 Public).
 *
 * Private companies measure options off the concluded 409A FMV. Toggling to
 * Public switches the underlying to the issuer's own market price (auto-fetched
 * from a ticker, with its own historical volatility) and unlocks the award
 * types public issuers grant — ESPPs with a lookback discount, RSUs (service /
 * performance / market condition) and relative-TSR awards.
 */

type CompanyType = 'private' | 'public';
type TermMethod = 'simplified' | 'lattice' | 'historical';

interface Settings {
  valuation_id: string;
  company_type: CompanyType;
  ticker: string | null;
  expected_term_method: TermMethod;
  espp_discount_pct: string | null;
  espp_lookback_months: number | null;
}

interface Market {
  ticker: string;
  underlying: number | null;
  volatility: number | null;
  source: string;
  as_of: string | null;
  warning?: string;
}

interface Asc718Response {
  asc718: {
    company_type: CompanyType;
    ticker: string | null;
    market: Market | null;
    options: {
      totalCompensationCost: number;
      grants: Array<{ label: string | null; fairValuePerOption: number; totalCompensationCost: number; expectedToVestOptions: number }>;
      expenseByYear: Array<{ year: number; expense: number; cumulative: number }>;
    } | null;
    espp: Array<{ label: string | null; shares_enrolled: number; fair_value_per_share: number; total_fair_value: number; components: { purchaseDiscount: number; callComponent: number; putComponent: number } }>;
    rsu: Array<{ label: string | null; condition: string; units: number; fairValuePerUnit?: number; expectedPayoutRatio?: number; probabilityMet?: number; totalFairValue?: number }>;
    tsr: Array<{ label: string | null; target_units: number; fairValuePerUnit: number; expectedPayoutRatio: number; expectedPercentile: number; totalFairValue: number }>;
    valuation_fmv_per_share: number | null;
    currency: string;
  };
}

const numOrU = (s: string): number | undefined => {
  const n = Number(s);
  return s.trim() === '' || !Number.isFinite(n) ? undefined : n;
};

const emptyOption = { label: '', options_granted: '100000', grant_date: '2026-01-01', vesting_months: '48', exercise_price: '', expected_term_years: '6', volatility: '', risk_free_rate: '0.04' };
const emptyEspp = { label: '', shares_enrolled: '50000', grant_date_price: '', discount_pct: '0.15', lookback_months: '12', risk_free_rate: '0.03' };
const emptyRsu = { label: '', condition: 'service' as 'service' | 'performance' | 'market', units: '1000', market_price: '', vesting_years: '3', expected_attainment: '1', attainment_volatility: '0.25', hurdle_price: '', risk_free_rate: '0.03' };

export function Asc718Tab() {
  const { valuation } = useWorkspace();
  const { user } = useAuth();
  const ops = isOps(user);
  const id = valuation.id;

  const [settings, setSettings] = useState<Settings | null>(null);
  const [companyType, setCompanyType] = useState<CompanyType>('private');
  const [ticker, setTicker] = useState('');
  const [termMethod, setTermMethod] = useState<TermMethod>('simplified');
  const [defaultUnderlying, setDefaultUnderlying] = useState('');
  const [defaultVol, setDefaultVol] = useState('');

  const [options, setOptions] = useState([{ ...emptyOption }]);
  const [espps, setEspps] = useState<(typeof emptyEspp)[]>([]);
  const [rsus, setRsus] = useState<(typeof emptyRsu)[]>([]);

  const [result, setResult] = useState<Asc718Response['asc718'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { settings: s } = await api<{ settings: Settings | null }>(`/valuations/${id}/asc718/settings`);
      if (s) {
        setSettings(s);
        setCompanyType(s.company_type);
        setTicker(s.ticker ?? '');
        setTermMethod(s.expected_term_method);
      }
    } catch {
      /* settings are optional */
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (ops) void load();
    else setLoading(false);
  }, [load, ops]);

  const saveSettings = useCallback(async () => {
    setError(null);
    try {
      const { settings: s } = await api<{ settings: Settings }>(`/valuations/${id}/asc718/settings`, {
        method: 'PUT',
        body: {
          company_type: companyType,
          ticker: companyType === 'public' ? ticker.trim().toUpperCase() || null : null,
          expected_term_method: termMethod,
        },
      });
      setSettings(s);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to save settings');
    }
  }, [id, companyType, ticker, termMethod]);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        company_type: companyType,
        ...(companyType === 'public' && ticker.trim() ? { ticker: ticker.trim().toUpperCase() } : {}),
        ...(numOrU(defaultUnderlying) !== undefined ? { default_grant_date_fair_value: numOrU(defaultUnderlying) } : {}),
        ...(numOrU(defaultVol) !== undefined ? { default_volatility: numOrU(defaultVol) } : {}),
        grants: options
          .filter((o) => numOrU(o.exercise_price) !== undefined)
          .map((o) => ({
            label: o.label || undefined,
            options_granted: numOrU(o.options_granted),
            grant_date: o.grant_date,
            vesting_months: numOrU(o.vesting_months),
            exercise_price: numOrU(o.exercise_price),
            expected_term_years: numOrU(o.expected_term_years),
            volatility: numOrU(o.volatility),
            risk_free_rate: numOrU(o.risk_free_rate),
            expected_term_method: termMethod,
          })),
        espp: espps.map((e) => ({
          label: e.label || undefined,
          shares_enrolled: numOrU(e.shares_enrolled),
          grant_date_price: numOrU(e.grant_date_price),
          discount_pct: numOrU(e.discount_pct),
          lookback_months: numOrU(e.lookback_months),
          risk_free_rate: numOrU(e.risk_free_rate),
        })),
        rsu: rsus.map((r) => ({
          label: r.label || undefined,
          condition: r.condition,
          units: numOrU(r.units),
          market_price: numOrU(r.market_price),
          vesting_years: numOrU(r.vesting_years),
          ...(r.condition === 'performance' ? { expected_attainment: numOrU(r.expected_attainment), attainment_volatility: numOrU(r.attainment_volatility) } : {}),
          ...(r.condition === 'market' ? { hurdle_price: numOrU(r.hurdle_price), risk_free_rate: numOrU(r.risk_free_rate) } : {}),
        })),
      };
      const res = await api<Asc718Response>(`/valuations/${id}/asc718`, { method: 'POST', body: payload });
      setResult(res.asc718);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'ASC 718 computation failed');
    } finally {
      setRunning(false);
    }
  }, [id, companyType, ticker, defaultUnderlying, defaultVol, options, espps, rsus, termMethod]);

  if (!ops) return <EmptyState title="Operations only">ASC 718 measurement is restricted to the valuation team.</EmptyState>;
  if (loading) return <Spinner />;

  const currency = result?.currency ?? valuation.currency ?? 'USD';

  return (
    <div className="space-y-6">
      <header>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-ink-800">
          ASC 718 — stock-based compensation
          <HelpIcon article="asc718-public-overview" label="Help: ASC 718 for public companies" />
        </h2>
        <p className="mt-1 text-sm text-ink-500">
          Measure grant-date fair value and the expense schedule. Public issuers price off their own market
          data and can add ESPP, RSU and relative-TSR awards.
        </p>
      </header>

      {/* Company type toggle */}
      <div className="rounded-lg border border-paper-200 bg-surface p-4">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Company type">
            <Select value={companyType} onChange={(e) => setCompanyType(e.target.value as CompanyType)}>
              <option value="private">Private (409A FMV underlying)</option>
              <option value="public">Public (market-price underlying)</option>
            </Select>
          </Field>
          {companyType === 'public' && (
            <>
              <Field label="Ticker">
                <TextInput value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="ACME" className="w-28" />
              </Field>
              <Field
                label="Expected-term method"
                tooltip="How the option's expected life is estimated. SAB 107 simplified averages the vesting and contractual terms; the binomial lattice models early exercise when the price reaches an exercise multiple of the strike; historical uses your own exercise data."
              >
                <Select value={termMethod} onChange={(e) => setTermMethod(e.target.value as TermMethod)}>
                  <option value="simplified">SAB 107 simplified</option>
                  <option value="lattice">Lattice (exercise behaviour)</option>
                  <option value="historical">Historical exercise data</option>
                </Select>
              </Field>
            </>
          )}
          <Button variant="secondary" onClick={() => void saveSettings()}>Save settings</Button>
        </div>
        {settings && <p className="mt-2 text-xs text-ink-400">Settings saved. Company type: {settings.company_type}.</p>}
      </div>

      {/* Defaults */}
      <div className="rounded-lg border border-paper-200 bg-surface p-4">
        <h3 className="mb-3 text-sm font-semibold text-ink-700">Default assumptions</h3>
        <div className="flex flex-wrap gap-4">
          <Field label={companyType === 'public' ? 'Underlying (blank → market price)' : 'Underlying (blank → 409A FMV)'}>
            <TextInput value={defaultUnderlying} onChange={(e) => setDefaultUnderlying(e.target.value)} placeholder="e.g. 20" className="w-40" />
          </Field>
          <Field
            label={companyType === 'public' ? 'Volatility (blank → historical)' : 'Volatility'}
            tooltip={
              companyType === 'public'
                ? 'Annualised return volatility used in Black-Scholes. Leave blank to use the historical volatility of the issuer’s own stock, computed from the market feed.'
                : 'Annualised return volatility used in Black-Scholes, typically derived from a comparable-company peer set (e.g. 0.40 = 40%).'
            }
          >
            <TextInput value={defaultVol} onChange={(e) => setDefaultVol(e.target.value)} placeholder="e.g. 0.4" className="w-40" />
          </Field>
        </div>
        {companyType === 'public' && (
          <p className="mt-2 text-xs text-ink-400">
            With a ticker set, the underlying and volatility are fetched from the market feed when left blank.
          </p>
        )}
      </div>

      <OptionSection options={options} setOptions={setOptions} />
      <EsppSection espps={espps} setEspps={setEspps} disabled={companyType !== 'public'} />
      <RsuSection rsus={rsus} setRsus={setRsus} disabled={companyType !== 'public'} />

      {error && <ErrorNote>{error}</ErrorNote>}
      <Button onClick={() => void run()} disabled={running}>{running ? 'Computing…' : 'Run ASC 718'}</Button>

      {result && <Results result={result} currency={currency} />}
    </div>
  );
}

function ArrayHeader({ title, onAdd, addLabel }: { title: string; onAdd?: () => void; addLabel?: string }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h3 className="text-sm font-semibold text-ink-700">{title}</h3>
      {onAdd && <Button variant="secondary" onClick={onAdd}>{addLabel ?? 'Add'}</Button>}
    </div>
  );
}

function OptionSection({ options, setOptions }: { options: (typeof emptyOption)[]; setOptions: (v: (typeof emptyOption)[]) => void }) {
  const upd = (i: number, k: keyof typeof emptyOption, v: string) => setOptions(options.map((o, j) => (j === i ? { ...o, [k]: v } : o)));
  return (
    <div className="rounded-lg border border-paper-200 bg-surface p-4">
      <ArrayHeader title="Option grants" onAdd={() => setOptions([...options, { ...emptyOption }])} addLabel="Add grant" />
      {options.length === 0 && <p className="text-sm text-ink-400">No option grants.</p>}
      <div className="space-y-3">
        {options.map((o, i) => (
          <div key={i} className="grid grid-cols-2 gap-3 border-b border-paper-100 pb-3 last:border-0 md:grid-cols-4">
            <Field label="Label"><TextInput value={o.label} onChange={(e) => upd(i, 'label', e.target.value)} placeholder="2026 pool" /></Field>
            <Field label="Options"><TextInput value={o.options_granted} onChange={(e) => upd(i, 'options_granted', e.target.value)} /></Field>
            <Field label="Grant date"><TextInput value={o.grant_date} onChange={(e) => upd(i, 'grant_date', e.target.value)} /></Field>
            <Field label="Vesting months"><TextInput value={o.vesting_months} onChange={(e) => upd(i, 'vesting_months', e.target.value)} /></Field>
            <Field label="Exercise price"><TextInput value={o.exercise_price} onChange={(e) => upd(i, 'exercise_price', e.target.value)} placeholder="required" /></Field>
            <Field label="Expected term (y)" tooltip="Years the option is expected to stay outstanding before exercise — shorter than the contractual term. Used directly by the simplified method; the lattice derives it from modelled exercise behaviour instead."><TextInput value={o.expected_term_years} onChange={(e) => upd(i, 'expected_term_years', e.target.value)} /></Field>
            <Field label="Volatility"><TextInput value={o.volatility} onChange={(e) => upd(i, 'volatility', e.target.value)} placeholder="blank → default" /></Field>
            <Field label="Risk-free"><TextInput value={o.risk_free_rate} onChange={(e) => upd(i, 'risk_free_rate', e.target.value)} /></Field>
            <div className="col-span-full">
              <button className="text-xs text-red-600 hover:underline" onClick={() => setOptions(options.filter((_, j) => j !== i))}>Remove</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EsppSection({ espps, setEspps, disabled }: { espps: (typeof emptyEspp)[]; setEspps: (v: (typeof emptyEspp)[]) => void; disabled: boolean }) {
  const upd = (i: number, k: keyof typeof emptyEspp, v: string) => setEspps(espps.map((o, j) => (j === i ? { ...o, [k]: v } : o)));
  return (
    <div className="rounded-lg border border-paper-200 bg-surface p-4">
      <ArrayHeader title="ESPP (public)" onAdd={disabled ? undefined : () => setEspps([...espps, { ...emptyEspp }])} addLabel="Add ESPP" />
      {disabled ? (
        <p className="text-sm text-ink-400">ESPP valuation is a public-company award. Switch company type to Public.</p>
      ) : espps.length === 0 ? (
        <p className="text-sm text-ink-400">No ESPP offerings.</p>
      ) : (
        <div className="space-y-3">
          {espps.map((e, i) => (
            <div key={i} className="grid grid-cols-2 gap-3 border-b border-paper-100 pb-3 last:border-0 md:grid-cols-3">
              <Field label="Label"><TextInput value={e.label} onChange={(ev) => upd(i, 'label', ev.target.value)} /></Field>
              <Field label="Shares enrolled"><TextInput value={e.shares_enrolled} onChange={(ev) => upd(i, 'shares_enrolled', ev.target.value)} /></Field>
              <Field label="Grant-date price"><TextInput value={e.grant_date_price} onChange={(ev) => upd(i, 'grant_date_price', ev.target.value)} /></Field>
              <Field label="Discount %"><TextInput value={e.discount_pct} onChange={(ev) => upd(i, 'discount_pct', ev.target.value)} /></Field>
              <Field label="Lookback months" tooltip="Length of the ESPP lookback window. Employees buy at a price based on the lower of the offering-date and purchase-date prices, so a longer lookback embeds a more valuable call option and raises the fair value."><TextInput value={e.lookback_months} onChange={(ev) => upd(i, 'lookback_months', ev.target.value)} /></Field>
              <Field label="Risk-free"><TextInput value={e.risk_free_rate} onChange={(ev) => upd(i, 'risk_free_rate', ev.target.value)} /></Field>
              <div className="col-span-full"><button className="text-xs text-red-600 hover:underline" onClick={() => setEspps(espps.filter((_, j) => j !== i))}>Remove</button></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RsuSection({ rsus, setRsus, disabled }: { rsus: (typeof emptyRsu)[]; setRsus: (v: (typeof emptyRsu)[]) => void; disabled: boolean }) {
  const upd = (i: number, k: keyof typeof emptyRsu, v: string) => setRsus(rsus.map((o, j) => (j === i ? { ...o, [k]: v } : o)));
  return (
    <div className="rounded-lg border border-paper-200 bg-surface p-4">
      <ArrayHeader title="RSUs (public)" onAdd={disabled ? undefined : () => setRsus([...rsus, { ...emptyRsu }])} addLabel="Add RSU" />
      {disabled ? (
        <p className="text-sm text-ink-400">RSU valuation is a public-company award. Switch company type to Public.</p>
      ) : rsus.length === 0 ? (
        <p className="text-sm text-ink-400">No RSU grants.</p>
      ) : (
        <div className="space-y-3">
          {rsus.map((r, i) => (
            <div key={i} className="grid grid-cols-2 gap-3 border-b border-paper-100 pb-3 last:border-0 md:grid-cols-4">
              <Field label="Label"><TextInput value={r.label} onChange={(e) => upd(i, 'label', e.target.value)} /></Field>
              <Field label="Condition">
                <Select value={r.condition} onChange={(e) => upd(i, 'condition', e.target.value)}>
                  <option value="service">Service only</option>
                  <option value="performance">Performance</option>
                  <option value="market">Market</option>
                </Select>
              </Field>
              <Field label="Units"><TextInput value={r.units} onChange={(e) => upd(i, 'units', e.target.value)} /></Field>
              <Field label="Market price"><TextInput value={r.market_price} onChange={(e) => upd(i, 'market_price', e.target.value)} placeholder="blank → default" /></Field>
              {r.condition === 'service' && <Field label="Vesting years"><TextInput value={r.vesting_years} onChange={(e) => upd(i, 'vesting_years', e.target.value)} /></Field>}
              {r.condition === 'performance' && (
                <>
                  <Field label="Expected attainment"><TextInput value={r.expected_attainment} onChange={(e) => upd(i, 'expected_attainment', e.target.value)} /></Field>
                  <Field label="Attainment vol"><TextInput value={r.attainment_volatility} onChange={(e) => upd(i, 'attainment_volatility', e.target.value)} /></Field>
                </>
              )}
              {r.condition === 'market' && (
                <>
                  <Field label="Hurdle price"><TextInput value={r.hurdle_price} onChange={(e) => upd(i, 'hurdle_price', e.target.value)} /></Field>
                  <Field label="Vesting years"><TextInput value={r.vesting_years} onChange={(e) => upd(i, 'vesting_years', e.target.value)} /></Field>
                  <Field label="Risk-free"><TextInput value={r.risk_free_rate} onChange={(e) => upd(i, 'risk_free_rate', e.target.value)} /></Field>
                </>
              )}
              <div className="col-span-full"><button className="text-xs text-red-600 hover:underline" onClick={() => setRsus(rsus.filter((_, j) => j !== i))}>Remove</button></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Results({ result, currency }: { result: Asc718Response['asc718']; currency: string }) {
  return (
    <div className="space-y-5 rounded-lg border border-paper-300 bg-paper-50 p-5">
      <h3 className="text-base font-semibold text-ink-800">Results</h3>
      {result.market && (
        <div className="rounded-md border border-paper-200 bg-surface p-3 text-sm">
          <span className="font-semibold">{result.market.ticker}</span> — underlying{' '}
          {result.market.underlying != null ? formatMoney(result.market.underlying, currency) : '—'}, historical vol{' '}
          {result.market.volatility != null ? `${(result.market.volatility * 100).toFixed(1)}%` : '—'}{' '}
          <span className="text-ink-400">({result.market.source}{result.market.warning ? ` — ${result.market.warning}` : ''})</span>
        </div>
      )}
      {result.options && (
        <div>
          <h4 className="overline mb-2 text-ink-400">Options — total cost {formatMoney(result.options.totalCompensationCost, currency)}</h4>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-paper-300 text-left text-xs text-ink-500 uppercase"><th className="py-1.5 pr-3">Grant</th><th className="py-1.5 pr-3">FV/option</th><th className="py-1.5 pr-3">Expected to vest</th><th className="py-1.5">Total cost</th></tr></thead>
            <tbody className="tnum">
              {result.options.grants.map((g, i) => (
                <tr key={i} className="border-b border-paper-200 last:border-0">
                  <td className="py-1.5 pr-3">{g.label ?? `Grant ${i + 1}`}</td>
                  <td className="py-1.5 pr-3">{formatMoney(g.fairValuePerOption, currency)}</td>
                  <td className="py-1.5 pr-3">{formatNumber(g.expectedToVestOptions)}</td>
                  <td className="py-1.5 font-semibold">{formatMoney(g.totalCompensationCost, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.espp.length > 0 && (
        <div>
          <h4 className="overline mb-2 text-ink-400">ESPP</h4>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-paper-300 text-left text-xs text-ink-500 uppercase"><th className="py-1.5 pr-3">Offering</th><th className="py-1.5 pr-3">FV/share</th><th className="py-1.5 pr-3">Discount</th><th className="py-1.5 pr-3">Call</th><th className="py-1.5 pr-3">Put</th><th className="py-1.5">Total</th></tr></thead>
            <tbody className="tnum">
              {result.espp.map((e, i) => (
                <tr key={i} className="border-b border-paper-200 last:border-0">
                  <td className="py-1.5 pr-3">{e.label ?? `ESPP ${i + 1}`}</td>
                  <td className="py-1.5 pr-3">{formatMoney(e.fair_value_per_share, currency)}</td>
                  <td className="py-1.5 pr-3 text-ink-500">{formatMoney(e.components.purchaseDiscount, currency)}</td>
                  <td className="py-1.5 pr-3 text-ink-500">{formatMoney(e.components.callComponent, currency)}</td>
                  <td className="py-1.5 pr-3 text-ink-500">{formatMoney(e.components.putComponent, currency)}</td>
                  <td className="py-1.5 font-semibold">{formatMoney(e.total_fair_value, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.rsu.length > 0 && (
        <div>
          <h4 className="overline mb-2 text-ink-400">RSUs</h4>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-paper-300 text-left text-xs text-ink-500 uppercase"><th className="py-1.5 pr-3">Award</th><th className="py-1.5 pr-3">Condition</th><th className="py-1.5 pr-3">Units</th><th className="py-1.5 pr-3">FV/unit</th><th className="py-1.5">Total</th></tr></thead>
            <tbody className="tnum">
              {result.rsu.map((r, i) => (
                <tr key={i} className="border-b border-paper-200 last:border-0">
                  <td className="py-1.5 pr-3">{r.label ?? `RSU ${i + 1}`}</td>
                  <td className="py-1.5 pr-3 text-ink-500">{r.condition}{r.expectedPayoutRatio != null ? ` (${(r.expectedPayoutRatio * 100).toFixed(0)}%)` : ''}{r.probabilityMet != null ? ` (P=${(r.probabilityMet * 100).toFixed(0)}%)` : ''}</td>
                  <td className="py-1.5 pr-3">{formatNumber(r.units)}</td>
                  <td className="py-1.5 pr-3">{r.fairValuePerUnit != null ? formatMoney(r.fairValuePerUnit, currency) : '—'}</td>
                  <td className="py-1.5 font-semibold">{r.totalFairValue != null ? formatMoney(r.totalFairValue, currency) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.tsr.length > 0 && (
        <div>
          <h4 className="overline mb-2 flex items-center gap-1.5 text-ink-400">
            Relative TSR
            <InfoTooltip
              label="About relative TSR"
              text="Market-condition awards that pay out on the company’s total-shareholder-return rank against a TSR peer group. Valued by a Monte Carlo simulation of correlated peer price paths; the fair value is fixed at grant and never trued up."
            />
          </h4>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-paper-300 text-left text-xs text-ink-500 uppercase"><th className="py-1.5 pr-3">Award</th><th className="py-1.5 pr-3">Units</th><th className="py-1.5 pr-3">FV/unit</th><th className="py-1.5 pr-3">Exp. %ile</th><th className="py-1.5 pr-3">Payout</th><th className="py-1.5">Total</th></tr></thead>
            <tbody className="tnum">
              {result.tsr.map((t, i) => (
                <tr key={i} className="border-b border-paper-200 last:border-0">
                  <td className="py-1.5 pr-3">{t.label ?? `TSR ${i + 1}`}</td>
                  <td className="py-1.5 pr-3">{formatNumber(t.target_units)}</td>
                  <td className="py-1.5 pr-3">{formatMoney(t.fairValuePerUnit, currency)}</td>
                  <td className="py-1.5 pr-3 text-ink-500">{t.expectedPercentile.toFixed(0)}</td>
                  <td className="py-1.5 pr-3 text-ink-500">{(t.expectedPayoutRatio * 100).toFixed(0)}%</td>
                  <td className="py-1.5 font-semibold">{formatMoney(t.totalFairValue, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
