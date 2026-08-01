import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/** P1 #7 — partner portal management: archive, detail rollups, branding, scoping. */
describe.skipIf(!dbUp)('partner management API', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let reviewer: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  const createPartner = async (name: string, key: string) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/partners',
      headers: authHeader(admin.token),
      payload: { name, key },
    });
    expect(res.statusCode).toBe(201);
    return res.json().partner as { id: string; name: string };
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    reviewer = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  describe('archive lifecycle', () => {
    it('archives and restores a partner; archived ones leave the default list', async () => {
      const partner = await createPartner('Archive Me', 'archive-me');

      const archive = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/partners/${partner.id}`,
        headers: authHeader(admin.token),
        payload: { archived: true },
      });
      expect(archive.statusCode).toBe(200);
      expect(archive.json().partner.archived_at).toBeTruthy();

      const defaultList = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/partners',
        headers: authHeader(admin.token),
      });
      expect(defaultList.json().partners.map((p: { id: string }) => p.id)).not.toContain(partner.id);

      const fullList = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/partners?include_archived=true',
        headers: authHeader(admin.token),
      });
      expect(fullList.json().partners.map((p: { id: string }) => p.id)).toContain(partner.id);

      const restore = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/partners/${partner.id}`,
        headers: authHeader(admin.token),
        payload: { archived: false },
      });
      expect(restore.json().partner.archived_at).toBeNull();
    });

    it('rejects branding with a malformed colour', async () => {
      const partner = await createPartner('Brand Bad', 'brand-bad');
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/partners/${partner.id}`,
        headers: authHeader(admin.token),
        payload: { brand_color: 'green' },
      });
      expect(res.statusCode).toBe(422);
    });
  });

  describe('detail rollups', () => {
    it('reports users, valuations by state group, and the org user list', async () => {
      const partner = await createPartner('Detail Org', 'detail-org');
      const orgAdmin = await seedUser(ctx, { roles: ['partner'], partnerId: partner.id });
      await seedUser(ctx, { roles: ['member'], partnerId: partner.id });

      // Two engagements through the channel: one open, one pushed to review.
      for (const state of [null, 'review']) {
        const created = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/valuations',
          headers: authHeader(orgAdmin.token),
          payload: { kind: '409a', company_name: 'ChannelCo' },
        });
        expect(created.statusCode).toBe(201);
        if (state) {
          const patched = await ctx.app.inject({
            method: 'PATCH',
            url: `/api/v1/valuations/${created.json().valuation.id}`,
            headers: authHeader(admin.token),
            payload: { state },
          });
          expect(patched.statusCode).toBe(200);
        }
      }

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/partners/${partner.id}`,
        headers: authHeader(admin.token),
      });
      expect(res.statusCode).toBe(200);
      const detail = res.json().partner;
      expect(detail.user_count).toBe(2);
      expect(detail.valuation_count).toBe(2);
      expect(detail.valuations_by_group).toMatchObject({ open: 1, in_review: 1 });
      expect(detail.last_activity_at).toBeTruthy();
      expect(detail.users.map((u: { id: string }) => u.id)).toContain(orgAdmin.id);
    });

    it('is user-admin only', async () => {
      const partner = await createPartner('Locked Org', 'locked-org');
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/partners/${partner.id}`,
        headers: authHeader(reviewer.token),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /partners/mine', () => {
    it('gives a partner user their own branding and nothing more', async () => {
      const partner = await createPartner('Mine Org', 'mine-org');
      await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/partners/${partner.id}`,
        headers: authHeader(admin.token),
        payload: { brand_color: '#1f6f54', logo_url: 'https://mine.example/logo.png' },
      });
      const member = await seedUser(ctx, { roles: ['member'], partnerId: partner.id });

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/partners/mine',
        headers: authHeader(member.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().partner).toEqual({
        id: partner.id,
        name: 'Mine Org',
        key: 'mine-org',
        brand_color: '#1f6f54',
        logo_url: 'https://mine.example/logo.png',
      });
    });

    it('404s for accounts without a partner', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/partners/mine',
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('partner-role scoping validation', () => {
    it('rejects creating a partner-role user without an organisation', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: authHeader(admin.token),
        payload: {
          email: 'scopeless@test.example.com',
          password: 'long-enough-password',
          roles: ['partner'],
        },
      });
      expect(res.statusCode).toBe(422);
    });

    it('rejects inviting a member without an organisation', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users/invite',
        headers: authHeader(admin.token),
        payload: { email: 'scopeless-invite@test.example.com', roles: ['member'] },
      });
      expect(res.statusCode).toBe(422);
    });

    it('rejects assigning users or invitations to an archived partner', async () => {
      const partner = await createPartner('Closed Org', 'closed-org');
      await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/partners/${partner.id}`,
        headers: authHeader(admin.token),
        payload: { archived: true },
      });

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: authHeader(admin.token),
        payload: {
          email: 'late-joiner@test.example.com',
          password: 'long-enough-password',
          roles: ['member'],
          partner_id: partner.id,
        },
      });
      expect(res.statusCode).toBe(422);
    });

    it('rejects a patch that would leave a partner role without an organisation', async () => {
      const partner = await createPartner('Patch Org', 'patch-org');
      const member = await seedUser(ctx, { roles: ['member'], partnerId: partner.id });

      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${member.id}`,
        headers: authHeader(admin.token),
        payload: { partner_id: null },
      });
      expect(res.statusCode).toBe(422);

      // Dropping the role along with the org is fine.
      const ok = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${member.id}`,
        headers: authHeader(admin.token),
        payload: { partner_id: null, roles: ['valuation_user'] },
      });
      expect(ok.statusCode).toBe(200);
    });
  });
});
