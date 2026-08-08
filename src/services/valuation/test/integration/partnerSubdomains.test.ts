import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { PLATFORM_BRANDING } from '../../src/domain/branding.js';

const dbUp = await isDbAvailable();

/**
 * Partner subdomains (migration 0106) — a white-label firm's own address.
 *
 * The property worth testing is that `GET /public/branding` is unauthenticated,
 * driven entirely by an attacker-controlled Host header, and still cannot be
 * made to serve the wrong tenant or to fail.
 */
describe.skipIf(!dbUp)('partner subdomains', () => {
  let ctx: TestApp;
  let firmId: string;
  let rivalId: string;
  let firmToken: string;
  let rivalToken: string;

  const brandingFor = (host: string) =>
    ctx.app.inject({ method: 'GET', url: '/api/v1/public/branding', headers: { host } });

  const patch = (token: string, body: unknown) =>
    ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/branding',
      headers: authHeader(token),
      payload: body,
    });

  beforeAll(async () => {
    ctx = await setupTestApp({ APP_BASE_DOMAIN: 'app.409.ai' });
    firmId = await seedPartner(ctx, 'Meridian Valuation');
    rivalId = await seedPartner(ctx, 'Rival Advisory');
    firmToken = (await seedUser(ctx, { roles: ['partner'], partnerId: firmId })).token;
    rivalToken = (await seedUser(ctx, { roles: ['partner'], partnerId: rivalId })).token;
  }, 60_000);
  afterAll(() => ctx.teardown());

  it('claims a subdomain and serves the firm brand on it', async () => {
    const saved = await patch(firmToken, {
      subdomain: 'Meridian',
      brand_name: 'Meridian Valuations',
      brand_color: '#101a3a',
      white_label_enabled: true,
    });
    expect(saved.statusCode).toBe(200);
    // Case folded on the way in — the firm typed "Meridian" and gets `meridian`.
    expect(saved.json().settings.subdomain).toBe('meridian');

    const res = await brandingFor('meridian.app.409.ai');
    expect(res.statusCode).toBe(200);
    expect(res.json().branding.name).toBe('Meridian Valuations');
    expect(res.json().branding.subdomain).toBe('meridian');
    expect(res.json().branding.white_label).toBe(true);
    expect(res.json().css.light['--brand-accent']).toBeTruthy();
  });

  it('serves platform branding on the platform host', async () => {
    const res = await brandingFor('app.409.ai');
    expect(res.statusCode).toBe(200);
    expect(res.json().branding).toEqual(PLATFORM_BRANDING);
  });

  it('never fails on a host it does not recognize', async () => {
    // The login page has to render on every one of these; a 404 here is a
    // blank browser tab for whoever typed it.
    for (const host of [
      'unclaimed.app.409.ai',
      'admin.app.409.ai',
      'a.b.app.409.ai',
      'evil.com',
      'meridian.app.409.ai.evil.com',
      'localhost:3000',
      '[::1]:3000',
    ]) {
      const res = await brandingFor(host);
      expect(res.statusCode, host).toBe(200);
      expect(res.json().branding, host).toEqual(PLATFORM_BRANDING);
    }
  });

  it('resolves the same tenant however the Host header is spelled', async () => {
    for (const host of ['MERIDIAN.App.409.AI', 'meridian.app.409.ai:443', 'meridian.app.409.ai.']) {
      const res = await brandingFor(host);
      expect(res.json().branding.tenant_id, host).toBe(firmId);
    }
  });

  it('refuses a reserved subdomain', async () => {
    const res = await patch(rivalToken, { subdomain: 'secure' });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail ?? res.json().title).toMatch(/reserved/i);
  });

  it('refuses a subdomain DNS will not serve', async () => {
    for (const bad of ['ab', '-rival', 'rival_advisory', 'rival.advisory']) {
      const res = await patch(rivalToken, { subdomain: bad });
      expect(res.statusCode, bad).toBe(422);
    }
  });

  it('refuses a subdomain another firm already holds', async () => {
    const res = await patch(rivalToken, { subdomain: 'meridian' });
    expect(res.statusCode).toBe(409);
    // And the loser's address is unchanged, not cleared.
    const still = await brandingFor('meridian.app.409.ai');
    expect(still.json().branding.tenant_id).toBe(firmId);
  });

  it('serves platform branding for a tenant that has not gone live', async () => {
    // Reserved the address, has not flipped white_label_enabled. Serving their
    // half-configured brand would read as a misconfiguration rather than as
    // "not launched yet".
    const saved = await patch(rivalToken, { subdomain: 'rival', brand_name: 'Rival Advisory Group' });
    expect(saved.statusCode).toBe(200);
    const res = await brandingFor('rival.app.409.ai');
    expect(res.json().branding).toEqual(PLATFORM_BRANDING);

    await patch(rivalToken, { white_label_enabled: true });
    const live = await brandingFor('rival.app.409.ai');
    expect(live.json().branding.name).toBe('Rival Advisory Group');
  });

  it('releases the address when the firm clears it', async () => {
    await patch(rivalToken, { subdomain: null });
    const res = await brandingFor('rival.app.409.ai');
    expect(res.json().branding).toEqual(PLATFORM_BRANDING);
  });

  it('does no host resolution at all without a configured base domain', async () => {
    // Otherwise any Host header a client sends would be read as a tenant claim.
    const plain = await setupTestApp();
    try {
      const partner = await seedPartner(plain, 'Unbased Advisors');
      await plain.pool.query(
        "UPDATE partners SET subdomain = 'unbased', white_label_enabled = true WHERE id = $1",
        [partner],
      );
      const res = await plain.app.inject({
        method: 'GET',
        url: '/api/v1/public/branding',
        headers: { host: 'unbased.app.409.ai' },
      });
      expect(res.json().branding).toEqual(PLATFORM_BRANDING);
    } finally {
      await plain.teardown();
    }
  }, 60_000);
});
