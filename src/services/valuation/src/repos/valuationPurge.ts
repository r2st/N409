import type pg from 'pg';

/**
 * Retire valuations that should not appear in the product, by explicit id.
 *
 * This started out as a hard delete, on the assumption that the only obstacle
 * was the foreign key: every child table of `valuations` cascades except
 * `valuation_events`, which is `ON DELETE NO ACTION`, so the plan was to remove
 * the events first and in the same transaction.
 *
 * That assumption was wrong, and production said so on the first run —
 * `valuation_events is append-only (DELETE blocked)`. The table also carries
 * `valuation_events_immutable`, a `BEFORE UPDATE OR DELETE` trigger from
 * migration 0001 whose whole body is `RAISE EXCEPTION`, with a matching
 * `BEFORE TRUNCATE` one beside it. The comment above them reads "no UPDATE or
 * DELETE, ever (compliance/audit foundation)". There is no session flag and no
 * escape hatch, deliberately. A hard delete is therefore not something this
 * codebase can do without first disabling a compliance control, which is not a
 * trade a seeding tool is entitled to make on anyone's behalf.
 *
 * So this archives instead, which turns out to be what the schema was pointing
 * at all along. `archived_at` is filtered out of every list read — see the
 * `archived_at IS NULL` clause in `repos/valuations.ts`, applied unless a
 * caller asks for archived work explicitly — so an archived engagement is gone
 * from the product's views without being gone from its history. It is also
 * reversible, which a delete is not.
 *
 * The rename is the other half, and it is what makes `--replace` work.
 * Archiving alone leaves the row still matching its company name, so a re-run
 * would see the name as taken and skip the very sample it was asked to rebuild.
 * Suffixing frees the name, and leaves a row that reads as what it is.
 */
export interface RetireResult {
  /** Ids that existed, were live, and are now archived and renamed. */
  retired: string[];
  /** Ids that were asked for and do not exist. Not an error — just reported. */
  missing: string[];
  /** Ids that were already archived, and so were left untouched. */
  alreadyArchived: string[];
}

/** Appended to the company name so the original no longer collides. */
const RETIRED_SUFFIX = ' [retired]';

export async function retireValuations(pool: pg.Pool, ids: readonly string[]): Promise<RetireResult> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return { retired: [], missing: [], alreadyArchived: [] };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const present = await client.query<{ id: string; archived: boolean }>(
      'SELECT id, archived_at IS NOT NULL AS archived FROM valuations WHERE id = ANY($1::ulid[])',
      [wanted],
    );
    const found = present.rows.map((r) => r.id);
    const alreadyArchived = present.rows.filter((r) => r.archived).map((r) => r.id);
    const toRetire = present.rows.filter((r) => !r.archived).map((r) => r.id);

    if (toRetire.length > 0) {
      // The suffix is applied only where it is not already there, so retiring a
      // row twice cannot produce "Name [retired] [retired]".
      await client.query(
        `UPDATE valuations
            SET archived_at = now(),
                company_name = CASE
                  WHEN company_name LIKE ('%' || $2::text) THEN company_name
                  ELSE company_name || $2::text
                END
          WHERE id = ANY($1::ulid[])`,
        [toRetire, RETIRED_SUFFIX],
      );
    }
    await client.query('COMMIT');
    return {
      retired: toRetire,
      missing: wanted.filter((id) => !found.includes(id)),
      alreadyArchived,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Ids of the valuations carrying one of these exact company names.
 *
 * The seeder uses it to find the previous run's samples so `--replace` can
 * retire them, and the operator tools use it so a smoke test can be named
 * rather than have its ULID pasted. Exact match, never a pattern: a
 * `LIKE 'Smoke%'` in a path that mutates rows is one careless generalisation
 * away from taking a client's engagement with it.
 *
 * Archived rows are reported too, with a flag, because the caller is deciding
 * what to do about a *name* — and a name held by an archived row is still held.
 */
export async function findValuationIdsByCompanyName(
  pool: pg.Pool,
  names: readonly string[],
): Promise<Array<{ id: string; company_name: string; state: string; archived: boolean }>> {
  if (names.length === 0) return [];
  const res = await pool.query<{
    id: string;
    company_name: string;
    state: string;
    archived: boolean;
  }>(
    `SELECT id, company_name, state, archived_at IS NOT NULL AS archived
       FROM valuations WHERE company_name = ANY($1::text[]) ORDER BY created_at`,
    [[...names]],
  );
  return res.rows;
}
