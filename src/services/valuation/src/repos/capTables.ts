import type pg from 'pg';
import { ApiProblem, newUlid, problems } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';
import {
  CAP_TABLE_EVENT_TYPES,
  validateCapTable,
  type CapTableEntry,
  type CapTableValidation,
  type ColumnMapping,
} from '../domain/capTable.js';

export interface CapTableRow {
  id: string;
  valuation_id: string;
  source_format: string;
  entries: CapTableEntry[];
  validation: CapTableValidation;
  column_mapping: ColumnMapping;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  /** Bumped by every writer; carried over HTTP as an ETag (migration 0162). */
  version: number;
}

/**
 * The 409 a stale cap-table write is refused with.
 *
 * Worded like `repos/valuations.ts`'s equivalent and for the same reason: the
 * client needs to tell "somebody else saved" from "my own retry raced itself"
 * without a second round trip, so the version it collided with is named.
 *
 * `current` is optional because the row can be absent at the moment of the
 * write — either it was never there (the caller sent `If-Match` for a table
 * that does not exist yet) or it went away between the read and the write.
 */
function staleWrite(current: number | undefined, expected: number): never {
  throw problems.conflict(
    `This cap table was changed by someone else (expected version ${expected}, ` +
      `now ${current ?? 'unknown'}). Reload and reapply your changes.`,
  );
}

/**
 * The 409 an `expectAbsent` write is refused with.
 *
 * Its own sentence rather than `staleWrite`'s, because the caller asserted
 * something else: not "I read version N" but "there was nothing here". Naming a
 * version it never held would send the reader looking for a read it never made.
 *
 * Its own *type* because of who catches it. The provider sync wraps this write
 * in the catch that records a failure on the connection and puts it on a
 * backoff, and this is not that: the pull worked, the provider is well, and the
 * only thing that happened is that somebody else got there first. A caller has
 * to be able to tell those apart by something better than a status code, and
 * the class still renders as the 409 it is if one ever lets it through.
 */
export class CapTableAppearedError extends ApiProblem {
  constructor() {
    super({
      status: 409,
      title: 'Conflict',
      type: 'urn:n409:problem:conflict',
      detail:
        'A cap table was saved for this valuation while the provider pull was running, and this pull ' +
        'was not asked to replace one. Reload and pull again.',
    });
  }
}

/**
 * Re-derive the stored `validation` from the entries beside it.
 *
 * The column is a cache and nothing more: every writer — the import route, the
 * preview, the provider sync — stores exactly `validateCapTable(entries)`, and
 * the function is pure over the entries. Nothing else is folded in, so a read
 * can reproduce it exactly.
 *
 * It is a cache that goes stale, and had. `fully_diluted_shares` counted every
 * preferred share 1:1 until eded249 taught it `conversion_ratio`; the rows
 * written before that still hold the old denominator, and no import rewrites
 * one — a cap table is only revalidated when somebody re-imports it, which for
 * a published engagement is never. So a valuation whose Series A converts 2:1
 * showed a fully-diluted count below the one the engine divides by, on the
 * cap-table tab, in the `cap_table` monitoring baseline, and in the workbook's
 * Summary sheet, which sat in the same file as a Cap table sheet that had been
 * recomputing the figure correctly since it was written. `validateCapTable`
 * has also grown checks since — `no_shares` (bb6b5e3) among them — and a row
 * predating one is stored as clean against a rule it was never tested on.
 *
 * Recomputing here rather than backfilling the column: a migration fixes the
 * rows that exist once, and leaves the next rule change to go stale the same
 * way. The cost is a pass over at most a few hundred entries, which is less
 * than the JSON parse that produced them.
 */
function withFreshValidation(row: StoredCapTableRow): CapTableRow {
  return { ...row, validation: validateCapTable(row.entries) };
}

/**
 * Every column but the one that is thrown away (R393, methodology M8).
 *
 * `withFreshValidation` above replaces `validation` on **every** read, for the
 * reason set out there — the column is a cache of a pure function of `entries`,
 * and it goes stale whenever a rule changes. Both readers were `SELECT *`, so
 * the stored blob crossed the wire and went through the driver's `JSON.parse`
 * on every read of a cap table, to be overwritten by the next expression. Not
 * *sometimes* discarded: there is no path on which the stored value is the one
 * a caller sees.
 *
 * It is not a small blob either, because it holds one issue object with a prose
 * message per finding. A preferred row with no explicit multiple raises
 * `default_liq_pref`, which is the ordinary shape of an imported sheet: on 100
 * rows, 25.7 kB of entries and 8.8 kB of stored validation beside it.
 *
 * The batch reader is the one where it counts. `buildSnapshots` reads a cap
 * table per monitored valuation, `MONITOR_PAGE_LIMIT` is 500, and
 * `POST /monitors/scan` pages the whole enabled book through it. Measured at
 * 200 monitors carrying 100-row tables: 27.3 ms and 6.80 MB parsed, against
 * 21.9 ms and 5.08 MB.
 *
 * Spelled out rather than `SELECT *` minus a column, because there is no such
 * SQL. A column added to the table and not to this list is absent from the row
 * — which is the cost of the list, and why `CapTableRow` minus `validation` is
 * stated as a type so the compiler carries it.
 */
const STORED_CAP_TABLE_COLUMNS = `id, valuation_id, source_format, entries, column_mapping,
       created_by, created_at, updated_at, version`;

/** The row as it comes back: everything but the column the reader re-derives. */
type StoredCapTableRow = Omit<CapTableRow, 'validation'>;

export async function findCapTable(pool: pg.Pool, valuationId: string): Promise<CapTableRow | null> {
  const { rows } = await pool.query<StoredCapTableRow>(
    `SELECT ${STORED_CAP_TABLE_COLUMNS} FROM cap_tables WHERE valuation_id = $1`,
    [valuationId],
  );
  return rows[0] ? withFreshValidation(rows[0]) : null;
}

/**
 * Batch form of {@link findCapTable}, keyed by valuation id. Exists so callers
 * that already hold a list of valuations (the monitoring dashboard and scan)
 * can fetch every cap table in one round trip instead of one per valuation.
 */
export async function findCapTablesByValuationIds(
  pool: pg.Pool,
  valuationIds: string[],
): Promise<Map<string, CapTableRow>> {
  if (valuationIds.length === 0) return new Map();
  const { rows } = await pool.query<StoredCapTableRow>(
    `SELECT ${STORED_CAP_TABLE_COLUMNS} FROM cap_tables WHERE valuation_id = ANY($1)`,
    [[...new Set(valuationIds)]],
  );
  return new Map(rows.map((row) => [row.valuation_id, withFreshValidation(row)]));
}

export interface SaveCapTableOptions {
  /**
   * The `version` the caller's copy of the table was read at. When given, the
   * write is conditional on the row still being at that version and a stale
   * write is refused (409) rather than silently overwriting a concurrent import
   * (migration 0162).
   *
   * Omitted by callers that are not applying a document somebody read first —
   * the provider sync computes its rows from the pull rather than from the
   * stored table, so there is no stale read of *this* row to guard. It still
   * bumps the version, which is what makes the analyst's guarded write notice
   * that a sync landed underneath it.
   */
  expectedVersion?: number;
  /**
   * The write is authorised by there being no table to disturb, and says so
   * (round 268, methodology M5).
   *
   * The exemption above is right about the provider sync's ordinary case and
   * has a hole in the one branch where the sync *does* read this row. A pull
   * asked not to apply (`apply: false`) applies anyway when the valuation has
   * no cap table yet — "there is nothing to disturb" — and that read is a
   * separate statement from the write that relies on it, with a diff, a
   * validation pass and an `await` in between. An import that commits inside
   * that window has its table replaced by the provider's, by a pull that was
   * told not to write, under a `system` actor and with nothing refused.
   *
   * `ON CONFLICT DO NOTHING` is the whole guard: it asks the question in the
   * statement that acts on the answer, so there is no window left, and it needs
   * no `FOR UPDATE` — a row that does not exist yet cannot be locked, which is
   * exactly why the `expectedVersion` shape below could not cover this case.
   */
  expectAbsent?: boolean;
}

/** Insert-or-replace the valuation's cap table with a fresh import. */
export async function saveCapTable(
  pool: pg.Pool,
  input: {
    valuationId: string;
    sourceFormat: string;
    entries: CapTableEntry[];
    validation: CapTableValidation;
    columnMapping: ColumnMapping;
    createdBy: string;
  },
  actor: EventActor,
  options: SaveCapTableOptions = {},
): Promise<CapTableRow> {
  const { expectedVersion, expectAbsent } = options;
  return withTransaction(pool, async (client) => {
    if (expectedVersion !== undefined) {
      // `FOR UPDATE` is what makes this a check rather than a race of its own:
      // the second of two concurrent guarded writers blocks here until the
      // first commits, then reads the version the first bumped and is refused.
      // Without the lock both would read the same version, both would pass, and
      // the upsert below would hand the table to whoever committed last —
      // exactly the failure 0162 exists to close.
      //
      // A missing row is a conflict too. The caller is asserting "I read this
      // table at version N"; if there is no table, that assertion is false
      // however it came to be false, and inserting one would be the silent
      // overwrite in reverse.
      const { rows: live } = await client.query<{ version: number }>(
        'SELECT version FROM cap_tables WHERE valuation_id = $1 FOR UPDATE',
        [input.valuationId],
      );
      if (live[0]?.version !== expectedVersion) staleWrite(live[0]?.version, expectedVersion);
    }

    const { rows } = await client.query<CapTableRow>(
      `INSERT INTO cap_tables (id, valuation_id, source_format, entries, validation, column_mapping, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ${
         expectAbsent
           ? 'ON CONFLICT (valuation_id) DO NOTHING'
           : `ON CONFLICT (valuation_id) DO UPDATE SET
         source_format  = EXCLUDED.source_format,
         entries        = EXCLUDED.entries,
         validation     = EXCLUDED.validation,
         column_mapping = EXCLUDED.column_mapping,
         updated_at     = now(),
         -- Not EXCLUDED.version: that is the new row's default (1), which would
         -- reset the counter on every import and make a stale ETag look current
         -- again. Every write moves it forward, whether or not this caller
         -- asked to be guarded.
         version        = cap_tables.version + 1`
       }
       RETURNING *`,
      [
        newUlid(),
        input.valuationId,
        input.sourceFormat,
        JSON.stringify(input.entries),
        JSON.stringify(input.validation),
        JSON.stringify(input.columnMapping),
        input.createdBy,
      ],
    );
    // `DO NOTHING` returns no row when one was already there, which is the
    // refusal — and it must be raised before the event, or the trail records an
    // import that did not happen.
    if (rows.length === 0) throw new CapTableAppearedError();
    await recordEvent(client, {
      valuationId: input.valuationId,
      type: CAP_TABLE_EVENT_TYPES.imported,
      actor,
      payload: {
        source_format: input.sourceFormat,
        class_count: input.entries.length,
        valid: input.validation.valid,
      },
    });
    return rows[0]!;
  });
}
