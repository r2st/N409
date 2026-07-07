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
  });
});
