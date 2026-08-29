import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

const EXPORT_SRC = fileURLToPath(new URL('../../src/repos/dataExport.ts', import.meta.url));

/**
 * No table in a subject access request is reached by a sequential scan.
 *
 * `buildPersonalExport` answers an Art. 15 request with nineteen hand-written
 * sections under one `Promise.all`. Each asks the same question of a different
 * table — which of these rows are about this person — and the shape of the
 * answer is always the same: find the rows by a column that names the subject,
 * newest first, capped. Whether that is a lookup or a scan of the whole table
 * depends on a fact stated nowhere near the query, in a migration, about an
 * index.
 *
 * Six of the nineteen were scans when this was written, and they were the six
 * biggest tables the export touches: `documents`, `valuation_comments`,
 * `email_outbox`, `valuation_signatures`, and the two reached by folded email
 * address, `contact_submissions` and `user_invitations`. Migration 0176 closed
 * them. What is worth guarding is not those six but the reason nobody noticed:
 * an export is rare, nobody is timing it, and its cost is invisible until it is
 * the thing holding six of ten pool connections while it scans.
 *
 * `personalDataCensus` (unit) asks whether a table that holds personal data is
 * *in* the export. This asks whether the export can reach it without reading
 * the table end to end. The two together are the obligation on a new section:
 * be present, and be indexed.
 *
 * ## Why this is not another foreign-key sweep
 *
 * R92 concluded that 85 unindexed foreign keys are fine here, because the cost
 * of an unindexed foreign key falls when the parent row is deleted and this
 * schema hard-deletes almost nothing; `foreignKeyIndexCensus` holds that half.
 * R154 checked the other half — a foreign key that is also a filter predicate,
 * which is a scan whatever the delete story is — found seven candidates and
 * seven false positives, and the conclusion recorded was "clean".
 *
 * Four of the six above are foreign keys to `users` read as predicates, so they
 * are precisely what that sweep was looking for and did not find. Rather than
 * re-run a sweep of the whole schema and hope it reaches further this time,
 * this census asks the narrow question from the other end: not "which foreign
 * keys might be predicates" but "which predicates does this one endpoint
 * actually issue", read out of its own source.
 */

/** A table the export reads, and how it reaches it. */
interface Access {
  /** Section number, for a failure message that says which query. */
  section: number;
  table: string;
  /**
   * Leading key the access needs: a column name, or a normalised expression as
   * Postgres spells it in `pg_get_expr` (`lower(email)`).
   */
  key: string;
}

/**
 * The section SQL, taken from the source rather than restated here.
 *
 * A copy of the queries in this file would be the third place they exist and
 * the first to go stale — the failure mode would be a census that passes
 * against SQL nobody runs. Every section is written as `section(pool, \`…\`,
 * [userId])`, so one regex reaches all of them, and `finds every section` below
 * is the guard against that regex quietly matching fewer.
 */
function sectionSql(): string[] {
  const src = readFileSync(EXPORT_SRC, 'utf8');
  return [...src.matchAll(/section\(\s*pool,\s*`([\s\S]*?)`/g)].map((m) => m[1]!.replace(/\s+/g, ' ').trim());
}

/**
 * Which table each alias names, from the query's own FROM and JOIN clauses.
 *
 * `FROM valuations` with no alias is its own alias, which is why the map is
 * keyed on both.
 */
function aliases(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)(?:\s+([a-z][a-z0-9_]*))?/gi)) {
    const table = m[1]!.toLowerCase();
    const alias = m[2]?.toLowerCase();
    map.set(table, table);
    // `ORDER`/`WHERE`/`LIMIT` can follow a table name and look like an alias.
    if (alias && !/^(where|order|limit|on|group|left|inner|join)$/.test(alias)) map.set(alias, table);
  }
  return map;
}

/**
 * The accesses one section makes: every predicate that could be an index
 * lookup, as (table, leading key) pairs.
 *
 * Two sources, and both are needed. The `WHERE … = $1` is how the subject is
 * named, and for thirteen of the nineteen sections it is the only access there
 * is. The rest reach a second table through a join, and *that* table's cost is
 * decided by the `ON` clause instead — `payments` is found by
 * `payments.valuation_id`, `contact_submissions` by `lower(email)`. A census
 * that read only the WHERE would call those sections covered on the strength of
 * an index on the table they are not scanning.
 */
function accesses(sql: string, section: number): Access[] {
  const alias = aliases(sql);
  const out: Access[] = [];
  const resolve = (qualifier: string | undefined, column: string): Access | null => {
    // Unqualified column in a single-table section: the one table is the table.
    const table = qualifier ? alias.get(qualifier.toLowerCase()) : [...new Set(alias.values())][0];
    return table ? { section, table, key: column.toLowerCase() } : null;
  };

  const where = /WHERE\s+(?:([a-z][a-z0-9_]*)\.)?([a-z_][a-z0-9_]*)\s*=\s*\$1/i.exec(sql);
  if (where) {
    const a = resolve(where[1], where[2]!);
    if (a) out.push(a);
  }

  for (const on of sql.matchAll(/\bON\s+(\S+)\s*=\s*(\S+)/gi)) {
    for (const side of [on[1]!, on[2]!]) {
      // `lower(c.email)` -> key `lower(email)`; `p.valuation_id` -> `valuation_id`.
      const fn = /^([a-z_]+)\(([a-z][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\)$/i.exec(side);
      const plain = /^([a-z][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/i.exec(side);
      if (fn) {
        const table = alias.get(fn[2]!.toLowerCase());
        if (table) out.push({ section, table, key: `${fn[1]!.toLowerCase()}(${fn[3]!.toLowerCase()})` });
      } else if (plain) {
        const a = resolve(plain[1], plain[2]!);
        if (a) out.push(a);
      }
    }
  }
  return out;
}

/**
 * Leading index keys per table, from the catalog.
 *
 * Leading-column matching, which is the planner's own rule: an index on
 * `(uploaded_by, created_at)` serves a predicate on `uploaded_by` and one on
 * `(created_at, uploaded_by)` does not.
 *
 * Partial indexes are excluded, and that exclusion is the point rather than a
 * simplification. `user_invitations_pending_email_key` indexes `lower(email)`
 * and looks like coverage, but it is partial to invitations that are still
 * open — which is every invitation except the accepted one an account holder's
 * export is looking for. Counting it would have made this census green over the
 * exact query it was written to catch. A partial index that genuinely serves a
 * section can be admitted, but only by someone who has checked that the
 * section's predicate implies the index's, which is a judgement and not a join.
 */
const LEADING_KEYS_SQL = `
  SELECT t.relname AS tbl,
         CASE WHEN x.indkey[0] = 0
              THEN pg_get_expr(x.indexprs, x.indrelid)
              ELSE (SELECT a.attname FROM pg_attribute a
                     WHERE a.attrelid = t.oid AND a.attnum = x.indkey[0])
         END AS lead
    FROM pg_index x
    JOIN pg_class t ON t.oid = x.indrelid
   WHERE t.relnamespace = 'public'::regnamespace
     AND x.indpred IS NULL
     AND x.indisvalid`;

describe.skipIf(!dbUp)('the personal export reaches every table by an index (R193)', () => {
  let db: TestDb;
  let leading: Map<string, Set<string>>;
  let sections: string[];
  let reads: Access[];

  beforeAll(async () => {
    db = await setupTestDb();
    sections = sectionSql();
    reads = sections.flatMap((sql, i) => accesses(sql, i + 1));
    leading = new Map();
    const { rows } = await db.pool.query<{ tbl: string; lead: string }>(LEADING_KEYS_SQL);
    for (const r of rows) {
      if (!leading.has(r.tbl)) leading.set(r.tbl, new Set());
      leading.get(r.tbl)!.add(r.lead.toLowerCase());
    }
  });
  afterAll(async () => db?.teardown());

  it('finds every section of the export', () => {
    // Vacuity guard, and the one that matters most here: every assertion below
    // is over `reads`, so a regex that stopped matching would report a
    // perfectly indexed export of nothing. Pinned to a count rather than a
    // floor so that *deleting* a section is as visible as adding one.
    expect(sections).toHaveLength(20);
    const tables = new Set(reads.map((a) => a.table));
    for (const t of [
      'valuations',
      'documents',
      'email_outbox',
      'contact_submissions',
      'payments',
      'admin_events',
    ]) {
      expect(tables.has(t)).toBe(true);
    }
  });

  it('reads the catalog, including expression indexes', () => {
    // The other half of the vacuity guard. `lower(email)` only ever matches if
    // `pg_get_expr` spells it the way `accesses` does; if that ever diverges,
    // the two email-keyed sections fail below with no clue why, so it is
    // asserted here where the message is about spelling.
    expect(leading.size).toBeGreaterThan(50);
    expect(leading.get('contact_submissions')).toContain('lower(email)');
    expect(leading.get('documents')).toContain('uploaded_by');
  });

  it('leaves no section reaching a table by a sequential scan', () => {
    // One table may be reached several ways in one section — `payments` by its
    // valuation, `valuations` by its owner — and needs only one of them to be
    // an index. So the rule is per (section, table), not per predicate.
    const byTable = new Map<string, Access[]>();
    for (const a of reads) {
      const k = `${a.section}:${a.table}`;
      if (!byTable.has(k)) byTable.set(k, []);
      byTable.get(k)!.push(a);
    }
    const scans = [...byTable.entries()]
      .filter(([, group]) => !group.some((a) => leading.get(a.table)?.has(a.key)))
      .map(
        ([k, group]) =>
          `section ${group[0]!.section}: ${group[0]!.table} reached only by ` +
          `${[...new Set(group.map((a) => a.key))].join(' / ')} — ${k}`,
      );
    expect(scans).toEqual([]);
  });

  it('indexes the tables the export was scanning (0176, 0184)', () => {
    // Named individually so that reverting the migration fails with the list
    // rather than with a generic census message, and so the census cannot go
    // green by losing the sections instead of keeping the indexes.
    const closed: Array<[string, string]> = [
      ['documents', 'uploaded_by'],
      ['valuation_comments', 'author_id'],
      ['valuation_signatures', 'signer_user_id'],
      ['email_outbox', 'to_user_id'],
      ['contact_submissions', 'lower(email)'],
      ['user_invitations', 'lower(email)'],
      // 0184, and the same shape one round later: the audit spine's own
      // subject index leads on `subject_type`, which has about six distinct
      // values, so the account-events section (and `routes/evidence.ts`, which
      // has asked the same question since it was written) read the whole
      // table. Listed here rather than in a second block because what makes
      // it the same finding is not the migration number.
      ['admin_events', 'subject_id'],
    ];
    for (const [table, key] of closed) {
      expect(leading.get(table), `${table}.${key}`).toContain(key);
      expect(
        reads.some((a) => a.table === table && a.key === key),
        `${table}.${key} is read`,
      ).toBe(true);
    }
  });
});
