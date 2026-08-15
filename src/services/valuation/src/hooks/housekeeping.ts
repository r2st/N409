import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import {
  HOUSEKEEPING_BATCH,
  HOUSEKEEPING_RETENTION,
  HOUSEKEEPING_TARGETS,
  type HousekeepingTarget,
} from '../domain/housekeeping.js';

export interface HousekeepingResult {
  /** Rows removed per table, only for tables that had any. */
  removed: Record<string, number>;
  total: number;
  /** Tables that filled the batch and have more waiting for the next pass. */
  capped: string[];
}

/**
 * Delete the bookkeeping that has stopped meaning anything.
 *
 * One statement per target, each its own transaction, because there is no
 * relationship between the tables and binding them together would mean one
 * lock-timeout on the busiest costs the other four their pass.
 *
 * Bounded by `ctid` rather than by a primary key: the targets do not share a
 * key column — one of them has a composite key and no id at all — and `ctid`
 * is the row address every table has. It is only stable within a statement,
 * which is all this needs, since the subselect and the delete are one.
 */
export async function runHousekeepingSweep(deps: {
  pool: pg.Pool;
  log?: FastifyBaseLogger;
  retention?: string;
  batch?: number;
}): Promise<HousekeepingResult> {
  const retention = deps.retention ?? HOUSEKEEPING_RETENTION;
  const batch = deps.batch ?? HOUSEKEEPING_BATCH;
  const result: HousekeepingResult = { removed: {}, total: 0, capped: [] };

  for (const target of HOUSEKEEPING_TARGETS) {
    const removed = await sweepOne(deps.pool, target, retention, batch).catch((err: unknown) => {
      // One table's failure is contained. The tables are unrelated, and a sweep
      // that gives up on the first error is a sweep that stops running entirely
      // the day one of them is locked by a migration.
      deps.log?.error({ err, table: target.table }, 'housekeeping sweep failed for table');
      return 0;
    });
    if (removed === 0) continue;
    result.removed[target.table] = removed;
    result.total += removed;
    if (removed >= batch) result.capped.push(target.table);
    deps.log?.info({ table: target.table, removed }, `housekeeping removed ${target.reason}`);
  }

  return result;
}

async function sweepOne(
  pool: pg.Pool,
  target: HousekeepingTarget,
  retention: string,
  batch: number,
): Promise<number> {
  // `table` and `where` are literals from `HOUSEKEEPING_TARGETS`, which is a
  // frozen list in this repository's own source. The retention window and the
  // batch size — the only values that could come from anywhere else — are
  // bound, not interpolated.
  const { rowCount } = await pool.query(
    `DELETE FROM ${target.table}
      WHERE ctid IN (
        SELECT ctid FROM ${target.table} WHERE ${target.where} LIMIT $2
      )`,
    [retention, batch],
  );
  return rowCount ?? 0;
}
