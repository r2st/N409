import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { problems, registerProblemHandler } from '../src/problem.js';
import { probeReady, registerHealth } from '../src/health.js';

describe('problem+json error handler (api-design.md §1)', () => {
  it('renders ApiProblem as RFC 9457 body', async () => {
    const app = Fastify();
    registerProblemHandler(app);
    app.get('/boom', async () => {
      throw problems.forbidden('partner scope violation');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json();
    expect(body).toMatchObject({
      type: 'urn:n409:problem:forbidden',
      title: 'Forbidden',
      status: 403,
      detail: 'partner scope violation',
      instance: '/boom',
    });
  });

  it('hides internals on unexpected 500s', async () => {
    const app = Fastify({ logger: false });
    registerProblemHandler(app);
    app.get('/crash', async () => {
      throw new Error('secret database string');
    });
    const res = await app.inject({ method: 'GET', url: '/crash' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret database string');
    expect(res.json().title).toBe('Internal Server Error');
  });

  it('renders 404s as problem+json', async () => {
    const app = Fastify();
    registerProblemHandler(app);
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().type).toBe('urn:n409:problem:not-found');
  });
});

describe('health endpoints (issue #4)', () => {
  it('reports liveness', async () => {
    const app = Fastify();
    registerHealth(app, { service: 'test-svc' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'test-svc' });
  });

  it('fails readiness when a dependency check throws', async () => {
    const app = Fastify();
    registerHealth(app, {
      service: 'test-svc',
      checks: {
        db: async () => {
          throw new Error('connection refused');
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.db).toBe('connection refused');
  });

  it('passes readiness when checks succeed', async () => {
    const app = Fastify();
    registerHealth(app, { service: 'test-svc', checks: { db: async () => {} } });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
  });

  it('reports every failing check, not just the first', async () => {
    const app = Fastify();
    registerHealth(app, {
      service: 'test-svc',
      checks: {
        db: async () => {
          throw new Error('connection refused');
        },
        ok: async () => {},
        ai: async () => {
          throw new Error('unreachable');
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual({
      db: 'connection refused',
      ok: 'ok',
      ai: 'unreachable',
    });
  });

  it('runs checks concurrently rather than paying the sum of their timeouts', async () => {
    const app = Fastify();
    const slow = (ms: number) => () => new Promise<void>((r) => setTimeout(r, ms));
    registerHealth(app, {
      service: 'test-svc',
      checks: { a: slow(60), b: slow(60), c: slow(60) },
    });
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    // Serially this is ≥180ms; concurrently ~60ms. The bound is loose so a busy
    // CI box does not make this flaky, while still failing a serial loop.
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('reports build provenance on /health', async () => {
    const app = Fastify();
    registerHealth(app, { service: 'test-svc' });
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    // Reported even when unrecorded, so a deploy that skipped the step shows up
    // as 'unknown' instead of the field simply being absent.
    expect(typeof body.build_sha).toBe('string');
    expect(body.build_sha).not.toBe('');
    expect(['env', 'file', 'unknown']).toContain(body.build_sha_source);
  });

  it('reports the build sha on /ready too', async () => {
    const app = Fastify();
    registerHealth(app, { service: 'test-svc', checks: { db: async () => {} } });
    expect((await app.inject({ method: 'GET', url: '/ready' })).json().build_sha).toBeTruthy();
  });
});

describe('probeReady', () => {
  const okFetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;

  it('resolves when the upstream is ready', async () => {
    await expect(probeReady('ai', 'http://ai:3002', { fetchFn: okFetch })).resolves.toBeUndefined();
  });

  it('probes /ready on the given base url, tolerating a trailing slash', async () => {
    const seen: string[] = [];
    const spy = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await probeReady('ai', 'http://ai:3002/', { fetchFn: spy });
    expect(seen).toEqual(['http://ai:3002/ready']);
  });

  it('honours an upstream 503 — a downstream that knows it is broken breaks us', async () => {
    const down = (async () => new Response('', { status: 503 })) as typeof fetch;
    await expect(probeReady('ai', 'http://ai:3002', { fetchFn: down })).rejects.toThrow(
      /not ready \(HTTP 503\)/,
    );
  });

  it('names the service and url when the upstream is unreachable', async () => {
    const dead = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    await expect(probeReady('engine', 'http://engine:3003', { fetchFn: dead })).rejects.toThrow(
      /engine unreachable at http:\/\/engine:3003\/ready: ECONNREFUSED/,
    );
  });

  it('passes headers through, for the internal shared secret', async () => {
    let sent: Record<string, string> | undefined;
    const spy = (async (_url: unknown, init?: RequestInit) => {
      sent = init?.headers as Record<string, string>;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await probeReady('ai', 'http://ai:3002', { fetchFn: spy, headers: { 'x-internal-token': 't' } });
    expect(sent).toEqual({ 'x-internal-token': 't' });
  });

  it('probes an alternate path when a service mounts health under a prefix', async () => {
    const seen: string[] = [];
    const spy = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await probeReady('engine', 'http://engine:3003', { fetchFn: spy, path: '/engine/v1/health' });
    expect(seen).toEqual(['http://engine:3003/engine/v1/health']);
  });

  it('sends no headers by default rather than undefined', async () => {
    let init: RequestInit | undefined;
    const spy = (async (_url: unknown, opts?: RequestInit) => {
      init = opts;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await probeReady('ai', 'http://ai:3002', { fetchFn: spy });
    expect(init?.headers).toEqual({});
  });

  it('aborts rather than hanging, so /ready cannot be held open by an upstream', async () => {
    let init: RequestInit | undefined;
    const spy = (async (_url: unknown, opts?: RequestInit) => {
      init = opts;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await probeReady('ai', 'http://ai:3002', { fetchFn: spy });
    // A readiness probe with no deadline turns one slow upstream into a
    // service that never answers its own probe, which is how a single
    // degraded dependency takes a whole tier out of the load balancer.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('names the service when the failure is not an Error at all', async () => {
    // fetch is not the only thing that can reject here — a mocked or patched
    // global can throw a string, and `err.message` on it is undefined. The
    // message still has to say which upstream, because that is the entire
    // diagnostic value of the /ready body.
    const odd = (async () => {
      throw 'socket hang up';
    }) as typeof fetch;
    await expect(probeReady('report', 'http://report:3004', { fetchFn: odd })).rejects.toThrow(
      /report unreachable at http:\/\/report:3004\/ready: unreachable/,
    );
  });
});

describe('/ready with no checks registered', () => {
  it('is ready, rather than treating "no dependencies" as "nothing verified"', async () => {
    // The report service has no upstreams of its own. If an empty check set
    // read as not-ready it would never join the load balancer; if it 200'd
    // with no `checks` key the deploy verifier's shape assertions would break.
    const app = Fastify({ logger: false });
    registerHealth(app, { service: 'report' });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready', checks: {} });
    await app.close();
  });
});
