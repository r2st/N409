import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { MAX_PAGE, offsetFor } from '../../src/domain/pagination.js';

const dbUp = await isDbAvailable();

/**
 * `page` is a caller-chosen number that becomes an OFFSET.
 *
 * `per_page` was always capped; `page` was `.min(1)` and nothing else, because
 * a page past the end reads as harmless — an empty list. It stops being
 * harmless once the number is large enough that `(page - 1) * per_page` is no
 * longer a value Postgres will accept for OFFSET: past 2^63 it is out of range
 * for bigint, and past ~1e21 JavaScript stringifies it in exponential notation
 * that bigint cannot parse at all. Both throw out of the driver, uncaught, on
 * eight list endpoints.
 */
describe.skipIf(!dbUp)('pagination bounds', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['admin', 'reviewer'] });
  });
  afterAll(async () => ctx?.teardown());

  // The two shapes that reach SQL differently: one overflows bigint, the other
  // is stringified as "2.5e+22" and fails to parse as one.
  const OVERFLOWING_PAGES = ['10000000000000000000', '1000000000000000000000', '1e21', '9'.repeat(30)];

  const PAGED_ROUTES = [
    '/api/v1/valuations',
    '/api/v1/tasks',
    '/api/v1/reviews',
    '/api/v1/users',
    '/api/v1/admin/events',
  ];

  it.each(PAGED_ROUTES)('refuses an out-of-range page on %s', async (url) => {
    for (const page of OVERFLOWING_PAGES) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `${url}?page=${page}`,
        headers: authHeader(ops.token),
      });
      // 400, not 500: an invalid query string is a bad request (the codebase
      // reserves 422 for bodies), and the caller is told which field is wrong.
      // Anything in the 500s means the value reached the database.
      expect(res.statusCode, `${url} page=${page} → ${res.statusCode}`).toBe(400);
    }
  });

  it.each(PAGED_ROUTES)('still serves an ordinary page on %s', async (url) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `${url}?page=2&per_page=25`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
  });

  it('admits the largest page it promises to admit', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations?page=${MAX_PAGE}&per_page=100`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valuations).toEqual([]);
  });

  it('rejects the first page past the ceiling', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations?page=${MAX_PAGE + 1}`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps the widest admissible offset inside what Postgres will take', async () => {
    // The bound is only meaningful if the offset it permits is one the database
    // accepts — and if it stays an integer literal rather than turning into
    // exponential notation on the way to the driver.
    const widestPerPage = 500;
    const offset = offsetFor(MAX_PAGE, widestPerPage);
    expect(Number.isSafeInteger(offset)).toBe(true);
    expect(String(offset)).toMatch(/^\d+$/);

    const { rows } = await ctx.pool.query('SELECT 1 AS ok LIMIT $1 OFFSET $2', [widestPerPage, offset]);
    expect(rows).toEqual([]);
  });

  it('is the bound that stands between the old page and the driver', async () => {
    // Demonstrates the failure the ceiling prevents, against the real database:
    // the offset an unbounded `page` would have produced is not a bigint.
    const unbounded = offsetFor(1e19, 25);
    await expect(ctx.pool.query('SELECT 1 LIMIT $1 OFFSET $2', [25, unbounded])).rejects.toThrow(
      /out of range|invalid input syntax/i,
    );
  });
});
