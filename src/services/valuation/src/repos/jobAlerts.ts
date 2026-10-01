import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import type { JobAlertFinding, JobAlertKind, JobAlertRule } from '../domain/jobAlerts.js';
import type { JobSource } from '../domain/jobQueue.js';

/**
 * Alert thresholds and the open/resolved alert ledger (migration 0120).
 */

export interface JobAlertRow {
  id: string;
  source: JobSource;
  kind: JobAlertKind;
  detail: string;
  observed: number;
  threshold: number;
  opened_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
  /** When the opening announcement was delivered; NULL means it is still owed. */
  opened_notified_at: Date | null;
  /** When the recovery announcement was delivered; NULL on a resolved alert means still owed. */
  resolved_notified_at: Date | null;
}

/**
 * A row as the pg driver actually hands it back: `observed` and `threshold` are
 * `numeric` and arrive as strings.
 *
 * Naming that difference lets `hydrate` return a `JobAlertRow` without an
 * assertion — the cast it replaces would have typed a forgotten column as a
 * number, and an alert compares `observed` against `threshold`.
 */
type RawJobAlertRow = Omit<JobAlertRow, 'observed' | 'threshold'> & {
  observed: string | number;
  threshold: string | number;
};

function hydrate(row: RawJobAlertRow): JobAlertRow {
  return {
    ...row,
    observed: Number(row.observed),
    threshold: Number(row.threshold),
  };
}

export async function listJobAlertRules(pool: pg.Pool | pg.PoolClient): Promise<JobAlertRule[]> {
  const { rows } = await pool.query<JobAlertRule>(`SELECT * FROM job_alert_rules ORDER BY source ASC`);
  return rows;
}

export interface JobAlertRulePatch {
  enabled?: boolean;
  stallMinutes?: number;
  failureCount?: number;
  failureWindowHours?: number;
  updatedBy?: string | null;
}

const RULE_COLUMNS: Array<[keyof JobAlertRulePatch, string]> = [
  ['enabled', 'enabled'],
  ['stallMinutes', 'stall_minutes'],
  ['failureCount', 'failure_count'],
  ['failureWindowHours', 'failure_window_hours'],
];

export async function updateJobAlertRule(
  pool: pg.Pool,
  source: JobSource,
  patch: JobAlertRulePatch,
): Promise<JobAlertRule | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of RULE_COLUMNS) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    sets.push(`${column} = $${params.length}`);
  }
  params.push(patch.updatedBy ?? null);
  sets.push(`updated_by = $${params.length}`);
  params.push(source);
  const { rows } = await pool.query<JobAlertRule>(
    `UPDATE job_alert_rules SET ${sets.join(', ')}, updated_at = now()
      WHERE source = $${params.length}
      RETURNING *`,
    params,
  );
  return rows[0] ?? null;
}

export async function listJobAlerts(
  pool: pg.Pool,
  opts: { openOnly?: boolean; limit?: number } = {},
): Promise<JobAlertRow[]> {
  const { rows } = await pool.query(
    `SELECT * FROM job_alerts
      WHERE ($1::boolean IS NOT TRUE OR resolved_at IS NULL)
      ORDER BY resolved_at IS NOT NULL ASC, opened_at DESC
      LIMIT $2`,
    [opts.openOnly ?? false, opts.limit ?? 50],
  );
  return rows.map(hydrate);
}

export interface ReconcileResult {
  /** Alerts that were not open before this scan — the ones worth notifying on. */
  opened: JobAlertRow[];
  /** Alerts whose condition has cleared. */
  resolved: JobAlertRow[];
  /** Still open and still true; bumped, not re-notified. */
  ongoing: JobAlertRow[];
}

/**
 * Bring the ledger in line with one scan's findings, in one transaction.
 *
 * Three outcomes per (source, kind), and the distinction between the first two
 * is the entire anti-spam mechanism: an alert that is already open is *bumped*
 * — `last_seen_at` moves, the detail is refreshed so a worsening figure is
 * visible — and returned as `ongoing`, which nothing notifies on. Only a
 * genuinely new alert reaches an operator's notification list. A five-minute
 * scan against a queue that stays stopped for a day would otherwise send 288
 * identical messages, which is how a channel gets muted.
 *
 * Anything open that this scan did not find is resolved, including alerts whose
 * rule has since been disabled: `evaluateJobAlerts` returns nothing for a
 * disabled rule, so turning a rule off closes its alert rather than freezing it
 * open forever.
 *
 * One transaction because a partial application is a lie about the state of the
 * platform — half the alerts resolved and half still open describes a moment
 * that never existed.
 */
export async function reconcileJobAlerts(
  pool: pg.Pool,
  findings: readonly JobAlertFinding[],
): Promise<ReconcileResult> {
  return withTransaction(pool, async (tx) => {
    // Serialize concurrent scans: two instances reconciling at once would both
    // see "not open", and one of the two inserts would hit the partial unique
    // index. Advisory lock rather than a retry, because the loser has nothing
    // useful to do with the conflict — the other scan just did its work.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('job_alerts_reconcile'))`);

    const { rows: openRows } = await tx.query(
      `SELECT * FROM job_alerts WHERE resolved_at IS NULL FOR UPDATE`,
    );
    const open = openRows.map(hydrate);
    const key = (source: string, kind: string) => `${source}:${kind}`;
    const found = new Set(findings.map((f) => key(f.source, f.kind)));

    const toUpdate: Array<{ id: string; detail: string; observed: number }> = [];
    const toInsert: JobAlertFinding[] = [];
    for (const finding of findings) {
      const existing = open.find((a) => a.source === finding.source && a.kind === finding.kind);
      if (existing) {
        toUpdate.push({ id: existing.id, detail: finding.detail, observed: finding.observed });
      } else {
        toInsert.push(finding);
      }
    }

    let ongoing: JobAlertRow[] = [];
    if (toUpdate.length > 0) {
      const params: unknown[] = [];
      const tuples: string[] = [];
      for (const u of toUpdate) {
        const i = params.length;
        params.push(u.id, u.detail, u.observed);
        tuples.push(`($${i + 1}, $${i + 2}, $${i + 3}::numeric)`);
      }
      const { rows } = await tx.query(
        `UPDATE job_alerts a
            SET last_seen_at = now(), detail = v.detail, observed = v.observed
           FROM (VALUES ${tuples.join(', ')}) AS v(id, detail, observed)
          WHERE a.id = v.id RETURNING a.*`,
        params,
      );
      ongoing = rows.map(hydrate);
    }

    let opened: JobAlertRow[] = [];
    if (toInsert.length > 0) {
      const params: unknown[] = [];
      const tuples: string[] = [];
      for (const f of toInsert) {
        const i = params.length;
        params.push(newUlid(), f.source, f.kind, f.detail, f.observed, f.threshold);
        tuples.push(`($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6})`);
      }
      const { rows } = await tx.query(
        `INSERT INTO job_alerts (id, source, kind, detail, observed, threshold)
         VALUES ${tuples.join(', ')} RETURNING *`,
        params,
      );
      opened = rows.map(hydrate);
    }

    const stale = open.filter((a) => !found.has(key(a.source, a.kind)));
    let resolved: JobAlertRow[] = [];
    if (stale.length > 0) {
      const { rows } = await tx.query(
        `UPDATE job_alerts SET resolved_at = now()
          WHERE id = ANY($1) RETURNING *`,
        [stale.map((a) => a.id)],
      );
      resolved = rows.map(hydrate);
    }

    return { opened, resolved, ongoing };
  });
}

/** Which of an alert's two announcements is being delivered. */
export type JobAlertAnnouncement = 'opened' | 'resolved';

/** The column stamping each announcement. A closed map, so nothing interpolated
 * into the SQL below can come from a caller. */
const NOTIFIED_COLUMN: Record<JobAlertAnnouncement, string> = {
  opened: 'opened_notified_at',
  resolved: 'resolved_notified_at',
};

export interface PendingJobAlertAnnouncements {
  /** Open alerts nobody has been told about yet. */
  opened: JobAlertRow[];
  /** Alerts that have cleared without the recovery being announced. */
  resolved: JobAlertRow[];
}

/**
 * The announcements the ledger still owes, oldest first.
 *
 * Read straight from `job_alerts` rather than from a reconcile's return value,
 * which is what makes delivery survive a scan that died halfway through it. A
 * scan that opened three alerts and crashed after announcing the first leaves
 * two rows with a NULL `opened_notified_at`; the next scan — or the ops-
 * triggered one — picks them up here and finishes the job.
 *
 * `resolved` is not filtered on `opened_notified_at`. An alert can clear before
 * its opening announcement ever got out, and both are then owed: "the queue
 * stalled" followed by "the queue recovered" is the honest account of a blip,
 * whereas a bare recovery notice names a problem the operator was never told
 * about. `runJobAlertScan` sends them in that order.
 */
export async function pendingJobAlertAnnouncements(
  pool: pg.Pool | pg.PoolClient,
): Promise<PendingJobAlertAnnouncements> {
  const { rows } = await pool.query<RawJobAlertRow>(
    `SELECT * FROM job_alerts
      WHERE opened_notified_at IS NULL
         OR (resolved_at IS NOT NULL AND resolved_notified_at IS NULL)
      ORDER BY opened_at ASC`,
  );
  const all = rows.map(hydrate);
  return {
    opened: all.filter((a) => a.opened_notified_at === null),
    resolved: all.filter((a) => a.resolved_at !== null && a.resolved_notified_at === null),
  };
}

/**
 * Deliver one announcement and record that it was delivered, atomically.
 *
 * `deliver` writes the admin event and the notification rows on the transaction
 * this opens, so the stamp and the thing it attests to commit together. There is
 * no ordering of two separate writes that survives a crash between them: stamp
 * first and a crash loses the alert exactly as before, stamp second and a crash
 * re-announces it. One transaction has neither failure.
 *
 * The row is taken `FOR UPDATE` with the NULL check in the predicate, which is
 * also the guard against two instances announcing the same alert: the sweep runs
 * on every instance and from an ops route, so concurrent delivery is ordinary
 * rather than exotic. The loser finds the column already stamped, matches no
 * row, and reports `false` without sending anything.
 *
 * Returns whether this call was the one that delivered it.
 */
export async function deliverJobAlertAnnouncement(
  pool: pg.Pool,
  alertId: string,
  which: JobAlertAnnouncement,
  deliver: (tx: pg.PoolClient, alert: JobAlertRow) => Promise<void>,
): Promise<boolean> {
  const column = NOTIFIED_COLUMN[which];
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<RawJobAlertRow>(
      `SELECT * FROM job_alerts WHERE id = $1 AND ${column} IS NULL FOR UPDATE`,
      [alertId],
    );
    const row = rows[0];
    if (!row) return false;
    await deliver(tx, hydrate(row));
    await tx.query(`UPDATE job_alerts SET ${column} = now() WHERE id = $1`, [alertId]);
    return true;
  });
}
