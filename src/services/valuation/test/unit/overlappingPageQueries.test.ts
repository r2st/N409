import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { listActivity } from '../../src/repos/activityLog.js';
import { firmClients } from '../../src/repos/firmDashboard.js';

/**
 * The count and the page are asked together, not one after the other (R338, M8).
 *
 * Both of these readers answer a paged screen with two statements: how many rows
 * match, and which rows this page shows. Neither reads anything the other
 * produces — they carry separate parameter lists precisely because they scan
 * different things — and both were awaited in sequence, so the screen cost the
 * *sum* of two round trips rather than the slower of them. On the activity log
 * the deferred half is the expensive one: a filtered `count(*)` over
 * `valuation_events`, which is append-only and the largest table on the box.
 *
 * Asserted by holding the first statement open and checking the second has
 * already been issued. A wall-clock assertion would pass on a sequential
 * implementation whenever the machine was quick; this one cannot.
 */

/** A pool that records the statements issued and never settles them by itself. */
function suspendedPool() {
  const issued: string[] = [];
  const release: Array<(rows: unknown[]) => void> = [];
  const pool = {
    query: (text: string) => {
      issued.push(text);
      return new Promise((resolve) => {
        release.push((rows: unknown[]) => resolve({ rows, rowCount: rows.length }));
      });
    },
  } as unknown as pg.Pool;
  return { pool, issued, release };
}

/** Let the event loop drain the synchronous part of the call under test. */
const settle = () => new Promise((r) => setImmediate(r));

describe('the activity log', () => {
  it('issues the page query without waiting for the count', async () => {
    const { pool, issued, release } = suspendedPool();
    const done = listActivity(pool, {
      scope: 'all',
      page: 1,
      perPage: 25,
    } as Parameters<typeof listActivity>[1]);
    await settle();

    // Both in flight while nothing has been answered.
    expect(issued).toHaveLength(2);
    expect(issued[0]).toContain('count(*)');
    expect(issued[1]).toContain('UNION ALL');

    release[0]!([{ total: 3 }]);
    release[1]!([]);
    await expect(done).resolves.toEqual({ items: [], total: 3 });
  });

  it('still answers the count alone when no branch is selected', async () => {
    const { pool, issued, release } = suspendedPool();
    // A `valuationId` filter is unanswerable by `admin_events`, so scoping to
    // admin leaves no branch to page over. The count is then the only statement,
    // and the early return still awaits the promise it started rather than
    // dropping it on the floor.
    const done = listActivity(pool, {
      scope: 'admin',
      page: 1,
      perPage: 25,
      valuationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    } as Parameters<typeof listActivity>[1]);
    await settle();
    expect(issued).toHaveLength(1);
    release[0]!([{ total: 0 }]);
    await expect(done).resolves.toEqual({ items: [], total: 0 });
  });
});

describe('the firm client roster', () => {
  it('issues the roster query without waiting for the total', async () => {
    const { pool, issued, release } = suspendedPool();
    const done = firmClients(pool, '01ARZ3NDEKTSV4RRFFQ69G5FAV', { limit: 10, offset: 0 });
    await settle();

    expect(issued).toHaveLength(2);
    expect(issued[0]).toContain('count(DISTINCT company_name)');
    expect(issued[1]).toContain('GROUP BY company_name');

    release[0]!([{ count: '0' }]);
    release[1]!([]);
    await expect(done).resolves.toEqual({ total: 0, clients: [] });
  });
});
