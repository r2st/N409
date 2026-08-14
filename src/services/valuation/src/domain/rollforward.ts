import type { CalibrationStep, MaterialChange } from '../repos/rollforwardRuns.js';

/**
 * Roll-forward — the bridge from a prior 409A's concluded equity value to this
 * engagement's date.
 *
 * `engine/v1/rollforward` (engine-wrapper: app/engine/rollforward.py) has done
 * the arithmetic since it was written and had no caller. The gap that leaves is
 * not a missing calculation, it is a missing *argument*: when a company
 * re-values without a new priced round, the prior appraisal's OPM-backsolve
 * equity value is the only figure on the engagement calibrated to an
 * arm's-length transaction, and a new valuation that ignores it has thrown away
 * its best evidence and has nothing to say when an auditor asks why the number
 * moved.
 *
 * This module is the shaping layer between that endpoint and the row: it reads
 * the response defensively, refuses one it cannot use, and hands back exactly
 * what `rollforward_runs` stores. Nothing here computes a valuation figure —
 * the engine owns every number, and restating any of them here is how the two
 * would come to disagree.
 */

/** A request this service will not send, or a response it will not store. */
export class RollforwardInputError extends Error {}

/** The `engine/v1/rollforward` response, as far as this module reads it. */
export interface RollforwardEngineResponse {
  prior_valuation_date?: unknown;
  new_valuation_date?: unknown;
  years_elapsed?: unknown;
  prior_equity_value?: unknown;
  rolled_equity_value?: unknown;
  annual_accretion?: unknown;
  calibration_steps?: unknown;
  material_changes?: unknown;
  requires_full_revaluation?: unknown;
  pre_populated_inputs?: unknown;
}

/**
 * A finite number, or null.
 *
 * `Number.isFinite`, not merely `!== null`: the response travels as JSON out of
 * a Python process, and `Infinity` stringifies to `null` in one direction and
 * parses out of `1e999` in the other. Every field below is either stored in a
 * `numeric` column — where a non-finite value is an error at insert time, i.e.
 * a 500 on a request that had already succeeded — or multiplied into a figure
 * the exhibit prints.
 */
function fin(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** An ISO calendar date at day resolution, or null. */
function isoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The calibration trail, as the row stores it.
 *
 * A step with no usable value is dropped rather than stored as a gap: the trail
 * is read as arithmetic — each line is the running total after that step — and
 * a line whose total is missing reads as a step that took the value to nothing.
 */
function calibrationSteps(raw: unknown): CalibrationStep[] {
  return (Array.isArray(raw) ? raw : [])
    .map((entry) => {
      const s = record(entry);
      const step = typeof s?.step === 'string' ? s.step : null;
      const value = fin(s?.value);
      if (step === null || value === null) return null;
      const annualRate = fin(s?.annual_rate);
      const years = fin(s?.years);
      const factor = fin(s?.factor);
      return {
        step,
        value,
        ...(annualRate === null ? {} : { annual_rate: annualRate }),
        ...(years === null ? {} : { years }),
        ...(factor === null ? {} : { factor }),
        ...(typeof s?.label === 'string' && s.label.trim() !== '' ? { label: s.label.trim() } : {}),
      } satisfies CalibrationStep;
    })
    .filter((s): s is CalibrationStep => s !== null);
}

/**
 * The detected changes, material and not.
 *
 * The immaterial ones are kept deliberately. "Revenue moved 4%, below the 20%
 * threshold" is not noise — it is the record that the question was asked and
 * answered, which is the difference between a roll-forward an analyst defended
 * and one nobody looked at.
 */
function materialChanges(raw: unknown): MaterialChange[] {
  return (Array.isArray(raw) ? raw : [])
    .map((entry) => {
      const c = record(entry);
      const field = typeof c?.field === 'string' ? c.field : null;
      const detail = typeof c?.detail === 'string' ? c.detail.trim() : '';
      if (field === null || detail === '') return null;
      const deltaPct = fin(c?.delta_pct);
      return {
        field,
        material: c?.material === true,
        detail,
        ...(deltaPct === null ? {} : { delta_pct: deltaPct }),
      } satisfies MaterialChange;
    })
    .filter((c): c is MaterialChange => c !== null);
}

export interface ShapedRollforward {
  priorValuationDate: string;
  newValuationDate: string;
  yearsElapsed: number;
  priorEquityValue: number;
  rolledEquityValue: number;
  annualAccretion: number;
  calibrationSteps: CalibrationStep[];
  materialChanges: MaterialChange[];
  requiresFullRevaluation: boolean;
  prePopulatedInputs: Record<string, unknown>;
}

/**
 * The engine's answer, as the row stores it.
 *
 * Throws rather than defaulting on the four figures the bridge *is*. A
 * roll-forward whose rolled value is missing is not a roll-forward with a gap
 * in it; substituting a zero or the prior value would write a bridge that
 * claims an arithmetic the engine never performed, and every consumer
 * downstream — the exhibit, the anchor the next compute runs on — would take it
 * as true. The engine has its own guards on all four (positive, finite), so
 * reaching any of these means the response was not the one this service asked
 * for.
 *
 * The lists and the pre-populated inputs default instead, because an empty
 * change list is a legitimate answer: nothing material moved.
 */
export function shapeRollforward(response: RollforwardEngineResponse): ShapedRollforward {
  const priorEquityValue = fin(response.prior_equity_value);
  const rolledEquityValue = fin(response.rolled_equity_value);
  if (priorEquityValue === null || priorEquityValue <= 0) {
    throw new RollforwardInputError('The roll-forward returned no usable prior equity value');
  }
  if (rolledEquityValue === null || rolledEquityValue <= 0) {
    throw new RollforwardInputError('The roll-forward returned no usable rolled equity value');
  }

  const priorValuationDate = isoDate(response.prior_valuation_date);
  const newValuationDate = isoDate(response.new_valuation_date);
  if (priorValuationDate === null || newValuationDate === null) {
    throw new RollforwardInputError('The roll-forward returned no usable valuation dates');
  }
  if (newValuationDate < priorValuationDate) {
    throw new RollforwardInputError('The roll-forward returned dates in the wrong order');
  }

  const yearsElapsed = fin(response.years_elapsed);
  const annualAccretion = fin(response.annual_accretion);
  if (yearsElapsed === null || yearsElapsed < 0) {
    throw new RollforwardInputError('The roll-forward returned no usable elapsed time');
  }
  // The floor `rollforward.py` enforces and the check constraint repeats: a
  // rate at or below -100% is a typo rather than an assumption about a company.
  if (annualAccretion === null || annualAccretion <= -1) {
    throw new RollforwardInputError('The roll-forward returned no usable accretion rate');
  }

  return {
    priorValuationDate,
    newValuationDate,
    yearsElapsed,
    priorEquityValue,
    rolledEquityValue,
    annualAccretion,
    calibrationSteps: calibrationSteps(response.calibration_steps),
    materialChanges: materialChanges(response.material_changes),
    // Derived from the list rather than trusted from the flag, so the sentence
    // the panel prints and the rows under it can never disagree — the same rule
    // `measuredCount` follows for the volatility estimate.
    requiresFullRevaluation: materialChanges(response.material_changes).some((c) => c.material),
    prePopulatedInputs: record(response.pre_populated_inputs) ?? {},
  };
}

/**
 * The appreciation the roll-forward should compound at, from a prior run.
 *
 * The engine falls back to a flat 20% when it can find no required return, and
 * that fallback is the right one *inside* the engine — but this service can see
 * something the engine's `prior_results` argument cannot: the discount rate the
 * prior engagement's own income approach concluded. Passing it explicitly turns
 * "the platform's default growth assumption" into "the cost of capital this
 * company's last appraisal concluded", which is the figure a reviewer can
 * actually challenge.
 *
 * Null when the prior run applied no income approach, and the engine's own
 * resolution then stands.
 */
export function priorRequiredReturn(priorResults: unknown): number | null {
  const results = record(priorResults);
  const approaches = record(results?.approaches);
  const income = record(approaches?.income);
  const rate = fin(income?.discount_rate);
  // A cost of capital outside (0, 100%] is not one: the engine's own band on
  // the accretion is wider, and a rate this service *chooses* to send should be
  // one it would defend.
  return rate !== null && rate > 0 && rate <= 1 ? rate : null;
}
