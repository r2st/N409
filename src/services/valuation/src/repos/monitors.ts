import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';
import { MONITOR_EVENT_TYPES, type MonitorSnapshot } from '../domain/monitoring.js';
import { STATE_GROUPS } from '../domain/operations.js';

export interface MonitorRow {
  id: string;
  valuation_id: string;
  enabled: boolean;
  baseline: MonitorSnapshot;
  last_checked_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export async function findMonitor(pool: pg.Pool, valuationId: string): Promise<MonitorRow | null> {
  const { rows } = await pool.query<MonitorRow>('SELECT * FROM valuation_monitors WHERE valuation_id = $1', [
    valuationId,
  ]);
  return rows[0] ?? null;
}

export async function enableMonitor(
  pool: pg.Pool,
  input: { valuationId: string; baseline: MonitorSnapshot; createdBy: string },
  actor: EventActor,
): Promise<MonitorRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<MonitorRow>(
      `INSERT INTO valuation_monitors (id, valuation_id, enabled, baseline, created_by)
       VALUES ($1, $2, true, $3, $4)
       ON CONFLICT (valuation_id) DO UPDATE SET
         enabled = true, baseline = EXCLUDED.baseline, updated_at = now()
       RETURNING *`,
      [newUlid(), input.valuationId, JSON.stringify(input.baseline), input.createdBy],
    );
    // Re-enabling with a fresh baseline clears old dedupe rows.
    await client.query('DELETE FROM monitor_alerts WHERE monitor_id = $1', [rows[0]!.id]);
    await recordEvent(client, {
      valuationId: input.valuationId,
      type: MONITOR_EVENT_TYPES.enabled,
      actor,
      payload: { baseline: input.baseline },
    });
    return rows[0]!;
  });
}

/**
 * Turn the watch off, and say so on the spine once.
 *
 * `enabled = true` in the predicate, and the event only when the row moved.
 * `findMonitor` — which is the whole of the route's existence check — returns
 * the row whether the watch is on or off, so `DELETE /monitor` on a monitor
 * that was already disabled answered 204 and wrote another `monitoring_disabled`
 * against the engagement. That is not even a race: it is a repeat of an
 * ordinary request, and the trail then reports a watch stopped as many times as
 * anybody pressed the control.
 *
 * The route still answers 204 either way, on `deleteDocument`'s reading: the
 * caller asked for a state the monitor is already in. The enable door is
 * deliberately not guarded the same way — re-enabling takes a fresh baseline
 * and clears the dedupe rows, so it is a re-arming an operator asked for rather
 * than a no-op.
 */
export async function disableMonitor(pool: pg.Pool, monitor: MonitorRow, actor: EventActor): Promise<void> {
  await withTransaction(pool, async (client) => {
    const { rowCount } = await client.query(
      'UPDATE valuation_monitors SET enabled = false, updated_at = now() WHERE id = $1 AND enabled = true',
      [monitor.id],
    );
    if ((rowCount ?? 0) === 0) return;
    await recordEvent(client, {
      valuationId: monitor.valuation_id,
      type: MONITOR_EVENT_TYPES.disabled,
      actor,
      payload: {},
    });
  });
}

export async function markChecked(pool: pg.Pool, monitorId: string): Promise<void> {
  await pool.query('UPDATE valuation_monitors SET last_checked_at = now() WHERE id = $1', [monitorId]);
}

/**
 * Stamp a whole page of monitors as checked in one statement.
 *
 * The scan stamped each monitor individually — an UPDATE per monitor whether or
 * not anything fired, which made the no-alerts case (the common one) cost a
 * round trip per monitor and nothing else.
 */
export async function markCheckedMany(pool: pg.Pool, monitorIds: readonly string[]): Promise<void> {
  if (monitorIds.length === 0) return;
  await pool.query('UPDATE valuation_monitors SET last_checked_at = now() WHERE id = ANY($1::ulid[])', [
    monitorIds as readonly string[],
  ]);
}

export interface MonitorListRow extends MonitorRow {
  company_name: string;
  kind: string;
  user_id: string;
}

/** Ceiling on one page of the monitoring dashboard. */
export const MONITOR_PAGE_LIMIT = 500;

/**
 * The join both the dashboard and the scan read enabled monitors through.
 *
 * `v.archived_at IS NULL` is part of it, not of the two callers, because the
 * two must not be able to disagree about which engagements are still being
 * watched. Archiving is this platform's soft delete for valuations
 * (`retireValuations`, the retention sweep), and `buildValuationWhere` filters
 * it out of the list, the counts and the export — so a retired engagement is
 * gone from every surface its client can reach.
 *
 * Monitoring outlived that. A monitor is not disabled by archiving, so the scan
 * kept evaluating retired engagements, and a trigger that fired emailed the
 * assigned reviewer a message ending "Consider a fresh valuation" about work
 * the firm had already withdrawn. That mail leaves the building, which makes it
 * the worse half: the dashboard row was merely wrong, the alert acted on it.
 *
 * Filtering the read rather than disabling the monitor on archive keeps the
 * decision reversible — un-archiving an engagement resumes the watch it was
 * set up with, instead of silently having turned it off.
 *
 * AND A CLOSED ENGAGEMENT IS THE REACHABLE HALF OF THAT (round 400,
 * methodology M3). Archiving is the retention sweep's word for a file
 * withdrawn years later. `cancelled`, `timeout` and `ignored` are the three
 * terminal states of `WORKFLOW_TRANSITIONS`, and `cancelled` is a legal move
 * out of every monitorable state but `published` — `completed`, `paid`,
 * `review`, `reviewed`, `drafted`, `draft_changes`, `draft_accepted`. So the
 * ordinary story is: ops enable the watch on a drafted engagement, the client
 * goes quiet, ops cancel it, and closing moves `state` and nothing else — the
 * monitor is still enabled, because nothing disables one.
 *
 * The scan then went on evaluating it and mailing the assigned reviewer
 * "Consider a fresh valuation" about work that had been called off, on every
 * tick, with a one-click roll-forward beside it. Same defect, same paragraph,
 * one axis over — and this half needs no retention policy to have run.
 *
 * Reversible for the same reason: `canRestart` puts a cancelled engagement
 * back to `started`, and the watch resumes rather than having been turned off.
 */
const ENABLED_MONITOR_SELECT = `
  SELECT m.*, v.company_name, v.kind, v.user_id
    FROM valuation_monitors m
    JOIN valuations v ON v.id = m.valuation_id
   WHERE m.enabled = true AND v.archived_at IS NULL
     AND v.state <> ALL(ARRAY[${STATE_GROUPS.closed.map((s) => `'${s}'`).join(', ')}]::valuation_state[])`;

/**
 * Every enabled monitor, newest first — a page of them.
 *
 * The dashboard reading this evaluates four snapshot queries' worth of data per
 * monitor, so the page is what bounds the work behind it as much as the rows on
 * it. Newest-first is kept: a monitor enabled today is the one an operator just
 * set up and is looking for.
 */
export async function listEnabledMonitors(
  pool: pg.Pool,
  opts: { limit?: number } = {},
): Promise<{ monitors: MonitorListRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? MONITOR_PAGE_LIMIT, 1), MONITOR_PAGE_LIMIT);
  const { rows } = await pool.query<MonitorListRow>(
    `${ENABLED_MONITOR_SELECT} ORDER BY m.created_at DESC, m.id DESC LIMIT $1`,
    [limit + 1],
  );
  return { monitors: rows.slice(0, limit), truncated: rows.length > limit };
}

/**
 * Every enabled monitor, a page at a time.
 *
 * For the scan, which must reach all of them: a revaluation trigger that fires
 * and is never emailed is the failure the monitor exists to prevent, and a
 * capped scan would report `scanned: 500` and look healthy. Keyset on `id` for
 * the reason `eachActiveEngagement` spells out — a `timestamptz` cursor loses
 * microseconds on the way through JavaScript and stops advancing.
 */
export async function* eachEnabledMonitor(
  pool: pg.Pool,
  opts: { pageSize?: number } = {},
): AsyncGenerator<MonitorListRow[]> {
  const size = Math.min(Math.max(opts.pageSize ?? MONITOR_PAGE_LIMIT, 1), MONITOR_PAGE_LIMIT);
  let after: string | null = null;
  for (;;) {
    const params: unknown[] = [size];
    const cursorSql: string = after ? `AND m.id > $${params.push(after)}` : '';
    const { rows }: pg.QueryResult<MonitorListRow> = await pool.query<MonitorListRow>(
      `${ENABLED_MONITOR_SELECT} ${cursorSql} ORDER BY m.id ASC LIMIT $1`,
      params,
    );
    // Yielded a page at a time rather than a row at a time: the scan batches
    // its snapshot, dedupe and reviewer reads across a page, and handing it
    // rows one by one would put those queries back inside a loop.
    if (rows.length > 0) yield rows;
    if (rows.length < size) return;
    after = rows[rows.length - 1]!.id;
  }
}

/** One `(monitor, signature)` the scan is about to consider sending. */
export interface AlertCandidate {
  monitorId: string;
  signature: string;
}

/**
 * Which of `candidates` have already been alerted on, for a whole page of
 * monitors in one query.
 *
 * Asked about the candidates rather than about the monitors. The earlier
 * spelling took the page's monitor ids and read *every* signature those
 * monitors had ever fired — a set that only grows, on a table that is appended
 * to on every scan, to answer a question about the handful of triggers this
 * scan evaluated. A monitor that has been watching an engagement for two years
 * dragged two years of alerts through the wire each time the sweep ran.
 *
 * Bounding it costs nothing here because this set is an optimisation and not
 * the guard: `recordAlert` is `ON CONFLICT (monitor_id, signature) DO NOTHING`
 * and the scan sends only when it reports a fresh insert. A signature this
 * function failed to return would cost one no-op INSERT, not a second email.
 * That is the opposite of {@link existingGrantExternalIds}'s situation and the
 * reason the two are bounded the same way rather than one of them capped.
 *
 * Monitors with nothing already alerted are absent from the map; the caller
 * reads them as an empty set.
 */
export async function notifiedSignaturesFor(
  pool: pg.Pool,
  candidates: readonly AlertCandidate[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (candidates.length === 0) return out;
  const { rows } = await pool.query<{ monitor_id: string; signature: string }>(
    `SELECT a.monitor_id, a.signature
       FROM monitor_alerts a
       JOIN unnest($1::ulid[], $2::text[]) AS c(monitor_id, signature)
         ON c.monitor_id = a.monitor_id AND c.signature = a.signature`,
    [candidates.map((c) => c.monitorId), candidates.map((c) => c.signature)],
  );
  for (const r of rows) {
    const set = out.get(r.monitor_id) ?? new Set<string>();
    set.add(r.signature);
    out.set(r.monitor_id, set);
  }
  return out;
}

/** Record a fired alert (idempotent on signature). Returns true if newly inserted. */
export async function recordAlert(
  pool: pg.Pool,
  input: { monitorId: string; valuationId: string; triggerType: string; level: string; signature: string },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO monitor_alerts (id, monitor_id, valuation_id, trigger_type, level, signature)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (monitor_id, signature) DO NOTHING`,
    [newUlid(), input.monitorId, input.valuationId, input.triggerType, input.level, input.signature],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Take back an alert this pass had just recorded and could not announce.
 *
 * The row is the suppressor: `notifiedSignaturesFor` reads exactly this table,
 * and `recordAlert`'s `ON CONFLICT DO NOTHING` means the second scan to see the
 * same signature reports `inserted: false` and skips it. So a scan that
 * committed the row and then failed before the reviewer was told suppressed
 * that alert for ever — which is the one failure a revaluation monitor exists
 * to prevent, and it is silent.
 *
 * Only safe for the caller's *own* insert, and only before anything is queued.
 * `sendTransactionalEmail` writes the outbox row as its first database write
 * and contains every failure after it, so a throw out of that call means
 * nothing was enqueued and nobody has been told; the scan's per-trigger catch
 * is the only caller and it holds both facts. Undoing anything else would be
 * deleting an announcement that had happened.
 */
export async function unrecordAlert(
  pool: pg.Pool,
  input: { monitorId: string; signature: string },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    'DELETE FROM monitor_alerts WHERE monitor_id = $1 AND signature = $2',
    [input.monitorId, input.signature],
  );
  return (rowCount ?? 0) > 0;
}
