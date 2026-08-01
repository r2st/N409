/**
 * Post-valuation monitoring (feature 10). Once a valuation is complete it can
 * be monitored for events that suggest a fresh 409A is due: a new funding
 * round, a material revenue change, a cap-table change, or the 12-month safe-
 * harbor expiry. Pure functions — callers pass `now` — so trigger evaluation is
 * deterministic and testable.
 */

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

  // 12-month expiry (safe-harbor window).
  if (baseline.valuation_date) {
    const months = monthsBetween(baseline.valuation_date, now);
    if (months >= EXPIRY_MONTHS) {
      triggers.push({
        type: 'expiry',
        level: 'red',
        message: `The valuation is ${months} months old — past the ${EXPIRY_MONTHS}-month safe-harbor window.`,
        signature: `expiry:${EXPIRY_MONTHS}`,
        detail: { months },
      });
    } else if (months >= EXPIRY_WARN_MONTHS) {
      triggers.push({
        type: 'expiry',
        level: 'yellow',
        message: `The valuation is ${months} months old — approaching the ${EXPIRY_MONTHS}-month expiry.`,
        signature: `expiry:${EXPIRY_WARN_MONTHS}`,
        detail: { months },
      });
    }
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
      message: `The cap table changed by ${delta > 0 ? '+' : ''}${delta.toLocaleString()} shares since the valuation.`,
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
