import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';

/**
 * Web /ready.
 *
 * It used to answer `200 {"checks":{}}` unconditionally — structurally incapable
 * of reporting "not ready", which is worse than having no endpoint, because
 * Caddy and every uptime check believed it. Web is the only origin the public
 * reaches, so its readiness has to mean "a request arriving here can be served",
 * and that depends on downstream services it does not contain.
 */

/** A pool stand-in: only `query` is ever called by the readiness check. */
const fakePool = (impl: () => Promise<unknown> = async () => ({ rows: [{ '?column?': 1 }] })) =>
  ({ query: vi.fn(impl) }) as unknown as pg.Pool;

const upstreamsUp = (async () =>
  new Response(JSON.stringify({ status: 'ready' }), { status: 200 })) as typeof fetch;

const upstreamsDown = (async () => new Response('', { status: 503 })) as typeof fetch;

function app(opts: Parameters<typeof buildApp>[0] = {}) {
  return buildApp({
    staticRoot: '/nonexistent',
    pool: fakePool(),
    readinessFetch: upstreamsUp,
    ...opts,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('web /ready', () => {
  it('is ready when Postgres and all three upstreams are', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ready',
      checks: { postgres: 'ok', valuation: 'ok', ai: 'ok', engine: 'ok' },
    });
    await a.close();
  });

  it('actually checks something — the regression that made this endpoint a lie', async () => {
    const a = app();
    const checks = (await a.inject({ method: 'GET', url: '/ready' })).json().checks;
    expect(Object.keys(checks).sort()).toEqual(['ai', 'engine', 'postgres', 'valuation']);
    await a.close();
  });

  it('is unavailable when Postgres is down', async () => {
    const a = app({
      pool: fakePool(async () => {
        throw new Error('connection refused');
      }),
    });
    const res = await a.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('unavailable');
    expect(res.json().checks.postgres).toBe('connection refused');
    await a.close();
  });

  it('is unavailable when the upstreams are down, and says which', async () => {
    const a = app({ readinessFetch: upstreamsDown });
    const res = await a.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    const { checks } = res.json();
    expect(checks.postgres).toBe('ok');
    for (const name of ['valuation', 'ai', 'engine']) {
      expect(checks[name]).toMatch(/not ready \(HTTP 503\)/);
    }
    await a.close();
  });

  it('is unavailable when only one upstream is down', async () => {
    // The common real case: the AI service loses its OpenRouter key. Web must
    // not report ready while a whole class of request 502s.
    const perHost = (async (url: string | URL | Request) =>
      String(url).includes(':3002')
        ? new Response('', { status: 503 })
        : new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const a = app({ readinessFetch: perHost });
    const res = await a.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toMatchObject({ postgres: 'ok', valuation: 'ok', engine: 'ok' });
    expect(res.json().checks.ai).toMatch(/503/);
    await a.close();
  });

  it('reports an unreachable upstream by name and url', async () => {
    const dead = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const a = app({ readinessFetch: dead, valuationUrl: 'http://127.0.0.1:3001' });
    const res = await a.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.valuation).toContain('http://127.0.0.1:3001/ready');
    await a.close();
  });

  it('probes the configured upstream urls, not hardcoded ones', async () => {
    const seen: string[] = [];
    const spy = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const a = app({
      readinessFetch: spy,
      valuationUrl: 'http://valuation:3001',
      aiUrl: 'http://ai:3002',
      engineUrl: 'http://engine-wrapper:3003',
    });
    await a.inject({ method: 'GET', url: '/ready' });
    expect(seen.sort()).toEqual([
      'http://ai:3002/ready',
      'http://engine-wrapper:3003/ready',
      'http://valuation:3001/ready',
    ]);
    await a.close();
  });

  it('reports unavailable rather than ok when DATABASE_URL is unset', async () => {
    // Every unit shares one EnvironmentFile that defines DATABASE_URL, so its
    // absence is a broken deploy. A check that silently passes when
    // unconfigured is how this endpoint came to report an empty object.
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const a = buildApp({ staticRoot: '/nonexistent', readinessFetch: upstreamsUp });
      const res = await a.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json().checks.postgres).toMatch(/DATABASE_URL is not configured/);
      await a.close();
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });

  it('leaves liveness independent of readiness', async () => {
    // /health must stay up while /ready is red, or systemd and the container
    // healthcheck restart a service whose only problem is a sick dependency.
    const a = app({ readinessFetch: upstreamsDown });
    expect((await a.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);
    expect((await a.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    await a.close();
  });

  it('closes a pool it created, and leaves an injected one alone', async () => {
    const injected = fakePool();
    (injected as unknown as { end: () => Promise<void> }).end = vi.fn(async () => {});
    const a = app({ pool: injected });
    await a.inject({ method: 'GET', url: '/ready' });
    await a.close();
    expect((injected as unknown as { end: () => Promise<void> }).end).not.toHaveBeenCalled();
  });
});
