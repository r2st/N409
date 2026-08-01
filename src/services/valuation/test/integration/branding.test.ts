import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { PLATFORM_BRANDING } from '../../src/domain/branding.js';

/**
 * White-label branding routes (migration 0091). The load-bearing property is
 * tenant isolation: a firm administrator may shape their own brand and must not
 * be able to reach anyone else's, including by naming a partner id directly.
 */

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('branding', () => {
  let ctx: TestApp;
  let firmId: string;
  let rivalId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    firmId = await seedPartner(ctx, 'Meridian Valuation');
    rivalId = await seedPartner(ctx, 'Rival Advisory');
  });
  afterAll(() => ctx.teardown());

  const patch = (token: string, body: unknown, query = '') =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/branding${query}`,
      headers: authHeader(token),
      payload: body,
    });

  it('serves platform branding to a principal with no tenant', async () => {
    const client = await seedUser(ctx, { roles: ['valuation_user'] });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/branding',
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().branding).toEqual(PLATFORM_BRANDING);
  });

  it('requires a session', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/branding' });
    expect(res.statusCode).toBe(401);
  });

  it('lets a firm administrator brand their own tenant end to end', async () => {
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });

    const saved = await patch(admin.token, {
      brand_name: 'Meridian Valuations',
      brand_tagline: '409A & ASC 718',
      brand_color: '#101a3a',
      logo_url: 'https://cdn.example.com/meridian.svg',
      support_email: 'valuations@meridian.example.com',
      white_label_enabled: true,
    });
    expect(saved.statusCode).toBe(200);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/branding',
      headers: authHeader(admin.token),
    });
    const { branding } = res.json();
    expect(branding.name).toBe('Meridian Valuations');
    expect(branding.white_label).toBe(true);
    expect(branding.tenant_id).toBe(firmId);
    expect(branding.accent).toBe('#101a3a');
    // The navy is illegible on the dark sidebar, so the resolver lifts it.
    expect(branding.accent_dark).not.toBe('#101a3a');
    expect(branding.logo_dark_url).toBe('https://cdn.example.com/meridian.svg');
  });

  it('shows platform branding to the firm until the switch is turned on', async () => {
    const staged = await seedPartner(ctx, 'Staged Firm');
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId: staged });
    await patch(admin.token, { brand_name: 'Staged', brand_color: '#7c3aed' });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/branding',
      headers: authHeader(admin.token),
    });
    expect(res.json().branding).toEqual(PLATFORM_BRANDING);

    // ...and the staging values are still visible in the editing view.
    const settings = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/branding/settings',
      headers: authHeader(admin.token),
    });
    expect(settings.json().settings.brand_name).toBe('Staged');
    expect(settings.json().preview.name).toBe('Staged');
  });

  it('refuses to let one firm touch another', async () => {
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    const res = await patch(admin.token, { brand_name: 'Hostile rebrand' }, `?partner_id=${rivalId}`);
    expect(res.statusCode).toBe(403);

    const settings = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/branding/settings?partner_id=${rivalId}`,
      headers: authHeader(admin.token),
    });
    expect(settings.statusCode).toBe(403);
  });

  it('does not let an ordinary firm member rebrand the firm', async () => {
    const member = await seedUser(ctx, { roles: ['member'], partnerId: firmId });
    const res = await patch(member.token, { brand_name: 'Member rebrand' });
    expect(res.statusCode).toBe(403);
  });

  it('lets platform admins brand any tenant', async () => {
    const ops = await seedUser(ctx, { roles: ['admin'] });
    const res = await patch(ops.token, { brand_name: 'Ops set this' }, `?partner_id=${rivalId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.brand_name).toBe('Ops set this');
  });

  it('rejects an unknown field instead of ignoring it', async () => {
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    // `key` is the tenant's URL slug — reachable on the table, never via here.
    const res = await patch(admin.token, { key: 'meridian-hijack' });
    expect(res.statusCode).toBe(422);

    const { rows } = await ctx.pool.query<{ key: string }>('SELECT key FROM partners WHERE id = $1', [
      firmId,
    ]);
    expect(rows[0]!.key).toBe('meridian-valuation');
  });

  it('rejects a malformed colour', async () => {
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    expect((await patch(admin.token, { brand_color: 'purple' })).statusCode).toBe(422);
  });

  it('records an audit event carrying the applied values', async () => {
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    await patch(admin.token, { brand_tagline: 'Independent valuations' });
    const { rows } = await ctx.pool.query<{ payload: { applied: Record<string, unknown> } }>(
      `SELECT payload FROM admin_events
        WHERE type = 'branding_updated' AND subject_id = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [firmId],
    );
    expect(rows[0]!.payload.applied).toEqual({ brand_tagline: 'Independent valuations' });
  });

  it('serves branding to the signed-out login page by slug', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/public/branding/meridian-valuation' });
    expect(res.statusCode).toBe(200);
    expect(res.json().branding.name).toBe('Meridian Valuations');

    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/public/branding/no-such-firm' })).statusCode,
    ).toBe(404);
  });

  it('stops serving a brand once the channel is archived', async () => {
    const closed = await seedPartner(ctx, 'Closed Firm');
    await ctx.pool.query(
      `UPDATE partners SET white_label_enabled = true, brand_name = 'Closed', archived_at = now()
        WHERE id = $1`,
      [closed],
    );
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/public/branding/closed-firm' });
    expect(res.statusCode).toBe(404);
  });

  it('lists white-label tenants for ops only', async () => {
    const ops = await seedUser(ctx, { roles: ['admin'] });
    const firmAdmin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/branding/tenants',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tenants.find((t: { id: string }) => t.id === firmId)).toMatchObject({
      name: 'Meridian Valuations',
      enabled: true,
    });

    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/branding/tenants',
          headers: authHeader(firmAdmin.token),
        })
      ).statusCode,
    ).toBe(403);
  });
});
