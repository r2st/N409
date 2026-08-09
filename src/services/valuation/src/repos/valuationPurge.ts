import type pg from 'pg';

/**
 * Hard-delete valuations and everything hanging off them.
 *
 * There is no route for this and there should not be: the product deletes
 * nothing, because an engagement is the audit record of an opinion somebody
 * signed. Archiving is what the workflow offers, and it is the right answer for
 * a real engagement.
 *
 * What it is *not* the right answer for is the four rows a deployment check
 * left in production — `M1 SmokeCo`, `Smoke M3 Co` twice — which have no
 * calculation, no report and no client, and which were the entire contents of
 * the valuations list on the live site for a month. Archiving those hides them
 * behind a filter and leaves them in every count. So this exists, as a function
 * the operator tools call by explicit id, tested against a real schema.
 *
 * The one thing it has to get right is the order. Every child table of
 * `valuations` cascades on delete except one: `valuation_events` — the
 * append-only audit spine — is `ON DELETE NO ACTION`, deliberately, so that
 * nothing can quietly erase the history of an engagement as a side effect of
 * some other statement. A plain `DELETE FROM valuations` therefore fails on the
 * foreign key rather than doing half the job, which is the safe failure; this
 * function removes the events first and in the same transaction, so the delete
 * is all-or-nothing.
 */
export interface PurgeResult {
  /** Ids that existed and were removed. */
  deleted: string[];
  /** Ids that were asked for and did not exist. Not an error — just reported. */
  missing: string[];
  /** Audit rows removed alongside them. */
  eventsDeleted: number;
}

export async function purgeValuations(pool: pg.Pool, ids: readonly string[]): Promise<PurgeResult> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return { deleted: [], missing: [], eventsDeleted: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const present = await client.query<{ id: string }>(
      'SELECT id FROM valuations WHERE id = ANY($1::ulid[])',
      [wanted],
    );
    const deleted = present.rows.map((r) => r.id);
    if (deleted.length === 0) {
      await client.query('ROLLBACK');
      return { deleted: [], missing: wanted, eventsDeleted: 0 };
    }
    const events = await client.query('DELETE FROM valuation_events WHERE valuation_id = ANY($1::ulid[])', [
      deleted,
    ]);
    await client.query('DELETE FROM valuations WHERE id = ANY($1::ulid[])', [deleted]);
    await client.query('COMMIT');
    return {
      deleted,
      missing: wanted.filter((id) => !deleted.includes(id)),
      eventsDeleted: events.rowCount ?? 0,
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
 * remove them, and the purge CLI uses it so an operator can name the smoke
 * tests rather than paste ULIDs. Exact match, never a pattern: a `LIKE 'Smoke%'`
 * in a delete path is one careless generalisation away from taking a client's
 * engagement with it.
 */
export async function findValuationIdsByCompanyName(
  pool: pg.Pool,
  names: readonly string[],
): Promise<Array<{ id: string; company_name: string; state: string }>> {
  if (names.length === 0) return [];
  const res = await pool.query<{ id: string; company_name: string; state: string }>(
    'SELECT id, company_name, state FROM valuations WHERE company_name = ANY($1::text[]) ORDER BY created_at',
    [[...names]],
  );
  return res.rows;
}
