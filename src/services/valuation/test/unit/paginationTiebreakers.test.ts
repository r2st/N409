import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { orderBySql } from '../../src/repos/valuations.js';

/**
 * Every OFFSET-paginated query carries a unique tiebreaker in its ORDER BY.
 *
 * A paged list issues one query per page, differing only in the OFFSET, and
 * Postgres guarantees nothing about the relative order of rows that tie on the
 * sort key. Two reads of an unchanged small table usually agree anyway, which
 * is exactly why this is worth a machine's attention rather than a reviewer's:
 * the bug is invisible until the table is written to, and then an UPDATE moves
 * a row to the end of the heap and the pages stop lining up. One row is served
 * twice, its neighbour never, and `total` goes on counting both.
 *
 * Ties are not exotic here. `created_at` defaults to `now()` — the *transaction*
 * timestamp — so every row a seed, an import, a restore or a batch writes shares
 * one instant to the microsecond, and `created_at` is what almost all of these
 * order by.
 *
 * `pageStability.test.ts` carries the behavioural half against a real database
 * for the two client-facing lists. This carries the coverage, because the
 * defect is a property of every paged query and the next one added to this
 * service is the tenth: `repos/valuations.ts` had the tiebreaker on the
 * explicit-sort branch and not on the default one for as long as both existed,
 * and no reviewer looking at either branch alone would see it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOS = path.resolve(HERE, '../../src/repos');

/**
 * Columns that are unique per row of the result and so settle any tie.
 *
 * `id` for the ordinary case. `company_name` for `firmClients`, which is a
 * GROUP BY — the group key is unique across the rows the LIMIT is cutting,
 * which is the only set that matters here.
 */
const TIEBREAKER = /\b(?:[a-z]+\.)?(?:id|company_name)\b\s*(?:ASC|DESC)?\s*(?:,|`|\n|$)/i;

interface PagedQuery {
  file: string;
  line: number;
  orderBy: string;
}

/**
 * Every SQL string in `repos/` that pages with OFFSET, with its ORDER BY.
 *
 * Matched on the SQL rather than on a helper name because there is no helper:
 * six repos spell `(page - 1) * perPage` themselves and assemble the LIMIT /
 * OFFSET placeholders inline.
 */
function pagedQueries(): PagedQuery[] {
  const found: PagedQuery[] = [];
  for (const file of readdirSync(REPOS).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(path.join(REPOS, file), 'utf8');
    // Template literals, which is how every multi-line query in this service is
    // written. `[\s\S]` rather than the `s` flag so a nested `${}` is kept.
    for (const match of src.matchAll(/`[\s\S]*?`/g)) {
      const sql = match[0];
      if (!/\bOFFSET\b/i.test(sql)) continue;
      // `pruneNetworkItems` uses OFFSET to find a boundary row, not to page:
      // it takes one row and discards the order afterwards.
      if (/\bDELETE\s+FROM\b/i.test(sql)) continue;
      // `listValuations` is the one query whose ORDER BY is interpolated from a
      // builder; the scan cannot read it and `orderBySql` is asserted directly
      // below instead, on both of its branches.
      if (/\$\{orderBySql\(/.test(sql)) continue;
      const orderBy = /ORDER BY([\s\S]*?)(?:\n\s*LIMIT\b|\bLIMIT\b)/i.exec(sql)?.[1];
      found.push({
        file,
        line: src.slice(0, match.index).split('\n').length,
        // A paged query with no ORDER BY at all is the same defect in its
        // purest form, and records as an empty clause rather than being skipped.
        orderBy: (orderBy ?? '').replace(/--[^\n]*/g, '').trim(),
      });
    }
  }
  return found;
}

describe('paged queries order deterministically', () => {
  const queries = pagedQueries();

  it('finds the paged queries at all (vacuity guard)', () => {
    // Nine at the time of writing. A regex that silently stopped matching would
    // make every assertion below vacuously true, which is the failure mode of
    // this whole style of test.
    expect(queries.length).toBeGreaterThanOrEqual(8);
    const files = new Set(queries.map((q) => q.file));
    for (const expected of ['firmDashboard.ts', 'inbox.ts', 'tasks.ts', 'reviews.ts']) {
      expect(files, `${expected} should contribute a paged query`).toContain(expected);
    }
  });

  /**
   * The engagement list — the busiest paged query on the platform, and the one
   * whose ORDER BY is assembled rather than written out.
   *
   * Both branches, because for a long time only one of them carried the
   * tiebreaker and it was the branch fewer callers use: sorting is opt-in, so
   * the default is what the client portal and the ops worklist actually issue.
   */
  it.each([
    ['the default order', undefined],
    ['an explicit sort', [{ column: 'company_name' as const, dir: 'asc' as const }]],
    ['a multi-term sort', [
      { column: 'state' as const, dir: 'desc' as const },
      { column: 'due_date' as const, dir: 'asc' as const },
    ]],
  ] as const)('settles ties on the engagement list for %s', (_label, sort) => {
    const clause = orderBySql(sort).replace(/^ORDER BY\s*/i, '');
    expect(TIEBREAKER.test(clause), `ORDER BY ${clause}`).toBe(true);
    // Aliased too: the export query joins `users` and `partners`, which have
    // their own `id`, so an unqualified tiebreaker there is an ambiguous-column
    // error rather than a stable sort.
    expect(orderBySql(sort, 'v.')).toMatch(/v\.id ASC$/);
  });

  it.each(pagedQueries().map((q) => [`${q.file}:${q.line}`, q] as const))(
    'settles ties in %s',
    (_label, query) => {
      expect(query.orderBy, 'a paged query with no ORDER BY orders arbitrarily').not.toBe('');
      expect(
        TIEBREAKER.test(query.orderBy),
        `ORDER BY ${query.orderBy} has no unique last term, so rows tying every ` +
          `term above it order arbitrarily and a tie across a page boundary ` +
          `duplicates one row and drops another`,
      ).toBe(true);
    },
  );

  it('rejects an ORDER BY whose terms all tie (the matcher works)', () => {
    // Proving the predicate can fail, planted rather than trusted — the trap in
    // every source scan is a pattern that matches everything.
    expect(TIEBREAKER.test('created_at DESC')).toBe(false);
    expect(TIEBREAKER.test('v.due_date ASC NULLS LAST, v.created_at DESC')).toBe(false);
    expect(TIEBREAKER.test('c.created_at DESC, c.id DESC')).toBe(true);
    expect(TIEBREAKER.test('max(created_at) DESC, company_name ASC')).toBe(true);
  });
});
