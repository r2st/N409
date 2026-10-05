import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

/**
 * Security headers on the report service (round 74).
 *
 * This was the one Fastify unit registering no helmet at all. The headers that
 * matter most here are the two that decide what a browser may do with the PDF:
 * the route answers `content-disposition: inline`, which asks the browser to
 * render rather than save, and the bytes are assembled from caller-supplied
 * `sections[].html`.
 */
describe('security headers', () => {
  it('sets a locked-down CSP, nosniff and deny-framing on health', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['strict-transport-security']).toContain('max-age=15552000');
    expect(res.headers['permissions-policy']).toContain('geolocation=()');
  });

  it('sets them on the rendered PDF itself, not just on the JSON routes', async () => {
    // The reason this service wanted headers in the first place. An inline
    // application/pdf with no nosniff is a document the browser is free to
    // re-interpret, and its content came from the caller.
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      payload: {
        title: 'Valuation Report',
        company_name: 'Acme',
        sections: [{ heading: 'Introduction', html: '<p>Hello.</p>' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('inline');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sets them on a 422 that echoes the caller back', async () => {
    // The validation problem carries the caller's own field paths and values.
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      payload: { title: '', company_name: '', sections: [] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sets them on the token gate 401, which never reaches a handler', async () => {
    // The response most likely to go out bare, because it is produced above the
    // router — the whole reason the policy hook is an onSend.
    const previous = process.env.INTERNAL_SERVICE_TOKEN;
    process.env.INTERNAL_SERVICE_TOKEN = 'round74-secret';
    try {
      const app = buildApp();
      const res = await app.inject({ method: 'POST', url: '/render/v1/pdf', payload: {} });
      expect(res.statusCode).toBe(401);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['permissions-policy']).toContain('geolocation=()');
    } finally {
      if (previous === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
      else process.env.INTERNAL_SERVICE_TOKEN = previous;
    }
  });

  /**
   * The estate is single-origin by construction: only the web BFF is published,
   * and this service is reached over loopback by the valuation service. A CORS
   * grant here would be meaningless at best; registering @fastify/cors with the
   * `origin: true` convenience default would make the render route callable
   * from any page that could reach the port.
   */
  it('answers a cross-origin request with no CORS grant at all', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://attacker.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does not answer a CORS preflight for the render route', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/render/v1/pdf',
      headers: {
        origin: 'https://attacker.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toBeUndefined();
  });
});

/**
 * Body-size ceiling. The render route buffers its whole JSON body before
 * validating it, so the limit is the only thing between an 8 MB cap and
 * whatever a caller feels like sending.
 */
describe('request body limit', () => {
  it('refuses a body past the 8 MB ceiling with 413 rather than buffering it', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      headers: { 'content-type': 'application/json' },
      payload: 'x'.repeat(9 * 1024 * 1024),
    });
    expect(res.statusCode).toBe(413);
  });

  it('still accepts a large legitimate render', async () => {
    // The ceiling has to sit above a real report: sections cap at 100 and each
    // `html` at 200_000 characters, so the schema alone permits a body far
    // larger than any report actually is. This pins that a plausible one fits.
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      payload: {
        title: 'Valuation Report',
        company_name: 'Acme',
        sections: Array.from({ length: 20 }, (_, i) => ({
          heading: `Section ${i + 1}`,
          html: `<p>${'word '.repeat(2000)}</p>`,
        })),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
