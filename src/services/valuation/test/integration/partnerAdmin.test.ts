import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Partner administration — the subdomain, the commercial terms and the shared
 * mailbox that 0106/0113 added, plus the firm-scoped engagement list and the
 * role catalog the assignment UI reads.
 */
describe.skipIf(!dbUp)('partner administration API', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let reviewer: Awaited<ReturnType<typeof seedUser>>;
  let partnerId: string;

  const create = async (name: string, key: string) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/partners',
      headers: authHeader(admin.token),
      payload: { name, key },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().partner as {
      id: string;
      subdomain: string | null;
      prepaid: boolean;
      cc_emails: string[];
    };
  };

  const patch = async (id: string, payload: Record<string, unknown>, token = admin.token) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/partners/${id}`,
      headers: authHeader(token),
      payload,
    });

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    reviewer = await seedUser(ctx, { roles: ['reviewer'] });
    partnerId = (await create('Waterstone Capital', 'waterstone')).id;
  });
  afterAll(async () => ctx?.teardown());

  describe('commercial terms', () => {
    it('starts a new firm on the platform’s own address, not prepaid', async () => {
      const fresh = await create('Fresh Firm', 'fresh-firm');
      expect(fresh).toMatchObject({ subdomain: null, prepaid: false, cc_emails: [] });
    });

    it('assigns a subdomain, normalising what was typed', async () => {
      const res = await patch(partnerId, { subdomain: '  WaterStone  ' });
      expect(res.statusCode).toBe(200);
      expect(res.json().partner.subdomain).toBe('waterstone');
    });

    it('refuses a reserved label with a reason', async () => {
      const res = await patch(partnerId, { subdomain: 'www' });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/reserved/i);
    });

    it('refuses a label DNS could not resolve, with a different reason', async () => {
      const res = await patch(partnerId, { subdomain: '-nope-' });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/3–63 characters/);
    });

    it('refuses to let two firms share an address', async () => {
      const other = await create('Copycat', 'copycat');
      const res = await patch(other.id, { subdomain: 'waterstone' });
      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toMatch(/already taken/);
    });

    it('releases the address on null', async () => {
      const temp = await create('Temporary', 'temporary');
      expect((await patch(temp.id, { subdomain: 'temporary' })).statusCode).toBe(200);
      const released = await patch(temp.id, { subdomain: null });
      expect(released.json().partner.subdomain).toBeNull();
      // Released means available: another firm can now claim it.
      const claimant = await create('Claimant', 'claimant');
      expect((await patch(claimant.id, { subdomain: 'temporary' })).statusCode).toBe(200);
    });

    it('records prepaid and the shared mailbox', async () => {
      const res = await patch(partnerId, {
        prepaid: true,
        cc_emails: ['ops@waterstone.test', 'filings@waterstone.test'],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().partner).toMatchObject({
        prepaid: true,
        cc_emails: ['ops@waterstone.test', 'filings@waterstone.test'],
      });
    });

    it('dedupes the mailbox list case-insensitively', async () => {
      // The same mailbox twice is two copies of every email, and differing
      // case is how it happens.
      const res = await patch(partnerId, {
        cc_emails: ['Ops@waterstone.test', 'ops@waterstone.test', 'legal@waterstone.test'],
      });
      expect(res.json().partner.cc_emails).toEqual(['Ops@waterstone.test', 'legal@waterstone.test']);
    });

    it('rejects a non-address in the mailbox list', async () => {
      expect((await patch(partnerId, { cc_emails: ['not-an-email'] })).statusCode).toBe(422);
    });

    it('rejects an unknown field rather than silently dropping it', async () => {
      expect((await patch(partnerId, { valuation_count: 999 })).statusCode).toBe(422);
    });

    it('is user-admin only — a reviewer cannot change a firm’s terms', async () => {
      expect((await patch(partnerId, { prepaid: false }, reviewer.token)).statusCode).toBe(403);
    });

    it('surfaces the new columns on the list and detail views', async () => {
      const list = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/partners',
        headers: authHeader(admin.token),
      });
      const row = list.json().partners.find((p: { id: string }) => p.id === partnerId);
      expect(row).toMatchObject({ subdomain: 'waterstone', prepaid: true });

      const detail = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/partners/${partnerId}`,
        headers: authHeader(admin.token),
      });
      expect(detail.json().partner).toMatchObject({ subdomain: 'waterstone', prepaid: true });
    });
  });

  describe('firm-scoped engagements', () => {
    let memberToken: string;

    beforeAll(async () => {
      const member = await seedUser(ctx, { roles: ['partner'], partnerId });
      memberToken = member.token;
      for (const name of ['Portfolio One', 'Portfolio Two', 'Portfolio Three']) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/valuations',
          headers: authHeader(memberToken),
          payload: { kind: '409a', company_name: name },
        });
        expect(res.statusCode).toBe(201);
      }
      // An engagement belonging to nobody's firm, to prove the scope holds.
      const outsider = await seedUser(ctx, { roles: ['valuation_user'] });
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(outsider.token),
        payload: { kind: '409a', company_name: 'Direct Client Co' },
      });
    });

    const listFor = async (id: string, query = '') => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/partners/${id}/valuations${query}`,
        headers: authHeader(admin.token),
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as { valuations: Array<{ company_name: string }>; total: number };
    };

    it('lists exactly the firm’s engagements', async () => {
      const body = await listFor(partnerId);
      expect(body.total).toBe(3);
      expect(body.valuations.map((v) => v.company_name).sort()).toEqual([
        'Portfolio One',
        'Portfolio Three',
        'Portfolio Two',
      ]);
    });

    it('filters and pages inside the firm', async () => {
      expect((await listFor(partnerId, '?q=Portfolio%20Two')).total).toBe(1);
      const page = await listFor(partnerId, '?per_page=2&page=1');
      expect(page.valuations).toHaveLength(2);
      expect(page.total).toBe(3);
    });

    it('404s for a firm that does not exist', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/partners/01JQZZZZZZZZZZZZZZZZZZZZZZ/valuations',
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(404);
    });

    it('is user-admin only', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/partners/${partnerId}/valuations`,
        headers: authHeader(reviewer.token),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('role catalog', () => {
    it('describes every role with its scope and capabilities', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/roles',
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(200);
      const { roles, capabilities } = res.json() as {
        roles: Array<{ key: string; label: string; scope: string; capabilities: string[] }>;
        capabilities: Array<{ key: string; label: string }>;
      };
      expect(roles).toHaveLength(18);
      const partner = roles.find((r) => r.key === 'partner')!;
      expect(partner).toMatchObject({ label: 'Partner', scope: 'partner' });
      expect(partner.capabilities).toContain('branding.manage.own');
      expect(roles.find((r) => r.key === 'ignored')!.capabilities).toEqual([]);
      expect(capabilities.length).toBeGreaterThan(5);
    });

    it('tells a signed-in user what they may do', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me/capabilities',
        headers: authHeader(reviewer.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { roles: string[]; capabilities: string[] };
      expect(body.roles).toEqual(['reviewer']);
      expect(body.capabilities).toContain('working_data.edit');
      expect(body.capabilities).not.toContain('users.manage');
    });

    it('keeps the catalog itself to ops', async () => {
      const client = await seedUser(ctx, { roles: ['valuation_user'] });
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/roles',
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(403);
      // Their own capabilities are still theirs to read.
      const mine = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me/capabilities',
        headers: authHeader(client.token),
      });
      expect(mine.statusCode).toBe(200);
      expect(mine.json().capabilities).toContain('valuations.read.own');
    });
  });
});
