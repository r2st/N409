import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Searching for a valuation by the number the screen shows.
 *
 * Every surface writes a valuation number with a `#` in front of it — the
 * dashboard, the inbox, the billing page, the firm roster, the admin document
 * list, and the search results page itself. The global search accepted only
 * the bare digits, so the most obvious thing a user can do with a number they
 * are looking at — copy it, paste it into the search box — returned nothing,
 * while the valuations list filter, which has always stripped the `#`, quietly
 * disagreed about the same query.
 *
 * The two forms are checked against each other rather than separately: a fix
 * that made `#42` work by breaking `42` would pass either assertion alone.
 */
describe.skipIf(!dbUp)('global search finds a valuation by its printed number', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let id: string;
  let number: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'Numbered Holdings' },
    });
    expect(created.statusCode).toBe(201);
    id = created.json().valuation.id as string;
    // Pinned rather than read off the sequence. A fresh test database hands
    // out `1`, and a one-character query is refused as too short before it
    // ever reaches the number clause — so a test that took whatever the
    // sequence gave would have been testing the length guard on some runs and
    // the number match on others.
    const { rows } = await ctx.pool.query<{ number: string }>(
      'UPDATE valuations SET number = 904271 WHERE id = $1 RETURNING number::text AS number',
      [id],
    );
    number = rows[0]!.number;
    expect(number).toBe('904271');
  });

  afterAll(async () => ctx?.teardown());

  const search = async (q: string) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/search?q=${encodeURIComponent(q)}&type=valuations`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode, `search for ${q}`).toBe(200);
    return (res.json().valuations as Array<{ id: string }>).map((v) => v.id);
  };

  it('finds it by the bare digits', async () => {
    expect(await search(number)).toContain(id);
  });

  it('finds it by the same digits with the # the page prints', async () => {
    expect(await search(`#${number}`)).toContain(id);
  });

  it('finds it by the number in the valuations list filter too', async () => {
    // The surface that already stripped the `#`. Asserted here so the two
    // stay answerable by the same query rather than drifting again.
    for (const q of [number, `#${number}`]) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations?q=${encodeURIComponent(q)}&per_page=100`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(
        res.json().valuations.map((v: { id: string }) => v.id),
        q,
      ).toContain(id);
    }
  });

  it('still refuses a digit run past the bigint ceiling, prefixed or not', async () => {
    // The clause is OR'd into the same statement as the name matches, so a
    // cast that overflows is not a miss — it fails the whole query with a 500.
    for (const q of ['9223372036854775808', '#9223372036854775808', '#' + '9'.repeat(40)]) {
      expect(await search(q)).toEqual([]);
    }
  });

  it('refuses a one-character query, # or digit alike', async () => {
    // The length floor is the substring guard: the number clause is OR'd with
    // `company_name ILIKE '%1%'`, which on its own is a scan of everything in
    // scope. Pinned here because it is the reason a valuation numbered below
    // 10 is not findable by number, which is a consequence worth stating
    // rather than discovering.
    for (const q of ['1', '#']) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/search?q=${encodeURIComponent(q)}&type=valuations`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode, q).toBe(400);
    }
  });

  it('does not turn a # query into a match on every valuation', async () => {
    // `#` alone is not a number, and the name clause must not see it as a
    // wildcard either.
    const other = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'Unnumbered Ltd' },
    });
    expect(other.statusCode).toBe(201);
    expect(await search('#%')).toEqual([]);
  });
});
