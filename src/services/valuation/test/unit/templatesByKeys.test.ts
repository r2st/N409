import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { findTemplatesByKeys } from '../../src/repos/communications.js';

/**
 * The drip scan looked its template up once per campaign. Campaign template
 * keys repeat — one renewal template serves several cadences — so a pass over
 * n campaigns spent n round trips re-reading a handful of distinct rows before
 * it looked at a single candidate.
 */

const ROWS = [
  { key: 'renewal_due', subject: 'Time to refresh', body: 'Hi {{company_name}}', enabled: true },
  { key: 'draft_ready', subject: 'Your draft', body: 'Ready', enabled: false },
];

function fakePool() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      const wanted = new Set(params[0] as string[]);
      const rows = ROWS.filter((r) => wanted.has(r.key));
      return { rows, rowCount: rows.length };
    }),
  } as unknown as pg.Pool;
  return { pool, calls };
}

describe('findTemplatesByKeys', () => {
  it('reads any number of templates in one query, keyed for lookup', async () => {
    const { pool, calls } = fakePool();

    const found = await findTemplatesByKeys(pool, ['renewal_due', 'draft_ready']);

    expect(calls).toHaveLength(1);
    expect([...found.keys()].sort()).toEqual(['draft_ready', 'renewal_due']);
    expect(found.get('renewal_due')?.subject).toBe('Time to refresh');
  });

  it('collapses repeated keys, which is the shape the scan actually passes', async () => {
    const { pool, calls } = fakePool();

    await findTemplatesByKeys(pool, ['renewal_due', 'renewal_due', 'draft_ready', 'renewal_due']);

    expect(calls[0]!.params[0]).toEqual(['renewal_due', 'draft_ready']);
  });

  /**
   * A missing row means "this campaign names a template that does not exist";
   * the scan reads that as skip-and-warn, so the absence has to survive the
   * batching rather than becoming an empty-but-present row.
   */
  it('omits keys with no row rather than inventing one', async () => {
    const { pool } = fakePool();

    const found = await findTemplatesByKeys(pool, ['renewal_due', 'no_such_template']);

    expect(found.has('no_such_template')).toBe(false);
    expect(found.get('no_such_template')).toBeUndefined();
    expect(found.size).toBe(1);
  });

  it('issues no query at all when there are no campaigns to serve', async () => {
    const { pool, calls } = fakePool();

    expect(await findTemplatesByKeys(pool, [])).toEqual(new Map());
    expect(calls).toHaveLength(0);
  });
});
