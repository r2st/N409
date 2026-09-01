import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * No index may be a strict prefix of another index on the same table.
 *
 * Such an index can serve no plan the wider one cannot: the same leading keys
 * are seekable, a longer pathkey list satisfies a request for its prefix, and an
 * index-only scan of the narrow one is an index-only scan of the wide one
 * carrying a column more. What it costs is real and is paid on every write —
 * a maintained btree per insert, and per UPDATE that moves the column.
 *
 * Seven of these had accumulated by 0199, every one a hand-written
 * `CREATE INDEX (valuation_id)` a few lines from the `UNIQUE (valuation_id, …)`
 * that subsumes it, usually in the same migration. 0201 and 0202 dropped them.
 * This is the standing guard, so the next one is argued for rather than typed.
 *
 * ASKED OF `pg_index`, NOT OF `pg_get_indexdef`. What separates a redundant
 * index from a necessary one is often invisible in the column *names*: a DESC,
 * a NULLS placement, a different opclass or collation makes two indexes over the
 * same columns answer different questions (0170's subject entirely). So the
 * comparison is over `indkey`, `indclass`, `indcollation` and `indoption`, and
 * partial and expression indexes are excluded — a predicate is a reason for a
 * second index over the same keys, and `indexprs` puts the real key outside
 * `indkey` where this comparison cannot see it.
 */
const CENSUS = `
  WITH ix AS (
    SELECT i.indrelid::regclass::text AS tbl, i.indexrelid::regclass::text AS name,
           string_to_array(i.indkey::text, ' ')       AS k,
           string_to_array(i.indclass::text, ' ')     AS c,
           string_to_array(i.indcollation::text, ' ') AS co,
           string_to_array(i.indoption::text, ' ')    AS o,
           i.indisunique AS uniq, i.indpred IS NOT NULL AS partial,
           i.indexprs IS NOT NULL AS expr, i.indnkeyatts AS n
      FROM pg_index i
      JOIN pg_class rel ON rel.oid = i.indexrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'public'
  )
  SELECT a.name AS narrow, b.name AS wide, a.tbl AS tbl
    FROM ix a JOIN ix b ON a.tbl = b.tbl AND a.name <> b.name
   -- A UNIQUE index is never redundant: it is a constraint as well as an access
   -- path, and the wider index does not enforce it.
   WHERE NOT a.uniq AND NOT a.partial AND NOT b.partial AND NOT a.expr AND NOT b.expr
     AND a.n < b.n
     AND a.k[1:a.n] = b.k[1:a.n] AND a.c[1:a.n] = b.c[1:a.n]
     AND a.co[1:a.n] = b.co[1:a.n] AND a.o[1:a.n] = b.o[1:a.n]
   ORDER BY a.tbl, a.name`;

/**
 * Indexes deliberately kept despite being a prefix of another, each with the
 * mechanism that makes the wider one the wrong answer. Empty, and an entry has
 * to say more than "it is smaller" — a narrower index is always smaller, so that
 * is the reason every one of these would have.
 */
const KEPT: Readonly<Record<string, string>> = {};

describe.skipIf(!dbUp)('no index is a strict prefix of another (R306)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await setupTestDb();
  }, 180_000);
  afterAll(async () => db?.teardown());

  it('finds a redundant index when there is one', async () => {
    /*
     * The discriminator, and this file needs one more than most: the assertion
     * below is that a query returns nothing, which is also what a query that has
     * stopped working returns. So one of the seven 0202 dropped is put back
     * inside a transaction that is rolled back: the census has to name it, and
     * name what subsumes it.
     */
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE INDEX census_probe_idx ON valuation_signatures (valuation_id)');
      const { rows } = await client.query<{ narrow: string; wide: string }>(CENSUS);
      expect(rows.map((r) => r.narrow)).toContain('census_probe_idx');
      // And it names what subsumes it, which is the half a fix needs.
      expect(rows.find((r) => r.narrow === 'census_probe_idx')?.wide).toBe(
        'valuation_signatures_valuation_id_role_key',
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('leaves none in the schema', async () => {
    const { rows } = await db.pool.query<{ narrow: string; wide: string; tbl: string }>(CENSUS);
    const unaccounted = rows
      .filter((r) => !(r.narrow in KEPT))
      .map((r) => `${r.tbl}: ${r.narrow} is a prefix of ${r.wide}`);
    expect(unaccounted).toEqual([]);
  });

  it('states a mechanism, not a size, for anything kept', () => {
    const vague = Object.entries(KEPT).filter(
      ([, why]) => why.trim().length < 80 || /\bsmaller\b|\bcheaper to scan\b/i.test(why),
    );
    expect(vague.map(([k]) => k)).toEqual([]);
  });
});
