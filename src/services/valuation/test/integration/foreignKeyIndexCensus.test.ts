import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/**
 * Postgres does not index a foreign key column for you, and most of this
 * schema's are not indexed — 85 of 172 at the time of writing. R92 measured
 * that and concluded it was fine, for a stated reason: the cost of an unindexed
 * foreign key falls when the *parent* row is deleted, because Postgres has to
 * prove no child still references it, and this schema hard-deletes almost
 * nothing. Engagements are archived ([[n409-archived-writes]]), users are
 * anonymised, and the ledgers are append-only.
 *
 * That reasoning is sound and it is also load-bearing and invisible. Nothing in
 * the repository states it, and nothing fails if it stops being true. The day
 * somebody adds `DELETE FROM users` — a GDPR erasure that goes further than
 * anonymisation, say — sixty unindexed foreign keys silently become sixty
 * sequential scans per deletion, and the only signal is a slow endpoint.
 *
 * So the premise is asserted rather than remembered. An unindexed foreign key
 * is allowed exactly while nothing deletes rows from the table it points at,
 * and this reads both halves from the things that decide them: the catalog for
 * the indexes, and the source for the deletes.
 *
 * Two ways it can fail, and both are the point:
 *   - a new `DELETE FROM parent` where `parent` is on the receiving end of an
 *     unindexed foreign key — index the column, or stop deleting;
 *   - a new table whose foreign key points at something already deleted.
 *
 * `EXEMPT` is empty and should stay that way. The one crossing this census
 * found when it was written — `auto_emails.template_key` against
 * `communication_templates`, which `deleteCommunicationTemplate` removes — was
 * closed with an index in migration 0171 rather than an entry here.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map();

/** Every `.ts` under the service's `src/`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * The tables this service deletes rows from, and where.
 *
 * Literal `DELETE FROM <table>` covers all but one caller. The exception is
 * `runHousekeepingSweep`, which interpolates `${target.table}` from
 * `HOUSEKEEPING_TARGETS` — a frozen list in this repository's own source, so
 * the names are read from there rather than lost to the interpolation. A census
 * that could not see them would be reporting five fewer deleted tables than
 * there are, which is the vacuous-check shape ([[n409-vacuous-checks]]).
 */
function hardDeletedTables(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const note = (table: string, where: string): void => {
    const at = found.get(table) ?? new Set<string>();
    at.add(where);
    found.set(table, at);
  };

  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file);
    for (const m of readFileSync(file, 'utf8').matchAll(/DELETE\s+FROM\s+([a-z_][a-z0-9_]*)/gi)) {
      note(m[1]!.toLowerCase(), rel);
    }
  }

  const housekeeping = readFileSync(path.join(SRC, 'domain/housekeeping.ts'), 'utf8');
  const targets = housekeeping.slice(housekeeping.indexOf('HOUSEKEEPING_TARGETS'));
  for (const m of targets.matchAll(/table:\s*'([a-z_]+)'/g)) {
    note(m[1]!, 'domain/housekeeping.ts (sweep)');
  }
  return found;
}

interface UnindexedFk {
  tgt_table: string;
  src_table: string;
  cols: string;
}

/**
 * Foreign keys with no index whose leading columns are the constraint's columns.
 *
 * Leading-column matching rather than exact: an index on `(valuation_id,
 * created_at)` serves a foreign key on `(valuation_id)` perfectly well, and one
 * on `(created_at, valuation_id)` does not. This is the same rule the planner
 * uses, so the census agrees with the thing it is describing.
 */
const UNINDEXED_FK_SQL = `
WITH fk AS (
  SELECT c.conname, src.relname AS src_table, tgt.relname AS tgt_table, c.conkey,
         (SELECT string_agg(a.attname, ',' ORDER BY x.ord)
            FROM unnest(c.conkey) WITH ORDINALITY x(att, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = x.att) AS cols
    FROM pg_constraint c
    JOIN pg_class src ON src.oid = c.conrelid
    JOIN pg_class tgt ON tgt.oid = c.confrelid
   WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace),
covered AS (
  SELECT fk.conname
    FROM fk
    JOIN pg_index i
      ON i.indrelid = (SELECT oid FROM pg_class
                        WHERE relname = fk.src_table AND relnamespace = 'public'::regnamespace)
   WHERE (i.indkey::int2[])[0:array_length(fk.conkey, 1) - 1] = fk.conkey)
SELECT tgt_table, src_table, cols
  FROM fk
 WHERE conname NOT IN (SELECT conname FROM covered)
 ORDER BY tgt_table, src_table, cols`;

describe.skipIf(!dbUp)('an unindexed foreign key never points at a deleted table (R166)', () => {
  let db: TestDb;
  let unindexed: UnindexedFk[];
  let deleted: Map<string, Set<string>>;

  beforeAll(async () => {
    db = await setupTestDb();
    unindexed = (await db.pool.query<UnindexedFk>(UNINDEXED_FK_SQL)).rows;
    deleted = hardDeletedTables();
  });
  afterAll(async () => db?.teardown());

  it('finds foreign keys and deletes to reason about at all', () => {
    // Both halves have to be non-empty or the crossing below is vacuous: a
    // regex that stopped matching, or a catalog query that stopped returning
    // rows, would otherwise read as a clean bill of health.
    expect(unindexed.length).toBeGreaterThan(50);
    expect(deleted.size).toBeGreaterThan(20);
    // The dynamic sweep's targets specifically — the ones a literal-only scan
    // would miss.
    expect(deleted.has('password_reset_tokens')).toBe(true);
    expect(deleted.has('partner_api_idempotency')).toBe(true);
  });

  it('leaves no unindexed foreign key pointing at a table something deletes', () => {
    const crossings = unindexed
      .filter((fk) => deleted.has(fk.tgt_table))
      .filter((fk) => !EXEMPT.has(`${fk.src_table}.${fk.cols}`))
      .map(
        (fk) =>
          `${fk.src_table}.${fk.cols} -> ${fk.tgt_table} ` +
          `(deleted in ${[...deleted.get(fk.tgt_table)!].sort().join(', ')})`,
      );
    expect(crossings).toEqual([]);
  });

  it('has no exemption that no longer names a real crossing', () => {
    // An exemption for a pair that has since been indexed or stopped being
    // deleted is a licence nobody is using, and the next reader would take it
    // for a still-live problem.
    const live = new Set(
      unindexed.filter((fk) => deleted.has(fk.tgt_table)).map((fk) => `${fk.src_table}.${fk.cols}`),
    );
    expect([...EXEMPT.keys()].filter((k) => !live.has(k))).toEqual([]);
  });

  it('indexes the foreign key behind the template delete (0171)', () => {
    // The crossing this census was written to find, pinned by name so the
    // migration cannot be reverted back into a passing census.
    const stillUnindexed = unindexed.some(
      (fk) => fk.src_table === 'auto_emails' && fk.cols === 'template_key',
    );
    expect(stillUnindexed).toBe(false);
  });
});
