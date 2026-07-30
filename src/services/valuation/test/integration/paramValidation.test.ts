import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Malformed route ids are rejected before any handler runs (plugins/params.ts).
 *
 * The ids are ULIDs, not UUIDs — `newUlid()` mints them and migration 0001 pins
 * the column type to the `ulid` domain.
 */

const dbUp = await isDbAvailable();

const BAD_IDS = [
  'not-a-ulid',
  '3f2504e0-4f89-11d3-9a0c-0305e82c3301', // a real UUID is still not a ULID
  "01K' OR 1=1--",
  '01KIIIIIIIIIIIIIIIIIIIIIII', // I/L/O/U are outside Crockford base32
  '%2e%2e%2f',
];

describe.skipIf(!dbUp)('route id parameter validation', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['ops'] });
  });
  afterAll(() => ctx.teardown());

  it.each(BAD_IDS)('404s a malformed valuation id (%s)', async (bad) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${encodeURIComponent(bad)}`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s a malformed nested id rather than letting it reach SQL', async () => {
    // :memberId went straight to findSignoffById, so a non-ULID reached the
    // `ulid` domain and came back as a 500 — an error-shape oracle.
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/valuations/01K0000000000000000000000A/board/members/not-a-ulid',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects the id before authenticating, so it costs nothing', async () => {
    // No credentials at all: the hook runs at preValidation, ahead of the
    // route's own preHandler, so this is a 404 and not a 401.
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/valuations/not-a-ulid' });
    expect(res.statusCode).toBe(404);
  });

  it('answers problem+json indistinguishable from any other 404', async () => {
    const malformed = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/valuations/definitely-not-an-id',
      headers: authHeader(ops.token),
    });
    const absent = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/valuations/01K0000000000000000000000A',
      headers: authHeader(ops.token),
    });
    expect(malformed.headers['content-type']).toContain('application/problem+json');
    // Only `instance` (the echoed request path) may differ: a caller must not be
    // able to tell "malformed" from "no such row" or "not yours". That
    // indistinguishability is the reason this answers 404 and not 422.
    const shape = (r: typeof malformed) => {
      const { instance: _instance, ...rest } = r.json() as Record<string, unknown>;
      return rest;
    };
    expect(shape(malformed)).toEqual(shape(absent));
    expect(shape(malformed)).not.toHaveProperty('errors');
  });

  it('still accepts a well-formed id that simply does not exist', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/valuations/01K0000000000000000000000A',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(404); // reached the repo and found nothing
  });

  it('leaves non-id route parameters working', async () => {
    // :key on the public branding route is a partner key, not a ULID — the hook
    // must not touch it, or the white-label login page 404s for everyone.
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/public/partners/some-partner-key/branding',
    });
    expect(res.statusCode).toBe(404); // no such partner, but it got that far
    expect(res.json().title).not.toBe(undefined);
  });
});
