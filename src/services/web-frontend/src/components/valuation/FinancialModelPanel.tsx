import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import type { EngineInputs, ShareClassInput } from '../../lib/pipeline';
import { Button, ErrorNote, Field, Select, Spinner, TextInput } from '../ui';

/**
 * Financial model editor — hand-enter the full engine input document so an
 * analyst can perform a valuation without waiting on AI document extraction.
 * The field set mirrors the compute engine (engine-wrapper compute.py +
 * waterfall.py); saving PATCHes /valuations/:id/engine-inputs, after which the
 * Calculations tab runs the four approaches over exactly these inputs.
 */

interface ProjRow {
  revenue: string;
  fcf: string;
}

interface ClassRow {
  name: string;
  kind: 'common' | 'preferred' | 'option';
  shares: string;
  preference: string;
  seniority: string;
  participating: boolean;
  conversion_ratio: string;
  strike: string;
}

interface FormState {
  shares_outstanding_common: string;
  shares_outstanding_preferred: string;
  options_outstanding: string;
  liquidation_preference: string;
  volatility: string;
  risk_free_rate: string;
  time_to_exit_years: string;
  valuation_date: string;
  cash: string;
  debt: string;
  last_round_post_money: string;
  last_round_price_per_share: string;
  last_round_class: string;
  total_assets: string;
  total_liabilities: string;
  cost_to_replicate: string;
  discount_rate: string;
  terminal_growth: string;
  market_metric: string;
  projections: ProjRow[];
  multiples: string[];
  share_classes: ClassRow[];
}

const str = (v: number | string | null | undefined) => (v === null || v === undefined ? '' : String(v));
const emptyClass = (kind: ClassRow['kind'] = 'common'): ClassRow => ({
  name: '',
  kind,
  shares: '',
  preference: '',
  seniority: '1',
  participating: false,
  conversion_ratio: '1',
  strike: '',
});

function fromInputs(ei: EngineInputs): FormState {
  const fcf = ei.income?.free_cash_flows ?? [];
  const rev = ei.income?.revenues ?? [];
  const years = Math.max(fcf.length, rev.length);
  const projections: ProjRow[] = [];
  for (let i = 0; i < years; i += 1) {
    projections.push({ revenue: str(rev[i]), fcf: str(fcf[i]) });
  }
  return {
    shares_outstanding_common: str(ei.shares_outstanding_common),
    shares_outstanding_preferred: str(ei.shares_outstanding_preferred),
    options_outstanding: str(ei.options_outstanding),
    liquidation_preference: str(ei.liquidation_preference),
    volatility: str(ei.volatility),
    risk_free_rate: str(ei.risk_free_rate),
    time_to_exit_years: str(ei.time_to_exit_years),
    valuation_date: ei.valuation_date?.slice(0, 10) ?? '',
    cash: str(ei.cash),
    debt: str(ei.debt),
    last_round_post_money: str(ei.last_round_post_money),
    last_round_price_per_share: str(ei.last_round_price_per_share),
    last_round_class: ei.last_round_class ?? '',
    total_assets: str(ei.asset?.total_assets),
    total_liabilities: str(ei.asset?.total_liabilities),
    cost_to_replicate: str(ei.asset?.cost_to_replicate),
    discount_rate: str(ei.income?.discount_rate),
    terminal_growth: str(ei.income?.terminal_growth),
    market_metric: str(ei.market?.metric),
    projections: projections.length > 0 ? projections : [{ revenue: '', fcf: '' }],
    multiples: (ei.market?.multiples ?? []).map((m) => str(m)),
    share_classes: (ei.share_classes ?? []).map((c) => ({
      ...emptyClass(c.kind),
      name: c.name,
      shares: str(c.shares),
      preference: str(c.preference),
      seniority: str(c.seniority ?? 1),
      participating: Boolean(c.participating),
      conversion_ratio: str(c.conversion_ratio ?? 1),
      strike: str(c.strike),
    })),
  };
}

const numOrNull = (v: string): number | null => {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const numList = (vals: string[]): number[] =>
  vals.map((v) => Number(v.trim())).filter((n) => Number.isFinite(n));

/** Builds the engine_inputs patch, sending null for wholly-empty sections. */
function toBody(form: FormState): EngineInputs {
  const fcfs = numList(form.projections.map((p) => p.fcf));
  const revenues = numList(form.projections.map((p) => p.revenue));
  const incomeHas =
    fcfs.length > 0 || revenues.length > 0 || form.discount_rate.trim() !== '' || form.terminal_growth.trim() !== '';
  const income = incomeHas
    ? {
        free_cash_flows: fcfs.length > 0 ? fcfs : null,
        revenues: revenues.length > 0 ? revenues : null,
        discount_rate: numOrNull(form.discount_rate),
        terminal_growth: numOrNull(form.terminal_growth),
      }
    : null;

  const multiples = numList(form.multiples);
  const marketHas = form.market_metric.trim() !== '' || multiples.length > 0;
  const market = marketHas
    ? { metric: numOrNull(form.market_metric), multiples: multiples.length > 0 ? multiples : null }
    : null;

  const assetHas =
    form.total_assets.trim() !== '' || form.total_liabilities.trim() !== '' || form.cost_to_replicate.trim() !== '';
  const asset = assetHas
    ? {
        total_assets: numOrNull(form.total_assets),
        total_liabilities: numOrNull(form.total_liabilities),
        cost_to_replicate: numOrNull(form.cost_to_replicate),
      }
    : null;

  const classes: ShareClassInput[] = form.share_classes
    .filter((c) => c.name.trim() !== '' || c.shares.trim() !== '')
    .map((c) => {
      const base = { name: c.name.trim(), kind: c.kind, shares: Number(c.shares) };
      if (c.kind === 'preferred') {
        return {
          ...base,
          preference: numOrNull(c.preference) ?? 0,
          seniority: numOrNull(c.seniority) ?? 1,
          participating: c.participating,
          conversion_ratio: numOrNull(c.conversion_ratio) ?? 1,
        };
      }
      if (c.kind === 'option') return { ...base, strike: numOrNull(c.strike) ?? 0 };
      return base;
    });

  return {
    shares_outstanding_common: numOrNull(form.shares_outstanding_common),
    shares_outstanding_preferred: numOrNull(form.shares_outstanding_preferred),
    options_outstanding: numOrNull(form.options_outstanding),
    liquidation_preference: numOrNull(form.liquidation_preference),
    volatility: numOrNull(form.volatility),
    risk_free_rate: numOrNull(form.risk_free_rate),
    time_to_exit_years: numOrNull(form.time_to_exit_years),
    valuation_date: form.valuation_date || null,
    cash: numOrNull(form.cash),
    debt: numOrNull(form.debt),
    last_round_post_money: numOrNull(form.last_round_post_money),
    last_round_price_per_share: numOrNull(form.last_round_price_per_share),
    last_round_class: form.last_round_class.trim() || null,
    asset,
    income,
    market,
    share_classes: classes.length > 0 ? classes : null,
  };
}

/** Client mirror of the engine's discount-rate > terminal-growth rule. */
function modelProblem(form: FormState): string | null {
  const dr = numOrNull(form.discount_rate);
  const tg = numOrNull(form.terminal_growth);
  if (dr !== null && tg !== null && dr <= tg) {
    return 'DCF discount rate must exceed terminal growth.';
  }
  if (form.share_classes.some((c) => c.name.trim() !== '') && !form.share_classes.some((c) => c.kind === 'common' && c.name.trim() !== '')) {
    return 'The cap table must include at least one common class.';
  }
  return null;
}

const cardClass = 'rounded-lg border border-paper-300 bg-surface p-6 shadow-card';
const headingClass = 'overline mb-5 text-ink-400';

export function FinancialModelPanel({ valuationId, readOnly }: { valuationId: string; readOnly: boolean }) {
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { engine_inputs } = await api<{ engine_inputs: EngineInputs }>(
        `/valuations/${valuationId}/engine-inputs`,
      );
      setForm(fromInputs(engine_inputs ?? {}));
    } catch {
      setError('Could not load the financial model.');
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!form) return error ? <ErrorNote>{error}</ErrorNote> : <Spinner />;

  const problem = modelProblem(form);

  const set = (key: keyof FormState) => (value: string) => {
    setSaved(false);
    setForm((f) => (f ? { ...f, [key]: value } : f));
  };
  const setProjection = (i: number, key: keyof ProjRow, value: string) => {
    setSaved(false);
    setForm((f) =>
      f ? { ...f, projections: f.projections.map((p, j) => (j === i ? { ...p, [key]: value } : p)) } : f,
    );
  };
  const setClass = (i: number, patch: Partial<ClassRow>) => {
    setSaved(false);
    setForm((f) =>
      f ? { ...f, share_classes: f.share_classes.map((c, j) => (j === i ? { ...c, ...patch } : c)) } : f,
    );
  };
  const setMultiple = (i: number, value: string) => {
    setSaved(false);
    setForm((f) => (f ? { ...f, multiples: f.multiples.map((m, j) => (j === i ? value : m)) } : f));
  };
  const update = (patch: Partial<FormState>) => {
    setSaved(false);
    setForm((f) => (f ? { ...f, ...patch } : f));
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    setError(null);
    setBusy(true);
    try {
      await api(`/valuations/${valuationId}/engine-inputs`, { method: 'PATCH', body: toBody(form) });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the financial model.');
    } finally {
      setBusy(false);
    }
  };

  const numField = (
    key: keyof FormState,
    label: string,
    opts: { hint?: string; step?: number; min?: number; max?: number; tooltip?: string } = {},
  ) => (
    <Field label={label} hint={opts.hint} tooltip={opts.tooltip}>
      <TextInput
        type="number"
        step={opts.step ?? 'any'}
        min={opts.min}
        max={opts.max}
        disabled={readOnly}
        aria-label={label}
        value={form[key] as string}
        onChange={(e) => set(key)(e.target.value)}
      />
    </Field>
  );

  return (
    <form onSubmit={save} className="space-y-6">
      <p className="max-w-3xl text-sm text-ink-500">
        Enter the financial model by hand. These inputs feed the compute engine directly — once the model
        is complete and approach weights are set in <span className="font-semibold">Params</span>, run the
        valuation from the <span className="font-semibold">Calculations</span> tab.
      </p>
      {error && <ErrorNote>{error}</ErrorNote>}
      {problem && <ErrorNote>{problem}</ErrorNote>}
      {saved && (
        <div
          role="status"
          className="rounded-md border border-bond-200 bg-bond-50 px-3.5 py-2.5 text-sm text-bond-700"
        >
          Financial model saved.
        </div>
      )}

      {/* Cap table & allocation */}
      <section className={cardClass}>
        <h3 className={headingClass}>Cap table &amp; OPM allocation</h3>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {numField('shares_outstanding_common', 'Common shares', { hint: 'Fully diluted common.' })}
          {numField('shares_outstanding_preferred', 'Preferred shares')}
          {numField('options_outstanding', 'Options outstanding')}
          {numField('liquidation_preference', 'Liquidation preference', { hint: 'Aggregate, in currency.' })}
        </div>

        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-[0.8rem] font-semibold text-ink-700">
              Share classes <span className="font-normal text-ink-400">(optional — enables the multi-breakpoint waterfall)</span>
            </h4>
            {!readOnly && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => update({ share_classes: [...form.share_classes, emptyClass('common')] })}
                  className="cursor-pointer text-xs font-semibold text-bond-600 hover:text-bond-700"
                >
                  + Add class
                </button>
              </div>
            )}
          </div>
          {form.share_classes.length === 0 && (
            <p className="text-xs text-ink-400">
              None. With no classes the engine uses the aggregate single-breakpoint allocation above.
            </p>
          )}
          <div className="space-y-3">
            {form.share_classes.map((c, i) => (
              <div
                key={i}
                data-testid="share-class-row"
                className="grid items-end gap-3 rounded-md border border-paper-200 bg-paper-50 p-3 sm:grid-cols-2 lg:grid-cols-6"
              >
                <Field label="Name">
                  <TextInput
                    disabled={readOnly}
                    value={c.name}
                    aria-label={`Share class ${i + 1} name`}
                    onChange={(e) => setClass(i, { name: e.target.value })}
                  />
                </Field>
                <Field label="Kind">
                  <Select
                    disabled={readOnly}
                    value={c.kind}
                    aria-label={`Share class ${i + 1} kind`}
                    onChange={(e) => setClass(i, { kind: e.target.value as ClassRow['kind'] })}
                  >
                    <option value="common">Common</option>
                    <option value="preferred">Preferred</option>
                    <option value="option">Option pool</option>
                  </Select>
                </Field>
                <Field label="Shares">
                  <TextInput
                    type="number"
                    step="any"
                    min={0}
                    disabled={readOnly}
                    value={c.shares}
                    aria-label={`Share class ${i + 1} shares`}
                    onChange={(e) => setClass(i, { shares: e.target.value })}
                  />
                </Field>
                {c.kind === 'preferred' && (
                  <>
                    <Field label="Preference">
                      <TextInput
                        type="number"
                        step="any"
                        min={0}
                        disabled={readOnly}
                        value={c.preference}
                        aria-label={`Share class ${i + 1} preference`}
                        onChange={(e) => setClass(i, { preference: e.target.value })}
                      />
                    </Field>
                    <Field label="Seniority">
                      <TextInput
                        type="number"
                        step={1}
                        min={1}
                        disabled={readOnly}
                        value={c.seniority}
                        aria-label={`Share class ${i + 1} seniority`}
                        onChange={(e) => setClass(i, { seniority: e.target.value })}
                      />
                    </Field>
                    <Field label="Conv. ratio">
                      <TextInput
                        type="number"
                        step="any"
                        min={0}
                        disabled={readOnly}
                        value={c.conversion_ratio}
                        aria-label={`Share class ${i + 1} conversion ratio`}
                        onChange={(e) => setClass(i, { conversion_ratio: e.target.value })}
                      />
                    </Field>
                    <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-700">
                      <input
                        type="checkbox"
                        disabled={readOnly}
                        checked={c.participating}
                        onChange={(e) => setClass(i, { participating: e.target.checked })}
                        className="accent-bond-600"
                      />
                      Participating
                    </label>
                  </>
                )}
                {c.kind === 'option' && (
                  <Field label="Strike">
                    <TextInput
                      type="number"
                      step="any"
                      min={0}
                      disabled={readOnly}
                      value={c.strike}
                      aria-label={`Share class ${i + 1} strike`}
                      onChange={(e) => setClass(i, { strike: e.target.value })}
                    />
                  </Field>
                )}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() =>
                      update({ share_classes: form.share_classes.filter((_, j) => j !== i) })
                    }
                    className="cursor-pointer justify-self-start text-xs font-semibold text-red-600 hover:text-red-700"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Assumptions */}
      <section className={cardClass}>
        <h3 className={headingClass}>Valuation assumptions</h3>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {numField('volatility', 'Volatility', {
            hint: 'Decimal, e.g. 0.60 for 60%.',
            step: 0.01,
            tooltip:
              'Annualized standard deviation of equity value, usually taken from comparable public companies. A core OPM input — higher volatility raises the common-stock value.',
          })}
          {numField('risk_free_rate', 'Risk-free rate', {
            hint: 'Decimal, e.g. 0.043.',
            step: 0.001,
            tooltip:
              'The return on a risk-free asset (Treasury yield) matched to the time to exit. Used by the Black-Scholes OPM allocation.',
          })}
          {numField('time_to_exit_years', 'Time to exit (years)', { hint: 'Overrides the params exit date.', step: 0.25 })}
          <Field label="Valuation date" hint="Used with the exit date if no explicit term.">
            <TextInput
              type="date"
              disabled={readOnly}
              aria-label="Valuation date"
              value={form.valuation_date}
              onChange={(e) => set('valuation_date')(e.target.value)}
            />
          </Field>
          {numField('cash', 'Cash', { hint: 'Bridges enterprise → equity.' })}
          {numField('debt', 'Debt')}
        </div>
      </section>

      {/* Income / DCF */}
      <section className={cardClass}>
        <h3 className={headingClass}>Income approach — DCF</h3>
        <div className="grid gap-5 sm:grid-cols-2">
          {numField('discount_rate', 'Discount rate (WACC)', { hint: 'Decimal, must exceed terminal growth.', step: 0.01 })}
          {numField('terminal_growth', 'Terminal growth', { hint: 'Decimal, e.g. 0.02.', step: 0.01 })}
        </div>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm" aria-label="DCF projections">
            <thead>
              <tr className="border-b border-paper-300 text-left">
                <th className="overline px-2 py-2 font-semibold text-ink-400">Year</th>
                <th className="overline px-2 py-2 font-semibold text-ink-400">Revenue</th>
                <th className="overline px-2 py-2 font-semibold text-ink-400">Free cash flow</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {form.projections.map((p, i) => (
                <tr key={i} data-testid="projection-row" className="border-b border-paper-200 last:border-0">
                  <td className="tnum px-2 py-2 text-ink-500">{i + 1}</td>
                  <td className="px-2 py-2">
                    <TextInput
                      type="number"
                      step="any"
                      disabled={readOnly}
                      value={p.revenue}
                      aria-label={`Year ${i + 1} revenue`}
                      onChange={(e) => setProjection(i, 'revenue', e.target.value)}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <TextInput
                      type="number"
                      step="any"
                      disabled={readOnly}
                      value={p.fcf}
                      aria-label={`Year ${i + 1} free cash flow`}
                      onChange={(e) => setProjection(i, 'fcf', e.target.value)}
                    />
                  </td>
                  <td className="px-2 py-2">
                    {!readOnly && form.projections.length > 1 && (
                      <button
                        type="button"
                        onClick={() => update({ projections: form.projections.filter((_, j) => j !== i) })}
                        className="cursor-pointer text-xs font-semibold text-red-600 hover:text-red-700"
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!readOnly && (
            <button
              type="button"
              onClick={() => update({ projections: [...form.projections, { revenue: '', fcf: '' }] })}
              className="mt-3 cursor-pointer text-xs font-semibold text-bond-600 hover:text-bond-700"
            >
              + Add year
            </button>
          )}
        </div>
      </section>

      {/* Market */}
      <section className={cardClass}>
        <h3 className={headingClass}>Market approach — comparables</h3>
        <div className="grid gap-5 sm:grid-cols-2">
          {numField('market_metric', 'Metric', { hint: 'The company metric the multiple applies to (e.g. revenue or EBITDA).' })}
          <div>
            <span className="mb-1.5 block text-[0.8rem] font-semibold text-ink-700">
              Comparable multiples
            </span>
            <div className="space-y-2">
              {form.multiples.map((m, i) => (
                <div key={i} className="flex items-center gap-2">
                  <TextInput
                    type="number"
                    step="any"
                    min={0}
                    disabled={readOnly}
                    value={m}
                    aria-label={`Multiple ${i + 1}`}
                    onChange={(e) => setMultiple(i, e.target.value)}
                  />
                  {!readOnly && (
                    <button
                      type="button"
                      aria-label={`Remove multiple ${i + 1}`}
                      onClick={() => update({ multiples: form.multiples.filter((_, j) => j !== i) })}
                      className="cursor-pointer text-xs font-semibold text-red-600 hover:text-red-700"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => update({ multiples: [...form.multiples, ''] })}
                  className="cursor-pointer text-xs font-semibold text-bond-600 hover:text-bond-700"
                >
                  + Add multiple
                </button>
              )}
            </div>
            <span className="mt-1 block text-xs text-ink-400">One positive multiple per comparable.</span>
          </div>
        </div>
      </section>

      {/* Asset */}
      <section className={cardClass}>
        <h3 className={headingClass}>Asset approach</h3>
        <div className="grid gap-5 sm:grid-cols-3">
          {numField('total_assets', 'Total assets', { hint: 'For net-asset-value.' })}
          {numField('total_liabilities', 'Total liabilities')}
          {numField('cost_to_replicate', 'Cost to replicate', { hint: 'For the cost-to-replicate method.' })}
        </div>
      </section>

      {/* OPM backsolve — last round */}
      <section className={cardClass}>
        <h3 className={headingClass}>OPM backsolve — last priced round</h3>
        <div className="grid gap-5 sm:grid-cols-3">
          {numField('last_round_post_money', 'Post-money valuation')}
          {numField('last_round_price_per_share', 'Price per share', { hint: 'Enables the Newton-Raphson backsolve.' })}
          <Field label="Last round class" hint="Which share class was priced (waterfall backsolve).">
            <TextInput
              disabled={readOnly}
              aria-label="Last round class"
              value={form.last_round_class}
              onChange={(e) => set('last_round_class')(e.target.value)}
            />
          </Field>
        </div>
      </section>

      {!readOnly && (
        <Button type="submit" disabled={busy || Boolean(problem)}>
          {busy ? 'Saving…' : 'Save financial model'}
        </Button>
      )}
    </form>
  );
}
