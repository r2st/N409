import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Impossible calendar dates at the write boundary.
 *
 * Every route schema validated a date with `/^\d{4}-\d{2}-\d{2}$/`, which is a
 * *shape* check being used as a validity check. It admits `2026-02-31`,
 * `2026-13-01` and `2026-02-29` in a common year, and what happened next
 * depended only on where the string landed:
 *
 *   * straight into a `date` column — Postgres refused it and the unhandled
 *     driver error surfaced as a 500 where the honest answer is a 422;
 *   * into `new Date(...)` — JavaScript rolled it forward without a word, so
 *     `2026-02-31` became `2026-03-03`. On a grant's vesting start that moves
 *     every tranche, and nothing downstream can tell.
 *
 * `domain/intake.ts` and `domain/overwrites.ts` had the real check all along;
 * it just never reached the routes.
 */

const dbUp = await isDbAvailable();

/** Days that pass the shape check and are not days. */
const IMPOSSIBLE = ['2026-02-31', '2026-13-01', '2026-00-10', '2026-04-31', '2026-02-29'];

describe.runIf(dbUp)('impossible calendar dates are refused, not absorbed', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'DateCo' },
    });
    valuationId = created.json().valuation.id;
  });
  afterAll(() => ctx?.teardown());

  it.each(IMPOSSIBLE)('a transaction dated %s is a 422, not a 500 from the driver', async (date) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/transactions`,
      headers: authHeader(ops.token),
      payload: { kind: 'secondary_sale', occurred_on: date, shares: 100 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('a real date on the same route still works', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/transactions`,
      headers: authHeader(ops.token),
      payload: { kind: 'secondary_sale', occurred_on: '2024-02-29', shares: 100 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().transaction.occurred_on).toBeTruthy();
  });

  it('a funding round with an impossible close date is refused', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/rounds`,
      headers: authHeader(ops.token),
      payload: { name: 'Series A', closed_on: '2026-02-31' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('a grant dated on a day that does not exist is refused rather than moved', async () => {
    // The silent half of the bug: this used to be stored as 2026-03-03, and a
    // grant date is a contract date.
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(ops.token),
      payload: { grantee_name: 'A', grant_date: '2026-02-31', options_count: 100 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('a grant whose vesting start does not exist is refused too', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(ops.token),
      payload: {
        grantee_name: 'A',
        grant_date: '2026-01-01',
        vesting_start_date: '2026-02-29',
        options_count: 100,
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('a valuation date that does not exist is refused', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}`,
      headers: authHeader(ops.token),
      payload: { valuation_date: '2026-02-31' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('a company profile with an impossible incorporation date is refused', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/company-profile`,
      headers: authHeader(ops.token),
      payload: { incorporation_date: '2026-13-01' },
    });
    expect(res.statusCode).toBe(422);
  });
});
