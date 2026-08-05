import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { INT4_MAX, fitsInt4 } from '../../src/domain/int4.js';

const dbUp = await isDbAvailable();

/**
 * Every number that lands in an `integer` column.
 *
 * `paginationBounds.test.ts` covers the same failure for `page`, which becomes
 * a bigint OFFSET. This is the narrower and more common type: `delivery_days`,
 * `options_count`, and both `version` columns are int4, and each was validated
 * with an unbounded `z.number().int()`. 3000000000 satisfied Zod, reached the
 * driver, and came back as `22003 value out of range for type integer` — an
 * uncaught 500 where a 422 naming the field belonged.
 *
 * The read path mattered more than the write paths: `GET
 * .../report/versions/3000000000` is a route whose whole contract is to answer
 * 404 for a version that is not there, and a 500 instead told the caller a
 * report existed.
 */
describe.skipIf(!dbUp)('int4 bounds', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;
  let approvedId: string;

  /** The smallest value that overflows int4, and two that clear it comfortably. */
  const OVERFLOWING = [INT4_MAX + 1, 3_000_000_000, 9_999_999_999];

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['admin', 'reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'Int4Co' },
    });
    valuationId = created.json().valuation.id;

    // A GET on the report mints the report row and version 1, so the version
    // lookups below get past the "no report at all" short circuit and actually
    // reach the query.
    await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/report`,
      headers: authHeader(ops.token),
    });

    approvedId = await approvedValuation();
  });
  afterAll(async () => ctx?.teardown());

  /** Drives a valuation to an approved board resolution so grants can be issued. */
  async function approvedValuation(): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Int4GrantCo' },
    });
    const id = created.json().valuation.id as string;
    await createCalculation(
      ctx.pool,
      {
        valuationId: id,
        engineVersion: 'test',
        status: 'succeeded',
        inputs: {},
        results: { fmv_per_share: 2.5 },
        equityValue: 25_000_000,
        fmvPerShare: 2.5,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/board`,
      headers: authHeader(ops.token),
      payload: {},
    });
    const add = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/board/members`,
      headers: authHeader(ops.token),
      payload: { name: 'Chair', email: 'chair@board.example' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/board/sign',
      payload: { token: add.json().sign_token, decision: 'signed' },
    });
    return id;
  }

  it('answers 404, not 500, for a report version past int4', async () => {
    for (const version of OVERFLOWING) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/report/versions/${version}`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode, `version=${version} → ${res.statusCode}`).toBe(404);
    }
  });

  it('still serves a report version that exists', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/report/versions/1`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().version.version).toBe(1);
  });

  it('refuses a report revert to a version past int4', async () => {
    for (const version of OVERFLOWING) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/report/revert`,
        headers: authHeader(ops.token),
        payload: { version },
      });
      expect(res.statusCode, `version=${version} → ${res.statusCode}`).toBe(422);
    }
  });

  it('refuses a prompt revert to a version past int4', async () => {
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/prompts',
      headers: authHeader(ops.token),
    });
    expect(list.statusCode).toBe(200);
    const promptId = list.json().prompts?.[0]?.id;
    expect(promptId, 'expected at least one seeded prompt').toBeTruthy();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/prompts/${promptId}/revert`,
      headers: authHeader(ops.token),
      payload: { version: 3_000_000_000 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('refuses a delivery_days past int4', async () => {
    for (const days of OVERFLOWING) {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}`,
        headers: authHeader(ops.token),
        payload: { delivery_days: days },
      });
      expect(res.statusCode, `delivery_days=${days} → ${res.statusCode}`).toBe(422);
    }
  });

  it('still accepts an ordinary delivery_days', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}`,
      headers: authHeader(ops.token),
      payload: { delivery_days: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valuation.delivery_days).toBe(10);
  });

  it('refuses an options_count past int4 on create and on patch', async () => {
    for (const count of OVERFLOWING) {
      const created = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${approvedId}/grants`,
        headers: authHeader(ops.token),
        payload: {
          grantee_name: 'Overflow',
          grant_date: '2025-01-01',
          options_count: count,
          exercise_price: 1,
        },
      });
      expect(created.statusCode, `options_count=${count} → ${created.statusCode}`).toBe(422);
    }

    const real = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${approvedId}/grants`,
      headers: authHeader(ops.token),
      payload: {
        grantee_name: 'Ordinary',
        grant_date: '2025-01-01',
        options_count: 1_000,
        exercise_price: 1,
      },
    });
    expect(real.statusCode).toBe(201);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${approvedId}/grants/${real.json().grant.id}`,
      headers: authHeader(ops.token),
      payload: { options_count: 3_000_000_000 },
    });
    expect(patched.statusCode).toBe(422);
  });

  it('admits the largest count int4 can hold', () => {
    expect(fitsInt4(INT4_MAX)).toBe(true);
    expect(fitsInt4(INT4_MAX + 1)).toBe(false);
    expect(fitsInt4(-2_147_483_648)).toBe(true);
    expect(fitsInt4(-2_147_483_649)).toBe(false);
    expect(fitsInt4(1.5)).toBe(false);
    expect(fitsInt4(Number.NaN)).toBe(false);
    expect(fitsInt4(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('is the bound that stands between the old schema and the driver', async () => {
    // The failure the ceiling prevents, against the real database: the value an
    // unbounded `z.number().int().positive()` would have passed through.
    await expect(ctx.pool.query('SELECT $1::integer AS n', [INT4_MAX + 1])).rejects.toThrow(/out of range/i);
  });
});
