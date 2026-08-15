import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/** @fastify/helmet security headers on the JSON API (audit B-1 P1). */
describe.skipIf(!dbUp)('security headers', () => {
  let ctx: TestApp;
  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(async () => ctx?.teardown());

  it('sets a locked-down CSP, nosniff, and deny-framing on responses', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['strict-transport-security']).toContain('max-age=15552000');
  });

  /**
   * The estate is deliberately single-origin: the browser only ever talks to
   * the web BFF, which proxies /api to this service, so no response here has
   * any reason to carry CORS headers. That is not a detail — it is half of the
   * cross-origin defence. The other half is the session cookie
   * (auth/cookies.ts: httpOnly, SameSite=strict, secure), and the two are only
   * strong together: registering @fastify/cors with the `origin: true`
   * convenience default would reflect *any* requesting origin, and every
   * Authorization-header and API-token route on this service would become
   * readable cross-origin.
   *
   * Asserted with an Origin on the request, because a CORS plugin echoes the
   * header only when one is present — checking a plain request would pass no
   * matter what was registered.
   */
  it('answers a cross-origin request with no CORS grant at all', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://attacker.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does not answer a CORS preflight for a mutating route', async () => {
    const res = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/valuations',
      headers: {
        origin: 'https://attacker.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    // Whatever the router makes of an unrouted OPTIONS, it must not be a grant.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toBeUndefined();
  });
});
