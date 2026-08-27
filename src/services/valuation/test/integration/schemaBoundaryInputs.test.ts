import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Round 174: the boundary values a schema accepted and something downstream
 * could not.
 *
 * The interesting inputs here are not the obviously-malformed ones. Those were
 * already refused, by six rounds of work this suite records: `paramValidation`
 * (a route id that is not a ULID), `paginationBounds` (an offset past int8),
 * `int4Bounds` and `numericColumn` (a figure past its column), `emailBounds`
 * and `inputSizeBounds` (a value past its index tuple), `finiteNumberSweep`
 * (Infinity through a lower bound). What this file adds is the residue: values
 * that satisfied every schema in front of them, reached Postgres, and came back
 * as a 500.
 *
 * Two of those existed when the round started, and both are pinned below:
 *
 *  - a NUL byte anywhere in a string. `POST /api/v1/contact` is the
 *    unauthenticated marketing form; a `name` with one in it was a 500.
 *  - a date outside Postgres's timestamp range in `?from=`/`?to=`.
 *    `GET /api/v1/admin/events` was a 500, and on a *read* — the parameter
 *    never had to be stored to break the query.
 *
 * The rest of the file is the categories that turned out to be closed already,
 * asserted rather than assumed. A boundary sweep whose only content is the two
 * bugs it found says nothing about the eight places it looked and found
 * nothing, and the next reader has no way to tell "checked" from "skipped".
 */
describe.skipIf(!dbUp)('schema boundary inputs', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const NUL = '\u0000';

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    admin = await seedUser(ctx, { roles: ['admin'] });
    ops = await seedUser(ctx, { roles: ['ops'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(admin.token),
      payload: { kind: '409a', company_name: 'Boundary Co' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;
  });
  afterAll(() => ctx.teardown());

  /* ---------------------------------------------------------------- NUL --- */

  describe('a NUL byte in a string', () => {
    /**
     * `U+0000` has no UTF-8 encoding Postgres accepts, so the driver refuses
     * any parameter carrying one with `22021 invalid byte sequence`. That is
     * not a constraint violation any repo looks for, so it left as a 500.
     *
     * The guard is a `preValidation` hook rather than a `.refine` per field,
     * because the exposure is per column and every `z.string()` in the service
     * is a candidate. See domain/nulBytes.ts.
     */
    it('is refused on the public contact form, which used to 500', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/contact',
        payload: { name: `Bo${NUL}b`, email: 'bob@example.com', message: 'hello' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toMatch(/NUL byte/);
      // Names the field. "Something in your request" is not actionable when the
      // body is a cap table.
      expect(res.json().detail).toContain('name');
    });

    it('is refused in an authenticated body', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/organizations',
        headers: authHeader(ops.token),
        payload: { name: `Acme${NUL} Holdings` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().type).toBe('urn:n409:problem:bad-request');
    });

    it('is refused in a query string, where it arrives already decoded', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/search?q=%00abc',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toContain('q');
    });

    it('does not disturb the awkward text that is legitimate', async () => {
      for (const name of ['Ünïcödé 🏢 Ltd', "O'Brien & Sons, Ltd.", 'Acme\tHoldings']) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/organizations',
          headers: authHeader(ops.token),
          payload: { name },
        });
        expect(res.statusCode, name).toBe(201);
        expect(res.json().organization.name, name).toBe(name);
      }
    });
  });

  /* --------------------------------------------------------------- dates --- */

  describe('a date outside the Postgres timestamp range', () => {
    /**
     * `z.coerce.date()` is `new Date(...)` plus an Invalid-Date check. A
     * JavaScript date reaches ISO year -271821; `timestamptz` stops at 4714 BC.
     * The gap between them is reachable from a query string.
     */
    const OUT_OF_RANGE = [
      ['five thousand years BC', '-005000-01-01T00:00:00.000Z'],
      ['the floor of the JavaScript range', '-271821-04-20T00:00:00.000Z'],
      ['the ceiling of the JavaScript range', '+275760-09-13T00:00:00.000Z'],
    ] as const;

    it.each(OUT_OF_RANGE)('is refused as `from` (%s)', async (_why, value) => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/admin/events?from=${encodeURIComponent(value)}`,
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(400);
    });

    it.each(OUT_OF_RANGE)('is refused as `to` (%s)', async (_why, value) => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/admin/events?to=${encodeURIComponent(value)}`,
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(400);
    });

    it('is refused on the per-engagement audit trail, which shares the schema', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/audit-trail?from=${encodeURIComponent('-005000-01-01T00:00:00.000Z')}`,
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(400);
    });

    it('still accepts the windows a date picker produces, epoch zero included', async () => {
      for (const q of [
        'from=2026-01-01&to=2026-12-31',
        'from=1970-01-01T00:00:00.000Z',
        'to=2026-08-27T12:00:00.000Z',
      ]) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/admin/events?${q}`,
          headers: authHeader(admin.token),
        });
        expect(res.statusCode, q).toBe(200);
      }
    });

    it('still refuses an inverted window, which is a different complaint', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/events?from=2026-12-31&to=2026-01-01',
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toContain('earlier than');
    });
  });

  /* ------------------------------------------------------ unknown fields --- */

  describe('unknown fields in a patch body', () => {
    /**
     * Seventeen patch schemas already refused them; four stripped, which meant
     * `{title: 'A', publised: true}` applied the title, dropped the typo and
     * answered 200. The caller has no way to see that half the patch went
     * nowhere. `schemaBoundaryCensus.test.ts` keeps the other side of this.
     */
    let slug: string;
    // The patch route keys on the id; the read route keys on the slug.
    let postId: string;

    beforeAll(async () => {
      slug = `boundary-post-${Date.now().toString(36)}`;
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/blog/posts',
        headers: authHeader(admin.token),
        payload: { slug, title: 'Boundary', body_html: '<p>Body</p>' },
      });
      expect(res.statusCode).toBe(201);
      postId = res.json().post.id as string;
    });

    it('refuses a patch that mixes a real field with a misspelled one', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/blog/posts/${postId}`,
        headers: authHeader(admin.token),
        payload: { title: 'Renamed', publised: true },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.stringify(res.json())).toContain('unrecognized_keys');
    });

    it('leaves the title alone when it refuses', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/admin/blog/posts/${slug}`,
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().post.title).toBe('Boundary');
    });

    it('still applies a patch made only of real fields', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/blog/posts/${postId}`,
        headers: authHeader(admin.token),
        payload: { title: 'Renamed' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().post.title).toBe('Renamed');
    });

    it('refuses a coerced date past the range in a body, not just a query', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/blog/posts/${postId}`,
        headers: authHeader(admin.token),
        // `z.coerce.date()` reads a number as epoch milliseconds, which is a
        // way in that no query string offers.
        payload: { published_at: -8.64e15 },
      });
      expect(res.statusCode).toBe(422);
    });
  });

  /* -------------------------------------------------- already-closed set --- */

  describe('the categories that were already closed', () => {
    const listQuery = (q: string) =>
      ctx.app.inject({ method: 'GET', url: `/api/v1/valuations?${q}`, headers: authHeader(ops.token) });

    it('refuses every degenerate page and per_page', async () => {
      for (const q of [
        'page=0',
        'page=-1',
        'page=1.5',
        'page=999999999999999999999',
        'page=NaN',
        'page=Infinity',
        'per_page=0',
        'per_page=999999',
        // A bare `?page=` is an empty string, and `z.coerce.number('')` is 0 —
        // the default does not apply, because the field is present.
        'page=',
        'per_page=',
      ]) {
        const res = await listQuery(q);
        expect(res.statusCode, q).toBe(400);
      }
    });

    it('refuses an enum value that is only wrong in its case', async () => {
      for (const q of ['state=DRAFT', 'state=nope', "state=draft'--", 'kind=409A']) {
        const res = await listQuery(q);
        expect(res.statusCode, q).toBe(400);
      }
    });

    it('stores an injection attempt as the text it is', async () => {
      const name = "Robert'); DROP TABLE valuations;--";
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/organizations',
        headers: authHeader(ops.token),
        payload: { name },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().organization.name).toBe(name);
      // The table it names is still there.
      const still = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations',
        headers: authHeader(admin.token),
      });
      expect(still.statusCode).toBe(200);
    });

    it('bounds a long string at the schema rather than at the index', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/organizations',
        headers: authHeader(ops.token),
        payload: { name: 'x'.repeat(100_000) },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.stringify(res.json())).toContain('too_big');
    });

    it('refuses a body that is not an object at all', async () => {
      for (const payload of [[1, 2, 3], null]) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/valuations',
          headers: authHeader(admin.token),
          payload: payload as object,
        });
        expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      }
      // A bare string is refused a step earlier: `inject` sends it as
      // text/plain, and no parser is registered for that. 415 rather than 422,
      // and still not a 500.
      const text = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(admin.token),
        payload: 'a string',
      });
      expect(text.statusCode).toBe(415);
    });

    it('404s an id that is well-formed and belongs to nobody', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations/01JZZZZZZZZZZZZZZZZZZZZZZZ',
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(404);
    });

    it("404s another tenant's engagement rather than confirming it exists", async () => {
      const otherPartner = await seedPartner(ctx, `Boundary Partner ${Date.now().toString(36)}`);
      const stranger = await seedUser(ctx, { roles: ['partner'], partnerId: otherPartner });
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}`,
        headers: authHeader(stranger.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  /* ------------------------------------------------------- the invariant --- */

  it('answers 4xx and never 5xx across every input above', async () => {
    // The acceptance criterion of the round, restated as one assertion over a
    // sweep. Each request is malformed in a different category; none of them is
    // this service's fault to have received.
    const requests: Array<[string, Parameters<TestApp['app']['inject']>[0]]> = [
      [
        'NUL in body',
        {
          method: 'POST',
          url: '/api/v1/organizations',
          headers: authHeader(ops.token),
          payload: { name: `a${NUL}` },
        },
      ],
      ['NUL in query', { method: 'GET', url: '/api/v1/valuations?q=%00', headers: authHeader(ops.token) }],
      [
        'BC window',
        {
          method: 'GET',
          url: '/api/v1/admin/events?from=-005000-01-01T00:00:00.000Z',
          headers: authHeader(admin.token),
        },
      ],
      ['page zero', { method: 'GET', url: '/api/v1/valuations?page=0', headers: authHeader(ops.token) }],
      [
        'unknown enum',
        { method: 'GET', url: '/api/v1/valuations?state=nope', headers: authHeader(ops.token) },
      ],
      [
        'empty body',
        { method: 'POST', url: '/api/v1/organizations', headers: authHeader(ops.token), payload: {} },
      ],
      [
        'array body',
        { method: 'POST', url: '/api/v1/organizations', headers: authHeader(ops.token), payload: [] },
      ],
      [
        'malformed id',
        { method: 'GET', url: '/api/v1/valuations/not-a-ulid', headers: authHeader(admin.token) },
      ],
    ];
    for (const [label, req] of requests) {
      const res = await ctx.app.inject(req);
      expect(res.statusCode, `${label} -> ${res.body.slice(0, 200)}`).toBeLessThan(500);
      expect(res.statusCode, label).toBeGreaterThanOrEqual(400);
    }
  });
});
