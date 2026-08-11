import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { JOB_SOURCES, JOB_SOURCE_LABELS } from '../domain/jobQueue.js';
import { evaluateJobAlerts, observeQueues } from '../domain/jobAlerts.js';
import { dbNow, jobStats, oldestActiveJobs } from '../repos/jobs.js';
import { listJobAlertRules, reconcileJobAlerts, type ReconcileResult } from '../repos/jobAlerts.js';
import { createNotification } from '../repos/notifications.js';
import { listUserIdsWithRoles } from '../repos/users.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { JOB_ALERT_ROLES } from '../domain/roles.js';

/**
 * The job-monitor alert sweep (design §17.1 item 13).
 *
 * Reads the same two queries the monitor page reads — `jobStats` and
 * `oldestActiveJobs` — evaluates them against the per-queue thresholds, and
 * reconciles the alert ledger. Reachable from the boot interval and from the
 * ops-triggered route, and safe to run from several instances at once: the
 * reconciler takes an advisory lock.
 *
 * Notifications go out on `opened` and `resolved` only. `ongoing` is deliberate
 * silence — see `reconcileJobAlerts`.
 *
 * The failure window comes from the rules rather than being fixed here, and the
 * stats query is run once at the widest window any enabled rule asks for, then
 * counted per queue. Running it once per source would be five scans of five
 * unioned tables every tick to answer one question.
 */
export async function runJobAlertScan(deps: {
  pool: pg.Pool;
  log?: FastifyBaseLogger;
  now?: Date;
}): Promise<ReconcileResult & { evaluated: number }> {
  const rules = await listJobAlertRules(deps.pool);
  const enabled = rules.filter((r) => r.enabled);
  if (enabled.length === 0) {
    // No enabled rule means nothing can be true, so everything open resolves.
    // Reconciling with an empty finding list is what makes that happen rather
    // than leaving yesterday's alerts up with nothing to close them.
    const result = await reconcileJobAlerts(deps.pool, []);
    return { ...result, evaluated: 0 };
  }

  const windowHours = Math.max(...enabled.map((r) => r.failure_window_hours));
  // The clock is read from the database alongside the stats, not from the
  // process. Every `created_at` being subtracted was written by Postgres, so
  // this is the one clock that makes the difference an age rather than an age
  // plus the drift between two hosts. See `dbNow`.
  const [stats, oldest, observedAt] = await Promise.all([
    jobStats(deps.pool, windowHours),
    oldestActiveJobs(deps.pool),
    deps.now ? Promise.resolve(deps.now) : dbNow(deps.pool),
  ]);

  const findings = evaluateJobAlerts(observeQueues(JOB_SOURCES, stats, oldest), rules, observedAt);
  const result = await reconcileJobAlerts(deps.pool, findings);

  if (result.opened.length > 0 || result.resolved.length > 0) {
    const recipients = await listUserIdsWithRoles(deps.pool, JOB_ALERT_ROLES);
    for (const alert of result.opened) {
      deps.log?.warn(
        { source: alert.source, kind: alert.kind, observed: alert.observed },
        'job queue alert opened',
      );
      await recordAdminEvent(deps.pool, {
        type: 'job_alert_opened',
        actor: { actorType: 'system', actorId: 'job-alerts', source: 'monitor' },
        subjectType: 'job_queue',
        subjectId: null,
        subjectLabel: JOB_SOURCE_LABELS[alert.source],
        payload: {
          source: alert.source,
          kind: alert.kind,
          observed: alert.observed,
          threshold: alert.threshold,
        },
      });
      for (const userId of recipients) {
        await createNotification(deps.pool, {
          userId,
          type: 'job_alert',
          title:
            alert.kind === 'stalled'
              ? `${JOB_SOURCE_LABELS[alert.source]} queue looks stalled`
              : `${JOB_SOURCE_LABELS[alert.source]} queue is failing`,
          body: alert.detail,
        });
      }
    }
    for (const alert of result.resolved) {
      deps.log?.info({ source: alert.source, kind: alert.kind }, 'job queue alert resolved');
      await recordAdminEvent(deps.pool, {
        type: 'job_alert_resolved',
        actor: { actorType: 'system', actorId: 'job-alerts', source: 'monitor' },
        subjectType: 'job_queue',
        subjectId: null,
        subjectLabel: JOB_SOURCE_LABELS[alert.source],
        payload: {
          source: alert.source,
          kind: alert.kind,
          // How long it went on, which is the figure a post-mortem wants and
          // the one nothing else records once the queue drains.
          open_minutes: Math.round(
            (new Date(alert.resolved_at ?? Date.now()).getTime() - new Date(alert.opened_at).getTime()) /
              60_000,
          ),
        },
      });
      // Recovery is notified too. An alert that arrives and never says it is
      // over leaves an operator checking a page to find out, which is the habit
      // the alert was supposed to replace.
      for (const userId of recipients) {
        await createNotification(deps.pool, {
          userId,
          type: 'job_alert_resolved',
          title: `${JOB_SOURCE_LABELS[alert.source]} queue recovered`,
          body: alert.detail,
        });
      }
    }
  }

  return { ...result, evaluated: findings.length };
}
