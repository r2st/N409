import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INTERNAL_TOKEN_HEADER,
  internalToken,
  internalTokenMatches,
  isInternalPublicPath,
  isProductionEnv,
  MissingInternalTokenError,
  registerInternalAuth,
} from '../src/internalAuth.js';
import { registerHealth } from '../src/health.js';
import { registerProblemHandler } from '../src/problem.js';

/**
 * The property: an internal Node service behaves exactly like the Python ones
 * — off when `INTERNAL_SERVICE_TOKEN` is unset, required on everything but the
 * health probes once it is set.
 */
const SECRET = 'a'.repeat(64);

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A service shaped like the report service: health probes plus one work route. */
function buildStub(env: NodeJS.ProcessEnv): FastifyInstance {
  const instance = Fastify({ logger: false });
  registerProblemHandler(instance);
  registerInternalAuth(instance, { service: 'stub', env, log: { warn: () => {} } });
  registerHealth(instance, { service: 'stub' });
  instance.post('/render/v1/pdf', async () => ({ rendered: true }));
  return instance;
}

describe('internalToken', () => {
  it('is null when unset or empty, so the guard stays off', () => {
    expect(internalToken({})).toBeNull();
    expect(internalToken({ INTERNAL_SERVICE_TOKEN: '' })).toBeNull();
    expect(internalToken({ INTERNAL_SERVICE_TOKEN: SECRET })).toBe(SECRET);
  });
});

describe('internalTokenMatches', () => {
  it('accepts only the exact secret', () => {
    expect(internalTokenMatches(SECRET, SECRET)).toBe(true);
    expect(internalTokenMatches(`${SECRET}x`, SECRET)).toBe(false);
    expect(internalTokenMatches(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(internalTokenMatches(`b${SECRET.slice(1)}`, SECRET)).toBe(false);
  });

  it('returns false rather than throwing on an absent or mismatched-length header', () => {
    // timingSafeEqual throws on unequal lengths; the length check has to come
    // first or a short header is a 500 instead of a 401.
    expect(internalTokenMatches(undefined, SECRET)).toBe(false);
    expect(internalTokenMatches('', SECRET)).toBe(false);
    expect(internalTokenMatches('short', SECRET)).toBe(false);
  });
});

describe('isInternalPublicPath', () => {
  it('exempts the probes a supervisor calls, and nothing else', () => {
    expect(isInternalPublicPath('/')).toBe(true);
    expect(isInternalPublicPath('/health')).toBe(true);
    expect(isInternalPublicPath('/ready')).toBe(true);
    expect(isInternalPublicPath('/ready?verbose=1')).toBe(true);
    expect(isInternalPublicPath('/render/v1/pdf')).toBe(false);
    expect(isInternalPublicPath('/health/../render/v1/pdf')).toBe(false);
  });
});

describe('registerInternalAuth', () => {
  it('is a no-op when no secret is configured', async () => {
    app = buildStub({});
    const res = await app.inject({ method: 'POST', url: '/render/v1/pdf' });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a request with no token once a secret is configured', async () => {
    app = buildStub({ INTERNAL_SERVICE_TOKEN: SECRET });
    const res = await app.inject({ method: 'POST', url: '/render/v1/pdf' });
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toMatch(/internal service token/i);
  });

  it('refuses a wrong token', async () => {
    app = buildStub({ INTERNAL_SERVICE_TOKEN: SECRET });
    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      headers: { [INTERNAL_TOKEN_HEADER]: 'b'.repeat(64) },
    });
    expect(res.statusCode).toBe(401);
  });

  it('admits the right token', async () => {
    app = buildStub({ INTERNAL_SERVICE_TOKEN: SECRET });
    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      headers: { [INTERNAL_TOKEN_HEADER]: SECRET },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rendered: true });
  });

  it('leaves the health probes reachable without the secret', async () => {
    app = buildStub({ INTERNAL_SERVICE_TOKEN: SECRET });
    for (const url of ['/', '/health', '/ready']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it('rejects before the body is parsed, so an unauthenticated caller cannot make us buffer it', async () => {
    // onRequest, not preHandler: the render body cap is 8 MB and reading it is
    // most of what an unauthenticated caller would be trying to cost us.
    let parsedBody: unknown;
    app = Fastify({ logger: false });
    registerProblemHandler(app);
    registerInternalAuth(app, {
      service: 'stub',
      env: { INTERNAL_SERVICE_TOKEN: SECRET },
      log: { warn: () => {} },
    });
    app.addHook('preValidation', async (req) => {
      parsedBody = req.body;
    });
    app.post('/render/v1/pdf', async () => ({ rendered: true }));

    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      payload: { title: 'x'.repeat(1000) },
    });
    expect(res.statusCode).toBe(401);
    expect(parsedBody).toBeUndefined();
  });

  it('honours a secret rotated after start-up, without a restart', async () => {
    const env: NodeJS.ProcessEnv = { INTERNAL_SERVICE_TOKEN: SECRET };
    app = buildStub(env);
    const rotated = 'c'.repeat(64);
    env.INTERNAL_SERVICE_TOKEN = rotated;

    const stale = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      headers: { [INTERNAL_TOKEN_HEADER]: SECRET },
    });
    expect(stale.statusCode).toBe(401);

    const fresh = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      headers: { [INTERNAL_TOKEN_HEADER]: rotated },
    });
    expect(fresh.statusCode).toBe(200);
  });

  it('warns at start-up when no secret is configured', async () => {
    const warnings: string[] = [];
    app = Fastify({ logger: false });
    registerInternalAuth(app, { service: 'stub', env: {}, log: { warn: (_o, m) => warnings.push(m) } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/INTERNAL_SERVICE_TOKEN is not set/);
  });

  it('refuses a duplicated token header rather than finding the good value in it', async () => {
    // Header smuggling shape: send a junk value and the real secret, and hope
    // the reader searches for one that works. Node joins repeated headers into
    // a single comma-separated string before Fastify ever sees them, so what
    // arrives is `"wrong,<secret>"` — one value, containing the secret and not
    // equal to it. The constant-time compare is whole-string, so it fails on
    // length and never gets as far as looking inside.
    app = buildStub({ INTERNAL_SERVICE_TOKEN: SECRET });
    for (const headers of [
      { [INTERNAL_TOKEN_HEADER]: ['wrong', SECRET] },
      { [INTERNAL_TOKEN_HEADER]: [SECRET, 'wrong'] },
      { [INTERNAL_TOKEN_HEADER]: [SECRET, SECRET] },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/render/v1/pdf', headers });
      expect(res.statusCode, JSON.stringify(headers)).toBe(401);
    }
  });

  describe('with no options passed', () => {
    // The whole point of the defaults is that a service can call
    // `registerInternalAuth(app)` and be guarded; nothing exercised that path,
    // so a broken `process.env` fallback would have looked exactly like a
    // service that had simply not been configured yet.
    const saved = process.env.INTERNAL_SERVICE_TOKEN;
    afterEach(() => {
      if (saved === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
      else process.env.INTERNAL_SERVICE_TOKEN = saved;
    });

    it('reads the secret from process.env and enforces it', async () => {
      process.env.INTERNAL_SERVICE_TOKEN = SECRET;
      app = Fastify({ logger: false });
      registerProblemHandler(app);
      registerInternalAuth(app);
      app.post('/render/v1/pdf', async () => ({ rendered: true }));

      const denied = await app.inject({ method: 'POST', url: '/render/v1/pdf' });
      expect(denied.statusCode).toBe(401);
      const allowed = await app.inject({
        method: 'POST',
        url: '/render/v1/pdf',
        headers: { [INTERNAL_TOKEN_HEADER]: SECRET },
      });
      expect(allowed.statusCode).toBe(200);
    });

    it('warns through the app logger when process.env has no secret', async () => {
      delete process.env.INTERNAL_SERVICE_TOKEN;
      const warnings: string[] = [];
      app = Fastify({ logger: false });
      // The fallback is `app.log`, which is what a service that passes no
      // logger actually gets.
      app.log.warn = ((_obj: unknown, msg: string) => warnings.push(msg)) as typeof app.log.warn;
      registerInternalAuth(app);
      expect(warnings[0]).toMatch(/INTERNAL_SERVICE_TOKEN is not set/);
    });
  });
});

/**
 * Fail-closed in production (R25 security audit).
 *
 * Warn-only was the whole gap: a deploy that forgot the secret logged one line
 * and then served every non-health route unauthenticated, and that line reads
 * exactly like the one a developer laptop prints, where it is correct. Under
 * `NODE_ENV=production` the same situation has to stop the service instead —
 * a unit that will not start gets noticed, an open one does not.
 */
describe('registerInternalAuth in production', () => {
  const PROD = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;

  it('refuses to register with no secret configured', () => {
    const instance = Fastify({ logger: false });
    expect(() => registerInternalAuth(instance, { service: 'report', env: { ...PROD } })).toThrow(
      MissingInternalTokenError,
    );
    expect(() => registerInternalAuth(instance, { service: 'report', env: { ...PROD } })).toThrow(
      /INTERNAL_SERVICE_TOKEN is required.*refusing to start report/s,
    );
  });

  it('names the service that refused, so a five-unit estate says which one', () => {
    const instance = Fastify({ logger: false });
    try {
      registerInternalAuth(instance, { service: 'report', env: { ...PROD } });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingInternalTokenError);
      expect((err as MissingInternalTokenError).service).toBe('report');
    }
  });

  it('registers normally when the secret is configured', async () => {
    app = buildStub({ ...PROD, INTERNAL_SERVICE_TOKEN: SECRET });
    const denied = await app.inject({ method: 'POST', url: '/render/v1/pdf' });
    expect(denied.statusCode).toBe(401);
    const allowed = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      headers: { [INTERNAL_TOKEN_HEADER]: SECRET },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('closes the gate when a rotation removes the secret after start-up', async () => {
    // The secret is deliberately re-read per request so it can rotate without a
    // restart. That means the start-up check is not the only thing holding the
    // door: rotating to nothing must 401, not fall through to the handler.
    const env: NodeJS.ProcessEnv = { ...PROD, INTERNAL_SERVICE_TOKEN: SECRET };
    app = buildStub(env);
    delete env.INTERNAL_SERVICE_TOKEN;

    const res = await app.inject({
      method: 'POST',
      url: '/render/v1/pdf',
      headers: { [INTERNAL_TOKEN_HEADER]: SECRET },
    });
    expect(res.statusCode).toBe(401);
  });

  it('keeps the probes open when a rotation removes the secret', async () => {
    // A supervisor has to be able to see that the service is up and misconfigured.
    const env: NodeJS.ProcessEnv = { ...PROD, INTERNAL_SERVICE_TOKEN: SECRET };
    app = buildStub(env);
    delete env.INTERNAL_SERVICE_TOKEN;

    for (const url of ['/', '/health', '/ready']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it('leaves every non-production environment warn-only', () => {
    for (const NODE_ENV of ['development', 'test', 'staging', undefined]) {
      const instance = Fastify({ logger: false });
      expect(() =>
        registerInternalAuth(instance, { service: 'stub', env: { NODE_ENV }, log: { warn: () => {} } }),
      ).not.toThrow();
    }
  });
});

/**
 * The one caller of `gatedElsewhere` is `/metrics`, which carries its own
 * `METRICS_TOKEN` gate. Without the exemption the two would stack on the report
 * service and nowhere else, so a scraper holding only the metrics secret would
 * collect from two of the three Fastify services and silently fail on the third.
 */
describe('registerInternalAuth gatedElsewhere', () => {
  const build = (gatedElsewhere?: readonly string[]) => {
    const app = Fastify({ logger: false });
    registerInternalAuth(app, {
      service: 'stub',
      env: { INTERNAL_SERVICE_TOKEN: 'estate-secret' },
      log: { warn: () => {} },
      gatedElsewhere,
    });
    app.get('/metrics', async () => 'metrics');
    app.get('/render', async () => 'render');
    return app;
  };

  it('lets an exempt path past without the internal token', async () => {
    const app = build(['/metrics']);
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
    // Query strings do not smuggle a path past the comparison, or around it.
    expect((await app.inject({ method: 'GET', url: '/metrics?x=1' })).statusCode).toBe(200);
    await app.close();
  });

  it('still guards every path not named', async () => {
    const app = build(['/metrics']);
    expect((await app.inject({ method: 'GET', url: '/render' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/render',
          headers: { 'x-internal-token': 'estate-secret' },
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
  });

  it('guards everything when nothing is exempted', async () => {
    const app = build();
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    await app.close();
  });

  // R378: `gatedElsewhere` did not normalise trailing slashes, while
  // `isInternalPublicPath` (the check two lines above it) did. Now both strip
  // trailing slashes, so `/metrics/` passes the auth hook instead of being
  // rejected with 401. The route itself may 404 (Fastify's router is strict
  // about trailing slashes), but the point is the auth hook no longer blocks it.
  it('normalises trailing slashes on exempt paths', async () => {
    const app = build(['/metrics']);
    // Without the fix these would be 401 — the gatedElsewhere check saw
    // "/metrics/" and didn't match the set entry "/metrics".
    const single = await app.inject({ method: 'GET', url: '/metrics/' });
    expect(single.statusCode).not.toBe(401);
    const multi = await app.inject({ method: 'GET', url: '/metrics///' });
    expect(multi.statusCode).not.toBe(401);
    await app.close();
  });

  // An exemption is by exact path, so a prefix cannot open the routes under it.
  it('does not exempt a path that merely starts with an exempt one', async () => {
    const app = Fastify({ logger: false });
    registerInternalAuth(app, {
      service: 'stub',
      env: { INTERNAL_SERVICE_TOKEN: 'estate-secret' },
      log: { warn: () => {} },
      gatedElsewhere: ['/metrics'],
    });
    app.get('/metrics/secrets', async () => 'nope');
    expect((await app.inject({ method: 'GET', url: '/metrics/secrets' })).statusCode).toBe(401);
    await app.close();
  });
});

describe('isProductionEnv', () => {
  it('matches only the exact word the unit files set', () => {
    expect(isProductionEnv({ NODE_ENV: 'production' })).toBe(true);
    // `prod` is deliberately not production: guessing at near-misses would make
    // a laptop with NODE_ENV=prod refuse to start, trading one confusing
    // failure for another. infra/systemd/* all set `production`.
    expect(isProductionEnv({ NODE_ENV: 'prod' })).toBe(false);
    expect(isProductionEnv({ NODE_ENV: 'Production' })).toBe(false);
    expect(isProductionEnv({ NODE_ENV: 'development' })).toBe(false);
    expect(isProductionEnv({})).toBe(false);
  });
});
