import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { weightsProblem, type ValuationParams } from '../../lib/pipeline';
import { Button, ErrorNote, Field, InfoTooltip, Select, Spinner, TextInput } from '../ui';
import { HelpIcon } from '../HelpIcon';
import {
  CONTROL_PREMIUM_STUDIES,
  DEFAULT_CONTROL_PREMIUM_SET,
  DEFAULT_PRE_IPO_SET,
  DEFAULT_RESTRICTED_STOCK_SET,
  PRE_IPO_STUDIES,
  RESTRICTED_STOCK_STUDIES,
  StudySelector,
  emptySelection,
  indicativeNote,
  preIpoNote,
  rule144Note,
  selectionFromParams,
  studyTableProblem,
  tableForApi,
  type StudySelection,
} from './StudySelector';

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

/**
 * The DLOM models the engine implements (engine/dlom.py). The form used to
 * offer three of the seven: an analyst who wanted Ghaidarov, Longstaff, or
 * either study family had no way to ask for it from the product, only through
 * the API. The option-pricing three are grouped apart from the empirical two
 * because the question a reviewer asks first is which family the discount came
 * from, not which formula within it.
 */
const DLOM_METHOD_OPTIONS = [
  { value: 'chaffee', label: 'Chaffee (protective put)' },
  { value: 'finnerty', label: 'Finnerty (average-strike put)' },
  { value: 'ghaidarov', label: 'Ghaidarov (average-strike, corrected)' },
  { value: 'longstaff', label: 'Longstaff (lookback — upper bound)' },
  { value: 'restricted_stock', label: 'Restricted-stock studies' },
  { value: 'pre_ipo', label: 'Pre-IPO studies' },
  { value: 'qualitative', label: 'Qualitative' },
] as const;

/**
 * How the DLOC was derived (engine/dloc.py). An empty value keeps the historic
 * behaviour — `dloc` applied as a figure the analyst states outright — which is
 * what every engagement written before migration 0132 carries.
 */
const DLOC_METHOD_OPTIONS = [
  { value: '', label: 'Stated figure' },
  { value: 'control_premium', label: 'Inverted from a control premium' },
  { value: 'studies', label: 'Control-premium studies' },
  { value: 'qualitative', label: 'Qualitative (analyst judgement)' },
] as const;

interface FormState {
  rolling_forward: boolean;
  inception_date: string;
  fiscal_year_end: string;
  weight_asset: string;
  weight_opm: string;
  weight_income: string;
  weight_market: string;
  dloc: string;
  dloc_method: string;
  control_premium: string;
  dloc_synergy_share: string;
  dloc_statistic: string;
  dlom_method: string;
  dlom_qualitative: string;
  dlom_statistic: string;
  revenue_status: string;
  development_stage: string;
  exit_timeline: string;
  last_round_date: string;
  last_year_revenue: string;
  ytd_revenue: string;
  runway_months: string;
  market_method: string;
  market_horizon: string;
  asset_method: string;
  allocation_method: string;
  business_overview: string;
}

/** One leg of a weighted DLOM blend (`dlom_methods`). */
interface DlomLeg {
  method: string;
  weight: string;
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

/**
 * Money crosses the wire in cents (`last_year_revenue_cents`) and is typed in
 * whole currency units. Kept as a string in form state rather than a number so
 * a half-typed "12." survives a keystroke, and rounded on the way out because
 * the column is an integer.
 */
const centsToUnits = (v: string | number | null | undefined): string => {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(n / 100) : '';
};

const unitsToCents = (v: string): number | null => {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

function fromParams(p: ValuationParams): FormState {
  return {
    rolling_forward: p.rolling_forward === true,
    inception_date: p.inception_date?.slice(0, 10) ?? '',
    fiscal_year_end: p.fiscal_year_end?.slice(0, 10) ?? '',
    weight_asset: str(p.weight_asset),
    weight_opm: str(p.weight_opm),
    weight_income: str(p.weight_income),
    weight_market: str(p.weight_market),
    dloc: str(p.dloc),
    dloc_method: p.dloc_method ?? '',
    control_premium: str(p.control_premium ?? null),
    dloc_synergy_share: str(p.dloc_synergy_share ?? null),
    dloc_statistic: p.dloc_statistic ?? '',
    dlom_method: p.dlom_method ?? '',
    dlom_qualitative: str(p.dlom_qualitative),
    dlom_statistic: p.dlom_statistic ?? '',
    revenue_status: p.revenue_status ?? '',
    development_stage: str(p.development_stage),
    exit_timeline: p.exit_timeline?.slice(0, 10) ?? '',
    last_round_date: p.last_round_date?.slice(0, 10) ?? '',
    last_year_revenue: centsToUnits(p.last_year_revenue_cents),
    ytd_revenue: centsToUnits(p.ytd_revenue_cents),
    runway_months: str(p.runway_months),
    market_method: p.market_method ?? '',
    market_horizon: p.market_horizon ?? '',
    asset_method: p.asset_method ?? '',
    allocation_method: p.allocation_method ?? 'opm',
    business_overview: p.business_overview ?? '',
  };
}

/** The blend legs as the API carries them, or `[]` when a single method is set. */
function legsFromParams(p: ValuationParams): DlomLeg[] {
  const raw = p.dlom_methods;
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => ({ method: String(m.method), weight: str(m.weight) }));
}

type WeightKey = 'weight_asset' | 'weight_opm' | 'weight_income' | 'weight_market';

const WEIGHTS: Array<{ key: WeightKey; label: string }> = [
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
  const [dlomLegs, setDlomLegs] = useState<DlomLeg[]>([]);
  /*
   * The three study selections. Kept beside the form rather than in it because
   * each is an array pair (`*_studies` + `*_study_table`) rather than a scalar,
   * and because they are saved unconditionally: an analyst who switches away
   * from a study method and back should find the set they chose still chosen,
   * which is the same reason `calculations.ts` forwards them whatever the
   * method is.
   */
  const [rsSelection, setRsSelection] = useState<StudySelection>(emptySelection);
  const [preIpoSelection, setPreIpoSelection] = useState<StudySelection>(emptySelection);
  const [dlocSelection, setDlocSelection] = useState<StudySelection>(emptySelection);

  const loadSelections = (p: ValuationParams) => {
    setRsSelection(selectionFromParams(p.dlom_studies, p.dlom_study_table, 'discount'));
    setPreIpoSelection(selectionFromParams(p.dlom_pre_ipo_studies, p.dlom_pre_ipo_table, 'discount'));
    setDlocSelection(selectionFromParams(p.dloc_studies, p.dloc_study_table, 'premium'));
  };

  const load = useCallback(async () => {
    try {
      const { params: p } = await api<{ params: ValuationParams }>(`/valuations/${valuationId}/params`);
      setParams(p);
      setForm(fromParams(p));
      setDlomLegs(legsFromParams(p));
      loadSelections(p);
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

  const blending = dlomLegs.length > 0;
  /*
   * The blend's own checks, mirroring `validateDlomMethods` on the service so
   * the analyst is told at the field rather than by a 422. Weights are never
   * normalised here for the reason the service gives: legs summing to 0.9 are a
   * mistake in someone's spreadsheet, and scaling them up would conclude on a
   * discount nobody chose.
   */
  const blendTotal = dlomLegs.reduce((sum, leg) => sum + (Number(leg.weight) || 0), 0);
  const blendMethods = dlomLegs.map((leg) => leg.method);
  const blendDuplicate = blendMethods.find((m, i) => m !== '' && blendMethods.indexOf(m) !== i) ?? null;
  const blendIssue: string | null = !blending
    ? null
    : dlomLegs.length < 2
      ? 'A blend needs at least two methods — remove the leg to conclude on one method instead.'
      : blendMethods.some((m) => m === '')
        ? 'Every leg needs a method.'
        : blendDuplicate !== null
          ? `${DLOM_METHOD_OPTIONS.find((o) => o.value === blendDuplicate)?.label ?? blendDuplicate} is weighted twice.`
          : Math.abs(blendTotal - 1) > 1e-4
            ? 'Blend weights must sum to 1.0000.'
            : null;

  // A qualitative leg needs its figure whether it is the single method or one
  // weight among several — the service refuses both the same way.
  const qualitativeSelected = blending
    ? blendMethods.includes('qualitative')
    : form.dlom_method === 'qualitative';
  const qualitativeMissing = qualitativeSelected && form.dlom_qualitative.trim() === '';
  // `dlom_statistic` is read by both study families, so the field is offered
  // whenever either is in play — concluded on, or weighted as a leg.
  const dlomMethods = blending ? blendMethods : [form.dlom_method];
  const studySelected = dlomMethods.some((m) => m === 'restricted_stock' || m === 'pre_ipo');
  // Each family's set is offered only when that family is in play. The two
  // tables share no study names, so showing both pickers at once would invite
  // a selection the engine refuses as unknown.
  const restrictedStockSelected = dlomMethods.includes('restricted_stock');
  const preIpoSelected = dlomMethods.includes('pre_ipo');
  // `dloc` itself stays optional — an engagement that concludes no control
  // discount is a normal outcome — but a method that cannot run without its
  // input is not, so those are caught here rather than by the engine.
  const controlPremiumMissing = form.dloc_method === 'control_premium' && form.control_premium.trim() === '';
  const dlocQualitativeMissing = form.dloc_method === 'qualitative' && form.dloc.trim() === '';
  // The column is a non-negative bigint of cents. A number input's spinner
  // cannot reach a negative here, but a paste can, and the 422 it earns says
  // "last_year_revenue_cents" rather than which box to look in.
  const revenueIssue = [form.last_year_revenue, form.ytd_revenue].some(
    (v) => v.trim() !== '' && Number(v) < 0,
  )
    ? 'Revenue cannot be negative.'
    : null;

  const set = (key: keyof FormState) => (value: string | boolean) => {
    setSaved(false);
    setForm((f) => (f ? { ...f, [key]: value } : f));
  };

  const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));

  // A malformed custom study table is refused at the field. Checked for all
  // three families whether or not the section is on screen, because the tables
  // are saved unconditionally — an invalid one hidden behind a method switch
  // would still be in the request.
  const studyTableIssue =
    studyTableProblem(rsSelection.table, 'discount') ??
    studyTableProblem(preIpoSelection.table, 'discount') ??
    studyTableProblem(dlocSelection.table, 'premium');

  const saveBlocked = Boolean(
    weightsIssue ||
    qualitativeMissing ||
    blendIssue ||
    controlPremiumMissing ||
    dlocQualitativeMissing ||
    studyTableIssue ||
    revenueIssue,
  );

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (saveBlocked) return;
    setError(null);
    setBusy(true);
    try {
      const body = {
        rolling_forward: form.rolling_forward,
        inception_date: form.inception_date || null,
        fiscal_year_end: form.fiscal_year_end || null,
        weight_asset: numOrNull(form.weight_asset),
        weight_opm: numOrNull(form.weight_opm),
        weight_income: numOrNull(form.weight_income),
        weight_market: numOrNull(form.weight_market),
        dloc: numOrNull(form.dloc),
        dloc_method: form.dloc_method || null,
        control_premium: numOrNull(form.control_premium),
        dloc_synergy_share: numOrNull(form.dloc_synergy_share),
        dloc_statistic: form.dloc_statistic || null,
        /*
         * The three study selections, sent whatever the method is — the engine
         * ignores the ones its method does not read, and clearing them on a
         * method switch would throw away a set the analyst chose. An empty
         * selection is the column's NULL, which is what asks for the engine's
         * default set; an empty table is NULL, which asks for its built-ins.
         */
        dloc_studies: dlocSelection.studies.length > 0 ? dlocSelection.studies : null,
        dloc_study_table: tableForApi(dlocSelection.table, 'premium', false),
        /*
         * The two DLOM forms are mutually exclusive (the table's
         * `valuation_params_one_dlom_form` CHECK), so whichever is not in use
         * is sent as an explicit null rather than omitted. Omitting it would
         * leave the other one on the row and the save would be refused —
         * switching from a blend back to a single method has to clear the blend
         * in the same request that sets the method.
         */
        dlom_method: blending ? null : form.dlom_method || null,
        dlom_methods: blending
          ? dlomLegs.map((leg) => ({ method: leg.method, weight: Number(leg.weight) }))
          : null,
        dlom_qualitative: numOrNull(form.dlom_qualitative),
        dlom_studies: rsSelection.studies.length > 0 ? rsSelection.studies : null,
        dlom_statistic: form.dlom_statistic || null,
        dlom_study_table: tableForApi(rsSelection.table, 'discount', true),
        dlom_pre_ipo_studies: preIpoSelection.studies.length > 0 ? preIpoSelection.studies : null,
        dlom_pre_ipo_table: tableForApi(preIpoSelection.table, 'discount', true),
        revenue_status: form.revenue_status || null,
        development_stage: numOrNull(form.development_stage),
        exit_timeline: form.exit_timeline || null,
        last_round_date: form.last_round_date || null,
        last_year_revenue_cents: unitsToCents(form.last_year_revenue),
        ytd_revenue_cents: unitsToCents(form.ytd_revenue),
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
      setDlomLegs(legsFromParams(updated));
      loadSelections(updated);
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

      {/* ── Engagement basics (409.ai §7.1/§7.7). Every field here is a column
          the API has always accepted and no screen ever offered: an analyst
          could not record that a valuation was a roll-forward, when the company
          was incorporated, or what it earned last year, except through the
          intake form or the API. */}
      <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <h3 className="overline mb-5 text-ink-400">Engagement basics</h3>
        <div className="grid gap-5 sm:grid-cols-3">
          <Field
            label="Inception date"
            hint="Incorporation, for the age of the enterprise."
            tooltip="When the company was formed. Used to describe the stage of the enterprise and to sanity-check the financial history."
          >
            <TextInput
              type="date"
              disabled={readOnly}
              value={form.inception_date}
              onChange={(e) => set('inception_date')(e.target.value)}
            />
          </Field>
          <Field label="Fiscal year end" hint="Anchors the historical and projected periods.">
            <TextInput
              type="date"
              disabled={readOnly}
              value={form.fiscal_year_end}
              onChange={(e) => set('fiscal_year_end')(e.target.value)}
            />
          </Field>
          <Field
            label="Expected exit"
            hint="Drives time-to-liquidity in OPM & DLOM."
            tooltip="The date a liquidity event is expected. It sets the term on the option-pricing allocation and on the put that prices the marketability discount."
          >
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
          <div className="flex items-center">
            <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink-800">
              <input
                type="checkbox"
                disabled={readOnly}
                checked={form.rolling_forward}
                onChange={(e) => set('rolling_forward')(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-bond-600"
                data-testid="rolling-forward"
              />
              <span>
                <span className="font-semibold">Rolling forward</span>
                <span className="mt-0.5 block text-xs text-ink-400">
                  A refresh of an earlier engagement for the same company, rather than a first opinion.
                </span>
              </span>
            </label>
          </div>
        </div>
      </section>

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
        {weightsIssue && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <p className="text-sm font-medium text-red-600">{weightsIssue}</p>
            {/*
             * Offered only while the weights are wrong, and only when there is
             * something to scale — the save is already blocked, and sliders in
             * increments of 0.05 land off 1.0000 constantly. It rescales what
             * the analyst chose rather than inventing a split, which is why it
             * is a button here and emphatically not something the service does
             * on its own (see `validateWeights`).
             */}
            {!readOnly && weightTotal > 0 && (
              <Button
                type="button"
                variant="secondary"
                data-testid="normalise-weights"
                onClick={() => {
                  setSaved(false);
                  setForm((f) => {
                    if (!f) return f;
                    const total = WEIGHTS.reduce((sum, w) => sum + (Number(f[w.key]) || 0), 0);
                    if (total <= 0) return f;
                    const scaled = { ...f };
                    // The last weight absorbs the rounding, so the four always
                    // sum to exactly 1.0000 at four decimal places.
                    let used = 0;
                    WEIGHTS.forEach(({ key }, i) => {
                      if (i === WEIGHTS.length - 1) {
                        scaled[key] = (Math.round((1 - used) * 1e4) / 1e4).toString();
                        return;
                      }
                      const w = Math.round(((Number(f[key]) || 0) / total) * 1e4) / 1e4;
                      used += w;
                      scaled[key] = w.toString();
                    });
                    return scaled;
                  });
                }}
              >
                Scale to 1.0000
              </Button>
            )}
          </div>
        )}
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

        {/* ── DLOC ──────────────────────────────────────────────────────────
            The method drives which inputs matter, so only those are shown: a
            control premium box is noise on an engagement that states its
            discount outright, and worse than noise when it holds a stale figure
            the engine is not reading. */}
        <h4 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink-800">
          Lack of control (DLOC)
          <InfoTooltip text="Minority holders cannot direct the company, so their shares may be worth less than a controlling stake. The method says how that discount was arrived at — the report names it either way." />
        </h4>
        <div className="grid gap-5 sm:grid-cols-3">
          <Field label="Derivation" hint="Named in the report as the basis for the discount.">
            <Select
              disabled={readOnly}
              value={form.dloc_method}
              onChange={(e) => set('dloc_method')(e.target.value)}
              data-testid="dloc-method"
            >
              {DLOC_METHOD_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>

          {/* 'studies' concludes the discount itself; the other three read the
              `dloc` box, either as the answer or as the analyst's judgement. */}
          {form.dloc_method !== 'studies' && (
            <Field
              label="DLOC (fraction)"
              hint="0–1."
              error={dlocQualitativeMissing ? 'Required for the qualitative method.' : null}
            >
              <TextInput
                type="number"
                min={0}
                max={1}
                step={0.01}
                disabled={readOnly || form.dloc_method === 'control_premium'}
                value={form.dloc}
                onChange={(e) => set('dloc')(e.target.value)}
                data-testid="dloc"
              />
            </Field>
          )}

          {form.dloc_method === 'control_premium' && (
            <>
              <Field
                label="Control premium (fraction)"
                hint="Inverted, not subtracted: 0.25 → a 20% discount."
                error={controlPremiumMissing ? 'Required for this derivation.' : null}
                tooltip="A premium and a discount are the same fact from opposite sides, and the conversion is not symmetric: DLOC = 1 − 1/(1+CP). The engine computes the discount, so the DLOC box is read-only here."
              >
                <TextInput
                  type="number"
                  min={0}
                  max={10}
                  step={0.01}
                  disabled={readOnly}
                  value={form.control_premium}
                  onChange={(e) => set('control_premium')(e.target.value)}
                  data-testid="control-premium"
                />
              </Field>
              <Field
                label="Synergy share (fraction)"
                hint="Removed before inverting. Blank keeps the whole premium."
                tooltip="The share of an observed acquisition premium attributable to synergies rather than to control. Buyers pay for both; only the control half is evidence for a DLOC."
              >
                <TextInput
                  type="number"
                  min={0}
                  max={0.99}
                  step={0.01}
                  disabled={readOnly}
                  value={form.dloc_synergy_share}
                  onChange={(e) => set('dloc_synergy_share')(e.target.value)}
                />
              </Field>
            </>
          )}

          {form.dloc_method === 'studies' && (
            <Field
              label="Study statistic"
              hint="Blank uses the engine's default."
              tooltip="Which figure to take from each published control-premium study. The studies themselves come from the engine's table."
            >
              <Select
                disabled={readOnly}
                value={form.dloc_statistic}
                onChange={(e) => set('dloc_statistic')(e.target.value)}
                data-testid="dloc-statistic"
              >
                <option value="">Engine default</option>
                <option value="median">Median</option>
                <option value="mean">Mean</option>
              </Select>
            </Field>
          )}
        </div>

        {form.dloc_method === 'studies' && (
          <StudySelector
            testId="dloc-studies"
            label="Control-premium studies"
            tooltip="An acquisition premium is the spread paid for a whole public company over the pre-announcement trading price of the same stock — the market's own measurement of control against marketable minority. The selected rows are blended on the premium scale and inverted once, at the end."
            builtIn={CONTROL_PREMIUM_STUDIES}
            defaultSet={DEFAULT_CONTROL_PREMIUM_SET}
            valueKey="premium"
            note={indicativeNote}
            value={dlocSelection}
            onChange={(next) => {
              setSaved(false);
              setDlocSelection(next);
            }}
            readOnly={readOnly}
          />
        )}

        {/* ── DLOM ────────────────────────────────────────────────────────── */}
        <h4 className="mt-8 mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink-800">
          Lack of marketability (DLOM)
          <InfoTooltip text="Private stock cannot be sold freely. The option-pricing models price that as a put over the holding period; the study families read it off observed discounts. A blend weights several." />
        </h4>

        {/*
         * One method or a weighted blend, never both — the table's
         * `valuation_params_one_dlom_form` CHECK. Presenting that as a pair of
         * radios rather than an eighth "blended" entry in the method list keeps
         * the exclusivity visible, and is why switching back to a single method
         * clears the legs rather than leaving them where a later save would be
         * refused for carrying two answers.
         */}
        <div className="mb-4 flex flex-wrap gap-x-6 gap-y-2" role="radiogroup" aria-label="DLOM form">
          {[
            { blend: false, label: 'Conclude on one method' },
            { blend: true, label: 'Weight several methods' },
          ].map((o) => (
            <label
              key={String(o.blend)}
              className="flex cursor-pointer items-center gap-2 text-sm text-ink-800"
            >
              <input
                type="radio"
                name="dlom-form"
                disabled={readOnly}
                checked={blending === o.blend}
                onChange={() => {
                  setSaved(false);
                  if (o.blend) {
                    // Seed the blend from the concluded method, so choosing to
                    // weight does not throw away the choice already made.
                    const seed = form.dlom_method === '' ? 'chaffee' : form.dlom_method;
                    const second = seed === 'finnerty' ? 'chaffee' : 'finnerty';
                    setDlomLegs([
                      { method: seed, weight: '0.5' },
                      { method: second, weight: '0.5' },
                    ]);
                    set('dlom_method')('');
                  } else {
                    setDlomLegs([]);
                  }
                }}
                className="h-4 w-4 accent-bond-600"
                data-testid={o.blend ? 'dlom-form-blend' : 'dlom-form-single'}
              />
              {o.label}
            </label>
          ))}
        </div>

        <div className="grid gap-5 sm:grid-cols-3">
          {!blending && (
            <Field label="DLOM method" hint="All but Qualitative are computed by the engine.">
              <Select
                disabled={readOnly}
                value={form.dlom_method}
                onChange={(e) => set('dlom_method')(e.target.value)}
                data-testid="dlom-method"
              >
                <option value="">Not set</option>
                {DLOM_METHOD_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {/* A qualitative leg needs its figure whether it is the conclusion or
              one weight among several — the service refuses both the same way. */}
          {qualitativeSelected && (
            <Field
              label="Qualitative DLOM (fraction)"
              hint="0–1."
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
                data-testid="dlom-qualitative"
              />
            </Field>
          )}

          {/* Shared by both study families, so it is offered whenever either is
              in play — as the conclusion or as a leg of the blend. */}
          {studySelected && (
            <Field
              label="Study statistic"
              hint="Blank uses the engine's default."
              tooltip="Which figure to take from each published study. Shared by the restricted-stock and pre-IPO tables, so a blend weighting both reads them the same way."
            >
              <Select
                disabled={readOnly}
                value={form.dlom_statistic}
                onChange={(e) => set('dlom_statistic')(e.target.value)}
                data-testid="dlom-statistic"
              >
                <option value="">Engine default</option>
                <option value="median">Median</option>
                <option value="mean">Mean</option>
              </Select>
            </Field>
          )}
        </div>

        {blending && (
          <div className="mt-5" data-testid="dlom-blend">
            <ol className="space-y-3">
              {dlomLegs.map((leg, i) => (
                <li key={i} className="flex flex-wrap items-end gap-3">
                  <div className="min-w-[16rem] flex-1">
                    <Field label={`Method ${i + 1}`}>
                      <Select
                        disabled={readOnly}
                        value={leg.method}
                        onChange={(e) => {
                          setSaved(false);
                          const method = e.target.value;
                          setDlomLegs((legs) => legs.map((l, j) => (j === i ? { ...l, method } : l)));
                        }}
                      >
                        <option value="">Select a method</option>
                        {DLOM_METHOD_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <div className="w-32">
                    <Field label="Weight">
                      <TextInput
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        disabled={readOnly}
                        value={leg.weight}
                        onChange={(e) => {
                          setSaved(false);
                          const weight = e.target.value;
                          setDlomLegs((legs) => legs.map((l, j) => (j === i ? { ...l, weight } : l)));
                        }}
                      />
                    </Field>
                  </div>
                  {!readOnly && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="mb-1"
                      onClick={() => {
                        setSaved(false);
                        setDlomLegs((legs) => legs.filter((_, j) => j !== i));
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ol>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span className="tnum text-sm text-ink-600">
                Total <span className="font-semibold text-ink-900">{blendTotal.toFixed(4)}</span>
              </span>
              {!readOnly && dlomLegs.length < DLOM_METHOD_OPTIONS.length && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setSaved(false);
                    setDlomLegs((legs) => [...legs, { method: '', weight: '' }]);
                  }}
                  data-testid="add-dlom-leg"
                >
                  Add method
                </Button>
              )}
            </div>
            {blendIssue && <p className="mt-2 text-sm font-medium text-red-600">{blendIssue}</p>}
          </div>
        )}

        {/* One picker per family, shown when that family is concluded on or
            weighted as a leg. A blend across both shows both. */}
        {restrictedStockSelected && (
          <StudySelector
            testId="dlom-studies"
            label="Restricted-stock studies"
            tooltip="Observed discounts on private placements of stock that is restricted from resale — as close as the market gets to pricing marketability on its own. The default set is the studies that observed only post-1997-amendment placements."
            builtIn={RESTRICTED_STOCK_STUDIES}
            defaultSet={DEFAULT_RESTRICTED_STOCK_SET}
            valueKey="discount"
            withStatistic
            note={rule144Note}
            value={rsSelection}
            onChange={(next) => {
              setSaved(false);
              setRsSelection(next);
            }}
            readOnly={readOnly}
          />
        )}

        {preIpoSelected && (
          <StudySelector
            testId="dlom-pre-ipo-studies"
            label="Pre-IPO studies"
            tooltip="Discounts of private transactions in a company's own stock to the price of the IPO that followed. A different measurement from the restricted-stock family, not a second sample of it: the figures run roughly twice as large, and part of what they measure is the change in the company's prospects."
            builtIn={PRE_IPO_STUDIES}
            defaultSet={DEFAULT_PRE_IPO_SET}
            valueKey="discount"
            withStatistic
            note={preIpoNote}
            value={preIpoSelection}
            onChange={(next) => {
              setSaved(false);
              setPreIpoSelection(next);
            }}
            readOnly={readOnly}
          />
        )}
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
          {/* The dates and the runway moved up to Engagement basics, where they
              sit with the rest of the engagement's own facts. */}
          <Field
            label="Last full year revenue"
            hint="Whole currency units."
            error={revenueIssue}
            tooltip="Revenue for the last completed fiscal year. Feeds the revenue multiple in the market approach and the stage-of-development conclusion."
          >
            <TextInput
              type="number"
              min={0}
              step={1000}
              disabled={readOnly}
              value={form.last_year_revenue}
              onChange={(e) => set('last_year_revenue')(e.target.value)}
              data-testid="last-year-revenue"
            />
          </Field>
          <Field label="Revenue year to date" hint="Whole currency units.">
            <TextInput
              type="number"
              min={0}
              step={1000}
              disabled={readOnly}
              value={form.ytd_revenue}
              onChange={(e) => set('ytd_revenue')(e.target.value)}
              data-testid="ytd-revenue"
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
            className="mt-1 w-full rounded-md border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-bond-600 focus:ring-2 focus:ring-bond-600/20 focus:outline-none"
          />
        </Field>
      </section>

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy || saveBlocked}>
            {busy ? 'Saving…' : 'Save methodology'}
          </Button>
          {/* The blocking field can be several sections up a long form, and a
              disabled button with no reason beside it reads as a broken one.
              The field keeps its own inline error; this only says which. */}
          {saveBlocked && (
            <p className="text-sm text-ink-600" data-testid="save-blocked">
              {weightsIssue
                ? 'Approach weights need fixing before this can be saved.'
                : blendIssue
                  ? 'The DLOM blend needs fixing before this can be saved.'
                  : revenueIssue
                    ? 'Revenue needs fixing before this can be saved.'
                    : 'A discount is missing an input it cannot be computed without.'}
            </p>
          )}
        </div>
      )}
    </form>
  );
}
