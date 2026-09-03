import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { JOB_SOURCES, JOB_SOURCE_LABELS, type JobSource } from '../domain/jobQueue.js';
import {
  evaluateJobAlerts,
  observeQueues,
  type JobAlertKind,
  type JobAlertRule,
} from '../domain/jobAlerts.js';
import { dbNow, failedJobCounts, jobStats, oldestActiveJobs } from '../repos/jobs.js';
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
import { SWEEP_LOCKS, withSweepLock } from '../db/sweepLock.js';
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
 * The failure window comes from the rules rather than being fixed here, and it
 * is each rule's own window. It used to be the widest window any enabled rule
 * asked for, applied to all of them — one scan instead of five, and a different
 * question than the rules ask: a webhook rule reading "five failures in an
 * hour" beside an email rule reading "twenty in a day" counted the webhook's
 * failures over the day as well, so it opened on failures it was never meant to
 * see and the alert text said "in the last 1h" for a count that covered
 * twenty-four. `failedJobCounts` joins the per-source windows inside the one
 * scan, so the windows are the rules' own and the union is still read once.
 */
/** One queue's alert, as the gauge below reports it. */
export interface OpenJobAlert {
  source: JobSource;
  kind: JobAlertKind;
}

/**
 * The alerts this ledger held open at the end of the last scan.
 *
 * `null` until a scan has finished, which is the difference between "no queue
 * is in trouble" and "nothing has looked". The gauge reports nothing at all in
 * that state rather than a row of reassuring zeros — a sweep that is not
 * running is `SweepStopped`'s question, not this one's.
 *
 * Why a snapshot rather than a query at scrape time: a gauge's `collect` runs
 * inside the request that scrapes and must be cheap and synchronous, for the
 * reason `MetricsRegistry.gauge` gives — a scrape that queries the database
 * turns a monitoring poll into load on the thing being monitored, hardest
 * exactly when the database is already the problem. The scan already reads this
 * state on its own schedule; this is that read, kept.
 */
let openAlerts: readonly OpenJobAlert[] | null = null;

/**
 * Whether each queue in `JOB_SOURCES` is being watched at all.
 *
 * `job_queue_alert_open` reports a 0 per queue meaning "the monitor is holding
 * no alert here", and R321 was right that publishing it beats leaving a rule to
 * infer health from an absent series. What it could not say is the third state
 * underneath both: a queue with no *enabled rule* produces no findings at all
 * (`evaluateJobAlerts` skips it, and `reconcileJobAlerts` resolves whatever was
 * open), so it reported the same confident zero as a healthy watched queue —
 * and `JobQueueAlertOpen` could never fire for it again. The comment on
 * `auto_pipeline_runs_pending` delegates every DB-backed backlog to this sweep,
 * so for the outbox and the webhook deliveries that zero was the only thing
 * anybody had.
 *
 * Two ways in, and they are different incidents. `disabled` is an operator
 * choice made in the admin console and is supported — nothing alerts on it, for
 * the reason `background_sweep_enabled == 0` has no rule either.
 * `unconfigured` is a source in this codebase's `JOB_SOURCES` with no row in
 * `job_alert_rules`: nobody chose to stop watching it, a migration simply never
 * seeded it, and the queue has been unwatched since the day it was added.
 *
 * Same snapshot discipline as `openAlerts` above — read by the scan on its own
 * schedule, never by the scrape.
 */
let ruleStates: Readonly<Record<JobSource, JobAlertRuleState>> | null = null;

/** The three states a queue's alert rule can be in. A state-set, like the circuits. */
export const JOB_ALERT_RULE_STATES = ['enabled', 'disabled', 'unconfigured'] as const;
export type JobAlertRuleState = (typeof JOB_ALERT_RULE_STATES)[number];

/**
 * What the job monitor currently holds open, or null before the first scan.
 *
 * This subsystem decides that a queue is stalled or failing, and until R321 it
 * told an in-app notification list, the admin trail and the journal — three
 * channels, none of which is the one an on-call rotation reads. The gauge
 * `metricsRegistry` builds off this is what puts a stalled outbox in front of
 * the same alerting the pool and the upstream hops go to. The comment on
 * `auto_pipeline_runs_pending` delegates the DB-backed backlogs to this sweep
 * precisely because a count query per scrape is the wrong shape; what it did
 * not say is that the delegate reported nowhere a rule could see.
 */
export function openJobAlerts(): readonly OpenJobAlert[] | null {
  return openAlerts;
}

/**
 * Which queues the last scan was in a position to say anything about.
 *
 * Null before the first scan, for the same reason `openJobAlerts` is: "nothing
 * has looked" is not "every queue is watched".
 */
export function jobAlertRuleStates(): Readonly<Record<JobSource, JobAlertRuleState>> | null {
  return ruleStates;
}

/** Test seam: forget the last scan, as a fresh process would. */
export function resetOpenJobAlerts(): void {
  openAlerts = null;
  ruleStates = null;
}

/**
 * The rule rows, read as a verdict per source in `JOB_SOURCES`.
 *
 * Keyed off this codebase's source list rather than off the rows, because the
 * failure being caught is a source that has no row — which a scan of the rows
 * cannot see. A row for a source `JOB_SOURCES` does not contain is inert by
 * the migration's own decision ("an unknown key here is inert rather than a
 * broken insert") and is left out here for the same reason.
 */
function rememberRules(rules: readonly JobAlertRule[]): void {
  ruleStates = Object.fromEntries(
    JOB_SOURCES.map((source) => {
      const rule = rules.find((r) => r.source === source);
      return [source, !rule ? 'unconfigured' : rule.enabled ? 'enabled' : 'disabled'];
    }),
  ) as Record<JobSource, JobAlertRuleState>;
}

function rememberOpen(result: ReconcileResult): void {
  openAlerts = [...result.opened, ...result.ongoing].map((a) => ({ source: a.source, kind: a.kind }));
}

/**
 * The scan, with the pass serialized against itself.
 *
 * `reconcileJobAlerts` holds a transaction-scoped advisory lock, and the route
 * that presses this used to cite it as the reason a double-press was safe. It
 * is the reason the *ledger* stays consistent; it is not the reason the scan's
 * conclusions do. Every input to those conclusions — `jobStats`,
 * `oldestActiveJobs`, the clock — is read **before** that lock is taken, so two
 * overlapping passes each reconcile a picture of the queues taken at a
 * different moment, and the later-committing one is not necessarily the one
 * holding the newer picture.
 *
 * What that does, on a queue that recovers between the two reads: the pass that
 * looked after the recovery finds nothing, resolves the open alert and
 * announces the recovery; the pass that looked before it then finds the stall
 * still there, cannot see the alert it just closed, opens a *new* one and
 * announces that. An operator is told a queue recovered and then immediately
 * that it is stalled, about a queue that is fine, and the next tick resolves it
 * and announces the recovery a second time. `ongoing` — the silence that keeps
 * a day-long stall from sending 288 messages — is bypassed entirely, because
 * the alert the second pass opened is genuinely new.
 *
 * Overlapping is ordinary here rather than exotic, and for the same two reasons
 * the overdue sweep gives: `POST /admin/jobs/alerts/scan` is a button, and the
 * five-minute tick can land on a pass still reading five unioned tables.
 * `scheduleSweep` keeps the *timer* from overlapping itself; the route goes
 * nowhere near it.
 *
 * So the whole pass — observe, reconcile, announce — takes
 * `SWEEP_LOCKS.jobAlertScan`, and a pass that arrives while one is running
 * declines rather than queueing, which is `withSweepLock`'s standing argument:
 * waiting only earns the right to re-read a picture the holder has already
 * acted on. `skipped` says so, so "the scan you asked for is already happening"
 * is something the operator is told rather than an empty result that reads as
 * "nothing is wrong". Nothing is lost by declining: announcements are owed by
 * the ledger, not by the pass, so the holder delivers what this one would have.
 */
export async function runJobAlertScan(deps: {
  pool: pg.Pool;
  log?: FastifyBaseLogger;
  now?: Date;
}): Promise<ReconcileResult & { evaluated: number; notified: AnnouncementTally; skipped: boolean }> {
  const run = await withSweepLock(deps.pool, SWEEP_LOCKS.jobAlertScan, deps.log, () => scanUnderLock(deps));
  if (run.ran) return { ...run.value, skipped: false };
  deps.log?.info({ event: 'job_alert_scan_skipped' }, 'job alert scan already in progress; skipped');
  return {
    opened: [],
    resolved: [],
    ongoing: [],
    evaluated: 0,
    notified: { opened: 0, resolved: 0, failed: 0 },
    skipped: true,
  };
}

async function scanUnderLock(deps: {
  pool: pg.Pool;
  log?: FastifyBaseLogger;
  now?: Date;
}): Promise<ReconcileResult & { evaluated: number; notified: AnnouncementTally }> {
  const rules = await listJobAlertRules(deps.pool);
  // Before the early return below, not after it: a deployment with every rule
  // switched off is exactly the state this snapshot exists to make legible.
  rememberRules(rules);
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
    rememberOpen(result);
    return { ...result, evaluated: 0, notified: await announceJobAlerts(deps) };
  }

  // Each enabled rule's own window, and only the enabled ones: a disabled rule
  // produces no finding, so counting its queue's failures would be work for an
  // answer nobody reads.
  const windows = enabled.map((r) => ({ source: r.source, hours: r.failure_window_hours }));
  // `jobStats` still supplies the active counts, which are window-independent —
  // its query keeps every queued or running row however old. The window passed
  // here therefore only bounds the succeeded/skipped columns nothing below
  // reads; the widest rule window keeps it from being an all-time scan.
  const windowHours = Math.max(...enabled.map((r) => r.failure_window_hours));
  // The clock is read from the database alongside the stats, not from the
  // process. Every `created_at` being subtracted was written by Postgres, so
  // this is the one clock that makes the difference an age rather than an age
  // plus the drift between two hosts. See `dbNow`.
  const [stats, oldest, failed, observedAt] = await Promise.all([
    jobStats(deps.pool, windowHours),
    oldestActiveJobs(deps.pool),
    failedJobCounts(deps.pool, windows),
    deps.now ? Promise.resolve(deps.now) : dbNow(deps.pool),
  ]);

  const failedBySource = new Map(failed.map((f) => [f.source, f.count]));
  const findings = evaluateJobAlerts(
    observeQueues(JOB_SOURCES, stats, oldest, failedBySource),
    rules,
    observedAt,
  );
  const result = await reconcileJobAlerts(deps.pool, findings);

  rememberOpen(result);
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
  /*
   * AN ANNOUNCEMENT WITH NOBODY TO ANNOUNCE TO (R401, methodology M11).
   *
   * `createNotifications` accepts an empty list and writes nothing, and
   * `deliverJobAlertAnnouncement` stamps the row on the way out — so a scan
   * that found no recipient marked every announcement delivered, returned
   * `sent`, and counted `opened`/`resolved`. `announcements_failed` stayed at
   * zero, which is what `JobAlertAnnouncementsFailing` reads, and the rule's
   * own note says what that number is for: "an operator who has not been told
   * a queue is stalled, which is the one failure the job monitor exists to
   * prevent". Nobody being there to tell is that, exactly, and it was the one
   * spelling of it the tally called a success.
   *
   * And permanently: the row is stamped, so no later scan owes the
   * announcement again. The outbox, the webhook deliveries and the AI jobs are
   * watched by this sweep and by nothing else on the estate.
   *
   * `listUserIdsWithRoles` drops closed *and* suspended accounts, so this is
   * not a hypothetical empty database — a deployment whose last administrator
   * is suspended has an alerting subsystem reporting itself healthy.
   *
   * Returned before `announce` rather than counted inside it, which is what
   * leaves the rows unstamped: this is the one announcement on the platform
   * that is retried, and the next scan owes it again once somebody is there.
   * A rate rather than a one-off is also what makes a persisting condition
   * visible, and a rate is what the rule reads.
   */
  if (recipients.length === 0) {
    const owed = pending.opened.length + pending.resolved.length;
    tally.failed += owed;
    deps.log?.error(
      {
        alert: true,
        owed,
        roles: [...JOB_ALERT_ROLES],
        sources: [...new Set([...pending.opened, ...pending.resolved].map((a) => a.source))],
      },
      'job queue alerts have nobody to announce to — no active account holds an alerting role',
    );
    return tally;
  }

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
    // announcement-loss: retried. `deliverJobAlertAnnouncement` leaves the row
    // unstamped when the transaction rolls back, so the next scan owes this
    // announcement again — the one announcement on the platform that is not
    // lost when it fails. `logUnretried` would claim the opposite.
    //
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
