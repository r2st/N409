import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { PICKER_LIMIT } from '../../src/repos/adminUsers.js';

const dbUp = await isDbAvailable();

/**
 * The two pickers that used to read a whole table.
 *
 * `/users/options` fed the reviewer dropdowns from every ops account (or every
 * partner account) on the platform, and `/partners` fed the partner dropdowns
 * from every partner row — each of the latter carrying two correlated counts
 * over `users` and `valuations`. Both are bounded now, and the reason these
 * tests care about `truncated` as much as about the cap is that a cap on a
 * picker is only safe while it is visible: a reviewer who is missing from the
 * list reads as a reviewer who cannot be assigned, and nobody doubts a
 * dropdown. The flag is what the client turns into "filter to narrow".
 */
describe.skipIf(!dbUp)('picker limits', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;

  const options = async (query = '') =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/users/options${query}`,
      headers: authHeader(admin.token),
    });

  const partners = async (query = '') =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/partners${query}`,
      headers: authHeader(admin.token),
    });

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'], email: 'picker-admin@test.example.com' });
    // Distinctive, sortable emails: the cap slices by `email ASC`, so the test
    // can name exactly which rows a truncated page is expected to contain.
    for (let i = 0; i < 6; i += 1) {
      await seedUser(ctx, {
        roles: ['reviewer'],
        email: `picker-reviewer-${String(i).padStart(2, '0')}@test.example.com`,
      });
    }
    await seedPartner(ctx, 'Picker Alpha');
    await seedPartner(ctx, 'Picker Beta');
    await seedPartner(ctx, 'Picker Gamma');
  });
  afterAll(async () => ctx?.teardown());

  it('serves the whole list, and says it is whole, when it fits', async () => {
    const res = await options();
    expect(res.statusCode).toBe(200);
    const body = res.json() as { options: Array<{ email: string }>; truncated: boolean };
    expect(body.truncated).toBe(false);
    expect(body.options.length).toBeLessThanOrEqual(PICKER_LIMIT);
    expect(body.options.map((o) => o.email)).toContain('picker-reviewer-00@test.example.com');
  });

  it('caps the list at the requested limit and admits it was cut', async () => {
    const res = await options('?limit=3');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { options: Array<{ email: string }>; truncated: boolean };
    expect(body.options).toHaveLength(3);
    expect(body.truncated).toBe(true);
  });

  it('does not claim truncation when the limit is exactly the row count', async () => {
    // Off-by-one guard: the repo fetches limit + 1 rows to answer "is there
    // more", so a list of exactly `limit` rows must still report false.
    const all = (await options()).json() as { options: unknown[] };
    const exact = await options(`?limit=${all.options.length}`);
    const body = exact.json() as { options: unknown[]; truncated: boolean };
    expect(body.options).toHaveLength(all.options.length);
    expect(body.truncated).toBe(false);
  });

  it('searches by email or name so a capped list can still be reached', async () => {
    const res = await options('?q=picker-reviewer-04');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { options: Array<{ email: string }>; truncated: boolean };
    expect(body.options.map((o) => o.email)).toEqual(['picker-reviewer-04@test.example.com']);
    expect(body.truncated).toBe(false);
  });

  it('treats a search as a literal, not as a LIKE pattern', async () => {
    // `%` would otherwise match every row and make the narrowest query the
    // widest one — the bug `escapeLike` exists to prevent.
    const res = await options('?q=%');
    expect(res.statusCode).toBe(200);
    expect((res.json() as { options: unknown[] }).options).toEqual([]);
  });

  it('refuses a limit above the ceiling rather than honouring it', async () => {
    const res = await options(`?limit=${PICKER_LIMIT + 1}`);
    expect(res.statusCode).toBe(400);
  });

  it('caps the partner picker and reports truncation too', async () => {
    const capped = await partners('?limit=2');
    expect(capped.statusCode).toBe(200);
    const body = capped.json() as { partners: Array<{ name: string }>; truncated: boolean };
    expect(body.partners).toHaveLength(2);
    expect(body.truncated).toBe(true);

    const whole = await partners();
    const all = whole.json() as { partners: Array<{ name: string }>; truncated: boolean };
    expect(all.truncated).toBe(false);
    expect(all.partners.map((p) => p.name)).toContain('Picker Gamma');
  });

  it('searches partners by name and key', async () => {
    const res = await partners('?q=Picker Beta');
    const body = res.json() as { partners: Array<{ name: string }> };
    expect(body.partners.map((p) => p.name)).toEqual(['Picker Beta']);

    const byKey = await partners('?q=picker-gamma');
    expect((byKey.json() as { partners: Array<{ name: string }> }).partners.map((p) => p.name)).toEqual([
      'Picker Gamma',
    ]);
  });

  it('still keeps archived partners out of the picker when capped', async () => {
    const id = await seedPartner(ctx, 'Picker Archived');
    await ctx.pool.query('UPDATE partners SET archived_at = now() WHERE id = $1', [id]);
    const res = await partners('?q=Picker Archived');
    expect((res.json() as { partners: unknown[] }).partners).toEqual([]);

    const included = await partners('?q=Picker Archived&include_archived=true');
    expect((included.json() as { partners: Array<{ name: string }> }).partners.map((p) => p.name)).toEqual([
      'Picker Archived',
    ]);
  });
});
