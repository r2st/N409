import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, forceState, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

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
        // Arranged, not transitioned: the rollup below counts states, and how
        // the second engagement got to `review` is another suite's subject.
        if (state) await forceState(ctx, created.json().valuation.id, state);
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

  describe('the name a tenant is known by', () => {
    it('refuses a partner name that is only whitespace, on create and on patch', async () => {
      /*
       * The patch body two lines below `name` already carried this rule for the
       * white-label email overrides, with a comment explaining it:
       * `applyPartnerEmailTemplates` gates on `override.subject && override.body`,
       * which a string of spaces passes. `name` is the label those emails are
       * signed with — `publicPartnerName` resolves to it whenever white label is
       * off or `brand_name` is blank — and it was `min(1)`, a character count.
       * A firm saved that way had no name in the console, in the client-facing
       * header, or on its mail.
       */
      const blank = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/partners',
        headers: authHeader(admin.token),
        payload: { name: '   ', key: 'blank-name-org' },
      });
      expect(blank.statusCode).toBe(422);
      expect(blank.json().detail).toMatch(/whitespace/i);

      const partner = await createPartner('Named Org', 'named-org');
      const patched = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/partners/${partner.id}`,
        headers: authHeader(admin.token),
        payload: { name: '\t ' },
      });
      expect(patched.statusCode).toBe(422);
    });
  });

  describe('GET /partners/mine', () => {
    it('gives a partner user their own branding and nothing more', async () => {
      /*
       * The colour and the mark wait for the switch, and the name does not —
       * `liveBrand`, which this route resolves through, returns
       * `{ name: source.name, accent: null, logo_url: null }` while
       * `white_label_enabled` is false. This test asserted the pre-`liveBrand`
       * behaviour and had been failing on main; it now pins both sides of the
       * switch, which is the part that was never covered.
       */
      const partner = await createPartner('Mine Org', 'mine-org');
      const brand = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/partners/${partner.id}`,
        headers: authHeader(admin.token),
        payload: { brand_color: '#1f6f54', logo_url: 'https://mine.example/logo.png' },
      });
      expect(brand.statusCode).toBe(200);
      const member = await seedUser(ctx, { roles: ['member'], partnerId: partner.id });

      const mine = () =>
        ctx.app.inject({
          method: 'GET',
          url: '/api/v1/partners/mine',
          headers: authHeader(member.token),
        });

      const staged = await mine();
      expect(staged.statusCode).toBe(200);
      expect(staged.json().partner).toEqual({
        id: partner.id,
        name: 'Mine Org',
        key: 'mine-org',
        brand_color: null,
        logo_url: null,
      });

      // Live: the same two fields, now that the firm has turned white label on.
      await ctx.pool.query(`UPDATE partners SET white_label_enabled = true WHERE id = $1`, [
        partner.id,
      ]);
      expect((await mine()).json().partner).toEqual({
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
