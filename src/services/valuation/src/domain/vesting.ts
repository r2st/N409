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
  {
    key: 'standard_4yr_1yr_cliff',
    label: '4-year monthly, 1-year cliff',
    vestingMonths: 48,
    cliffMonths: 12,
    frequencyMonths: 1,
  },
  {
    key: 'four_year_no_cliff',
    label: '4-year monthly, no cliff',
    vestingMonths: 48,
    cliffMonths: 0,
    frequencyMonths: 1,
  },
  {
    key: 'three_year_quarterly',
    label: '3-year quarterly, 1-year cliff',
    vestingMonths: 36,
    cliffMonths: 12,
    frequencyMonths: 3,
  },
] as const;

export function templateByKey(key: string): VestingTemplate | undefined {
  return VESTING_TEMPLATES.find((t) => t.key === key);
}

/**
 * The key that means "not one of the built-ins — the schedule is spelled out in
 * the request". The grant form offers it alongside the templates.
 */
export const CUSTOM_TEMPLATE_KEY = 'custom';

/**
 * Template keys a grant may be *issued* under.
 *
 * `templateByKey` returning undefined is how an unrecognised key used to be
 * handled, and every caller treated that as "fall back to the defaults". A
 * misspelled key therefore issued a standard 4-year, 1-year-cliff grant while
 * storing the misspelling in `vesting_template`, so the row's own label
 * disagreed with the schedule it vests on — an option grant is a contract, and
 * the disagreement is not visible anywhere in the UI. Unrecognised is now
 * refused at the write boundary instead.
 *
 * Deliberately narrower than what the *column* holds: the HRIS importer writes
 * `imported` for grants whose schedule came from an external system, and that
 * is provenance rather than a schedule this service chose. The check belongs on
 * the routes that pick a schedule, not on the repo.
 */
export const ISSUABLE_TEMPLATE_KEYS: readonly string[] = [
  ...VESTING_TEMPLATES.map((t) => t.key),
  CUSTOM_TEMPLATE_KEY,
];

export function isIssuableTemplate(key: string): boolean {
  return ISSUABLE_TEMPLATE_KEYS.includes(key);
}

/**
 * The range a vesting schedule's month figures may occupy.
 *
 * Exported because the manual grant routes are not the only writer. They bound
 * these in zod; the HRIS importer maps a provider's payload straight onto a
 * grant row and bounded nothing, so a schedule the API refuses could still be
 * imported — see `clampScheduleMonths`, which is what that path now uses.
 *
 * 240 months is twenty years. Real schedules run to four, occasionally ten;
 * the ceiling is not a modelling opinion, it is the point past which the figure
 * is not a schedule.
 */
export const VESTING_MONTHS_MAX = 240;
export const CLIFF_MONTHS_MAX = 120;
export const FREQUENCY_MONTHS_MAX = 12;

export interface VestingSchedule {
  totalShares: number;
  /** ISO date string or a Date (pg returns `date` columns as Date objects). */
  vestingStartDate: string | Date;
  vestingMonths: number;
  cliffMonths: number;
  frequencyMonths: number;
}

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
};

/**
 * Force a schedule's three month figures into the range the grant routes
 * enforce, for callers taking them from somewhere that is not a validated
 * request body.
 *
 * Clamped rather than refused, because the caller is the HRIS importer and the
 * alternative is dropping an employee's grant on the floor over a field the
 * analyst can correct afterwards — which is the same judgement the mapper
 * already makes when it fills an absent schedule with 48/12/1. A provider
 * sending a figure outside these bounds is sending garbage, not a long vest.
 *
 * A cliff past the end of the vest is clamped to the vest for the same reason:
 * the routes refuse that pairing, and here refusing means losing the grant.
 */
export function clampScheduleMonths(input: {
  vestingMonths?: unknown;
  cliffMonths?: unknown;
  frequencyMonths?: unknown;
}): { vestingMonths: number; cliffMonths: number; frequencyMonths: number } {
  const vestingMonths = clampInt(input.vestingMonths, 0, VESTING_MONTHS_MAX, 48);
  return {
    vestingMonths,
    cliffMonths: Math.min(vestingMonths, clampInt(input.cliffMonths, 0, CLIFF_MONTHS_MAX, 12)),
    frequencyMonths: clampInt(input.frequencyMonths, 1, FREQUENCY_MONTHS_MAX, 1),
  };
}

/** Coerce a Date or ISO string to a bare YYYY-MM-DD date string. */
export function toIsoDate(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * Whole months from `start` up to `asOf` (never negative).
 *
 * The day-of-month test has to mirror the clamping `addMonths` does, or the two
 * stop being inverses. A grant vesting from 31 August has its month-15 cadence
 * point on 30 November — `addMonths` clamps it there, because November has no
 * 31st. Asked how many months had elapsed on that very date, this returned 14:
 * 30 is less than 31, so the month was judged incomplete on the one day it
 * could ever complete on. Quarterly, that reported the previous quarter's
 * total, so the timeline chart stalled at exactly the anniversaries it plots —
 * 30 November and 28 February both showed the tranche before them.
 *
 * A day-of-month short of the start's is therefore only incomplete when the
 * month it falls in actually has that day to reach. On the last day of a
 * shorter month the anniversary has arrived, clamped.
 */
export function monthsElapsed(start: string | Date, asOf: Date): number {
  const startDate = new Date(`${toIsoDate(start)}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime())) return 0;
  let months =
    (asOf.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
    (asOf.getUTCMonth() - startDate.getUTCMonth());
  const asOfDay = asOf.getUTCDate();
  if (asOfDay < startDate.getUTCDate() && asOfDay < daysInMonth(asOf.getUTCFullYear(), asOf.getUTCMonth())) {
    months -= 1;
  }
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

/** Last day of `month` (0-11) in `year`, as a day-of-month. */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one. Set through
  // setUTCFullYear rather than Date.UTC so a year below 100 stays itself.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month + 1, 0);
  return probe.getUTCDate();
}

/**
 * Add `months` to an ISO date, clamping the day of month.
 *
 * `setUTCMonth(getUTCMonth() + n)` does not clamp, it overflows: 31 January
 * plus one month is 31 February, which JS rolls into 3 March. A grant vesting
 * from month-end therefore produced a timeline whose first cadence point
 * landed in March and whose second landed in March as well — February never
 * appeared, and two periods shared a month. Month-end grant dates are not an
 * edge case in this domain; boards routinely date grants to the last day of a
 * quarter.
 */
export function addMonths(start: string | Date, months: number): string {
  const iso = toIsoDate(start);
  const [y, m, d] = iso.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return iso;
  // Zero-based month index counted from January of year `y`, so a negative
  // `months` borrows years correctly rather than landing on month -1.
  const absolute = m! - 1 + Math.trunc(months);
  const year = y! + Math.floor(absolute / 12);
  const month = ((absolute % 12) + 12) % 12;
  const out = new Date(0);
  out.setUTCFullYear(year, month, Math.min(d!, daysInMonth(year, month)));
  // A Date holds ±8.64e15 ms — about ±273,000 years — and `toISOString` does not
  // return anything past that, it throws `RangeError: Invalid time value`. That
  // is roughly 3.3 million months, so it takes a schedule no validated request
  // body could carry; the unvalidated ones reaching this were the bug that
  // `clampScheduleMonths` closes. Returning the date unmoved keeps a stored row
  // that predates the clamp from turning a grant page into a 500, which is the
  // one thing worse than a wrong-looking timeline.
  const stamp = out.getTime();
  if (!Number.isFinite(stamp)) return iso;
  return out.toISOString().slice(0, 10);
}

/**
 * Cumulative vested shares at each cadence boundary over the vesting term — the
 * data behind the timeline chart. Includes the cliff jump and a t=0 point.
 */
export function vestingTimeline(schedule: VestingSchedule): VestingPoint[] {
  const total = Math.max(0, Math.floor(schedule.totalShares));
  const freq = Math.max(1, schedule.frequencyMonths);
  // One point per cadence step, so the array and the work are both set by
  // `vestingMonths` — a figure that arrives on the row rather than on the
  // request. The routes cap it at 240; the HRIS importer did not, and a row
  // holding 2,000,000 built a two-million-element array in six seconds of
  // blocked event loop, on a GET any reader of the valuation can make. Capping
  // here as well as at the two writers, because the rows are already stored.
  const months = Math.min(schedule.vestingMonths, VESTING_MONTHS_MAX);
  const points: VestingPoint[] = [
    { monthOffset: 0, date: toIsoDate(schedule.vestingStartDate), cumulativeVested: 0 },
  ];
  for (let m = freq; m <= months; m += freq) {
    const asOf = new Date(`${addMonths(schedule.vestingStartDate, m)}T00:00:00Z`);
    const status = vestingStatus(schedule, asOf);
    points.push({
      monthOffset: m,
      date: addMonths(schedule.vestingStartDate, m),
      cumulativeVested: status.vestedShares,
    });
  }
  // Ensure the final point shows full vesting even if the term isn't a clean
  // multiple of the cadence.
  const last = points[points.length - 1]!;
  if (last.cumulativeVested < total) {
    points.push({
      monthOffset: months,
      date: addMonths(schedule.vestingStartDate, months),
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
/**
 * How many what-if FMVs one grant panel may be asked for. The default ladder
 * below is four; twenty is well past any ladder a person reads, and keeps a
 * comma-separated query parameter from turning a short request into a long
 * response.
 */
export const MAX_SCENARIO_FMVS = 20;

export function defaultScenarioFmvs(currentFmv: number): number[] {
  return [1, 2, 5, 10].map((mult) => Math.round(currentFmv * mult * 10000) / 10000);
}
