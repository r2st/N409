import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { weightsProblem, type ValuationParams } from '../../lib/pipeline';
import { Button, ErrorNote, Field, InfoTooltip, Select, Spinner, TextInput } from '../ui';
import { HelpIcon } from '../HelpIcon';

/**
 * The AICPA six-stage scale, in the words the report states it in. Duplicated
 * from the service's `domain/developmentStage.ts` rather than fetched: it is a
 * published scale that does not change, and a select that cannot render until a
 * round trip completes is worse than one that cannot drift.
 */
const DEVELOPMENT_STAGE_OPTIONS = [
  { value: '1', label: 'Stage 1 — Seed' },
  { value: '2', label: 'Stage 2 — Product development' },
  { value: '3', label: 'Stage 3 — Key milestones met' },
  { value: '4', label: 'Stage 4 — Product revenue, operating at a loss' },
  { value: '5', label: 'Stage 5 — Breakeven or positive cash flow' },
  { value: '6', label: 'Stage 6 — Established operating history' },
] as const;

interface FormState {
  weight_asset: string;
  weight_opm: string;
  weight_income: string;
  weight_market: string;
  dloc: string;
  dlom_method: string;
  dlom_qualitative: string;
  revenue_status: string;
  development_stage: string;
  exit_timeline: string;
  last_round_date: string;
  runway_months: string;
  market_method: string;
  market_horizon: string;
  asset_method: string;
  allocation_method: string;
  business_overview: string;
}

/** One editable PWERM exit scenario (values in whole currency units). */
interface ScenarioRow {
  name: string;
  type: string;
  probability: string;
  exit_value: string;
  time_years: string;
  discount_rate: string;
}

const SCENARIO_TYPES = [
  { value: '', label: '—' },
  { value: 'ipo', label: 'IPO' },
  { value: 'acquisition', label: 'Acquisition' },
  { value: 'merger', label: 'Merger' },
  { value: 'continuation', label: 'Continuation' },
  { value: 'stay_private', label: 'Stay private' },
  { value: 'liquidation', label: 'Liquidation' },
  { value: 'dissolution', label: 'Dissolution' },
];

const emptyScenario = (): ScenarioRow => ({
  name: '',
  type: '',
  probability: '',
  exit_value: '',
  time_years: '',
  discount_rate: '',
});

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
    development_stage: str(p.development_stage),
    exit_timeline: p.exit_timeline?.slice(0, 10) ?? '',
    last_round_date: p.last_round_date?.slice(0, 10) ?? '',
    runway_months: str(p.runway_months),
    market_method: p.market_method ?? '',
    market_horizon: p.market_horizon ?? '',
    asset_method: p.asset_method ?? '',
    allocation_method: p.allocation_method ?? 'opm',
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
  const [scenarios, setScenarios] = useState<ScenarioRow[]>([]);
  const [scenariosBusy, setScenariosBusy] = useState(false);
  const [scenariosSaved, setScenariosSaved] = useState(false);
  const [hybridOpmWeight, setHybridOpmWeight] = useState('0.5');
  const [hybridPwermWeight, setHybridPwermWeight] = useState('0.5');

  const load = useCallback(async () => {
    try {
      const { params: p } = await api<{ params: ValuationParams }>(`/valuations/${valuationId}/params`);
      setParams(p);
      setForm(fromParams(p));
      try {
        const { engine_inputs } = await api<{
          engine_inputs: {
            pwerm?: { scenarios?: unknown[] };
            hybrid?: { opm_weight?: number | null; pwerm_weight?: number | null };
          };
        }>(`/valuations/${valuationId}/engine-inputs`);
        const hy = engine_inputs?.hybrid;
        if (hy) {
          if (hy.opm_weight != null) setHybridOpmWeight(String(hy.opm_weight));
          if (hy.pwerm_weight != null) setHybridPwermWeight(String(hy.pwerm_weight));
        }
        const raw = engine_inputs?.pwerm?.scenarios;
        if (Array.isArray(raw) && raw.length > 0) {
          setScenarios(
            raw.map((s) => {
              const r = s as Record<string, unknown>;
              return {
                name: r.name ? String(r.name) : '',
                type: r.type ? String(r.type) : '',
                probability: r.probability != null ? String(r.probability) : '',
                exit_value:
                  r.equity_value != null
                    ? String(r.equity_value)
                    : r.enterprise_value != null
                      ? String(r.enterprise_value)
                      : '',
                time_years: r.time_to_exit_years != null ? String(r.time_to_exit_years) : '',
                discount_rate: r.discount_rate != null ? String(r.discount_rate) : '',
              };
            }),
          );
        }
      } catch {
        /* engine-inputs is ops-only / may 404 for owners — scenarios stay empty */
      }
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
        development_stage: numOrNull(form.development_stage),
        exit_timeline: form.exit_timeline || null,
        last_round_date: form.last_round_date || null,
        runway_months: numOrNull(form.runway_months),
        market_method: form.market_method || null,
        market_horizon: form.market_horizon || null,
        asset_method: form.asset_method || null,
        allocation_method: form.allocation_method || 'opm',
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

  const isPwerm = form.allocation_method === 'pwerm';
  const isHybrid = form.allocation_method === 'hybrid';
  const isCvm = form.allocation_method === 'cvm';
  const isMonteCarlo = form.allocation_method === 'monte_carlo';
  const probabilityTotal = scenarios.reduce((sum, s) => sum + (Number(s.probability) || 0), 0);
  const probabilityOff = scenarios.length > 0 && Math.abs(probabilityTotal - 1) > 1e-4;

  const setScenario = (i: number, key: keyof ScenarioRow) => (value: string) => {
    setScenariosSaved(false);
    setScenarios((rows) => rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  };

  const saveScenarios = async () => {
    setError(null);
    setScenariosBusy(true);
    try {
      const body: Record<string, unknown> = {
        pwerm: {
          scenarios: scenarios.map((s) => ({
            name: s.name.trim() || null,
            type: s.type || null,
            probability: Number(s.probability) || 0,
            equity_value: Number(s.exit_value) || 0,
            time_to_exit_years: Number(s.time_years) || 0,
            discount_rate: s.discount_rate.trim() === '' ? null : Number(s.discount_rate),
          })),
        },
      };
      // Hybrid needs both the discrete scenarios (PWERM leg) and the blend
      // weights, saved together to engine_inputs.
      if (isHybrid) {
        body.hybrid = {
          opm_weight: hybridOpmWeight.trim() === '' ? null : Number(hybridOpmWeight),
          pwerm_weight: hybridPwermWeight.trim() === '' ? null : Number(hybridPwermWeight),
        };
      }
      await api(`/valuations/${valuationId}/engine-inputs`, { method: 'PATCH', body });
      setScenariosSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save PWERM scenarios.');
    } finally {
      setScenariosBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-6">
      {error && <ErrorNote>{error}</ErrorNote>}
      {saved && (
        <div className="rounded-md border border-bond-200 bg-bond-50 px-3.5 py-2.5 text-sm text-bond-700">
          Methodology saved.
        </div>
      )}

      <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <div className="mb-5 flex items-baseline justify-between">
          <h3 className="overline flex items-center gap-1.5 text-ink-400">
            Approach weights
            <InfoTooltip
              label="About approach weights"
              text="How much each valuation approach (asset, OPM, income, market) counts toward the final value. The four weights must sum to 1.0."
            />
          </h3>
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

      <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <h3 className="overline mb-5 flex items-center gap-1.5 text-ink-400">
          Allocation method
          <HelpIcon article="methodology-overview" />
        </h3>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Equity allocation"
            hint="OPM: Black-Scholes call. PWERM: discrete exit scenarios. Hybrid: blend of both. CVM: current-value waterfall. Monte Carlo: simulated, per-scenario horizon and volatility."
          >
            <Select
              disabled={readOnly}
              value={form.allocation_method}
              onChange={(e) => set('allocation_method')(e.target.value)}
              aria-label="Allocation method"
            >
              <option value="opm">Option Pricing Method (OPM)</option>
              <option value="pwerm">Probability-Weighted Expected Return (PWERM)</option>
              <option value="hybrid">Hybrid (OPM + PWERM blend)</option>
              <option value="cvm">Current Value Method (CVM)</option>
              <option value="monte_carlo">Monte Carlo simulation</option>
            </Select>
          </Field>
          {isHybrid && (
            <div className="grid grid-cols-2 gap-4" data-testid="hybrid-weights">
              <Field label="OPM weight" hint="Far-term continuation.">
                <TextInput
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  disabled={readOnly}
                  value={hybridOpmWeight}
                  onChange={(e) => {
                    setScenariosSaved(false);
                    setHybridOpmWeight(e.target.value);
                  }}
                  aria-label="Hybrid OPM weight"
                />
              </Field>
              <Field label="PWERM weight" hint="Near-term discrete exits.">
                <TextInput
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  disabled={readOnly}
                  value={hybridPwermWeight}
                  onChange={(e) => {
                    setScenariosSaved(false);
                    setHybridPwermWeight(e.target.value);
                  }}
                  aria-label="Hybrid PWERM weight"
                />
              </Field>
            </div>
          )}
        </div>
        {isHybrid &&
          Math.abs((Number(hybridOpmWeight) || 0) + (Number(hybridPwermWeight) || 0) - 1) > 1e-4 && (
            <p className="mt-3 text-sm text-red-600" data-testid="hybrid-weight-warning">
              OPM + PWERM weights must sum to 1.00.
            </p>
          )}
        {isCvm && (
          <p className="mt-3 text-sm text-ink-400">
            CVM allocates the current equity value by the deterministic liquidation waterfall — best for very
            early-stage, pre-revenue, or distressed companies.
          </p>
        )}
        {/*
          Said plainly, because the honest answer is "usually don't". Where the
          exit is a single lognormal the OPM prices this payoff exactly, and
          simulating it returns the same number with sampling noise on top — a
          reviewer who sees Monte Carlo on a routine engagement will ask why,
          and the analyst should have an answer better than "it sounded
          thorough".
        */}
        {isMonteCarlo && (
          <p className="mt-3 text-sm text-ink-400" data-testid="monte-carlo-note">
            Monte Carlo simulates the exit distribution and needs the cap table on the Cap Table tab. It is
            worth reaching for when the exit is not one distribution — say a five-year IPO case alongside a
            two-year trade sale, each with its own volatility. With a single exit case the OPM prices the same
            payoff exactly and without simulation noise. The run is seeded, so the concluded value reproduces,
            and the report states the simulation&rsquo;s standard error.
          </p>
        )}
      </section>

      {(isPwerm || isHybrid) && (
        <section
          className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card"
          data-testid="pwerm-scenarios"
        >
          <div className="mb-4 flex items-baseline justify-between">
            <h3 className="overline text-ink-400">
              {isHybrid ? 'Hybrid — near-term exit scenarios (PWERM leg)' : 'PWERM exit scenarios'}
            </h3>
            <span
              className={`tnum text-sm font-semibold ${probabilityOff ? 'text-red-600' : 'text-bond-700'}`}
              data-testid="pwerm-probability-total"
            >
              Σp {probabilityTotal.toFixed(4)}
            </span>
          </div>
          {scenarios.length === 0 ? (
            <p className="text-sm text-ink-400">
              No scenarios yet — add IPO / acquisition / continuation / liquidation outcomes.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-paper-300 text-xs text-ink-400">
                    <th className="py-2 pr-3 text-left font-semibold">Name</th>
                    <th className="py-2 pr-3 text-left font-semibold">Type</th>
                    <th className="py-2 pr-3 text-left font-semibold">Probability</th>
                    <th className="py-2 pr-3 text-left font-semibold">Exit equity ($)</th>
                    <th className="py-2 pr-3 text-left font-semibold">Years</th>
                    <th className="py-2 pr-3 text-left font-semibold">
                      <span className="inline-flex items-center gap-1.5">
                        Disc. rate
                        <InfoTooltip
                          label="About the discount rate"
                          text="The annual required return used to bring this scenario's exit payoff back to present value. Leave blank to use the engagement default."
                        />
                      </span>
                    </th>
                    <th className="py-2 font-semibold" />
                  </tr>
                </thead>
                <tbody>
                  {scenarios.map((s, i) => (
                    <tr key={i} className="border-b border-paper-200 last:border-0">
                      <td className="py-1.5 pr-3">
                        <TextInput
                          disabled={readOnly}
                          value={s.name}
                          onChange={(e) => setScenario(i, 'name')(e.target.value)}
                          aria-label={`Scenario ${i + 1} name`}
                        />
                      </td>
                      <td className="py-1.5 pr-3">
                        <Select
                          disabled={readOnly}
                          value={s.type}
                          onChange={(e) => setScenario(i, 'type')(e.target.value)}
                          aria-label={`Scenario ${i + 1} type`}
                        >
                          {SCENARIO_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="py-1.5 pr-3">
                        <TextInput
                          type="number"
                          min={0}
                          max={1}
                          step={0.01}
                          disabled={readOnly}
                          value={s.probability}
                          onChange={(e) => setScenario(i, 'probability')(e.target.value)}
                          className="w-24"
                          aria-label={`Scenario ${i + 1} probability`}
                        />
                      </td>
                      <td className="py-1.5 pr-3">
                        <TextInput
                          type="number"
                          min={0}
                          step="any"
                          disabled={readOnly}
                          value={s.exit_value}
                          onChange={(e) => setScenario(i, 'exit_value')(e.target.value)}
                          className="w-36"
                          aria-label={`Scenario ${i + 1} exit value`}
                        />
                      </td>
                      <td className="py-1.5 pr-3">
                        <TextInput
                          type="number"
                          min={0}
                          step="any"
                          disabled={readOnly}
                          value={s.time_years}
                          onChange={(e) => setScenario(i, 'time_years')(e.target.value)}
                          className="w-20"
                          aria-label={`Scenario ${i + 1} years`}
                        />
                      </td>
                      <td className="py-1.5 pr-3">
                        <TextInput
                          type="number"
                          step="any"
                          disabled={readOnly}
                          value={s.discount_rate}
                          onChange={(e) => setScenario(i, 'discount_rate')(e.target.value)}
                          className="w-24"
                          placeholder="dflt"
                          aria-label={`Scenario ${i + 1} discount rate`}
                        />
                      </td>
                      <td className="py-1.5">
                        {!readOnly && (
                          <button
                            type="button"
                            onClick={() => setScenarios((rows) => rows.filter((_, j) => j !== i))}
                            className="text-xs font-semibold text-red-600 hover:text-red-700"
                            aria-label={`Remove scenario ${i + 1}`}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {probabilityOff && (
            <p className="mt-3 text-sm font-medium text-red-600">
              Scenario probabilities must sum to 1.0000.
            </p>
          )}
          {scenariosSaved && <p className="mt-3 text-sm font-medium text-bond-700">Scenarios saved.</p>}
          {!readOnly && (
            <div className="mt-4 flex gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setScenariosSaved(false);
                  setScenarios((r) => [...r, emptyScenario()]);
                }}
              >
                Add scenario
              </Button>
              <Button
                type="button"
                onClick={() => void saveScenarios()}
                disabled={scenariosBusy || scenarios.length === 0 || probabilityOff}
              >
                {scenariosBusy ? 'Saving…' : 'Save scenarios'}
              </Button>
            </div>
          )}
        </section>
      )}

      <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <h3 className="overline mb-5 text-ink-400">Discounts</h3>
        <div className="grid gap-5 sm:grid-cols-3">
          <Field
            label="DLOC (fraction)"
            hint="Discount for lack of control, 0–1."
            tooltip="Discount for Lack of Control: minority holders can't direct the company, so their shares may be worth less. Enter a fraction from 0 to 1."
          >
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
          <Field
            label="DLOM method"
            hint="Chaffee/Finnerty are computed by the engine."
            tooltip="Discount for Lack of Marketability: private stock can't be sold freely. Chaffee and Finnerty model it as a protective put; Qualitative takes a fraction you enter."
          >
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
            <Field
              label="Qualitative DLOM (fraction)"
              error={qualitativeMissing ? 'Required for the qualitative method.' : null}
            >
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

      <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
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
          <Field
            label="Stage of development"
            hint="Names the AICPA stage in the report, and prints Appendix III against it."
          >
            <Select
              disabled={readOnly}
              value={form.development_stage}
              onChange={(e) => set('development_stage')(e.target.value)}
              data-testid="development-stage"
            >
              {/* Left unset until an analyst concludes one — the stage is a
                  judgement, and the report says nothing rather than guess. */}
              <option value="">Not set</option>
              {DEVELOPMENT_STAGE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
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
            className="mt-1 w-full rounded-md border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 placeholder:text-ink-300 focus:border-bond-600 focus:ring-2 focus:ring-bond-600/20 focus:outline-none"
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
