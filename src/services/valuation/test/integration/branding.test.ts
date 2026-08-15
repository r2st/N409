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

/**
 * Caching on the three resolved-branding reads.
 *
 * These are the busiest non-static endpoints here — the signed-out SPA calls
 * `/public/branding` before its first frame and the signed-in one calls
 * `/branding` on every load — so they carry a read-through cache and an ETag.
 * Both introduce a way to be wrong that the routes did not have before, and the
 * expensive one is staleness: a firm administrator who fixes their logo and
 * still sees the old one has no way to tell a cache from a failed save. The
 * invalidation tests below are the point of this block; the 304 tests only
 * confirm the saving is actually taken.
 */
describe.skipIf(!dbUp)('branding caching', () => {
  let ctx: TestApp;
  let firmId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    firmId = await seedPartner(ctx, 'Cacheable Firm');
  });
  afterAll(() => ctx.teardown());

  const get = (url: string, headers: Record<string, string> = {}) =>
    ctx.app.inject({ method: 'GET', url, headers });

  it('gives the signed-in read an ETag and answers a match with a bodyless 304', async () => {
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    const first = await get('/api/v1/branding', authHeader(admin.token));
    expect(first.statusCode).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();

    const second = await get('/api/v1/branding', {
      ...authHeader(admin.token),
      'if-none-match': etag,
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });

  it('keeps the signed-in read private — it is chosen by the caller, not the URI', async () => {
    // A shared cache holding this would serve one firm's brand to another's
    // staff, because the URL is identical for every tenant.
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    const res = await get('/api/v1/branding', authHeader(admin.token));
    expect(res.headers['cache-control']).toContain('private');
    expect(res.headers['cache-control']).toContain('no-cache');
  });

  it('lets a shared cache hold the anonymous read', async () => {
    const res = await get('/api/v1/public/branding');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, no-cache');
    expect(res.headers.etag).toBeTruthy();
  });

  it('answers a matching If-None-Match on the anonymous read with a 304', async () => {
    const first = await get('/api/v1/public/branding');
    const second = await get('/api/v1/public/branding', {
      'if-none-match': first.headers.etag as string,
    });
    expect(second.statusCode).toBe(304);
  });

  it('sends the body again when the client holds a different version', async () => {
    const res = await get('/api/v1/public/branding', { 'if-none-match': '"not-the-one"' });
    expect(res.statusCode).toBe(200);
    expect(res.json().branding).toBeTruthy();
  });

  // ── the half that can be wrong ──────────────────────────────────────────────

  it('shows a rebrand on the very next read, rather than after the TTL', async () => {
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/branding',
      headers: authHeader(admin.token),
      payload: { brand_name: 'Before', white_label_enabled: true },
    });
    const before = await get('/api/v1/branding', authHeader(admin.token));
    expect(before.json().branding.name).toBe('Before');

    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/branding',
      headers: authHeader(admin.token),
      payload: { brand_name: 'After' },
    });

    // No waiting: the write clears the cache, so this is the new value even
    // though the 60s TTL has not come close to expiring.
    const after = await get('/api/v1/branding', authHeader(admin.token));
    expect(after.json().branding.name).toBe('After');
  });

  it('changes the ETag when the brand changes, so a held copy is not reused', async () => {
    // The failure this guards is subtle: a correct invalidation with a stale
    // validator still serves the old bytes, because the client asks "is my copy
    // current?" and gets a 304 for a copy that is not.
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/branding',
      headers: authHeader(admin.token),
      payload: { brand_name: 'Etag One', white_label_enabled: true },
    });
    const first = await get('/api/v1/branding', authHeader(admin.token));
    const firstEtag = first.headers.etag as string;

    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/branding',
      headers: authHeader(admin.token),
      payload: { brand_name: 'Etag Two' },
    });

    const revalidated = await get('/api/v1/branding', {
      ...authHeader(admin.token),
      'if-none-match': firstEtag,
    });
    expect(revalidated.statusCode).toBe(200);
    expect(revalidated.json().branding.name).toBe('Etag Two');
  });

  it('does not serve one tenant the other tenant’s cached brand', async () => {
    // The cache is keyed per tenant; a single shared entry would be the worst
    // bug available here, so it is asserted rather than assumed.
    const otherId = await seedPartner(ctx, 'Other Cacheable Firm');
    const mine = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    const theirs = await seedUser(ctx, { roles: ['partner'], partnerId: otherId });

    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/branding',
      headers: authHeader(mine.token),
      payload: { brand_name: 'Mine', white_label_enabled: true },
    });
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/branding',
      headers: authHeader(theirs.token),
      payload: { brand_name: 'Theirs', white_label_enabled: true },
    });

    expect((await get('/api/v1/branding', authHeader(mine.token))).json().branding.name).toBe('Mine');
    expect((await get('/api/v1/branding', authHeader(theirs.token))).json().branding.name).toBe(
      'Theirs',
    );
  });

  it('still 404s an unknown slug, and does so from the cached miss', async () => {
    const first = await get('/api/v1/public/branding/no-such-tenant');
    expect(first.statusCode).toBe(404);
    // Second time is served from the cached null rather than a second query;
    // what is asserted is that caching the miss did not turn it into a 200.
    expect((await get('/api/v1/public/branding/no-such-tenant')).statusCode).toBe(404);
  });
});
