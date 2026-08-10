import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { findDocumentsByIds } from '../../src/repos/documents.js';

/** A pool stand-in that records every query the repo issues. */
function fakePool(rows: Array<{ id: string }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      const wanted = new Set(params[0] as string[]);
      const matched = rows.filter((r) => wanted.has(r.id));
      return { rows: matched, rowCount: matched.length };
    }),
  } as unknown as pg.Pool;
  return { pool, calls };
}

const DOCS = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];

describe('findDocumentsByIds', () => {
  /**
   * The point of the function. Bulk re-filing used to call findDocumentById
   * once per assignment, so a "select all" on the triage queue cost one round
   * trip per row before a single write happened.
   */
  it('reads any number of documents in one query', async () => {
    const { pool, calls } = fakePool(DOCS);
    const found = await findDocumentsByIds(pool, ['A', 'B', 'C']);
    expect(calls).toHaveLength(1);
    expect([...found.keys()].sort()).toEqual(['A', 'B', 'C']);
  });

  it('keys the result by id so the caller looks up rather than scans', async () => {
    const { pool } = fakePool(DOCS);
    const found = await findDocumentsByIds(pool, ['B']);
    expect(found.get('B')).toEqual({ id: 'B' });
  });

  it('issues no query at all for an empty batch', async () => {
    const { pool, calls } = fakePool(DOCS);
    expect(await findDocumentsByIds(pool, [])).toEqual(new Map());
    expect(calls).toHaveLength(0);
  });

  it('de-duplicates ids before asking the database', async () => {
    const { pool, calls } = fakePool(DOCS);
    await findDocumentsByIds(pool, ['A', 'A', 'A', 'B']);
    expect(calls[0]!.params[0]).toEqual(['A', 'B']);
  });

  /**
   * Absent rather than an error: the caller reports per-item outcomes and
   * already has to say "unknown document" for a row someone else removed while
   * the queue was on screen.
   */
  it('omits ids that match nothing instead of failing the batch', async () => {
    const { pool } = fakePool(DOCS);
    const found = await findDocumentsByIds(pool, ['A', 'MISSING']);
    expect([...found.keys()]).toEqual(['A']);
  });

  it('excludes soft-deleted documents in SQL, not after the fact', async () => {
    const { pool, calls } = fakePool(DOCS);
    await findDocumentsByIds(pool, ['A']);
    expect(calls[0]!.sql).toContain('deleted_at IS NULL');
  });
});
