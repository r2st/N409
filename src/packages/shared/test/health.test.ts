import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { CHECK_FAILED, CHECK_OK, READY_CACHE_MS, registerHealth } from '../src/health.js';
import { INTERNAL_TOKEN_ENV, INTERNAL_TOKEN_HEADER } from '../src/internalAuth.js';

/**
 * The two properties of `/ready` that are about the endpoint itself rather than
 * about any particular dependency: what it is willing to say, and how much work
 * one request can make it do.
 *
 * Both matter because of where this endpoint is served. `/ready` is on the
 * internal-auth public path list, and on the web service it is reachable from
 * the open internet through Caddy — it has to be, since that is the endpoint a
 * load balancer and every uptime check read. So an unauthenticated stranger can
 * ask this question as often as they like, and whatever it answers, it answers
 * to them.
 */

const TOKEN = 'internal-secret-token';

function appWith(
  checks: Record<string, () => Promise<void>>,
  opts: { readyCacheMs?: number } = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  registerHealth(app, { service: 'test-svc', checks, ...opts });
  return app;
}

/** A check that fails the way the real ones do: with the topology in the text. */
const leakyCheck = () => async () => {
  throw new Error('valuation unreachable at http://127.0.0.1:3001/ready: ECONNREFUSED');
};

let savedToken: string | undefined;

beforeEach(() => {
  savedToken = process.env[INTERNAL_TOKEN_ENV];
});

afterEach(() => {
  if (savedToken === undefined) delete process.env[INTERNAL_TOKEN_ENV];
  else process.env[INTERNAL_TOKEN_ENV] = savedToken;
  vi.useRealTimers();
});

describe('/ready disclosure', () => {
  it('does not put the failure reason in the body of an unauthenticated probe', async () => {
    // The regression this exists for: the thrown message went into the body
    // verbatim, so a routine restart of the valuation service answered the
    // public internet with the loopback address and port it lives on.
    process.env[INTERNAL_TOKEN_ENV] = TOKEN;
    const app = appWith({ valuation: leakyCheck() });
    const res = await app.inject({ method: 'GET', url: '/ready' });

    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual({ valuation: CHECK_FAILED });
    expect(res.payload).not.toContain('127.0.0.1');
    expect(res.payload).not.toContain('3001');
    expect(res.payload).not.toContain('ECONNREFUSED');
    await app.close();
  });

  it('does not leak a connection string when Postgres is the thing that failed', async () => {
    // libpq names the host, the database and the role in its common failures,
    // and a misconfigured DSN can carry the password into the message too.
    process.env[INTERNAL_TOKEN_ENV] = TOKEN;
    const app = appWith({
      postgres: async () => {
        throw new Error(
          'could not connect to postgres://n409:hunter2@db.internal:5432/n409_prod: role "n409" does not exist',
        );
      },
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });

    expect(res.json().checks.postgres).toBe(CHECK_FAILED);
    for (const secret of ['hunter2', 'db.internal', 'n409_prod']) {
      expect(res.payload, secret).not.toContain(secret);
    }
    await app.close();
  });

  it('still says which check failed, because that is what a probe acts on', async () => {
    // Redacting the reason must not degrade into redacting the result: an
    // operator reading the public body should still see that it is the AI
    // service and not Postgres, just not the address of either.
    process.env[INTERNAL_TOKEN_ENV] = TOKEN;
    const app = appWith({
      postgres: async () => {},
      ai: leakyCheck(),
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'unavailable',
      checks: { postgres: CHECK_OK, ai: CHECK_FAILED },
    });
    await app.close();
  });

  it('tells a caller holding the internal token, so one curl on the box still explains it', async () => {
    process.env[INTERNAL_TOKEN_ENV] = TOKEN;
    const app = appWith({ valuation: leakyCheck() });
    const res = await app.inject({
      method: 'GET',
      url: '/ready',
      headers: { [INTERNAL_TOKEN_HEADER]: TOKEN },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().checks.valuation).toMatch(/unreachable at http:\/\/127\.0\.0\.1:3001\/ready/);
    await app.close();
  });

  it('is not fooled by a wrong token', async () => {
    process.env[INTERNAL_TOKEN_ENV] = TOKEN;
    const app = appWith({ valuation: leakyCheck() });
    for (const attempt of ['', 'wrong', `${TOKEN}x`, TOKEN.slice(0, -1)]) {
      const res = await app.inject({
        method: 'GET',
        url: '/ready',
        headers: { [INTERNAL_TOKEN_HEADER]: attempt },
      });
      expect(res.json().checks.valuation, attempt).toBe(CHECK_FAILED);
    }
    await app.close();
  });

  it('discloses nothing when no secret is configured, rather than everything', async () => {
    // The inverse of the route gate in internalAuth.ts, deliberately: an unset
    // secret there means "open" so a developer machine works, but here it would
    // mean the reasons are public on exactly the installation least equipped to
    // afford it. Nobody is authorized, so nobody is told.
    delete process.env[INTERNAL_TOKEN_ENV];
    const app = appWith({ valuation: leakyCheck() });
    const withHeader = await app.inject({
      method: 'GET',
      url: '/ready',
      headers: { [INTERNAL_TOKEN_HEADER]: TOKEN },
    });
    expect(withHeader.json().checks.valuation).toBe(CHECK_FAILED);
    await app.close();
  });

  it('scrubs the reason it hands the authorized caller, and the log line behind it', async () => {
    // The token buys the topology, not the credentials: this is the same text
    // that goes to the log, and scrubSensitive is what keeps a DSN password out
    // of both.
    process.env[INTERNAL_TOKEN_ENV] = TOKEN;
    const app = appWith({
      postgres: async () => {
        throw new Error('connect ECONNREFUSED postgres://n409:hunter2@db.internal:5432/n409');
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/ready',
      headers: { [INTERNAL_TOKEN_HEADER]: TOKEN },
    });

    expect(res.json().checks.postgres).toContain('db.internal');
    expect(res.json().checks.postgres).not.toContain('hunter2');
    await app.close();
  });

  it('logs the reason so it is recoverable without the token at all', async () => {
    process.env[INTERNAL_TOKEN_ENV] = TOKEN;
    const app = Fastify({ logger: false });
    const warn = vi.fn();
    registerHealth(app, {
      service: 'test-svc',
      checks: { valuation: leakyCheck() },
    });
    // Fastify's request logger is what the handler reaches for; replace it.
    app.addHook('onRequest', (req, _reply, done) => {
      (req as unknown as { log: unknown }).log = { warn, error: warn, info: warn, debug: warn };
      done();
    });
    await app.inject({ method: 'GET', url: '/ready' });

    expect(warn).toHaveBeenCalledTimes(1);
    const [obj] = warn.mock.calls[0] as [{ checks: Record<string, string> }];
    expect(obj.checks.valuation).toMatch(/127\.0\.0\.1:3001/);
    await app.close();
  });

  it('marks health and readiness uncacheable by an intermediary', async () => {
    // A CDN or proxy that caches a 200 keeps answering "ready" for a process
    // that has since gone away — the one answer these endpoints must not give.
    const app = appWith({ ok: async () => {} });
    for (const url of ['/health', '/ready']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['cache-control'], url).toBe('no-store');
    }
    await app.close();
  });
});

describe('/ready coalescing', () => {
  it('collapses concurrent probes into one dependency fan-out', async () => {
    // Each probe costs a query on a pool sized max:1 plus one HTTP call per
    // upstream. Unauthenticated and unthrottled, that is an amplifier pointed
    // at the estate — and at the single connection readiness itself needs, so
    // enough concurrency turns a healthy instance red on pool contention alone.
    let runs = 0;
    const app = appWith({
      postgres: async () => {
        runs += 1;
        await new Promise((r) => setTimeout(r, 20));
      },
    });

    const responses = await Promise.all(
      Array.from({ length: 25 }, () => app.inject({ method: 'GET', url: '/ready' })),
    );

    expect(runs).toBe(1);
    for (const res of responses) expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('coalesces a failing estate too, which is when the flood arrives', async () => {
    // A rejection would be uncacheable, so the checks resolve with their result
    // rather than throwing. Everything being down is precisely when every
    // client retries at once.
    let runs = 0;
    const app = appWith({
      ai: async () => {
        runs += 1;
        throw new Error('ai unreachable at http://127.0.0.1:3002/ready: ECONNREFUSED');
      },
    });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => app.inject({ method: 'GET', url: '/ready' })),
    );

    expect(runs).toBe(1);
    for (const res of responses) expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('re-checks once the window has passed, so the answer cannot go stale', async () => {
    // The cache exists to bound cost, not to stop reporting. A window longer
    // than a probe interval would hide a recovery — or an outage — for as long
    // as it lasted.
    let healthy = false;
    let runs = 0;
    const app = appWith({
      postgres: async () => {
        runs += 1;
        if (!healthy) throw new Error('connection refused');
      },
    });

    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);
    healthy = true;
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);
    expect(runs).toBe(1);

    await new Promise((r) => setTimeout(r, READY_CACHE_MS + 50));
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    expect(runs).toBe(2);
    await app.close();
  });

  it('window is short enough that a deploy wait loop still sees the truth', async () => {
    // infra/deploy.sh polls /ready in a loop after the restart; a window on the
    // order of its interval would have it acting on a pre-restart answer.
    expect(READY_CACHE_MS).toBeLessThanOrEqual(2000);
  });

  it('can be turned off, for a caller that needs every probe to be a real one', async () => {
    let runs = 0;
    const app = appWith({ ok: async () => void (runs += 1) }, { readyCacheMs: 0 });
    await app.inject({ method: 'GET', url: '/ready' });
    await app.inject({ method: 'GET', url: '/ready' });
    expect(runs).toBe(2);
    await app.close();
  });

  it('leaves liveness free of the readiness fan-out entirely', async () => {
    let runs = 0;
    const app = appWith({ postgres: async () => void (runs += 1) });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(runs).toBe(0);
    await app.close();
  });
});

/**
 * A dependency the service was designed to serve without (round 361, M11).
 *
 * A 503 from `/ready` is a claim — *this instance cannot serve the request and
 * another one can* — and a consumer acts on it by taking the instance out. The
 * valuation tier's boot gate had already decided the AI and engine units are
 * not that, refusing to require either because "refusing to boot would convert
 * a degraded feature into a total outage", and `/ready` on both the valuation
 * and web tiers required them anyway. The web tier is the origin Caddy proxies
 * every public path to, so an AI unit answering 503 over a lapsed provider key
 * answered the internet with `unavailable`.
 *
 * The split has to be *reported* rather than merely ignored, which is the whole
 * of what these assert: the check is still run, still named, still `failed` in
 * the public form, and the summary word moves to `degraded` so a green probe
 * cannot be mistaken for a whole estate.
 */
describe('optional readiness checks', () => {
  const app = (
    checks: Record<string, () => Promise<void>>,
    optional: Record<string, () => Promise<void>>,
  ) => {
    const instance = Fastify({ logger: false });
    registerHealth(instance, { service: 'test', checks, optional, readyCacheMs: 0 });
    return instance;
  };
  const ok = async () => {};
  const fails = async () => {
    throw new Error('nope');
  };

  it('stays 200 and says degraded when only an optional check fails', async () => {
    const a = app({ postgres: ok }, { ai: fails });
    const res = await a.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('degraded');
    // Named, not hidden: the point of not gating is not to stop reporting.
    expect(res.json().checks).toMatchObject({ postgres: 'ok', ai: 'failed' });
    await a.close();
  });

  it('is 503 when a gating check fails, whatever the optional ones say', async () => {
    const a = app({ postgres: fails }, { ai: ok });
    const res = await a.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('unavailable');
    await a.close();
  });

  it('says ready only when nothing at all failed', async () => {
    const a = app({ postgres: ok }, { ai: ok });
    const res = await a.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ready');
    await a.close();
  });

  it('logs a degraded fan-out without calling it unavailable', async () => {
    const warn = vi.fn();
    const instance = Fastify({ logger: false });
    registerHealth(instance, {
      service: 'test',
      checks: { postgres: ok },
      optional: { ai: fails },
      readyCacheMs: 0,
    });
    instance.addHook('onRequest', (req, _reply, done) => {
      (req as unknown as { log: unknown }).log = { warn, error: warn, info: warn, debug: warn };
      done();
    });
    await instance.inject({ method: 'GET', url: '/ready' });
    expect(warn).toHaveBeenCalledTimes(1);
    const [context, message] = warn.mock.calls[0]!;
    // The discriminating half: *this service* is not the thing reporting
    // unavailable, and a line that said so would be read as the outage the
    // split exists to avoid declaring.
    expect(message).not.toContain('reporting unavailable');
    expect(message).toContain('still serving');
    expect((context as { degraded: string[] }).degraded).toEqual(['ai']);
    await instance.close();
  });
});
