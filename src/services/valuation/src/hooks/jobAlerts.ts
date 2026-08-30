import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { JOB_SOURCES, JOB_SOURCE_LABELS } from '../domain/jobQueue.js';
import { evaluateJobAlerts, observeQueues } from '../domain/jobAlerts.js';
import { dbNow, jobStats, oldestActiveJobs } from '../repos/jobs.js';
import {
  deliverJobAlertAnnouncement,
  listJobAlertRules,
  pendingJobAlertAnnouncements,
  reconcileJobAlerts,
  type JobAlertRow,
  type ReconcileResult,
} from '../repos/jobAlerts.js';
import { createNotifications } from '../repos/notifications.js';
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
 * Which announcements are owed is read back from the ledger rather than taken
 * from this scan's reconcile result, and each is delivered in a transaction
 * that also stamps it as delivered. That is what makes an announcement survive
 * a scan that fails partway through it: reconciling had already committed, so
 * under the original code a throw while notifying alert one left alerts two and
 * three recorded as open, never announced, and permanently silent — the next
 * scan saw them as `ongoing`. Delivery is now retried until it lands, and one
 * alert's failure is contained to that alert. See migration 0157.
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
}): Promise<ReconcileResult & { evaluated: number; notified: AnnouncementTally }> {
  const rules = await listJobAlertRules(deps.pool);
  const enabled = rules.filter((r) => r.enabled);
  if (enabled.length === 0) {
    // No enabled rule means nothing can be true, so everything open resolves.
    // Reconciling with an empty finding list is what makes that happen rather
    // than leaving yesterday's alerts up with nothing to close them.
    //
    // The announcement pass runs on this path too. Disabling every rule closes
    // the open alerts, and those recoveries are owed to the same operator —
    // returning early here would resolve them in the ledger and tell nobody,
    // which is the failure the rest of this file exists to remove.
    const result = await reconcileJobAlerts(deps.pool, []);
    return { ...result, evaluated: 0, notified: await announceJobAlerts(deps) };
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

  const notified = await announceJobAlerts(deps);

  return { ...result, evaluated: findings.length, notified };
}

export interface AnnouncementTally {
  opened: number;
  resolved: number;
  /** Announcements still owed after this pass; the next scan retries them. */
  failed: number;
}

/**
 * Send every announcement the ledger still owes.
 *
 * Each is its own transaction, and each is wrapped on its own: a failure here is
 * a transient database problem, and the queue that is stalled is usually stalled
 * *because* the database is unwell, so one alert failing to send is the case to
 * design for rather than the exception. Containing it to that alert means the
 * other four queues still reach an operator, and leaving the row unstamped means
 * the fifth reaches them on the next tick instead of never.
 */
async function announceJobAlerts(deps: {
  pool: pg.Pool;
  log?: FastifyBaseLogger;
}): Promise<AnnouncementTally> {
  const pending = await pendingJobAlertAnnouncements(deps.pool);
  const tally: AnnouncementTally = { opened: 0, resolved: 0, failed: 0 };
  if (pending.opened.length === 0 && pending.resolved.length === 0) return tally;

  const recipients = await listUserIdsWithRoles(deps.pool, JOB_ALERT_ROLES);

  // Opening announcements first: an alert that cleared before it was ever
  // announced owes both, and "recovered" reads as a non-sequitur on its own.
  for (const alert of pending.opened) {
    const sent = await announce(deps, alert, 'opened', recipients, tally);
    if (sent) tally.opened += 1;
  }
  for (const alert of pending.resolved) {
    const sent = await announce(deps, alert, 'resolved', recipients, tally);
    if (sent) tally.resolved += 1;
  }
  return tally;
}

/** One announcement, contained. Returns whether this call delivered it. */
async function announce(
  deps: { pool: pg.Pool; log?: FastifyBaseLogger },
  alert: JobAlertRow,
  which: 'opened' | 'resolved',
  recipients: readonly string[],
  tally: AnnouncementTally,
): Promise<boolean> {
  try {
    return await deliverJobAlertAnnouncement(deps.pool, alert.id, which, async (tx, row) => {
      if (which === 'opened') {
        deps.log?.warn(
          { source: row.source, kind: row.kind, observed: row.observed },
          'job queue alert opened',
        );
        await recordAdminEvent(tx, {
          type: 'job_alert_opened',
          actor: { actorType: 'system', actorId: 'job-alerts', source: 'monitor' },
          subjectType: 'job_queue',
          subjectId: null,
          subjectLabel: JOB_SOURCE_LABELS[row.source],
          payload: {
            source: row.source,
            kind: row.kind,
            observed: row.observed,
            threshold: row.threshold,
          },
        });
        await createNotifications(
          tx,
          recipients.map((userId) => ({
            userId,
            type: 'job_alert',
            // The monitor is the page this alert is asking somebody to open,
            // and until migration 0188 the notification could not name it.
            link: '/admin/jobs',
            title:
              row.kind === 'stalled'
                ? `${JOB_SOURCE_LABELS[row.source]} queue looks stalled`
                : `${JOB_SOURCE_LABELS[row.source]} queue is failing`,
            body: row.detail,
          })),
        );
        return;
      }

      deps.log?.info({ source: row.source, kind: row.kind }, 'job queue alert resolved');
      await recordAdminEvent(tx, {
        type: 'job_alert_resolved',
        actor: { actorType: 'system', actorId: 'job-alerts', source: 'monitor' },
        subjectType: 'job_queue',
        subjectId: null,
        subjectLabel: JOB_SOURCE_LABELS[row.source],
        payload: {
          source: row.source,
          kind: row.kind,
          // How long it went on, which is the figure a post-mortem wants and
          // the one nothing else records once the queue drains.
          open_minutes: Math.round(
            (new Date(row.resolved_at ?? Date.now()).getTime() - new Date(row.opened_at).getTime()) / 60_000,
          ),
        },
      });
      // Recovery is notified too. An alert that arrives and never says it is
      // over leaves an operator checking a page to find out, which is the habit
      // the alert was supposed to replace.
      await createNotifications(
        tx,
        recipients.map((userId) => ({
          userId,
          type: 'job_alert_resolved',
          link: '/admin/jobs',
          title: `${JOB_SOURCE_LABELS[row.source]} queue recovered`,
          body: row.detail,
        })),
      );
    });
  } catch (err) {
    // Logged at error, not warn: the row stays unstamped and will be retried,
    // but an announcement that keeps failing is an operator not being told
    // about a stalled queue, which is the failure this subsystem exists to
    // prevent and must not scroll past as a warning.
    deps.log?.error(
      { err, alertId: alert.id, source: alert.source, kind: alert.kind, announcement: which },
      'job queue alert announcement failed; still owed, will retry next scan',
    );
    tally.failed += 1;
    return false;
  }
}
