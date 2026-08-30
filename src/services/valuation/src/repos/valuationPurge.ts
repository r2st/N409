import type pg from 'pg';
import { invalidateValuation } from './valuations.js';

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
 * reversible, which a delete is not — see `restoreValuations`, which is the
 * half of that sentence the codebase went four rounds without.
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
      //
      // `version` moves because `company_name` moved. The rule is
      // `lockCounterDiscipline.test.ts`': every writer of a column a guarded
      // form posts advances the counter, including the writers that never send
      // `If-Match` themselves — `company_name` is in both `OPS_PATCH_FIELDS`
      // and `OWNER_PATCH_FIELDS`, so an editor holding this row is holding a
      // name this statement changed. Without it the ETag that editor echoes
      // still matches, and the guard reports "nobody touched this" about a row
      // whose most visible field is now different.
      await client.query(
        `UPDATE valuations
            SET archived_at = now(),
                version = version + 1,
                company_name = CASE
                  WHEN company_name LIKE ('%' || $2::text) THEN company_name
                  ELSE company_name || $2::text
                END
          WHERE id = ANY($1::ulid[])`,
        [toRetire, RETIRED_SUFFIX],
      );
    }
    await client.query('COMMIT');
    // This is the ninth writer to `valuations`, and the read-through cache in
    // `repos/valuations.ts` is only correct because every one of them drops the
    // row afterwards. Today the seeder runs out-of-process so the API's cache is
    // not this process's, and the drop is a no-op; the moment anything in the
    // service retires a valuation, the absence of this line is `state` and
    // `archived_at` served stale for a full TTL. After the COMMIT, not inside
    // it, for the reason `invalidateValuationAfter` documents.
    for (const id of toRetire) invalidateValuation(id);
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

export interface RestoreResult {
  /** Ids that existed, were archived, and are now live again. */
  restored: string[];
  /** Ids that were asked for and do not exist. Not an error — just reported. */
  missing: string[];
  /** Ids that were already live, and so were left untouched. */
  notArchived: string[];
}

/**
 * Put an archived valuation back in the product.
 *
 * The mirror of `retireValuations`, and it did not exist for four rounds while
 * the comment above claimed it did — "It is also reversible, which a delete is
 * not" was true of the schema and false of the codebase. R89 is what made the
 * absence matter rather than merely be untidy: it guarded all 86 writes under
 * a valuation id against `archived_at`, so an engagement archived by a mistyped
 * id or by a retention policy set too aggressively now refuses every write
 * anyone makes to it, permanently, with no way back through the product.
 *
 * The suffix comes off as well as the flag, and only the trailing one. Retiring
 * appended ` [retired]` so the freed name could be reused; leaving it on a
 * restored row would hand back an engagement whose company reads as retired
 * while the flag says otherwise, and the *reason* the suffix exists is gone the
 * moment the row is live again. `LIKE` on the tail rather than `replace()`,
 * which would also strike the string out of the middle of a name that happens
 * to contain it.
 *
 * NOT IDEMPOTENT IN THE SENSE THAT MATTERS: a row already live is reported in
 * `notArchived` and left completely alone, because stripping a suffix off a
 * name nobody archived would be this function editing a company name for no
 * reason. The two lists are what the caller answers on.
 *
 * The cache drop is the same obligation every writer to `valuations` carries
 * and for a sharper reason than `retireValuations` had: this one runs *in* the
 * API process, so the read-through cache it must invalidate is this process's.
 * Without the drop, `archived_at` stays non-null for a full TTL and every write
 * to the engagement keeps answering 409 after it has been restored.
 */
export async function restoreValuations(pool: pg.Pool, ids: readonly string[]): Promise<RestoreResult> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return { restored: [], missing: [], notArchived: [] };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The UPDATE is the arbiter, not this SELECT: `archived_at IS NOT NULL` can
    // stop being true between them. This reads what exists, the UPDATE reports
    // what it took, and the difference is `notArchived`.
    const present = await client.query<{ id: string }>(
      'SELECT id FROM valuations WHERE id = ANY($1::ulid[])',
      [wanted],
    );
    const found = present.rows.map((r) => r.id);

    // `version` moves for the same reason it moves in `retireValuations`: this
    // takes the suffix back off `company_name`, which is a field the ops and
    // owner forms both post. Restore is the half where it bites — reads stay
    // open on a retired engagement, so somebody can be sitting on the form
    // while an admin restores it, and their next save would have gone through
    // on a matching ETag against a name they never saw change.
    const { rows: taken } = await client.query<{ id: string }>(
      `UPDATE valuations
          SET archived_at = NULL,
              version = version + 1,
              company_name = CASE
                WHEN company_name LIKE ('%' || $2::text)
                  THEN left(company_name, length(company_name) - length($2::text))
                ELSE company_name
              END
        WHERE id = ANY($1::ulid[]) AND archived_at IS NOT NULL
        RETURNING id`,
      [found, RETIRED_SUFFIX],
    );
    await client.query('COMMIT');
    const restored = taken.map((r) => r.id);
    for (const id of restored) invalidateValuation(id);
    return {
      restored,
      missing: wanted.filter((id) => !found.includes(id)),
      notArchived: found.filter((id) => !restored.includes(id)),
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
