import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { conditionalJson, etagFor, matchesIfNoneMatch, registerNoStoreDefault } from '../src/httpCache.js';

/**
 * Conditional GET support. `TtlCache` keeps repeated reads off Postgres; this
 * keeps the identical bytes off the wire once the client already holds them.
 */

describe('etagFor', () => {
  it('is stable across calls for the same payload', () => {
    const payload = { articles: [{ id: 'a', title: 'Hello' }] };
    expect(etagFor(payload)).toBe(etagFor({ articles: [{ id: 'a', title: 'Hello' }] }));
  });

  it('changes when any part of the payload changes', () => {
    expect(etagFor({ n: 1 })).not.toBe(etagFor({ n: 2 }));
    expect(etagFor({ posts: [] })).not.toBe(etagFor({ posts: [{ id: 'x' }] }));
  });

  it('is a quoted opaque token, as the header grammar requires', () => {
    expect(etagFor({ a: 1 })).toMatch(/^"[A-Za-z0-9_-]+"$/);
  });

  it('does not throw on payloads JSON.stringify returns undefined for', () => {
    expect(() => etagFor(undefined)).not.toThrow();
    expect(etagFor(undefined)).toBe(etagFor(undefined));
  });
});

describe('matchesIfNoneMatch', () => {
  const etag = etagFor({ a: 1 });

  it('is false when the client sent no validator', () => {
    expect(matchesIfNoneMatch(undefined, etag)).toBe(false);
    expect(matchesIfNoneMatch('', etag)).toBe(false);
  });

  it('matches an identical tag', () => {
    expect(matchesIfNoneMatch(etag, etag)).toBe(true);
  });

  it('does not match a different tag', () => {
    expect(matchesIfNoneMatch(etagFor({ a: 2 }), etag)).toBe(false);
  });

  it('finds the tag inside a comma-separated list', () => {
    expect(matchesIfNoneMatch(`"other", ${etag} , "third"`, etag)).toBe(true);
  });

  it('compares weakly, so a W/ prefix on either side still matches', () => {
    expect(matchesIfNoneMatch(`W/${etag}`, etag)).toBe(true);
    expect(matchesIfNoneMatch(etag, `W/${etag}`)).toBe(true);
  });

  it('treats * as matching any representation', () => {
    expect(matchesIfNoneMatch('*', etag)).toBe(true);
  });
});

describe('conditionalJson', () => {
  /** A server whose single route answers conditionally with a fixed payload. */
  const serve = async (payload: unknown, cacheControl?: string) => {
    const app = Fastify();
    app.get('/thing', async (req, reply) =>
      conditionalJson(req, reply, payload, cacheControl ? { cacheControl } : {}),
    );
    await app.ready();
    return app;
  };

  it('sends the body with an ETag and a revalidating Cache-Control', async () => {
    const app = await serve({ hello: 'world' });
    const res = await app.inject({ method: 'GET', url: '/thing' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hello: 'world' });
    expect(res.headers.etag).toBe(etagFor({ hello: 'world' }));
    expect(res.headers['cache-control']).toBe('private, no-cache');
    await app.close();
  });

  it('honours an explicit Cache-Control for shared-cacheable responses', async () => {
    const app = await serve({ hello: 'world' }, 'public, no-cache');
    const res = await app.inject({ method: 'GET', url: '/thing' });
    expect(res.headers['cache-control']).toBe('public, no-cache');
    await app.close();
  });

  it('answers a matching If-None-Match with a bodyless 304', async () => {
    const app = await serve({ hello: 'world' });
    const first = await app.inject({ method: 'GET', url: '/thing' });
    const etag = first.headers.etag as string;

    const second = await app.inject({
      method: 'GET',
      url: '/thing',
      headers: { 'if-none-match': etag },
    });

    expect(second.statusCode).toBe(304);
    // A 304 carrying a body is a protocol violation, and some proxies cache
    // the result — so assert the absence, not just the status code.
    expect(second.body).toBe('');
    // The validator has to come back, or the client cannot revalidate again.
    expect(second.headers.etag).toBe(etag);
    await app.close();
  });

  it('sends the full body again when the payload has changed under the client', async () => {
    const app = await serve({ hello: 'world' });
    const stale = etagFor({ hello: 'previous' });

    const res = await app.inject({
      method: 'GET',
      url: '/thing',
      headers: { 'if-none-match': stale },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hello: 'world' });
    await app.close();
  });
});

/**
 * The default that makes the absence of a directive impossible.
 *
 * An API that sends no `Cache-Control` has not said "do not cache" — it has
 * said nothing, and both parties downstream fill that silence with a default of
 * their own. The browser writes an `inline` PDF to disk; Cloudflare decides
 * partly from the file extension, and `.pdf`, `.csv` and `.xlsx` are all on its
 * list. This closes the silence without taking away a route's ability to ask
 * for something else.
 */
describe('registerNoStoreDefault', () => {
  const appWith = async (route: (app: ReturnType<typeof Fastify>) => void) => {
    const app = Fastify();
    registerNoStoreDefault(app);
    route(app);
    await app.ready();
    return app;
  };

  it('marks a response that said nothing', async () => {
    const app = await appWith((a) => a.get('/x', async () => ({ ok: true })));
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('leaves a response that asked for something else alone', async () => {
    const app = await appWith((a) =>
      a.get('/x', async (_req, reply) => {
        void reply.header('cache-control', 'public, max-age=3600');
        return { ok: true };
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    await app.close();
  });

  it('marks a failure too', async () => {
    // A 404 is as storable as a 200 to anything in the path, and "no such
    // engagement" outlives the moment it was true.
    const app = await appWith((a) =>
      a.get('/x', async () => {
        throw Object.assign(new Error('nope'), { statusCode: 404 });
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('does not overwrite a directive set from a hook registered later', async () => {
    // Hook order is the trap: `onSend` hooks run in registration order, so a
    // route or plugin registered after this one still gets the last word only
    // if the default checks rather than assigns.
    const app = Fastify();
    registerNoStoreDefault(app);
    app.addHook('onSend', async (_req, reply) => {
      void reply.header('cache-control', 'private, no-cache');
    });
    app.get('/x', async () => ({ ok: true }));
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.headers['cache-control']).toBe('private, no-cache');
    await app.close();
  });
});
