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
 *
 * R90 added a fifth query and this file is what made that a decision rather
 * than a drift: the sweep now tells a partner their engagement was retired,
 * and the naive place to put that is inside the loop the batching removed.
 * `firePartnerWebhooksForRetirement` takes the whole archived batch and looks
 * the partner-owned rows up once, so the count went from four to five and not
 * from four to four-plus-N.
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

/** The three statements `withTransaction` issues around the pair it wraps. */
const TX_KEYWORDS = new Set(['BEGIN', 'COMMIT', 'ROLLBACK']);

/**
 * A pool stand-in that records every statement and hands the same recorder to
 * the client `withTransaction` checks out, so a query issued inside the
 * transaction is counted exactly like one issued on the pool.
 */
function recordingPool(answer: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount: number }): {
  pool: pg.Pool;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (TX_KEYWORDS.has(sql)) return { rows: [], rowCount: 0 };
    return answer(sql, params);
  });
  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
  } as unknown as pg.Pool;
  return { pool, calls };
}

/**
 * A pool stand-in that answers the queries the sweep issues, routed on the
 * statement rather than on call order — the point of the change is that the
 * order and the count both moved.
 */
function fakePool(candidates: Array<{ id: string; user_id: string; frozen: boolean }>) {
  return recordingPool((sql, params) => {
    if (sql.includes('FROM retention_policies')) return { rows: [POLICY], rowCount: 1 };
    if (sql.includes('FROM valuations v')) return { rows: candidates, rowCount: candidates.length };
    if (sql.startsWith('UPDATE valuations')) {
      // Mirrors `WHERE id = ANY($1) AND archived_at IS NULL RETURNING id`.
      const wanted = params[0] as string[];
      return { rows: wanted.map((id) => ({ id })), rowCount: wanted.length };
    }
    if (sql.includes('INSERT INTO retention_actions')) return { rows: [], rowCount: 0 };
    // The retirement-webhook lookup: which of the archived rows belong to a
    // partner. None here — the dispatch itself is covered end-to-end in
    // `partnerRetirementWebhook.test.ts`; what this file pins is that it is
    // one query for the batch.
    if (sql.includes('partner_id IS NOT NULL')) return { rows: [], rowCount: 0 };
    throw new Error(`unexpected query: ${sql}`);
  });
}

const candidate = (n: number, frozen = false) => ({
  id: `01JAAAAAAAAAAAAAAAAAAAAA${String(n).padStart(2, '0')}`,
  user_id: '01JUUUUUUUUUUUUUUUUUUUUUUU',
  frozen,
});

const of = (calls: Recorded[], fragment: string) => calls.filter((c) => c.sql.includes(fragment));

/*
 * `purged: 0` in every expectation below, and deliberately so.
 *
 * The sweep gained a third counter when outbox purging was added, and it is
 * separate from `archived` because "nothing was purged" has to be tellable
 * from "nothing was eligible". These fixtures seed the *valuation* policy
 * only, so `sweepOutbox` finds no `email_outbox` policy and returns before it
 * queries — which is what the fake pool, whose default branch throws on an
 * unexpected statement, is quietly proving.
 *
 * Asserted rather than dropped from the comparison: `toEqual` on the whole
 * result is what pins the shape, and a sweep that silently grew a fourth
 * counter should fail here and be described, not absorbed.
 */
describe('runRetentionSweep batching', () => {
  it('archives any number of candidates in one UPDATE and one INSERT', async () => {
    const { pool, calls } = fakePool(Array.from({ length: 250 }, (_, i) => candidate(i)));

    const result = await runRetentionSweep(pool);

    expect(result).toEqual({ archived: 250, skipped_hold: 0, purged: 0 });
    expect(of(calls, 'UPDATE valuations')).toHaveLength(1);
    expect(of(calls, 'INSERT INTO retention_actions')).toHaveLength(1);
    // And one lookup for the retirement webhooks, over the whole batch rather
    // than per row — the one place a new feature would have quietly undone the
    // batching this file exists to protect.
    expect(of(calls, 'partner_id IS NOT NULL')).toHaveLength(1);
    // Three reads and two writes for 250 valuations — the whole point — inside
    // the BEGIN/COMMIT that makes the archival and its action log one thing.
    expect(calls).toHaveLength(7);
    expect(calls.filter((c) => TX_KEYWORDS.has(c.sql)).map((c) => c.sql)).toEqual(['BEGIN', 'COMMIT']);
  });

  it('logs a skip for each held candidate and archives only the rest', async () => {
    const { pool, calls } = fakePool([candidate(1), candidate(2, true), candidate(3), candidate(4, true)]);

    const result = await runRetentionSweep(pool);

    expect(result).toEqual({ archived: 2, skipped_hold: 2, purged: 0 });
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
    const { pool, calls } = recordingPool((sql) => {
      if (sql.includes('FROM retention_policies')) return { rows: [POLICY], rowCount: 1 };
      if (sql.includes('FROM valuations v')) {
        return { rows: [candidate(1), candidate(2)], rowCount: 2 };
      }
      // A concurrent sweep already took the second one.
      if (sql.startsWith('UPDATE valuations')) return { rows: [{ id: candidate(1).id }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const result = await runRetentionSweep(pool);

    expect(result).toEqual({ archived: 1, skipped_hold: 0, purged: 0 });
    const [insert] = of(calls, 'INSERT INTO retention_actions');
    expect(insert!.params).toContain(candidate(1).id);
    expect(insert!.params).not.toContain(candidate(2).id);
  });

  it('writes nothing when the pass finds no candidates', async () => {
    const { pool, calls } = fakePool([]);

    expect(await runRetentionSweep(pool)).toEqual({ archived: 0, skipped_hold: 0, purged: 0 });
    // An empty VALUES list is a syntax error, so the no-op must be in the repo
    // and not in a loop that happens to run zero times.
    expect(of(calls, 'UPDATE valuations')).toHaveLength(0);
    expect(of(calls, 'INSERT INTO retention_actions')).toHaveLength(0);
    // Nothing was archived, so nobody is owed an event either.
    expect(of(calls, 'partner_id IS NOT NULL')).toHaveLength(0);
    // And no transaction: a pass with nothing to write must not check a
    // connection out of a pool of ten to write nothing in.
    expect(calls.filter((c) => TX_KEYWORDS.has(c.sql))).toHaveLength(0);
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

      expect(await runRetentionSweep(pool)).toEqual({ archived: 0, skipped_hold: 0, purged: 0 });
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
