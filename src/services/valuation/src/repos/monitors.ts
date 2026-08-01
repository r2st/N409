import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';
import { MONITOR_EVENT_TYPES, type MonitorSnapshot } from '../domain/monitoring.js';

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

export async function disableMonitor(pool: pg.Pool, monitor: MonitorRow, actor: EventActor): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query('UPDATE valuation_monitors SET enabled = false, updated_at = now() WHERE id = $1', [
      monitor.id,
    ]);
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

export interface MonitorListRow extends MonitorRow {
  company_name: string;
  kind: string;
  user_id: string;
}

export async function listEnabledMonitors(pool: pg.Pool): Promise<MonitorListRow[]> {
  const { rows } = await pool.query<MonitorListRow>(
    `SELECT m.*, v.company_name, v.kind, v.user_id
       FROM valuation_monitors m
       JOIN valuations v ON v.id = m.valuation_id
      WHERE m.enabled = true
      ORDER BY m.created_at DESC`,
  );
  return rows;
}

/** Set of alert signatures already emailed for a monitor (dedupe). */
export async function notifiedSignatures(pool: pg.Pool, monitorId: string): Promise<Set<string>> {
  const { rows } = await pool.query<{ signature: string }>(
    'SELECT signature FROM monitor_alerts WHERE monitor_id = $1',
    [monitorId],
  );
  return new Set(rows.map((r) => r.signature));
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
