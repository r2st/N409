/**
 * Stock-option vesting + exercise math (feature 6). Pure functions — no I/O,
 * no clock — so vested/unvested tracking and the exercise-scenario calculator
 * are deterministic and unit-testable. Callers pass `asOf` explicitly.
 */

export const GRANT_EVENT_TYPES = {
  granted: 'grant_issued',
  updated: 'grant_updated',
  cancelled: 'grant_cancelled',
} as const;

export interface VestingTemplate {
  key: string;
  label: string;
  vestingMonths: number;
  cliffMonths: number;
  /** Vesting cadence in months (1 = monthly, 3 = quarterly). */
  frequencyMonths: number;
}

/** Built-in templates; 'custom' lets the analyst specify the months directly. */
export const VESTING_TEMPLATES: readonly VestingTemplate[] = [
  { key: 'standard_4yr_1yr_cliff', label: '4-year monthly, 1-year cliff', vestingMonths: 48, cliffMonths: 12, frequencyMonths: 1 },
  { key: 'four_year_no_cliff', label: '4-year monthly, no cliff', vestingMonths: 48, cliffMonths: 0, frequencyMonths: 1 },
  { key: 'three_year_quarterly', label: '3-year quarterly, 1-year cliff', vestingMonths: 36, cliffMonths: 12, frequencyMonths: 3 },
] as const;

export function templateByKey(key: string): VestingTemplate | undefined {
  return VESTING_TEMPLATES.find((t) => t.key === key);
}

export interface VestingSchedule {
  totalShares: number;
  /** ISO date string or a Date (pg returns `date` columns as Date objects). */
  vestingStartDate: string | Date;
  vestingMonths: number;
  cliffMonths: number;
  frequencyMonths: number;
}

/** Coerce a Date or ISO string to a bare YYYY-MM-DD date string. */
export function toIsoDate(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** Whole months from `start` up to `asOf` (never negative). */
export function monthsElapsed(start: string | Date, asOf: Date): number {
  const startDate = new Date(`${toIsoDate(start)}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime())) return 0;
  let months =
    (asOf.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
    (asOf.getUTCMonth() - startDate.getUTCMonth());
  // Not a full month until the day-of-month is reached.
  if (asOf.getUTCDate() < startDate.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

export interface VestingStatus {
  totalShares: number;
  vestedShares: number;
  unvestedShares: number;
  percentVested: number;
  monthsElapsed: number;
  fullyVested: boolean;
  cliffCleared: boolean;
}

/**
 * Shares vested as of `asOf`. Nothing vests before the cliff; at the cliff the
 * pro-rata amount for the elapsed months vests at once, then it accrues each
 * period until fully vested. Vested counts are floored to whole shares.
 */
export function vestingStatus(schedule: VestingSchedule, asOf: Date): VestingStatus {
  const total = Math.max(0, Math.floor(schedule.totalShares));
  const elapsed = monthsElapsed(schedule.vestingStartDate, asOf);
  const cliffCleared = elapsed >= schedule.cliffMonths;

  let vested: number;
  if (schedule.vestingMonths <= 0) {
    vested = total; // degenerate: fully vested immediately
  } else if (!cliffCleared) {
    vested = 0;
  } else if (elapsed >= schedule.vestingMonths) {
    vested = total;
  } else {
    // Round elapsed down to the vesting cadence so quarterly grants only vest
    // on period boundaries.
    const freq = Math.max(1, schedule.frequencyMonths);
    const periodsElapsed = Math.floor(elapsed / freq) * freq;
    vested = Math.floor((total * periodsElapsed) / schedule.vestingMonths);
  }
  vested = Math.min(total, Math.max(0, vested));
  return {
    totalShares: total,
    vestedShares: vested,
    unvestedShares: total - vested,
    percentVested: total > 0 ? Math.round((vested / total) * 10000) / 100 : 0,
    monthsElapsed: elapsed,
    fullyVested: vested >= total && total > 0,
    cliffCleared,
  };
}

export interface VestingPoint {
  monthOffset: number;
  date: string;
  cumulativeVested: number;
}

/** Add `months` to an ISO date, clamping the day of month. */
function addMonths(start: string | Date, months: number): string {
  const d = new Date(`${toIsoDate(start)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/**
 * Cumulative vested shares at each cadence boundary over the vesting term — the
 * data behind the timeline chart. Includes the cliff jump and a t=0 point.
 */
export function vestingTimeline(schedule: VestingSchedule): VestingPoint[] {
  const total = Math.max(0, Math.floor(schedule.totalShares));
  const freq = Math.max(1, schedule.frequencyMonths);
  const points: VestingPoint[] = [
    { monthOffset: 0, date: toIsoDate(schedule.vestingStartDate), cumulativeVested: 0 },
  ];
  for (let m = freq; m <= schedule.vestingMonths; m += freq) {
    const asOf = new Date(`${addMonths(schedule.vestingStartDate, m)}T00:00:00Z`);
    const status = vestingStatus(schedule, asOf);
    points.push({ monthOffset: m, date: addMonths(schedule.vestingStartDate, m), cumulativeVested: status.vestedShares });
  }
  // Ensure the final point shows full vesting even if the term isn't a clean
  // multiple of the cadence.
  const last = points[points.length - 1]!;
  if (last.cumulativeVested < total) {
    points.push({
      monthOffset: schedule.vestingMonths,
      date: addMonths(schedule.vestingStartDate, schedule.vestingMonths),
      cumulativeVested: total,
    });
  }
  return points;
}

export interface ExerciseScenario {
  fmv: number;
  spreadPerShare: number;
  /** Value of exercising every share (assumes fully vested). */
  grossValue: number;
  /** Cost to exercise every share at the strike. */
  exerciseCost: number;
  /** Multiple of the current 409A FMV this scenario represents. */
  multipleOfCurrent: number;
}

/**
 * Potential value of a grant at a set of future per-share values. `grossValue`
 * is the in-the-money spread across all shares; a below-strike FMV yields zero
 * (options aren't exercised at a loss).
 */
export function exerciseScenarios(
  input: { totalShares: number; exercisePrice: number; currentFmv: number },
  futureFmvs: number[],
): ExerciseScenario[] {
  const shares = Math.max(0, Math.floor(input.totalShares));
  return futureFmvs.map((fmv) => {
    const spread = Math.max(0, fmv - input.exercisePrice);
    return {
      fmv,
      spreadPerShare: Math.round(spread * 10000) / 10000,
      grossValue: Math.round(spread * shares * 100) / 100,
      exerciseCost: Math.round(input.exercisePrice * shares * 100) / 100,
      multipleOfCurrent: input.currentFmv > 0 ? Math.round((fmv / input.currentFmv) * 100) / 100 : 0,
    };
  });
}

/** Default what-if ladder: 1×, 2×, 5×, 10× the current 409A FMV. */
export function defaultScenarioFmvs(currentFmv: number): number[] {
  return [1, 2, 5, 10].map((mult) => Math.round(currentFmv * mult * 10000) / 10000);
}
