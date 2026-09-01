/**
 * Cross-period value bridge (feature 3): explains the change in fair market
 * value per common share between two calculations of the same company.
 *
 * The engine's per-share FMV factorises exactly as
 *
 *     fmv = base × (1 − DLOC) × (1 − DLOM)
 *     base = fmv / ((1 − DLOC)(1 − DLOM))          (pre-discount common value/share)
 *         = E × (base / E)                          (company value × allocation&dilution)
 *
 * so fmv = E · (base/E) · (1−DLOC) · (1−DLOM), a product of four positive
 * factors. We attribute Δfmv across them with the additive LMDI-I index
 * (logarithmic mean Divisia): for fmv = ∏ xᵢ,
 *
 *     Δfmv = Σᵢ  L(fmv_to, fmv_from) · ln(xᵢ_to / xᵢ_from),   L(a,b) = (a−b)/ln(a/b)
 *
 * The contributions sum to Δfmv *exactly* (a defining property of LMDI), so the
 * waterfall closes with no residual — important for an audit-facing report. The
 * `drivers` block additionally reports the raw old/new/delta of the underlying
 * assumptions (equity value, DLOM/DLOC, volatility, approach weights, market
 * multiple) for context.
 */

import { isSpecialtyKind } from './specialty.js';
import { appliedMarketMultiple } from './valuationAnalytics.js';
import type { ValuationKind } from './valuation.js';

/**
 * A pair the bridge cannot be drawn over — an input condition, not a fault.
 *
 * `buildBridge` threw a bare `Error` for a calculation with no top-level
 * `fmv_per_share`, which reached the HTTP layer as a 500. Typed so the route
 * can answer 422 and say which pair it was asked about: an ordinary click
 * should not read as the server having broken.
 */
export class BridgeInputError extends Error {}

/**
 * Whether a kind's calculations are written in the vocabulary this bridge
 * factorises.
 *
 * The decomposition above is the 409A engine's: equity value, the allocation
 * that turns it into a per-share figure, DLOC, DLOM. A specialty engine writes
 * its own result shape under `results.specialty` (routes/specialty.ts) and none
 * of those four terms exist in it — an EMI run's actual market value moves
 * because the restriction discount moved, which is not a factor here.
 */
export function bridgeableKind(kind: string): boolean {
  return !isSpecialtyKind(kind as ValuationKind);
}

export interface BridgeFactor {
  key: 'company_value' | 'allocation_dilution' | 'dloc' | 'dlom';
  label: string;
  from: number;
  to: number;
  /** Signed dollar-per-share contribution to Δfmv (LMDI). */
  contribution: number;
}

export interface BridgeDriver {
  key: string;
  label: string;
  from: number | null;
  to: number | null;
  delta: number | null;
}

export interface ValuationBridge {
  from_fmv: number;
  to_fmv: number;
  delta: number;
  pct_change: number | null;
  /** LMDI contributions; sum(contribution) === delta (to rounding). */
  factors: BridgeFactor[];
  drivers: BridgeDriver[];
  /** True when the exact decomposition applies (all factors positive). */
  decomposable: boolean;
}

type Results = Record<string, unknown>;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Logarithmic mean L(a,b) = (a−b)/ln(a/b); L(a,a)=a.
 *
 * Precondition: a, b > 0. The single call site is inside the `allPositive`
 * arm, which has already established `fromFmv > 0 && toFmv > 0`, so a guard
 * against non-positive inputs here would be dead code rather than defence.
 */
function logMean(a: number, b: number): number {
  if (a === b) return a;
  return (a - b) / Math.log(a / b);
}

function discounts(r: Results): { dloc: number; dlom: number } {
  const d = (r.discounts ?? {}) as Results;
  return { dloc: num(d.dloc) ?? 0, dlom: num(d.dlom) ?? 0 };
}

function approachWeight(r: Results, name: string): number | null {
  const approaches = (r.approaches ?? {}) as Results;
  const entry = approaches[name] as Results | undefined;
  return entry ? num(entry.weight) : null;
}

/**
 * The multiple the market approach applied, on each side of the bridge.
 *
 * The **mean** of the comparable set before, called "Market multiple" in the
 * driver table beside the factors that move the conclusion. The engine selects
 * `statistics.median` of the positive multiples and puts its answer on the
 * result as `selected_multiple`, so on the ordinary shape of a comp set — one
 * richly-priced peer among five — the row named a figure the valuation never
 * used, and its `delta` was the movement of a statistic nobody struck. A set
 * that goes from `[4, 5, 6, 7, 28]` to `[4, 5, 6, 7, 12]` moved the multiple
 * the opinion rests on not at all, and this reported it falling 3.2×.
 *
 * `appliedMarketMultiple` is the one answer to that question — the same
 * function the analytics benchmark reads, fixed there for the same reason and
 * left restated here.
 */
function marketMultiple(r: Results): number | null {
  const approaches = (r.approaches ?? {}) as Results;
  if (!approaches.market) return null;
  return appliedMarketMultiple(r) ?? num((approaches.market as Results).multiple);
}

function driver(key: string, label: string, from: number | null, to: number | null): BridgeDriver {
  return { key, label, from, to, delta: from !== null && to !== null ? to - from : null };
}

/**
 * Build the bridge from two engine `results` objects (from → to). Throws only
 * on structurally unusable inputs (missing FMV); a non-decomposable case still
 * returns the totals and drivers with `decomposable: false`.
 */
export function buildBridge(from: Results, to: Results): ValuationBridge {
  const fromFmv = num(from.fmv_per_share);
  const toFmv = num(to.fmv_per_share);
  if (fromFmv === null || toFmv === null) {
    throw new BridgeInputError(
      'Both calculations need a per-share fair market value before a bridge can be drawn between them',
    );
  }

  const fromD = discounts(from);
  const toD = discounts(to);
  const round = (n: number) => Math.round(n * 1e6) / 1e6;

  const drivers: BridgeDriver[] = [
    driver('equity_value', 'Equity value', num(from.equity_value), num(to.equity_value)),
    driver('dlom', 'DLOM', fromD.dlom, toD.dlom),
    driver('dloc', 'DLOC', fromD.dloc, toD.dloc),
    driver(
      'volatility',
      'Volatility',
      num((from.assumptions as Results | undefined)?.volatility),
      num((to.assumptions as Results | undefined)?.volatility),
    ),
    driver('weight_asset', 'Asset weight', approachWeight(from, 'asset'), approachWeight(to, 'asset')),
    driver(
      'weight_opm',
      'OPM weight',
      approachWeight(from, 'opm_backsolve'),
      approachWeight(to, 'opm_backsolve'),
    ),
    driver('weight_income', 'Income weight', approachWeight(from, 'income'), approachWeight(to, 'income')),
    driver('weight_market', 'Market weight', approachWeight(from, 'market'), approachWeight(to, 'market')),
    driver('market_multiple', 'Market multiple', marketMultiple(from), marketMultiple(to)),
  ];

  const delta = round(toFmv - fromFmv);
  const pct = fromFmv !== 0 ? round((toFmv - fromFmv) / fromFmv) : null;

  // Factorisation: fmv = E · (base/E) · (1−dloc) · (1−dlom).
  const baseFrom = fromFmv / ((1 - fromD.dloc) * (1 - fromD.dlom) || 1);
  const baseTo = toFmv / ((1 - toD.dloc) * (1 - toD.dlom) || 1);
  const eFrom = num(from.equity_value);
  const eTo = num(to.equity_value);

  const factorPairs = [
    { key: 'company_value' as const, label: 'Company value', from: eFrom, to: eTo },
    {
      key: 'allocation_dilution' as const,
      label: 'Allocation & dilution',
      from: eFrom && eFrom > 0 ? baseFrom / eFrom : null,
      to: eTo && eTo > 0 ? baseTo / eTo : null,
    },
    {
      key: 'dloc' as const,
      label: 'Marketability of control (DLOC)',
      from: 1 - fromD.dloc,
      to: 1 - toD.dloc,
    },
    { key: 'dlom' as const, label: 'Marketability (DLOM)', from: 1 - fromD.dlom, to: 1 - toD.dlom },
  ];

  const allPositive =
    fromFmv > 0 &&
    toFmv > 0 &&
    factorPairs.every((f) => f.from !== null && f.to !== null && f.from > 0 && f.to > 0);

  let factors: BridgeFactor[];
  if (allPositive) {
    const L = logMean(toFmv, fromFmv);
    factors = factorPairs.map((f) => ({
      key: f.key,
      label: f.label,
      from: round(f.from as number),
      to: round(f.to as number),
      contribution: round(L * Math.log((f.to as number) / (f.from as number))),
    }));
  } else {
    // Fall back to reporting factor levels without an exact split.
    factors = factorPairs.map((f) => ({
      key: f.key,
      label: f.label,
      from: f.from !== null ? round(f.from) : 0,
      to: f.to !== null ? round(f.to) : 0,
      contribution: 0,
    }));
  }

  return {
    from_fmv: round(fromFmv),
    to_fmv: round(toFmv),
    delta,
    pct_change: pct,
    factors,
    drivers,
    decomposable: allPositive,
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const usd = (v: number) =>
  `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Optional value-bridge section for the report (feature 3). Returns a
 * {key, heading, html} section using only whitelisted tags (domain/report.ts
 * ALLOWED_TAGS), so it can be appended to report content and rendered by the
 * PDF service unchanged.
 */
export function renderBridgeSection(
  bridge: ValuationBridge,
  labels: { fromRef: string; toRef: string },
): { key: string; heading: string; html: string } {
  const dir = bridge.delta >= 0 ? 'increased' : 'decreased';
  const pct = bridge.pct_change !== null ? ` (${(bridge.pct_change * 100).toFixed(1)}%)` : '';
  const intro =
    `<p>The concluded fair market value per common share ${dir} from ` +
    `<strong>${usd(bridge.from_fmv)}</strong> (${esc(labels.fromRef)}) to ` +
    `<strong>${usd(bridge.to_fmv)}</strong> (${esc(labels.toRef)}), a change of ` +
    `<strong>${usd(bridge.delta)}</strong>${pct}.</p>`;

  const factorRows = bridge.decomposable
    ? bridge.factors.map((f) => `<tr><td>${esc(f.label)}</td><td>${usd(f.contribution)}</td></tr>`).join('')
    : '';
  const factorTable = bridge.decomposable
    ? `<p>Attribution of the per-share change:</p><table><thead><tr><th>Driver</th>` +
      `<th>Contribution</th></tr></thead><tbody>${factorRows}` +
      `<tr><th>Total change</th><th>${usd(bridge.delta)}</th></tr></tbody></table>`
    : '<p>A factor attribution is not available for this comparison (a per-share value is non-positive).</p>';

  return { key: 'value_bridge', heading: 'Cross-Period Value Bridge', html: intro + factorTable };
}
