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

    const opened: JobAlertRow[] = [];
    const ongoing: JobAlertRow[] = [];
    for (const finding of findings) {
      const existing = open.find((a) => a.source === finding.source && a.kind === finding.kind);
      if (existing) {
        const { rows } = await tx.query(
          `UPDATE job_alerts
              SET last_seen_at = now(), detail = $2, observed = $3
            WHERE id = $1 RETURNING *`,
          [existing.id, finding.detail, finding.observed],
        );
        ongoing.push(hydrate(rows[0]!));
        continue;
      }
      const { rows } = await tx.query(
        `INSERT INTO job_alerts (id, source, kind, detail, observed, threshold)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [newUlid(), finding.source, finding.kind, finding.detail, finding.observed, finding.threshold],
      );
      opened.push(hydrate(rows[0]!));
    }

    const stale = open.filter((a) => !found.has(key(a.source, a.kind)));
    const resolved: JobAlertRow[] = [];
    for (const alert of stale) {
      const { rows } = await tx.query(`UPDATE job_alerts SET resolved_at = now() WHERE id = $1 RETURNING *`, [
        alert.id,
      ]);
      resolved.push(hydrate(rows[0]!));
    }

    return { opened, resolved, ongoing };
  });
}
