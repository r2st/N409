import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';
import type { HealthCheck, HealthSeverity } from '../domain/healthChecks.js';

export interface HealthCheckRow {
  id: string;
  valuation_id: string;
  calculation_id: string;
  severity: HealthSeverity;
  blocking: boolean;
  checks: HealthCheck[];
  counts: Record<HealthSeverity, number>;
  created_by: string | null;
  created_at: Date;
}

export async function createHealthCheck(
  pool: pg.Pool,
  args: {
    valuationId: string;
    calculationId: string;
    severity: HealthSeverity;
    blocking: boolean;
    checks: HealthCheck[];
    counts: Record<HealthSeverity, number>;
    createdBy: string;
  },
  actor: EventActor,
): Promise<HealthCheckRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<HealthCheckRow>(
      `INSERT INTO valuation_health_checks
         (id, valuation_id, calculation_id, severity, blocking, checks, counts, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        newUlid(),
        args.valuationId,
        args.calculationId,
        args.severity,
        args.blocking,
        JSON.stringify(args.checks),
        JSON.stringify(args.counts),
        args.createdBy,
      ],
    );
    await recordEvent(client, {
      valuationId: args.valuationId,
      type: 'health_checks_run',
      actor,
      payload: {
        health_check_id: rows[0]!.id,
        calculation_id: args.calculationId,
        severity: args.severity,
        blocking: args.blocking,
        checks: args.checks.length,
      },
    });
    return rows[0]!;
  });
}

/** Ceiling on one page of the data-health run history. */
export const HEALTH_CHECK_PAGE_LIMIT = 20;

export async function listHealthChecks(
  pool: pg.Pool,
  valuationId: string,
  opts: { limit?: number } = {},
): Promise<{ runs: HealthCheckRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? HEALTH_CHECK_PAGE_LIMIT, 1), HEALTH_CHECK_PAGE_LIMIT);
  const { rows } = await pool.query<HealthCheckRow>(
    'SELECT * FROM valuation_health_checks WHERE valuation_id = $1 ORDER BY created_at DESC LIMIT $2',
    [valuationId, limit + 1],
  );
  return { runs: rows.slice(0, limit), truncated: rows.length > limit };
}
