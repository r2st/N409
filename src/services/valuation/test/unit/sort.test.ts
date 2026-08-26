import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { MAX_SORT_TERMS, SORTABLE_COLUMNS, exportValuations, parseSort } from '../../src/repos/valuations.js';

describe('rich sort parsing (M4 #30)', () => {
  it('parses multi-column sort with directions', () => {
    expect(parseSort('company_name:asc,created_at:desc')).toEqual([
      { column: 'company_name', dir: 'asc' },
      { column: 'created_at', dir: 'desc' },
    ]);
  });

  it('defaults direction to asc', () => {
    expect(parseSort('due_date')).toEqual([{ column: 'due_date', dir: 'asc' }]);
  });

  it('returns empty for absent sort', () => {
    expect(parseSort(undefined)).toEqual([]);
    expect(parseSort('')).toEqual([]);
  });

  it('rejects unknown columns (SQL injection guard) and bad directions', () => {
    expect(parseSort('company_name; DROP TABLE valuations')).toBeNull();
    expect(parseSort('password_digest:asc')).toBeNull();
    expect(parseSort('created_at:sideways')).toBeNull();
    expect(parseSort('company_name:asc,nope:desc')).toBeNull();
  });
});

describe('sort term count (round 36)', () => {
  it('accepts every sortable column at once', () => {
    const raw = SORTABLE_COLUMNS.map((c) => `${c}:asc`).join(',');
    expect(parseSort(raw)).toHaveLength(SORTABLE_COLUMNS.length);
    expect(SORTABLE_COLUMNS.length).toBeLessThanOrEqual(MAX_SORT_TERMS);
  });

  it('rejects more terms than there are columns to sort by', () => {
    // Whitelisted columns mean no term can be an injection, but the *count* was
    // unbounded: every term is another key Postgres sorts the result set by, so
    // the length of a query string set the length of an ORDER BY.
    expect(parseSort(Array(MAX_SORT_TERMS).fill('created_at:asc').join(','))).not.toBeNull();
    expect(
      parseSort(
        Array(MAX_SORT_TERMS + 1)
          .fill('created_at:asc')
          .join(','),
      ),
    ).toBeNull();
    expect(parseSort(Array(2000).fill('number:desc').join(','))).toBeNull();
  });
});

describe('exportValuations ordering (round 36)', () => {
  interface Captured {
    sql: string;
    params: unknown[];
  }

  function fakePool(): { pool: pg.Pool; calls: Captured[] } {
    const calls: Captured[] = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    } as unknown as pg.Pool;
    return { pool, calls };
  }

  const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  const scope = { kind: 'all' } as const;

  it('honours the caller’s sort instead of dropping it', async () => {
    // The route validated `sort`, rejected a bad one with a 400, and then called
    // this function without it — so every CSV and XLSX came back newest-first
    // whatever the list had been ordered by. Only the PDF branch applied it.
    const { pool, calls } = fakePool();
    await exportValuations(pool, scope, {
      sort: [
        { column: 'company_name', dir: 'asc' },
        { column: 'due_date', dir: 'desc' },
      ],
    });
    // The spelling is R166's: `NULLS LAST` survives only on `due_date`, which
    // is the one of these two that can hold a null, and the tiebreaker runs in
    // the last term's direction. Both are plan decisions — on a NOT NULL column
    // the clause cannot move a row but does cost the index, and `col DESC, id
    // ASC` is a mixed ordering no btree produces. What this test is about is
    // unchanged: the caller's sort reaches the SQL instead of being dropped.
    expect(squash(calls[0]!.sql)).toContain(
      'ORDER BY v.company_name ASC, v.due_date DESC NULLS LAST, v.id DESC',
    );
  });

  it('qualifies every ordering term with the table alias', async () => {
    // The export joins `users` twice and `partners` once, and all three carry
    // their own `created_at` and `id`. An unqualified term is not untidy here —
    // it is an ambiguous-column error that fails the whole export.
    const { pool, calls } = fakePool();
    await exportValuations(pool, scope, { sort: [{ column: 'created_at', dir: 'desc' }] });
    const orderBy = squash(calls[0]!.sql).match(/ORDER BY [^)]*?LIMIT/)![0];
    expect(orderBy).not.toMatch(/(?<!v\.)\bcreated_at\b/);
    expect(orderBy).not.toMatch(/(?<!v\.)\bid\b/);
  });

  it('falls back to newest-first when no sort is given', async () => {
    const { pool, calls } = fakePool();
    await exportValuations(pool, scope, {});
    expect(squash(calls[0]!.sql)).toContain('ORDER BY v.created_at DESC');
  });
});
