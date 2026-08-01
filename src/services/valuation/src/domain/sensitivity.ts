/**
 * OPM sensitivity analysis (M4, feature-gap-analysis P1 #19).
 *
 * The Option Pricing Method treats common stock as a call option on the
 * company's equity value with a strike at the preferred liquidation
 * preference (Black-Scholes). The dashboard stresses the two inputs the
 * analyst is least certain of — volatility and time to exit — and shows how
 * the per-share FMV (after DLOM) moves across the grid.
 *
 * Pure math, no I/O: unit-testable against known Black-Scholes values.
 */

export interface OpmInputs {
  /** Total equity value, in cents. */
  equityValueCents: number;
  /** Aggregate preferred liquidation preference (the OPM strike), in cents. */
  strikeCents: number;
  /** Annualized volatility as a decimal, e.g. 0.6 for 60%. */
  volatility: number;
  /** Time to a liquidity event, in years. */
  termYears: number;
  /** Annualized risk-free rate as a decimal, e.g. 0.043. */
  riskFreeRate: number;
  /** Fully diluted common shares outstanding. */
  commonShares: number;
  /** Discount for lack of marketability as a decimal, e.g. 0.30. */
  dlom: number;
}

/** Abramowitz & Stegun 7.1.26 erf approximation (|error| < 1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF. */
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Black-Scholes European call value (same units as spot/strike). */
export function blackScholesCall(
  spot: number,
  strike: number,
  volatility: number,
  termYears: number,
  riskFreeRate: number,
): number {
  if (spot <= 0) return 0;
  if (termYears <= 0 || volatility <= 0) {
    return Math.max(0, spot - strike * Math.exp(-riskFreeRate * termYears));
  }
  if (strike <= 0) return spot;
  const sqrtT = Math.sqrt(termYears);
  const d1 =
    (Math.log(spot / strike) + (riskFreeRate + (volatility * volatility) / 2) * termYears) /
    (volatility * sqrtT);
  const d2 = d1 - volatility * sqrtT;
  return spot * normCdf(d1) - strike * Math.exp(-riskFreeRate * termYears) * normCdf(d2);
}

/** Per-common-share FMV in cents: OPM call value spread over common, less DLOM. */
export function opmFmvPerShareCents(inputs: OpmInputs): number {
  if (inputs.commonShares <= 0) return 0;
  const call = blackScholesCall(
    inputs.equityValueCents,
    inputs.strikeCents,
    inputs.volatility,
    inputs.termYears,
    inputs.riskFreeRate,
  );
  const perShare = call / inputs.commonShares;
  const dlomClamped = Math.max(0, Math.min(inputs.dlom, 0.99));
  return perShare * (1 - dlomClamped);
}

export interface SensitivityCell {
  volatility: number;
  termYears: number;
  fmvPerShareCents: number;
  /** Relative change vs. the base-case cell, e.g. +0.12 = 12% higher. */
  deltaFromBase: number;
}

export interface SensitivityGrid {
  base: { volatility: number; termYears: number; fmvPerShareCents: number };
  volatilities: number[];
  terms: number[];
  /** rows[i][j] stresses volatilities[i] × terms[j]. */
  rows: SensitivityCell[][];
}

export interface GridOptions {
  /** Multiplicative stress steps applied to volatility, e.g. [-0.2, -0.1, 0, 0.1, 0.2]. */
  volatilitySteps?: number[];
  /** Additive stress steps applied to the term in years, e.g. [-1, -0.5, 0, 0.5, 1]. */
  termSteps?: number[];
}

const DEFAULT_VOL_STEPS = [-0.2, -0.1, 0, 0.1, 0.2];
const DEFAULT_TERM_STEPS = [-1, -0.5, 0, 0.5, 1];
const DEFAULT_RFR_STEPS = [-0.02, -0.01, 0, 0.01, 0.02];

/** Builds the volatility × term stress table around the base case. */
export function sensitivityGrid(inputs: OpmInputs, opts: GridOptions = {}): SensitivityGrid {
  const volSteps = opts.volatilitySteps ?? DEFAULT_VOL_STEPS;
  const termSteps = opts.termSteps ?? DEFAULT_TERM_STEPS;

  const volatilities = volSteps.map((s) => round4(inputs.volatility * (1 + s)));
  const terms = termSteps.map((s) => round4(Math.max(0.1, inputs.termYears + s)));
  const baseFmv = opmFmvPerShareCents(inputs);

  const rows = volatilities.map((volatility) =>
    terms.map((termYears) => {
      const fmv = opmFmvPerShareCents({ ...inputs, volatility, termYears });
      return {
        volatility,
        termYears,
        fmvPerShareCents: Math.round(fmv),
        deltaFromBase: baseFmv > 0 ? round4(fmv / baseFmv - 1) : 0,
      };
    }),
  );

  return {
    base: {
      volatility: inputs.volatility,
      termYears: inputs.termYears,
      fmvPerShareCents: Math.round(baseFmv),
    },
    volatilities,
    terms,
    rows,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/* ── Three-table dashboard (remaining-gaps §2 "Sensitivity dashboard") ──────
 * 409.ai stresses three axis pairs: Term×Vol, RFR×Vol, RFR×Term. Each cell
 * carries the price and its delta vs. the base case; the base row/column set
 * comes from the same steps as the classic grid, plus additive RFR steps. */

export type SensitivityAxis = 'volatility' | 'termYears' | 'riskFreeRate';

export interface AxisCell {
  /** rows[i][j]: row-axis value i × column-axis value j. */
  fmvPerShareCents: number;
  deltaFromBase: number;
}

export interface AxisTable {
  rowAxis: SensitivityAxis;
  colAxis: SensitivityAxis;
  rowValues: number[];
  colValues: number[];
  rows: AxisCell[][];
}

export interface SensitivityTables {
  base: {
    volatility: number;
    termYears: number;
    riskFreeRate: number;
    fmvPerShareCents: number;
  };
  tables: { term_vol: AxisTable; rfr_vol: AxisTable; rfr_term: AxisTable };
}

export interface TablesOptions extends GridOptions {
  /** Additive stress steps applied to the risk-free rate, e.g. [-0.01, 0, 0.01]. */
  rfrSteps?: number[];
}

function axisValues(inputs: OpmInputs, axis: SensitivityAxis, steps: number[]): number[] {
  switch (axis) {
    case 'volatility':
      // Multiplicative, like the classic grid.
      return steps.map((s) => round4(inputs.volatility * (1 + s)));
    case 'termYears':
      return steps.map((s) => round4(Math.max(0.1, inputs.termYears + s)));
    case 'riskFreeRate':
      return steps.map((s) => round4(Math.max(0, inputs.riskFreeRate + s)));
  }
}

function buildTable(
  inputs: OpmInputs,
  baseFmv: number,
  rowAxis: SensitivityAxis,
  colAxis: SensitivityAxis,
  rowValues: number[],
  colValues: number[],
): AxisTable {
  const rows = rowValues.map((rowValue) =>
    colValues.map((colValue) => {
      const fmv = opmFmvPerShareCents({ ...inputs, [rowAxis]: rowValue, [colAxis]: colValue });
      return {
        fmvPerShareCents: Math.round(fmv),
        deltaFromBase: baseFmv > 0 ? round4(fmv / baseFmv - 1) : 0,
      };
    }),
  );
  return { rowAxis, colAxis, rowValues, colValues, rows };
}

/** All three stress tables around the base case. */
export function sensitivityTables(inputs: OpmInputs, opts: TablesOptions = {}): SensitivityTables {
  const vols = axisValues(inputs, 'volatility', opts.volatilitySteps ?? DEFAULT_VOL_STEPS);
  const terms = axisValues(inputs, 'termYears', opts.termSteps ?? DEFAULT_TERM_STEPS);
  const rfrs = axisValues(inputs, 'riskFreeRate', opts.rfrSteps ?? DEFAULT_RFR_STEPS);
  const baseFmv = opmFmvPerShareCents(inputs);

  return {
    base: {
      volatility: inputs.volatility,
      termYears: inputs.termYears,
      riskFreeRate: inputs.riskFreeRate,
      fmvPerShareCents: Math.round(baseFmv),
    },
    tables: {
      term_vol: buildTable(inputs, baseFmv, 'termYears', 'volatility', terms, vols),
      rfr_vol: buildTable(inputs, baseFmv, 'riskFreeRate', 'volatility', rfrs, vols),
      rfr_term: buildTable(inputs, baseFmv, 'riskFreeRate', 'termYears', rfrs, terms),
    },
  };
}
