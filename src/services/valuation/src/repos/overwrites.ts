import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { EVENT_TYPES } from '../domain/valuation.js';
import { recordEvent, type EventActor } from '../events/record.js';
import type { OverwriteFieldDef } from '../domain/overwrites.js';

export interface OverwriteRow {
  id: string;
  valuation_id: string;
  category: string;
  field_key: string;
  class: string;
  value: unknown;
  original_value: unknown;
  reason: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function listOverwrites(pool: pg.Pool, valuationId: string): Promise<OverwriteRow[]> {
  const { rows } = await pool.query<OverwriteRow>(
    'SELECT * FROM overwrites WHERE valuation_id = $1 ORDER BY category, field_key',
    [valuationId],
  );
  return rows;
}

/**
 * Advisory-lock namespace for one override cell. Keyed on valuation + field, so
 * two analysts working different fields of the same valuation never wait on
 * each other; a hash collision only costs a little serialization.
 */
const OVERWRITE_CELL_LOCK = 0x0ffe7;

/**
 * Creates or updates an override. The first write freezes `original_value`
 * (the pre-override AI/computed value) and `created_by`; later writes only
 * move `value`/`reason`. The audit event carries the before/after pair.
 */
export async function upsertOverwrite(
  pool: pg.Pool,
  args: {
    valuationId: string;
    def: OverwriteFieldDef;
    value: unknown;
    reason: string | null;
    originalValue: unknown;
    actor: EventActor;
  },
): Promise<OverwriteRow> {
  return withTransaction(pool, async (client) => {
    // The branch below is a read-then-write against `UNIQUE (valuation_id,
    // field_key)`, and `FOR UPDATE` cannot serialize the branch that matters:
    // the *first* write of a field has no row to lock, so two of them both
    // read "no override", both take the INSERT arm, and the loser's
    // transaction dies on the unique violation. A PUT that raced another PUT
    // on the same cell comes back 500 — a double-clicked Save, or two analysts
    // on one engagement overriding the same field.
    //
    // Lock the cell rather than the row, so the check and the write are one
    // step whether or not the override already exists. It also keeps the
    // audit event honest: `from` is read under the same lock that decides
    // which arm runs, so it cannot report a value another write has replaced.
    await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
      OVERWRITE_CELL_LOCK,
      `${args.valuationId}:${args.def.key}`,
    ]);
    const { rows: existingRows } = await client.query<OverwriteRow>(
      'SELECT * FROM overwrites WHERE valuation_id = $1 AND field_key = $2',
      [args.valuationId, args.def.key],
    );
    const existing = existingRows[0] ?? null;
    const actorId = args.actor.actorId ?? null;

    let row: OverwriteRow;
    if (existing) {
      const { rows } = await client.query<OverwriteRow>(
        `UPDATE overwrites
           SET value = $1, reason = $2, updated_by = $3, updated_at = now()
         WHERE id = $4
         RETURNING *`,
        [JSON.stringify(args.value), args.reason, actorId, existing.id],
      );
      row = rows[0]!;
    } else {
      const { rows } = await client.query<OverwriteRow>(
        `INSERT INTO overwrites
           (id, valuation_id, category, field_key, class, value, original_value, reason, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
         RETURNING *`,
        [
          newUlid(),
          args.valuationId,
          args.def.category,
          args.def.key,
          args.def.class,
          JSON.stringify(args.value),
          args.originalValue === undefined ? null : JSON.stringify(args.originalValue),
          args.reason,
          actorId,
        ],
      );
      row = rows[0]!;
    }

    await recordEvent(client, {
      valuationId: args.valuationId,
      type: EVENT_TYPES.overwriteApplied,
      actor: args.actor,
      payload: {
        field_key: args.def.key,
        category: args.def.category,
        from: existing ? existing.value : (row.original_value ?? null),
        to: args.value,
        ...(args.reason ? { reason: args.reason } : {}),
      },
    });
    return row;
  });
}

/** Removes an override (revert to the original value). Returns false if absent. */
export async function deleteOverwrite(
  pool: pg.Pool,
  args: { valuationId: string; fieldKey: string; actor: EventActor },
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<OverwriteRow>(
      'DELETE FROM overwrites WHERE valuation_id = $1 AND field_key = $2 RETURNING *',
      [args.valuationId, args.fieldKey],
    );
    const deleted = rows[0];
    if (!deleted) return false;
    await recordEvent(client, {
      valuationId: args.valuationId,
      type: EVENT_TYPES.overwriteReverted,
      actor: args.actor,
      payload: {
        field_key: deleted.field_key,
        category: deleted.category,
        from: deleted.value,
        to: deleted.original_value ?? null,
      },
    });
    return true;
  });
}
