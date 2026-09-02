import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { listActivity } from '../../src/repos/activityLog.js';
import { firmClients } from '../../src/repos/firmDashboard.js';
import { listUsers } from '../../src/repos/adminUsers.js';
import { listInbox } from '../../src/repos/inbox.js';
import { listJobs } from '../../src/repos/jobs.js';
import { listReviewQueue } from '../../src/repos/reviews.js';
import { listTasks } from '../../src/repos/tasks.js';
import type { Principal } from '../../src/auth/principal.js';

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
  const params: unknown[][] = [];
  const release: Array<(rows: unknown[]) => void> = [];
  const pool = {
    query: (text: string, values?: unknown[]) => {
      issued.push(text);
      params.push(values ?? []);
      return new Promise((resolve) => {
        release.push((rows: unknown[]) => resolve({ rows, rowCount: rows.length }));
      });
    },
  } as unknown as pg.Pool;
  return { pool, issued, params, release };
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

/**
 * The five readers R338 did not reach (R351, M8).
 *
 * R338 fixed the two it measured and the shape turned out to be the house
 * style: every paged console on this service asks "how many match" and "which
 * rows does this page show" as two statements with two parameter lists, and
 * five of them still awaited the first before issuing the second.
 *
 * In all five the deferred half is the one with no ceiling on it. A page stops
 * at `perPage` rows out of an index; the count beside it reads everything that
 * matches — the whole five-way job union, the inbox's three-table join, every
 * account in the admin console, every task the queue can see with R342's
 * archived-engagement EXISTS asked about each one.
 *
 * Asserted the same way R338's two are: hold the first statement open and check
 * the second is already in flight. A wall-clock comparison would pass on a
 * sequential implementation whenever the machine happened to be quick.
 *
 * The parameter lists are checked alongside, because four of these five build
 * the page's placeholders by pushing onto the array the count is already
 * holding. Sharing it would send the count a list two values longer than its
 * own statement, which the driver answers with a bind error at run time and
 * nothing here would otherwise notice.
 */
describe('every other paged console', () => {
  const opsPrincipal = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    email: 'ops@example.com',
    roles: ['admin'],
  } as unknown as Principal;

  const cases: Array<{
    name: string;
    run: (pool: pg.Pool) => Promise<unknown>;
    count: string;
    page: string;
    countParams: number;
    pageParams: number;
  }> = [
    {
      name: 'the admin user console',
      run: (pool) => listUsers(pool, { q: 'ann', page: 2, perPage: 25 }),
      count: 'count(*)::text AS count FROM users u',
      page: 'WITH page AS (',
      countParams: 1,
      pageParams: 3,
    },
    {
      name: 'the shared inbox',
      run: (pool) => listInbox(pool, opsPrincipal, { page: 2, perPage: 25 }),
      count: 'unread_total',
      page: 'ORDER BY c.created_at DESC',
      countParams: 2,
      pageParams: 4,
    },
    {
      name: 'the job monitor',
      run: (pool) => listJobs(pool, { status: 'failed', page: 2, perPage: 25 }),
      count: 'count(*)::text AS total',
      page: 'v.company_name',
      countParams: 1,
      pageParams: 3,
    },
    {
      name: 'the reviewer queue',
      run: (pool) => listReviewQueue(pool, { page: 2, perPage: 25 }),
      count: 'count(*)::text AS count FROM valuations v',
      page: 'signed_second',
      countParams: 1,
      pageParams: 3,
    },
    {
      name: 'the ops task queue',
      run: (pool) => listTasks(pool, { status: 'open', page: 2, perPage: 25 }),
      count: 'count(*)::text AS count FROM review_tasks t',
      page: 'ORDER BY (t.status IN',
      countParams: 1,
      pageParams: 3,
    },
  ];

  for (const c of cases) {
    it(`${c.name} issues its page without waiting for its count`, async () => {
      const { pool, issued, params, release } = suspendedPool();
      const done = c.run(pool);
      await settle();

      expect(issued).toHaveLength(2);
      expect(issued[0]).toContain(c.count);
      expect(issued[1]).toContain(c.page);
      // The count must not have been handed the page's LIMIT/OFFSET.
      expect(params[0]).toHaveLength(c.countParams);
      expect(params[1]).toHaveLength(c.pageParams);

      release[0]!([{ count: '0', total: '0', unread_total: '0' }]);
      release[1]!([]);
      await expect(done).resolves.toBeTruthy();
    });
  }
});
