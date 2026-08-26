/**
 * Post-valuation monitoring (feature 10). Once a valuation is complete it can
 * be monitored for events that suggest a fresh 409A is due: a new funding
 * round, a material revenue change, a cap-table change, or the 12-month safe-
 * harbor expiry. Pure functions — callers pass `now` — so trigger evaluation is
 * deterministic and testable.
 */

import { concludes409AFmvPerShare, type SpecialtyKind } from './specialty.js';

export const MONITOR_EVENT_TYPES = {
  enabled: 'monitoring_enabled',
  disabled: 'monitoring_disabled',
  triggerFired: 'monitoring_trigger_fired',
} as const;

/** Fraction of revenue change considered material (409A best practice). */
export const MATERIAL_REVENUE_CHANGE = 0.25;
export const WATCH_REVENUE_CHANGE = 0.15;
/** Safe-harbor validity window. */
export const EXPIRY_MONTHS = 12;
export const EXPIRY_WARN_MONTHS = 10;

export interface MonitorSnapshot {
  /** ISO date the valuation concluded (safe-harbor clock start). */
  valuation_date: string | null;
  fmv_per_share: number | null;
  annual_revenue: number | null;
  fully_diluted_shares: number | null;
  last_round_date: string | null;
  /**
   * Which engine produced the run this snapshot was taken from — `null` for a
   * run of the 409A engine, which is what every kind that has a §409A safe
   * harbor produces.
   *
   * Read off the *current* snapshot rather than the baseline. A baseline is
   * JSONB written once when monitoring was enabled and rows predating this
   * field have no `run_kind` at all, while the current half is reassembled on
   * every read; and the claim being made is about the conclusion in force now,
   * not the one that happened to be latest a year ago.
   */
  run_kind?: SpecialtyKind | null;
}

/**
 * Correct a baseline share count that was snapshotted from the stale cache.
 *
 * `baseline` is JSONB written once when monitoring was enabled, and its
 * `fully_diluted_shares` was copied out of `cap_tables.validation` — the column
 * that counted every preferred share 1:1 until eded249 taught it
 * `conversion_ratio`. The live half of the comparison is now recomputed on read
 * (`withFreshValidation`), so a monitored engagement holding a class that
 * converts at other than 1:1, whose baseline predates that fix, compares an old
 * denominator against a new one and fires a `cap_table_change` reporting a move
 * nobody made. Nothing rewrites a baseline, so it fires on every scan until
 * somebody re-enables monitoring.
 *
 * The baseline cannot be recomputed in general — it is a snapshot of entries as
 * they stood, and those entries are not kept. But it can be recomputed in
 * exactly the case that matters: when the cap table has not been written since
 * the baseline was taken, the rows behind `capTable` *are* the rows the baseline
 * was taken from, so the only thing that can make the two counts differ is the
 * cache the old one was copied out of. Recompute there, and leave the count
 * alone whenever the table has been rewritten since — a difference then may be a
 * real change, and suppressing it would silence the trigger this exists for.
 *
 * `takenAt` is the monitor's `updated_at`: `enableMonitor` is the only writer of
 * `baseline` and it stamps that column, and neither `markChecked` nor the alert
 * writes touch it. `changedAt` is `cap_tables.updated_at`. Either being absent
 * means there is nothing to compare, so the baseline stands.
 */
export function reconcileBaselineShares(
  baseline: MonitorSnapshot,
  capTable: { fully_diluted_shares: number | null; changed_at: Date | string | null } | null,
  takenAt: Date | string | null,
): MonitorSnapshot {
  const live = capTable?.fully_diluted_shares ?? null;
  if (live === null || baseline.fully_diluted_shares === null || live === baseline.fully_diluted_shares) {
    return baseline;
  }
  const changed = asTime(capTable?.changed_at ?? null);
  const taken = asTime(takenAt);
  if (changed === null || taken === null || changed > taken) return baseline;
  return { ...baseline, fully_diluted_shares: live };
}

function asTime(v: Date | string | null): number | null {
  if (v === null) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

export type TriggerLevel = 'green' | 'yellow' | 'red';
export type TriggerType = 'expiry' | 'revenue_change' | 'funding_round' | 'cap_table_change';

export interface MonitorTrigger {
  type: TriggerType;
  level: TriggerLevel;
  message: string;
  /** Stable key so the same firing isn't emailed twice. */
  signature: string;
  detail?: Record<string, unknown>;
}

function monthsBetween(startIso: string, now: Date): number {
  const start = new Date(`${startIso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return 0;
  let months =
    (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + (now.getUTCMonth() - start.getUTCMonth());
  if (now.getUTCDate() < start.getUTCDate()) months -= 1;
  return months;
}

/**
 * Thousands separators for the figures these messages quote — see the longer
 * note on `INT` in `domain/healthChecks.ts`.
 *
 * These two strings are the ones with the furthest reach: the alert email
 * quotes a trigger's `message` verbatim to the assigned reviewer, so a host
 * that resolved a comma-decimal locale mails "The cap table changed by +1.500
 * shares" for a fifteen-hundred-share move. The `signature` beside it is built
 * from the raw number and is unaffected, which is what makes this quiet — the
 * dedupe keeps working and only the sentence a human reads is wrong.
 */
const INT = new Intl.NumberFormat('en-US');

function worse(a: TriggerLevel, b: TriggerLevel): TriggerLevel {
  const rank = { green: 0, yellow: 1, red: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Evaluate the revaluation triggers by comparing the current snapshot to the
 * baseline captured when monitoring began. Returns only firing (yellow/red)
 * triggers.
 */
export function evaluateTriggers(
  baseline: MonitorSnapshot,
  current: MonitorSnapshot,
  now: Date,
): MonitorTrigger[] {
  const triggers: MonitorTrigger[] = [];

  /*
   * 12-month expiry.
   *
   * The window is §409A's: Treasury Regulation §1.409A-1(b)(5)(iv)(B)(1)
   * presumes a valuation reasonable for twelve months, and that presumption is
   * the whole content of the words "safe-harbor window". It attaches to a
   * valuation of common stock *for §409A purposes* — a run that concludes a
   * §409A fair market value per share, which is exactly what
   * {@link concludes409AFmvPerShare} answers.
   *
   * Every kind was getting those words. A monitored EMI engagement is a UK
   * scheme valuation agreed with HMRC and has no §409A anything; an IFRS 2
   * memo measures an award at its grant date; a gift & estate appraisal
   * concludes as of a transfer that already happened. The alert email quotes
   * this sentence verbatim to the assigned reviewer, so the platform was
   * asserting a US tax standard over engagements it does not govern — the same
   * failure as R142's board resolution, one step downstream: a surface whose
   * own words claim a standard the run does not meet.
   *
   * The *fact* still holds and still fires — the engagement really is a year
   * old, and that is worth a reviewer's attention on any kind. What changes is
   * that it is stated as an age rather than as a lapsed presumption, with the
   * kind and the answer recorded in `detail` for anything reading the alert
   * rather than the sentence. The signature is deliberately untouched: it is
   * the dedupe key, and rewording an alert must not re-send one that already
   * went out.
   */
  if (baseline.valuation_date) {
    const months = monthsBetween(baseline.valuation_date, now);
    const kind = current.run_kind ?? null;
    const safeHarbor = kind === null || concludes409AFmvPerShare(kind);
    if (months >= EXPIRY_MONTHS) {
      triggers.push({
        type: 'expiry',
        level: 'red',
        message: safeHarbor
          ? `The valuation is ${months} months old — past the ${EXPIRY_MONTHS}-month safe-harbor window.`
          : `The valuation is ${months} months old — over ${EXPIRY_MONTHS} months since the valuation date.`,
        signature: `expiry:${EXPIRY_MONTHS}`,
        detail: { months, safe_harbor: safeHarbor, kind },
      });
    } else if (months >= EXPIRY_WARN_MONTHS) {
      triggers.push({
        type: 'expiry',
        level: 'yellow',
        message: safeHarbor
          ? `The valuation is ${months} months old — approaching the ${EXPIRY_MONTHS}-month expiry.`
          : `The valuation is ${months} months old — approaching ${EXPIRY_MONTHS} months since the valuation date.`,
        signature: `expiry:${EXPIRY_WARN_MONTHS}`,
        detail: { months, safe_harbor: safeHarbor, kind },
      });
    }
  }

  /*
   * First revenue, which the materiality test below cannot see.
   *
   * That test is a ratio, so it needs a non-zero denominator, and the `> 0`
   * guard that gives it one silently excludes the whole class of company this
   * platform mostly values: the pre-revenue startup. Its baseline is 0, so the
   * check never ran, and an engagement that went from nothing to a first
   * million in bookings — the single most legible event that a 409A no longer
   * holds — monitored green all the way. The guard was written against a
   * division by zero and took the alert with it.
   *
   * From zero there is no percentage to state, which is why this is its own
   * arm rather than a special case inside the ratio, and no threshold to apply
   * either: a company that had no revenue at the measurement date and has
   * revenue now has changed the premise the income and market approaches were
   * weighted on, at any amount. Red, and it says the figure instead of a
   * multiple of nothing.
   *
   * Only an explicit zero. A `null` baseline is a company whose revenue was
   * never recorded, not one that had none, and firing on that would report a
   * change we cannot see rather than one that happened.
   */
  if (baseline.annual_revenue === 0 && current.annual_revenue !== null && current.annual_revenue > 0) {
    triggers.push({
      type: 'revenue_change',
      level: 'red',
      message:
        `The company has begun recognising revenue (${INT.format(Math.round(current.annual_revenue))} ` +
        'annualised) — it had none at the valuation date.',
      signature: `revenue:first:${current.annual_revenue}`,
      detail: { baseline: 0, current: current.annual_revenue, pct: null },
    });
  }

  // Material revenue change.
  if (baseline.annual_revenue !== null && baseline.annual_revenue > 0 && current.annual_revenue !== null) {
    const change = Math.abs(current.annual_revenue - baseline.annual_revenue) / baseline.annual_revenue;
    const pct = Math.round(change * 1000) / 10;
    if (change > MATERIAL_REVENUE_CHANGE) {
      triggers.push({
        type: 'revenue_change',
        level: 'red',
        message: `Revenue has moved ${pct}% since the valuation (over the ${MATERIAL_REVENUE_CHANGE * 100}% materiality threshold).`,
        signature: `revenue:red:${current.annual_revenue}`,
        detail: { baseline: baseline.annual_revenue, current: current.annual_revenue, pct },
      });
    } else if (change > WATCH_REVENUE_CHANGE) {
      triggers.push({
        type: 'revenue_change',
        level: 'yellow',
        message: `Revenue has moved ${pct}% since the valuation.`,
        signature: `revenue:yellow:${current.annual_revenue}`,
        detail: { baseline: baseline.annual_revenue, current: current.annual_revenue, pct },
      });
    }
  }

  // New funding round.
  if (current.last_round_date && current.last_round_date !== baseline.last_round_date) {
    const isNewer =
      !baseline.last_round_date ||
      current.last_round_date.slice(0, 10) > baseline.last_round_date.slice(0, 10);
    if (isNewer) {
      triggers.push({
        type: 'funding_round',
        level: 'red',
        message: `A new funding round closed ${current.last_round_date.slice(0, 10)} since the valuation.`,
        signature: `funding:${current.last_round_date.slice(0, 10)}`,
        detail: { last_round_date: current.last_round_date },
      });
    }
  }

  // Cap-table change (fully diluted share count moved).
  if (
    baseline.fully_diluted_shares !== null &&
    current.fully_diluted_shares !== null &&
    current.fully_diluted_shares !== baseline.fully_diluted_shares
  ) {
    const delta = current.fully_diluted_shares - baseline.fully_diluted_shares;
    const pct = baseline.fully_diluted_shares > 0 ? Math.abs(delta) / baseline.fully_diluted_shares : 1;
    triggers.push({
      type: 'cap_table_change',
      level: pct > 0.05 ? 'red' : 'yellow',
      message: `The cap table changed by ${delta > 0 ? '+' : ''}${INT.format(delta)} shares since the valuation.`,
      signature: `cap_table:${current.fully_diluted_shares}`,
      detail: { baseline: baseline.fully_diluted_shares, current: current.fully_diluted_shares, delta },
    });
  }

  return triggers;
}

/** Worst trigger level across the set (green when nothing fired). */
export function overallStatus(triggers: MonitorTrigger[]): TriggerLevel {
  return triggers.reduce<TriggerLevel>((acc, t) => worse(acc, t.level), 'green');
}
