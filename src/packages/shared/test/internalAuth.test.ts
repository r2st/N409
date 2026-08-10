import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INTERNAL_TOKEN_HEADER,
  internalToken,
  internalTokenMatches,
  isInternalPublicPath,
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
