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
    expect(res.json().checks.postgres).toBe('failed');
    await a.close();
  });

  it('is unavailable when the upstreams are down, and says which', async () => {
    const a = app({ readinessFetch: upstreamsDown });
    const res = await a.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    const { checks } = res.json();
    expect(checks.postgres).toBe('ok');
    for (const name of ['valuation', 'ai', 'engine']) {
      expect(checks[name]).toBe('failed');
    }
    await a.close();
  });

  it('stays serving, and says degraded, when only an optional upstream is down', async () => {
    /*
     * This reverses a decision, so the argument is here rather than in a commit
     * message (round 361, methodology M11). The rule used to be "web must not
     * report ready while a whole class of request 502s", and the common real
     * case it named — the AI service losing its OpenRouter key — is exactly the
     * one that shows why it is the wrong rule.
     *
     * This is the origin Caddy proxies every public path to, so a 503 here is
     * the entire product reporting itself unavailable: no sign-in, no
     * engagement list, no report download, no invoice paid. None of those need
     * a model. The valuation tier's boot gate refuses to require the AI and
     * engine units for precisely that reason and says so in as many words, and
     * `/ready` required them anyway — the same mistake its own comment warns
     * against for the report unit, "a readiness check that manufactures the
     * outage it is reporting". `deploy.sh` ends on `/ready is not passing`,
     * so a lapsed provider key also failed the deploy.
     *
     * Degraded is not hidden: the check names itself, `status` says the word,
     * the fan-out logs it, and since R361 :3002 is a scrape target whose `up`
     * is the signal an operator actually alerts on.
     */
    const perHost = (async (url: string | URL | Request) =>
      String(url).includes(':3002')
        ? new Response('', { status: 503 })
        : new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const a = app({ readinessFetch: perHost });
    const res = await a.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('degraded');
    expect(res.json().checks).toMatchObject({ postgres: 'ok', valuation: 'ok', engine: 'ok' });
    expect(res.json().checks.ai).toBe('failed');
    await a.close();
  });

  it('is unavailable when the gating upstream is down, whatever the optional ones say', async () => {
    // The other half of the same rule: `valuation` is the tier this one exists
    // to front, and there is no page it can serve without it.
    const perHost = (async (url: string | URL | Request) =>
      String(url).includes(':3001')
        ? new Response('', { status: 503 })
        : new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const a = app({ readinessFetch: perHost });
    const res = await a.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('unavailable');
    await a.close();
  });

  it('names the upstream that is down without publishing where it lives', async () => {
    // This is the origin the public reaches, and /ready is unauthenticated on
    // it by necessity. It used to answer a stranger with
    // `valuation unreachable at http://127.0.0.1:3001/ready: ECONNREFUSED` —
    // the internal address and port of the service behind the proxy, handed
    // out during any restart. The check name is what a probe acts on; the
    // address is not, and now goes only to the log and to a caller holding the
    // internal token (see @n409/shared health.test.ts).
    const dead = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const a = app({ readinessFetch: dead, valuationUrl: 'http://127.0.0.1:3001' });
    const res = await a.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.valuation).toBe('failed');
    expect(res.payload).not.toContain('127.0.0.1');
    expect(res.payload).not.toContain('3001');
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
      expect(res.json().checks.postgres).toBe('failed');
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
