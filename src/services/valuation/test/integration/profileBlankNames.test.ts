import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeader,
  isDbAvailable,
  SEEDED_PASSWORD,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The administrator's door and the account holder's door write the same four
 * columns on `users`, and only one of them normalised a blank.
 *
 * The stake is not the stored bytes; it is that every roster in the product
 * reads a name as `[first, last].filter(Boolean).join(' ') || email`. A NULL or
 * an empty string drops out of that and the address shows. Three spaces do not,
 * so the account appears under a name made of nothing — on the firm dashboard,
 * in the saved-view owner column and in the presence stream — while the
 * administrator who typed it is told it saved.
 */
describe.skipIf(!dbUp)('a profile name cleared to whitespace', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  const stored = async (id: string) => {
    const { rows } = await ctx.pool.query<{
      first_name: string | null;
      last_name: string | null;
      job_title: string | null;
      company_name: string | null;
    }>('SELECT first_name, last_name, job_title, company_name FROM users WHERE id = $1', [id]);
    return rows[0]!;
  };

  const patchAsAdmin = (id: string, payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${id}`,
      headers: authHeader(admin.token),
      payload,
    });

  it('is stored as NULL by the administrator door, not as spaces', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const set = await patchAsAdmin(user.id, { first_name: 'Ada', last_name: 'Lovelace' });
    expect(set.statusCode, set.body).toBe(200);

    const cleared = await patchAsAdmin(user.id, {
      first_name: '   ',
      last_name: '\t',
      job_title: ' ',
      company_name: '  ',
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(await stored(user.id)).toEqual({
      first_name: null,
      last_name: null,
      job_title: null,
      company_name: null,
    });
  });

  it('agrees with the account holder’s own door on the same columns', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const self = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: authHeader(user.token),
      payload: { first_name: '   ', last_name: '   ', job_title: ' ', company_name: ' ' },
    });
    expect(self.statusCode, self.body).toBe(200);
    const viaSelf = await stored(user.id);

    const other = await seedUser(ctx, { roles: ['valuation_user'] });
    const viaAdmin = await patchAsAdmin(other.id, {
      first_name: '   ',
      last_name: '   ',
      job_title: ' ',
      company_name: ' ',
    });
    expect(viaAdmin.statusCode, viaAdmin.body).toBe(200);

    expect(viaSelf).toEqual(await stored(other.id));
  });

  it('still trims and keeps a real name', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const res = await patchAsAdmin(user.id, { first_name: '  Ada  ', last_name: ' Lovelace ' });
    expect(res.statusCode, res.body).toBe(200);
    const row = await stored(user.id);
    expect(row.first_name).toBe('Ada');
    expect(row.last_name).toBe('Lovelace');
  });

  it('still accepts an explicit null, which is how a name is removed', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    await patchAsAdmin(user.id, { first_name: 'Ada' });
    const res = await patchAsAdmin(user.id, { first_name: null });
    expect(res.statusCode, res.body).toBe(200);
    expect((await stored(user.id)).first_name).toBeNull();
  });

  /**
   * The create door was never the problem — `nonBlankText` refuses the value
   * outright there — and this pins that the two halves of one screen still
   * differ in their answer rather than in whether they have one.
   */
  it('is refused outright by the create door, which requires the name', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: authHeader(admin.token),
      payload: {
        current_password: SEEDED_PASSWORD,
        email: `blank.${Date.now()}@example.com`,
        password: 'correct-horse-battery-9',
        roles: ['valuation_user'],
        first_name: '   ',
      },
    });
    expect(res.statusCode).toBe(422);
  });
});
