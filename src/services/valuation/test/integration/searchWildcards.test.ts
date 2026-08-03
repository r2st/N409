import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Search boxes match a substring, so every one of them builds an ILIKE
 * pattern by wrapping the query in `%…%`. If the query itself is not escaped
 * first, its own `%` and `_` are read as wildcards rather than as characters
 * the user typed — so the narrowest possible query returns the widest possible
 * result. `escapeLike` exists for this and the global search already uses it;
 * these are the list filters that did not.
 */
describe.skipIf(!dbUp)('search filters treat LIKE wildcards as characters', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let firmAdmin: Awaited<ReturnType<typeof seedUser>>;
  let partnerId: string;

  const createValuation = async (companyName: string, token: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    partnerId = await seedPartner(ctx, 'Wildcard Firm');
    firmAdmin = await seedUser(ctx, { roles: ['partner'], partnerId });
  });

  /** The firm roster reads valuations directly, so seed them the same way. */
  const seedFirmValuation = async (company: string) => {
    await ctx.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id, partner_id, state)
       VALUES ($1, '409a', $2, $3, $4, 'review')`,
      [newUlid(), company, firmAdmin.id, partnerId],
    );
  };
  afterAll(async () => ctx?.teardown());

  describe('valuations list', () => {
    let percentId: string;
    let plainId: string;

    beforeAll(async () => {
      percentId = await createValuation('100% Renewable Co', ops.token);
      plainId = await createValuation('Zeta Holdings', ops.token);
    });

    it('finds the company whose name contains a percent sign', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations?q=${encodeURIComponent('100%')}&per_page=100`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const ids = res.json().valuations.map((v: { id: string }) => v.id);
      expect(ids).toContain(percentId);
      // Unescaped, `%100%%` matches every row in scope — the one query that
      // should be most specific instead behaves like no filter at all.
      expect(ids).not.toContain(plainId);
    });

    it('reads a bare percent as the character, not as "everything"', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations?q=${encodeURIComponent('%')}&per_page=100`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const ids = res.json().valuations.map((v: { id: string }) => v.id);
      expect(ids).toContain(percentId);
      expect(ids).not.toContain(plainId);
    });

    it('does not treat an underscore as "any character"', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations?q=${encodeURIComponent('Z_ta')}&per_page=100`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().valuations.map((v: { id: string }) => v.id)).not.toContain(plainId);
    });
  });

  describe('admin user list', () => {
    it('does not treat a bare percent as "every user"', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/users?q=${encodeURIComponent('%')}&per_page=100`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().users).toEqual([]);
    });

    it('still matches an email fragment', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/users?q=${encodeURIComponent(ops.email)}&per_page=100`,
        headers: authHeader(ops.token),
      });
      expect(res.json().users.some((u: { id: string }) => u.id === ops.id)).toBe(true);
    });
  });

  describe('firm client roster', () => {
    beforeAll(async () => {
      await seedFirmValuation('50% Off Ltd');
      await seedFirmValuation('Delta Partners');
    });

    it('finds the client whose name contains a percent sign, and only that one', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/firm/clients?search=${encodeURIComponent('50%')}&per_page=100`,
        headers: authHeader(firmAdmin.token),
      });
      expect(res.statusCode).toBe(200);
      const names = res.json().clients.map((c: { company_name: string }) => c.company_name);
      expect(names).toContain('50% Off Ltd');
      expect(names).not.toContain('Delta Partners');
      // `total` runs its own statement with the same pattern — it has to agree.
      expect(res.json().total).toBe(1);
    });

    it('reads a bare percent as the character, not as "every client"', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/firm/clients?search=${encodeURIComponent('%')}&per_page=100`,
        headers: authHeader(firmAdmin.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().clients.map((c: { company_name: string }) => c.company_name)).toEqual([
        '50% Off Ltd',
      ]);
      expect(res.json().total).toBe(1);
    });
  });
});
