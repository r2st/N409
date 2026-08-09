/**
 * Deterministic QA reasonableness checks (IMPROVEMENTS_RESEARCH §4.3) run
 * against a completed calculation before the valuation can publish. Pure —
 * no I/O — so every rule is unit-testable. Thresholds follow the market
 * benchmarks cited in the research doc (e.g. DLOM above 35% draws auditor
 * scrutiny); a 'fail' blocks publishing, a 'warn' surfaces for the analyst.
 */

import { modelDlomMethodsIn, selectsModelDlom } from './dlom.js';

export type QaStatus = 'pass' | 'warn' | 'fail';

export interface QaCheck {
  key: string;
  label: string;
  status: QaStatus;
  detail: string;
}

export interface QaChecksResult {
  status: QaStatus;
  checks: QaCheck[];
}

/** Subset of a calculation row the checks need. */
export interface QaCalculation {
  /** Stored engine payload: { params, inputs }. */
  inputs: Record<string, unknown>;
  /**
   * The engine's own result document. Optional only so a caller checking a run
   * that produced none still type-checks; when it is there it is authoritative
   * for the discounts — see {@link appliedDiscount}.
   */
  results?: Record<string, unknown> | null;
  equity_value: string | number | null;
  fmv_per_share: string | number | null;
  created_at: Date | string;
}

/**
 * The discount the engine actually applied, not the one the analyst typed.
 *
 * `params.dlom` is an *input*, and for two of the four DLOM methods the engine
 * ignores it outright: `compute._resolve_discounts` derives the discount from
 * volatility and time to exit under `chaffee` / `finnerty` and reports what it
 * used in `results.discounts.dlom`. Reading the param therefore graded the
 * wrong number on the one check that is a publish gate:
 *
 *   - with `dlom` left null (the normal shape for a model DLOM) the check did
 *     not run at all, so a Chaffee discount of any size published unexamined —
 *     and a model DLOM clears the 35% benchmark easily: 65% volatility over a
 *     four-year horizon puts Chaffee near 45%;
 *   - with a stale `dlom` still sitting on the row from before the method was
 *     switched, it graded that instead — the gate passing on a figure the
 *     deliverable does not contain, while the report's own summary page prints
 *     `results.discounts.dlom` beside it.
 *
 * The engine's pre-flight has the same hole by design (`validate._check_discounts`
 * sets `dlom = None` for the model methods, because at validation time there is
 * nothing to check yet). Post-run there is, and this is the only place that
 * looks at a completed run — so this is where the applied figure gets read.
 */
export function appliedDiscount(
  calculation: QaCalculation,
  key: 'dlom' | 'dloc',
): { value: number; fromResults: boolean } | null {
  const discounts = obj(obj(calculation.results ?? {}).discounts);
  const applied = num(discounts[key]);
  if (applied !== null) return { value: applied, fromResults: true };
  const param = num(obj(obj(calculation.inputs).params)[key]);
  return param === null ? null : { value: param, fromResults: false };
}

const SEVERITY: Record<QaStatus, number> = { pass: 0, warn: 1, fail: 2 };

export function worstStatus(statuses: QaStatus[]): QaStatus {
  return statuses.reduce<QaStatus>((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst), 'pass');
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

export function runQaChecks(args: {
  calculation: QaCalculation;
  /** Current valuation_params row — used for staleness; null when absent. */
  params?: { updated_at: Date | string } | null;
}): QaChecksResult {
  const checks: QaCheck[] = [];
  const add = (key: string, label: string, status: QaStatus, detail: string) =>
    checks.push({ key, label, status, detail });

  // The engine payload the calculation actually ran with.
  const payload = obj(args.calculation.inputs);
  const engineParams = obj(payload.params);
  const engineInputs = obj(payload.inputs);
  const income = obj(engineInputs.income);

  const equity = num(args.calculation.equity_value);
  const fmv = num(args.calculation.fmv_per_share);

  // ── Output sanity ───────────────────────────────────────────────────────
  if (equity !== null) {
    add(
      'equity_positive',
      'Equity value is positive',
      equity > 0 ? 'pass' : 'fail',
      equity > 0 ? `Equity value ${equity}` : `Equity value ${equity} is not positive`,
    );
  }
  if (fmv !== null) {
    add(
      'fmv_positive',
      'FMV per share is positive',
      fmv > 0 ? 'pass' : 'fail',
      fmv > 0 ? `FMV/share ${fmv}` : `FMV/share ${fmv} is not positive`,
    );
  }
  if (equity !== null && fmv !== null && equity > 0 && fmv > 0) {
    add(
      'fmv_vs_equity',
      'FMV per share below total equity value',
      fmv <= equity ? 'pass' : 'fail',
      fmv <= equity
        ? 'Per-share value is consistent with total equity value'
        : `FMV/share ${fmv} exceeds the entire equity value ${equity}`,
    );
  }

  // ── Approach weights ────────────────────────────────────────────────────
  const weights = ['weight_asset', 'weight_opm', 'weight_income', 'weight_market']
    .map((k) => num(engineParams[k]))
    .filter((w): w is number => w !== null);
  if (weights.length > 0) {
    const sum = weights.reduce((a, b) => a + b, 0);
    const ok = Math.abs(sum - 1) < 1e-4;
    add(
      'weights_sum',
      'Approach weights sum to 100%',
      ok ? 'pass' : 'fail',
      ok ? 'Weights sum to 100%' : `Weights sum to ${pct(sum)} — must total 100%`,
    );
  }

  // ── Discounts (benchmarks from IMPROVEMENTS_RESEARCH §4.3) ──────────────
  //
  // Read off the run, not off the params — see `appliedDiscount`. The detail
  // names the model when one produced the figure, so a reviewer reading a
  // warning can tell "the analyst chose 45%" from "Chaffee produced 45% at the
  // volatility and horizon this run used", which are different conversations.
  const dlomMethod = engineParams.dlom_method;
  // Every volatility-derived method, not the two that were spelled inline here
  // — and a weighted blend counts, because the point of the parenthetical is to
  // tell "the analyst chose 45%" from "the models produced 45% at this run's
  // volatility and horizon", which is exactly as true of a blend.
  const modelDlom = selectsModelDlom(engineParams);
  const modelNames = modelDlomMethodsIn(engineParams).join(' / ');
  const dlomSource = appliedDiscount(args.calculation, 'dlom');
  if (dlomSource !== null) {
    const dlom = dlomSource.value;
    const via = dlomSource.fromResults && modelDlom ? ` (${modelNames} model)` : '';
    const status: QaStatus = dlom < 0 || dlom > 0.6 ? 'fail' : dlom > 0.35 ? 'warn' : 'pass';
    add(
      'dlom_range',
      'DLOM within market norms',
      status,
      status === 'pass'
        ? `DLOM ${pct(dlom)}${via} is within the typical 0–35% band`
        : status === 'warn'
          ? `DLOM ${pct(dlom)}${via} exceeds the 35% benchmark auditors scrutinize`
          : `DLOM ${pct(dlom)}${via} is outside any defensible range`,
    );
  }
  const dlocSource = appliedDiscount(args.calculation, 'dloc');
  if (dlocSource !== null) {
    const dloc = dlocSource.value;
    const status: QaStatus = dloc < 0 || dloc > 0.5 ? 'fail' : dloc > 0.4 ? 'warn' : 'pass';
    add(
      'dloc_range',
      'DLOC within market norms',
      status,
      status === 'pass'
        ? `DLOC ${pct(dloc)} is within the typical band`
        : `DLOC ${pct(dloc)} is unusually high`,
    );
  }

  // ── Model inputs ────────────────────────────────────────────────────────
  const volatility = num(engineInputs.volatility);
  if (volatility !== null) {
    const status: QaStatus =
      volatility <= 0 ? 'fail' : volatility < 0.1 || volatility > 1.5 ? 'warn' : 'pass';
    add(
      'volatility_range',
      'Volatility within observed range',
      status,
      status === 'pass'
        ? `Volatility ${pct(volatility)} is within the observed 10–150% range`
        : `Volatility ${pct(volatility)} is an outlier — document the basis`,
    );
  }
  const discountRate = num(income.discount_rate);
  const terminalGrowth = num(income.terminal_growth);
  if (discountRate !== null && terminalGrowth !== null) {
    add(
      'discount_vs_growth',
      'Discount rate exceeds terminal growth',
      discountRate > terminalGrowth ? 'pass' : 'fail',
      discountRate > terminalGrowth
        ? `Discount ${pct(discountRate)} > terminal growth ${pct(terminalGrowth)}`
        : `Discount ${pct(discountRate)} must exceed terminal growth ${pct(terminalGrowth)} — the income approach diverges otherwise`,
    );
  }
  if (discountRate !== null) {
    const status: QaStatus = discountRate < 0.08 || discountRate > 0.6 ? 'warn' : 'pass';
    add(
      'discount_rate_range',
      'Discount rate within venture norms',
      status,
      status === 'pass'
        ? `Discount rate ${pct(discountRate)} is within the typical 8–60% venture band`
        : `Discount rate ${pct(discountRate)} is outside the typical 8–60% venture band`,
    );
  }

  // ── Cross-input consistency ─────────────────────────────────────────────
  const lastRoundPrice = num(engineInputs.last_round_price_per_share);
  if (lastRoundPrice !== null && fmv !== null && lastRoundPrice > 0) {
    add(
      'fmv_vs_last_round',
      'Common FMV below last preferred round price',
      fmv < lastRoundPrice ? 'pass' : 'warn',
      fmv < lastRoundPrice
        ? `FMV/share ${fmv} sits below the last round price ${lastRoundPrice}`
        : `Common FMV/share ${fmv} at or above the preferred round price ${lastRoundPrice} is unusual — document why`,
    );
  }

  // ── Staleness ───────────────────────────────────────────────────────────
  if (args.params?.updated_at) {
    const calcAt = new Date(args.calculation.created_at).getTime();
    const paramsAt = new Date(args.params.updated_at).getTime();
    if (Number.isFinite(calcAt) && Number.isFinite(paramsAt)) {
      add(
        'params_freshness',
        'Calculation reflects current parameters',
        paramsAt <= calcAt ? 'pass' : 'warn',
        paramsAt <= calcAt
          ? 'No parameter changes since this calculation'
          : 'Parameters changed after this calculation — recalculate before delivery',
      );
    }
  }

  return { status: worstStatus(checks.map((c) => c.status)), checks };
}
