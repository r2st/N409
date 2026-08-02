import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('web service', () => {
  it('serves health', async () => {
    const app = buildApp({ staticRoot: '/nonexistent' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().service).toBe('web');
    await app.close();
  });

  describe('SPA static hosting', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'n409-web-'));
    writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>N409</title>SPA-SHELL');

    it('serves index.html at /', async () => {
      const app = buildApp({ staticRoot: root });
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('SPA-SHELL');
      await app.close();
    });

    it('sets CSP and security headers on the served SPA (audit B-1 P1)', async () => {
      const app = buildApp({ staticRoot: root });
      const res = await app.inject({ method: 'GET', url: '/' });
      const csp = res.headers['content-security-policy'];
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain('https://www.googletagmanager.com');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(res.headers['strict-transport-security']).toContain('max-age=15552000');
      await app.close();
    });

    it('falls back to index.html for client-side routes', async () => {
      const app = buildApp({ staticRoot: root });
      const res = await app.inject({ method: 'GET', url: '/valuations/01ARZ3NDEKTSV4RRFFQ69G5FAV' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('SPA-SHELL');
      await app.close();
    });

    it('does not fall back for non-GET requests', async () => {
      const app = buildApp({ staticRoot: root });
      const res = await app.inject({ method: 'POST', url: '/not-an-api' });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  describe('API proxy', () => {
    const upstream = Fastify();
    let upstreamUrl = '';

    beforeAll(async () => {
      upstream.get('/api/v1/auth/providers', async (req) => ({
        password: true,
        google: false,
        sawAuth: req.headers.authorization ?? null,
        sawRequestId: req.headers['x-request-id'] ?? null,
      }));
      await upstream.listen({ port: 0, host: '127.0.0.1' });
      const addr = upstream.server.address();
      if (typeof addr === 'object' && addr) upstreamUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterAll(async () => {
      await upstream.close();
    });

    it('forwards /api/* to the valuation service, headers intact', async () => {
      const app = buildApp({ staticRoot: '/nonexistent', valuationUrl: upstreamUrl });
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/providers',
        headers: { authorization: 'Bearer abc' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ password: true, sawAuth: 'Bearer abc' });
      await app.close();
    });

    describe('request-id propagation', () => {
      /**
       * The BFF is where a browser request enters the estate, so it mints the
       * id that ties the chain together. Without the stamp below, the chain
       * broke at the first hop — valuation minted its own, and the engine a
       * third — and one user action wrote log lines under three unrelated ids.
       */
      it('stamps a minted request id onto the proxied request', async () => {
        const app = buildApp({ staticRoot: '/nonexistent', valuationUrl: upstreamUrl });
        const res = await app.inject({ method: 'GET', url: '/api/v1/auth/providers' });
        expect(res.json().sawRequestId).toBeTruthy();
        await app.close();
      });

      it('honours an inbound id, so a load balancer can supply its own', async () => {
        const app = buildApp({ staticRoot: '/nonexistent', valuationUrl: upstreamUrl });
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/auth/providers',
          headers: { 'x-request-id': 'edge-trace-1' },
        });
        expect(res.json().sawRequestId).toBe('edge-trace-1');
        await app.close();
      });

      it('passes the same id it logged against, not a second one', async () => {
        const app = buildApp({ staticRoot: '/nonexistent', valuationUrl: upstreamUrl });
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/auth/providers',
          headers: { 'x-request-id': 'edge-trace-2' },
        });
        // Fastify resolves req.id from the same header, so the id in this
        // service's own log lines and the one forwarded are one value.
        expect(res.json().sawRequestId).toBe('edge-trace-2');
        await app.close();
      });
    });
  });
});
