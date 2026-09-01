import { ACTIVE_JOB_STATUSES, JOB_SOURCE_LABELS, type JobSource, type JobStats } from './jobQueue.js';

/**
 * When a background queue is in trouble (design §17.1 item 13).
 *
 * The monitor has always been able to say how many jobs are in each state. What
 * it could not say is whether that number is a problem, and the reason is in
 * `oldestActiveJobs`' own docstring: a count cannot distinguish a busy queue
 * from a stopped one. Five hundred queued emails on a Monday morning is the
 * platform working. One email queued since Thursday is a dead SMTP host, and
 * the second is invisible in every count on the page.
 *
 * So there are two conditions and they measure different things:
 *
 *   * **stalled** — the oldest job that is *due now* has been due for longer
 *     than the queue's window. This is the one that catches a stopped worker,
 *     and it is the reason the age is measured rather than the depth. Due
 *     rather than merely outstanding, because two of the queues express a
 *     deliberate backoff as an active status and a receiver that is down is
 *     not a queue that is stalled — see `oldestActiveJobs`.
 *   * **failing** — more than N jobs failed inside the window. This catches a
 *     queue that is moving fine and getting every answer wrong, which the age
 *     check cannot see at all because a failed job is not outstanding.
 *
 * Pure, and deliberately so: the evaluator takes a clock and returns findings.
 * Everything about persistence, de-duplication and who gets told lives in the
 * repo and the hook, so the rules themselves can be tested against a table of
 * inputs rather than against a database at a particular moment.
 */

export const JOB_ALERT_KINDS = ['stalled', 'failing'] as const;
export type JobAlertKind = (typeof JOB_ALERT_KINDS)[number];

export interface JobAlertRule {
  source: JobSource;
  enabled: boolean;
  stall_minutes: number;
  failure_count: number;
  failure_window_hours: number;
}

/** One queue's current state, as `jobStats` + `oldestActiveJobs` report it. */
export interface QueueObservation {
  source: JobSource;
  /**
   * When the oldest job that is *due now* became due, or null when nothing is.
   *
   * Not the oldest active job: a webhook delivery waiting out its backoff and
   * an outbox row on its retry ladder are both still owed and both perfectly
   * healthy. `oldestActiveJobs` explains why the distinction is what keeps this
   * rule from paging an operator about a partner's downtime.
   */
  oldestActiveAt: Date | null;
  active: number;
  failed: number;
}

export interface JobAlertFinding {
  source: JobSource;
  kind: JobAlertKind;
  detail: string;
  /** The measured figure: minutes for `stalled`, a count for `failing`. */
  observed: number;
  threshold: number;
}

/** `4h 12m`, `18m` — how an operator reads a queue age. */
export function humanMinutes(minutes: number): string {
  const whole = Math.floor(minutes);
  if (whole < 60) return `${whole}m`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours < 24) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

/**
 * Fold the per-(source, status) stats and the oldest-active rows into one
 * observation per queue.
 *
 * Sources with no rows at all still appear, with a null age and zero counts —
 * an empty queue is a fact the evaluator needs, and dropping it would make
 * "nothing has run all day" indistinguishable from "this queue is healthy".
 */
export function observeQueues(
  sources: readonly JobSource[],
  stats: readonly JobStats[],
  oldest: readonly { source: JobSource; oldest_due_at: Date; active: number }[],
  /**
   * Failed counts already struck over each source's *own* rule window, when the
   * caller has them (`repos/jobs.failedJobCounts`).
   *
   * `stats` carries one window for every queue, which is what the monitor page
   * asks for and not what the rules mean: a rule reading "five failures in an
   * hour" evaluated against a day of them fires on failures it was never meant
   * to see, and says "in the last 1h" while doing it. The alert sweep passes
   * this; the monitor page has no per-source window and passes nothing, and
   * falls back to counting `stats` as before.
   *
   * A source absent from the map has no failures inside its window — the query
   * groups, so it returns no row rather than a zero.
   */
  failedBySource?: ReadonlyMap<JobSource, number>,
): QueueObservation[] {
  return sources.map((source) => {
    const mine = stats.filter((s) => s.source === source);
    const head = oldest.find((o) => o.source === source);
    return {
      source,
      oldestActiveAt: head ? new Date(head.oldest_due_at) : null,
      active: mine.reduce((n, s) => (ACTIVE_JOB_STATUSES.includes(s.status) ? n + s.count : n), 0),
      failed:
        failedBySource === undefined
          ? mine.reduce((n, s) => (s.status === 'failed' ? n + s.count : n), 0)
          : (failedBySource.get(source) ?? 0),
    };
  });
}

/**
 * The findings for one scan.
 *
 * A disabled rule produces nothing — not a suppressed finding. The difference
 * matters downstream: the reconciler resolves any open alert it does not see,
 * so disabling a rule closes its alert rather than freezing it open forever.
 */
export function evaluateJobAlerts(
  observations: readonly QueueObservation[],
  rules: readonly JobAlertRule[],
  now: Date,
): JobAlertFinding[] {
  const findings: JobAlertFinding[] = [];
  for (const observation of observations) {
    const rule = rules.find((r) => r.source === observation.source);
    if (!rule || !rule.enabled) continue;

    if (observation.oldestActiveAt) {
      const minutes = (now.getTime() - observation.oldestActiveAt.getTime()) / 60_000;
      if (minutes > rule.stall_minutes) {
        findings.push({
          source: observation.source,
          kind: 'stalled',
          observed: Math.round(minutes * 100) / 100,
          threshold: rule.stall_minutes,
          detail:
            `${JOB_SOURCE_LABELS[observation.source]}: oldest due job has been waiting ` +
            `${humanMinutes(minutes)} (threshold ${humanMinutes(rule.stall_minutes)}), ` +
            `${observation.active} still owed`,
        });
      }
    }

    if (observation.failed >= rule.failure_count) {
      findings.push({
        source: observation.source,
        kind: 'failing',
        observed: observation.failed,
        threshold: rule.failure_count,
        detail:
          `${JOB_SOURCE_LABELS[observation.source]}: ${observation.failed} failures in the last ` +
          `${rule.failure_window_hours}h (threshold ${rule.failure_count})`,
      });
    }
  }
  return findings;
}
