/**
 * Valuation health checks — a categorized readiness gate run before a report
 * is finalized. Distinct from domain/qaChecks.ts (which is a flat pass/warn/
 * fail reasonableness sweep): health checks group findings into the five
 * dimensions an auditor works through and grade each with an error / warning /
 * info severity. An `error` blocks finalization; warnings and info are
 * surfaced for the analyst but never block.
 *
 * Pure — no I/O — so every rule is unit-testable. Consumes the stored engine
 * payload (`calculation.inputs = { params, inputs }`), the engine results, the
 * current valuation_params row and the valuation itself.
 */

import { modelDlomMethodsIn, selectsModelDlom } from './dlom.js';
import { headlineCheckNames, specialtyRunKind } from './specialty.js';
import { kindLabel } from './valuationSelector.js';

export type HealthCategory = 'methodology' | 'assumptions' | 'completeness' | 'mathematical' | 'temporal';

/** A passing check is `ok`; findings escalate info < warning < error. */
export type HealthSeverity = 'ok' | 'info' | 'warning' | 'error';

export interface HealthCheck {
  key: string;
  category: HealthCategory;
  label: string;
  severity: HealthSeverity;
  detail: string;
}

export interface HealthReport {
  /** Worst severity across all checks. */
  severity: HealthSeverity;
  /** True when at least one check is an `error` (blocks finalization). */
  blocking: boolean;
  counts: Record<HealthSeverity, number>;
  checks: HealthCheck[];
}

const RANK: Record<HealthSeverity, number> = { ok: 0, info: 1, warning: 2, error: 3 };

export function worstSeverity(severities: HealthSeverity[]): HealthSeverity {
  return severities.reduce<HealthSeverity>((worst, s) => (RANK[s] > RANK[worst] ? s : worst), 'ok');
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/** A date column may arrive as Date or an ISO string; coerce to epoch millis. */
const dateMs = (v: unknown): number | null => {
  if (!v) return null;
  const t = new Date(v instanceof Date ? v : String(v)).getTime();
  return Number.isFinite(t) ? t : null;
};

export interface HealthCalculation {
  /** Stored engine payload: { params, inputs }. */
  inputs: Record<string, unknown>;
  /** Engine results (allocation, fully_diluted_common, …); null when absent. */
  results?: Record<string, unknown> | null;
  equity_value: string | number | null;
  fmv_per_share: string | number | null;
  created_at: Date | string;
}

export interface HealthParams {
  weight_asset?: unknown;
  weight_opm?: unknown;
  weight_income?: unknown;
  weight_market?: unknown;
  dlom?: unknown;
  dloc?: unknown;
  dlom_method?: unknown;
  /** A weighted DLOM blend (migration 0129), when one was configured. */
  dlom_methods?: unknown;
  allocation_method?: unknown;
  fiscal_year_end?: unknown;
  inception_date?: unknown;
  last_round_date?: unknown;
  exit_timeline?: unknown;
  updated_at?: Date | string | null;
}

export function runHealthChecks(args: {
  calculation: HealthCalculation;
  params?: HealthParams | null;
  valuation?: { currency?: string | null } | null;
}): HealthReport {
  const checks: HealthCheck[] = [];
  const add = (
    category: HealthCategory,
    key: string,
    label: string,
    severity: HealthSeverity,
    detail: string,
  ) => checks.push({ category, key, label, severity, detail });

  const payload = obj(args.calculation.inputs);
  const engineParams = obj(payload.params);
  const engineInputs = obj(payload.inputs);
  const results = obj(args.calculation.results);
  const income = obj(engineInputs.income);
  const market = obj(engineInputs.market);
  const params = args.params ?? {};

  /*
   * Which engine wrote this row, and therefore which rules below can grade it.
   *
   * Every check in this file except the three headline ones is a rule about the
   * 409A model — approach weights, an allocation method, a fully diluted common
   * count, a volatility the OPM runs on. A specialty run has none of those
   * fields, and most of the rules already fall away on their own because the
   * field they read is absent. Two did not: `common_shares_present` and
   * `weights_present` are unconditional `error`s, so every specialty run — an
   * IFRS 2 expense, a gift & estate appraisal, a QSBS attestation — came back
   * `blocking: true` reporting that its "fully diluted common share count is
   * missing" and that it had set no approach weights. Neither is a finding: the
   * deliverable has no such figures. The gate this report feeds
   * (`routes/healthChecks.ts`) was therefore unsatisfiable for those kinds
   * permanently, and unsatisfiable for a reason the analyst could not act on.
   */
  const specialtyKind = specialtyRunKind(args.calculation.results);
  const columns = headlineCheckNames(specialtyKind);

  const equity = num(args.calculation.equity_value);
  const fmv = num(args.calculation.fmv_per_share);
  const allocationMethod = String(params.allocation_method ?? engineParams.allocation_method ?? 'opm');

  const weights = {
    asset: num(engineParams.weight_asset),
    opm: num(engineParams.weight_opm),
    income: num(engineParams.weight_income),
    market: num(engineParams.weight_market),
  };

  // ── Scope ───────────────────────────────────────────────────────────────
  //
  // Said out loud rather than left to be inferred from a short list. Once the
  // 409A rules are skipped a specialty report can hold one check, or — on the
  // kinds that conclude neither typed column — none at all, and a health report
  // with nothing in it reads as an all-clear rather than as an examination that
  // was never applicable.
  if (specialtyKind !== null) {
    add(
      'methodology',
      'specialty_engine',
      'Checks match the valuation kind',
      'info',
      `${kindLabel(specialtyKind)} runs its own engine — the 409A model rules ` +
        '(approach weights, allocation method, share counts, DLOM benchmarks) do not apply to it ' +
        "and are not graded here. Review this kind's own schedules.",
    );
  }

  // ── Methodology consistency ─────────────────────────────────────────────
  if (allocationMethod === 'pwerm') {
    const scenarios = arr(obj(engineInputs.pwerm).scenarios);
    add(
      'methodology',
      'pwerm_scenarios_present',
      'PWERM scenarios defined',
      scenarios.length > 0 ? 'ok' : 'error',
      scenarios.length > 0
        ? `${scenarios.length} exit scenarios defined`
        : 'PWERM allocation selected but no exit scenarios are defined',
    );
  } else if ((weights.opm ?? 0) > 0) {
    const vol = num(engineInputs.volatility);
    add(
      'methodology',
      'opm_volatility_present',
      'OPM has a volatility input',
      vol !== null && vol > 0 ? 'ok' : 'error',
      vol !== null && vol > 0
        ? `OPM volatility ${pct(vol)}`
        : 'The OPM is weighted but no volatility is set — allocation cannot run',
    );
  }
  if ((weights.market ?? 0) > 0) {
    const multiples = arr(market.multiples);
    add(
      'methodology',
      'market_comparables_present',
      'Market approach has comparables',
      multiples.length > 0 ? 'ok' : 'error',
      multiples.length > 0
        ? `${multiples.length} comparable multiples`
        : 'The market approach is weighted but no comparable multiples are set',
    );
  }
  if ((weights.income ?? 0) > 0) {
    const fcf = arr(income.free_cash_flows);
    add(
      'methodology',
      'income_projections_present',
      'Income approach has projections',
      fcf.length > 0 ? 'ok' : 'error',
      fcf.length > 0
        ? `${fcf.length} projected cash-flow periods`
        : 'The income approach is weighted but no free-cash-flow projection is set',
    );
  }
  /*
   * Asked through `selectsModelDlom` rather than as `=== 'chaffee' || ===
   * 'finnerty'`, which is what this was and which was already wrong by two
   * methods: Ghaidarov and Longstaff are equally volatility-derived, so a run
   * selecting one with no volatility set was told nothing. A weighted blend
   * would have slipped past for the worse reason — a model leg with no
   * volatility contributes silently nothing to the concluded discount, so the
   * failure looks like a plausible number rather than a zero.
   */
  const dlomSelection = {
    dlom_method: engineParams.dlom_method ?? params.dlom_method,
    dlom_methods: engineParams.dlom_methods ?? params.dlom_methods,
  };
  if (selectsModelDlom(dlomSelection)) {
    const vol = num(engineInputs.volatility);
    const named = modelDlomMethodsIn(dlomSelection).join(' / ');
    add(
      'methodology',
      'dlom_model_needs_volatility',
      'Model DLOM has a volatility input',
      vol !== null && vol > 0 ? 'ok' : 'error',
      vol !== null && vol > 0
        ? `${named} DLOM will use volatility ${pct(vol)}`
        : `${named} DLOM needs a volatility input`,
    );
  }

  // ── Assumption reasonableness (benchmarks from IMPROVEMENTS_RESEARCH §4.3) ─
  const volatility = num(engineInputs.volatility);
  if (volatility !== null) {
    const sev: HealthSeverity =
      volatility <= 0 ? 'error' : volatility < 0.1 || volatility > 1.5 ? 'warning' : 'ok';
    add(
      'assumptions',
      'volatility_benchmarked',
      'Volatility within the observed range',
      sev,
      sev === 'ok'
        ? `Volatility ${pct(volatility)} is within the observed 10–150% band`
        : `Volatility ${pct(volatility)} is an outlier — document the benchmark basis`,
    );
  }
  const discountRate = num(income.discount_rate);
  if (discountRate !== null) {
    const sev: HealthSeverity = discountRate < 0.08 || discountRate > 0.6 ? 'warning' : 'ok';
    add(
      'assumptions',
      'discount_rate_range',
      'Discount rate within venture norms',
      sev,
      sev === 'ok'
        ? `Discount rate ${pct(discountRate)} is within the typical 8–60% venture band`
        : `Discount rate ${pct(discountRate)} is outside the typical 8–60% venture band`,
    );
  }
  const dlom = num(engineParams.dlom) ?? num(params.dlom);
  if (dlom !== null) {
    const sev: HealthSeverity = dlom < 0 || dlom > 0.6 ? 'error' : dlom > 0.35 ? 'warning' : 'ok';
    add(
      'assumptions',
      'dlom_range',
      'DLOM within market norms',
      sev,
      sev === 'ok'
        ? `DLOM ${pct(dlom)} is within the typical 0–35% band`
        : sev === 'warning'
          ? `DLOM ${pct(dlom)} exceeds the 35% benchmark auditors scrutinize`
          : `DLOM ${pct(dlom)} is outside any defensible range`,
    );
  }
  const terminalGrowth = num(income.terminal_growth);
  if (terminalGrowth !== null) {
    const sev: HealthSeverity = terminalGrowth < 0 || terminalGrowth > 0.05 ? 'warning' : 'ok';
    add(
      'assumptions',
      'terminal_growth_range',
      'Terminal growth is conservative',
      sev,
      sev === 'ok'
        ? `Terminal growth ${pct(terminalGrowth)} is within the 0–5% norm`
        : `Terminal growth ${pct(terminalGrowth)} is outside the 0–5% long-run norm`,
    );
  }

  // ── Data completeness ───────────────────────────────────────────────────
  const commonShares = num(engineInputs.shares_outstanding_common);
  // The two unconditional rules, and the only two that a specialty run could
  // not simply skip by having no field to read — see the note on `specialtyKind`.
  if (specialtyKind === null) {
    add(
      'completeness',
      'common_shares_present',
      'Common share count is set',
      commonShares !== null && commonShares > 0 ? 'ok' : 'error',
      commonShares !== null && commonShares > 0
        ? `${commonShares.toLocaleString()} common shares`
        : 'Fully diluted common share count is missing — FMV per share cannot be computed',
    );
    const anyWeight = Object.values(weights).some((w) => w !== null);
    add(
      'completeness',
      'weights_present',
      'Approach weights are set',
      anyWeight ? 'ok' : 'error',
      anyWeight ? 'Approach weights are set' : 'No approach weights are set',
    );
  }
  const shareClasses = arr(engineInputs.share_classes);
  if (shareClasses.length > 0 && commonShares !== null) {
    const capCommon = shareClasses
      .filter((c) => obj(c).kind === 'common')
      .reduce<number>((sum, c) => sum + (num(obj(c).shares) ?? 0), 0);
    // Options are a separate line in the aggregate inputs, so allow the cap
    // table's common to sit at or below the fully diluted common figure.
    const reconciles = capCommon > 0 && capCommon <= commonShares * 1.0001;
    add(
      'completeness',
      'cap_table_reconciles',
      'Cap table reconciles with common shares',
      reconciles ? 'ok' : 'warning',
      reconciles
        ? 'Cap-table common shares reconcile with the fully diluted common count'
        : `Cap-table common (${capCommon.toLocaleString()}) exceeds the fully diluted common count (${commonShares.toLocaleString()})`,
    );
  }

  // ── Mathematical consistency ────────────────────────────────────────────
  const setWeights = Object.values(weights).filter((w): w is number => w !== null);
  if (setWeights.length > 0) {
    const sum = setWeights.reduce((a, b) => a + b, 0);
    const ok = Math.abs(sum - 1) < 1e-4;
    add(
      'mathematical',
      'weights_sum',
      'Approach weights sum to 100%',
      ok ? 'ok' : 'error',
      ok ? 'Weights sum to 100%' : `Weights sum to ${pct(sum)} — must total 100%`,
    );
  }
  /*
   * The two typed columns, named for what this run actually put in them.
   *
   * `equity_value` and `fmv_per_share` are 409A columns by name and every
   * specialty engine writes into them because they are the columns the row has
   * (`specialtyHeadline`). Graded under those names, "Equity value is positive"
   * passed over an IFRS 2 total share-based-payment expense and "FMV per share
   * is positive" over an EMI *actual* market value — the restricted figure,
   * which is not the FMV and is not what HMRC's limits are tested against. The
   * arithmetic was right and the sentence was about a different number.
   *
   * A 409A run keeps the wording these checks have always carried: relabelling
   * it would change what a stored review says without correcting anything. A
   * `null` name is a kind that concludes no such figure, and the check is then
   * omitted rather than run under a borrowed one.
   */
  const equityName = columns.equity;
  const perShareName = columns.perShare;
  if (equity !== null && equityName !== null) {
    add(
      'mathematical',
      'equity_positive',
      `${equityName} is positive`,
      equity > 0 ? 'ok' : 'error',
      equity > 0 ? `${equityName} ${equity.toLocaleString()}` : `${equityName} ${equity} is not positive`,
    );
  }
  if (fmv !== null && perShareName !== null) {
    const shown = specialtyKind === null ? 'FMV/share' : perShareName;
    add(
      'mathematical',
      'fmv_positive',
      `${perShareName} is positive`,
      fmv > 0 ? 'ok' : 'error',
      fmv > 0 ? `${shown} ${fmv}` : `${shown} ${fmv} is not positive`,
    );
  }
  if (
    equity !== null &&
    fmv !== null &&
    equity > 0 &&
    fmv > 0 &&
    equityName !== null &&
    perShareName !== null
  ) {
    // "total equity value" on a 409A: the point of the comparison is that one
    // is a per-share figure and the other is the whole. A specialty kind names
    // its own whole, and "total" would be wrong in front of some of them.
    const whole = specialtyKind === null ? 'total equity value' : equityName.toLowerCase();
    const shown = specialtyKind === null ? 'FMV/share' : perShareName;
    add(
      'mathematical',
      'fmv_below_equity',
      `${perShareName} below ${whole}`,
      fmv <= equity ? 'ok' : 'error',
      fmv <= equity
        ? `Per-share value is consistent with ${whole}`
        : `${shown} ${fmv} exceeds the entire ${whole} ${equity}`,
    );
  }
  // Share-count reconciliation against the basis the engine actually divided
  // by. The two allocation families disclose different counts: the cap-table
  // waterfall values the option pool as its own class, so its per-share figure
  // is over the common classes alone, while the aggregate models fold the pool
  // into fully diluted common. Checking every calculation against
  // `common + options` therefore graded a correct waterfall run as a mismatch —
  // and, worse, passed a run whose disclosed count was the one that did *not*
  // produce its own headline FMV.
  const fdCommon = num(results.fully_diluted_common);
  const options = num(engineInputs.options_outstanding) ?? 0;
  const capTableBasis = results.fully_diluted_basis === 'cap_table_common';
  const capTableCommon = shareClasses
    .filter((c) => obj(c).kind === 'common')
    .reduce<number>((sum, c) => sum + (num(obj(c).shares) ?? 0), 0);
  const expected = capTableBasis ? capTableCommon : commonShares === null ? null : commonShares + options;
  if (fdCommon !== null && expected !== null && expected > 0) {
    const ok = Math.abs(fdCommon - expected) <= 1;
    const what = capTableBasis ? "the cap table's common shares" : 'common + options';
    add(
      'mathematical',
      'share_counts_match',
      'Share counts reconcile',
      ok ? 'ok' : 'warning',
      ok
        ? `Allocation basis (${fdCommon.toLocaleString()}) = ${what}`
        : `Allocation basis ${fdCommon.toLocaleString()} ≠ ${what} ${expected.toLocaleString()}`,
    );
  }

  // ── Temporal consistency ────────────────────────────────────────────────
  const valuationMs = dateMs(engineInputs.valuation_date);
  const calcMs = dateMs(args.calculation.created_at);
  const checkOrder = (
    key: string,
    label: string,
    earlier: number | null,
    laterOrEqual: number | null,
    detailOk: string,
    detailBad: string,
    sev: HealthSeverity = 'warning',
  ) => {
    if (earlier === null || laterOrEqual === null) return;
    add(
      'temporal',
      key,
      label,
      earlier <= laterOrEqual ? 'ok' : sev,
      earlier <= laterOrEqual ? detailOk : detailBad,
    );
  };
  checkOrder(
    'fiscal_before_valuation',
    'Financial data predates the valuation date',
    dateMs(params.fiscal_year_end),
    valuationMs,
    'Fiscal year-end precedes the valuation date',
    'Fiscal year-end is after the valuation date — the financials are forward of the measurement date',
  );
  checkOrder(
    'last_round_before_valuation',
    'Last round predates the valuation date',
    dateMs(params.last_round_date),
    valuationMs,
    'Last financing round precedes the valuation date',
    'Last financing round is dated after the valuation date',
  );
  if (valuationMs !== null) {
    const exitMs = dateMs(params.exit_timeline);
    if (exitMs !== null) {
      add(
        'temporal',
        'exit_after_valuation',
        'Expected exit is after the valuation date',
        exitMs >= valuationMs ? 'ok' : 'error',
        exitMs >= valuationMs
          ? 'Expected exit is in the future relative to the valuation date'
          : 'Expected exit is before the valuation date — the time-to-liquidity is negative',
      );
    }
  }
  // Staleness: params edited after the calculation ran.
  const paramsMs = dateMs(params.updated_at ?? null);
  if (paramsMs !== null && calcMs !== null) {
    add(
      'temporal',
      'params_freshness',
      'Calculation reflects current parameters',
      paramsMs <= calcMs ? 'ok' : 'warning',
      paramsMs <= calcMs
        ? 'No parameter changes since this calculation'
        : 'Parameters changed after this calculation — recalculate before finalizing',
    );
  }

  const severities = checks.map((c) => c.severity);
  const counts: Record<HealthSeverity, number> = { ok: 0, info: 0, warning: 0, error: 0 };
  for (const s of severities) counts[s] += 1;
  return {
    severity: worstSeverity(severities),
    blocking: counts.error > 0,
    counts,
    checks,
  };
}
