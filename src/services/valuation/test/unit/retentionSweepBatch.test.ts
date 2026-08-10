import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { markValuationsArchived, recordActions } from '../../src/repos/retention.js';
import { runRetentionSweep } from '../../src/routes/retention.js';

/**
 * The sweep used to spend an UPDATE and an INSERT on every candidate in turn,
 * and `findArchivableValuations` hands it up to 500 of them — so a full batch
 * cost around a thousand sequential round trips to say the same two things.
 * These pin the batched shape: the query count is a function of the pass, not
 * of how many valuations the pass happened to find.
 */

interface Recorded {
  sql: string;
  params: unknown[];
}

const POLICY = {
  data_type: 'valuation',
  archive_after_days: 365,
  retention_days: 730,
  enabled: true,
};

/**
 * A pool stand-in that answers the four queries the sweep issues, routed on the
 * statement rather than on call order — the point of the change is that the
 * order and the count both moved.
 */
function fakePool(candidates: Array<{ id: string; user_id: string; frozen: boolean }>) {
  const calls: Recorded[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM retention_policies')) return { rows: [POLICY], rowCount: 1 };
      if (sql.includes('FROM valuations v')) return { rows: candidates, rowCount: candidates.length };
      if (sql.startsWith('UPDATE valuations')) {
        // Mirrors `WHERE id = ANY($1) AND archived_at IS NULL RETURNING id`.
        const wanted = params[0] as string[];
        return { rows: wanted.map((id) => ({ id })), rowCount: wanted.length };
      }
      if (sql.includes('INSERT INTO retention_actions')) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected query: ${sql}`);
    }),
  } as unknown as pg.Pool;
  return { pool, calls };
}

const candidate = (n: number, frozen = false) => ({
  id: `01JAAAAAAAAAAAAAAAAAAAAA${String(n).padStart(2, '0')}`,
  user_id: '01JUUUUUUUUUUUUUUUUUUUUUUU',
  frozen,
});

const of = (calls: Recorded[], fragment: string) => calls.filter((c) => c.sql.includes(fragment));

describe('runRetentionSweep batching', () => {
  it('archives any number of candidates in one UPDATE and one INSERT', async () => {
    const { pool, calls } = fakePool(Array.from({ length: 250 }, (_, i) => candidate(i)));

    const result = await runRetentionSweep(pool);

    expect(result).toEqual({ archived: 250, skipped_hold: 0 });
    expect(of(calls, 'UPDATE valuations')).toHaveLength(1);
    expect(of(calls, 'INSERT INTO retention_actions')).toHaveLength(1);
    // Two reads and two writes for 250 valuations — the whole point.
    expect(calls).toHaveLength(4);
  });

  it('logs a skip for each held candidate and archives only the rest', async () => {
    const { pool, calls } = fakePool([
      candidate(1),
      candidate(2, true),
      candidate(3),
      candidate(4, true),
    ]);

    const result = await runRetentionSweep(pool);

    expect(result).toEqual({ archived: 2, skipped_hold: 2 });
    // The frozen pair is never named in the UPDATE, not merely absent from the count.
    const [update] = of(calls, 'UPDATE valuations');
    expect(update!.params[0]).toEqual([candidate(1).id, candidate(3).id]);
    // One INSERT carries both decisions: 2 skips + 2 archives, five params each.
    const [insert] = of(calls, 'INSERT INTO retention_actions');
    expect(insert!.params).toHaveLength(4 * 5);
    expect(insert!.params.filter((p) => p === 'skipped_hold')).toHaveLength(2);
    expect(insert!.params.filter((p) => p === 'archived')).toHaveLength(2);
  });

  /**
   * `archived_at IS NULL` can stop being true between the SELECT that found a
   * candidate and the UPDATE that takes it. The sweep counts and logs what
   * `RETURNING` gave back, so a row a concurrent pass archived first is neither
   * double-counted nor double-logged.
   */
  it('counts what the UPDATE took, not what it asked for', async () => {
    const calls: Recorded[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('FROM retention_policies')) return { rows: [POLICY], rowCount: 1 };
        if (sql.includes('FROM valuations v')) {
          return { rows: [candidate(1), candidate(2)], rowCount: 2 };
        }
        // A concurrent sweep already took the second one.
        if (sql.startsWith('UPDATE valuations')) return { rows: [{ id: candidate(1).id }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as pg.Pool;

    const result = await runRetentionSweep(pool);

    expect(result).toEqual({ archived: 1, skipped_hold: 0 });
    const [insert] = of(calls, 'INSERT INTO retention_actions');
    expect(insert!.params).toContain(candidate(1).id);
    expect(insert!.params).not.toContain(candidate(2).id);
  });

  it('writes nothing when the pass finds no candidates', async () => {
    const { pool, calls } = fakePool([]);

    expect(await runRetentionSweep(pool)).toEqual({ archived: 0, skipped_hold: 0 });
    // An empty VALUES list is a syntax error, so the no-op must be in the repo
    // and not in a loop that happens to run zero times.
    expect(of(calls, 'UPDATE valuations')).toHaveLength(0);
    expect(of(calls, 'INSERT INTO retention_actions')).toHaveLength(0);
  });

  it('stops before any write when the policy is off or unset', async () => {
    for (const policy of [
      { ...POLICY, enabled: false },
      { ...POLICY, archive_after_days: null },
    ]) {
      const calls: Recorded[] = [];
      const pool = {
        query: vi.fn(async (sql: string) => {
          calls.push({ sql, params: [] });
          if (sql.includes('FROM retention_policies')) return { rows: [policy], rowCount: 1 };
          throw new Error(`policy is off; nothing else should run, got: ${sql}`);
        }),
      } as unknown as pg.Pool;

      expect(await runRetentionSweep(pool)).toEqual({ archived: 0, skipped_hold: 0 });
      expect(calls).toHaveLength(1);
    }
  });
});

describe('recordActions', () => {
  it('writes one multi-row INSERT with five params per decision', async () => {
    const calls: Recorded[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as pg.Pool;

    await recordActions(pool, [
      { dataType: 'valuation', action: 'archived', referenceId: 'a', detail: { archive_after_days: 365 } },
      { dataType: 'valuation', action: 'skipped_hold', referenceId: 'b' },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)');
    expect(calls[0]!.params).toHaveLength(10);
    // A row with no detail still gets an object, not a null the column rejects.
    expect(calls[0]!.params[9]).toBe('{}');
    expect(calls[0]!.params[4]).toBe(JSON.stringify({ archive_after_days: 365 }));
  });

  it('issues no query at all for an empty batch', async () => {
    const query = vi.fn();
    await recordActions({ query } as unknown as pg.Pool, []);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('markValuationsArchived', () => {
  it('deduplicates ids and returns only the rows the UPDATE took', async () => {
    const calls: Recorded[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [{ id: 'a' }], rowCount: 1 };
      }),
    } as unknown as pg.Pool;

    expect(await markValuationsArchived(pool, ['a', 'b', 'a'])).toEqual(['a']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params[0]).toEqual(['a', 'b']);
    expect(calls[0]!.sql).toContain('archived_at IS NULL');
    expect(calls[0]!.sql).toContain('RETURNING id');
  });

  it('issues no query at all for an empty batch', async () => {
    const query = vi.fn();
    expect(await markValuationsArchived({ query } as unknown as pg.Pool, [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
