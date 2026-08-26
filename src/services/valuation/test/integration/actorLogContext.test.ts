/**
 * Every line a request writes says which user it was for.
 *
 * `requestErrorContext` has labelled the *unhandled error* line with an actor
 * since the B-1 audit, on the reasoning that "is this one customer or everyone"
 * is the first question asked of a spike in 500s. The forty-odd
 * `log.warn({ err }, …)` sites in the routes report failures that never become
 * a 500 — a webhook that would not sign, an upload that would not scan, a sync
 * that came back empty — and for those the question had no answer anywhere:
 * the id was on the request and on nothing the request wrote.
 *
 * This drives the real `authenticate` preHandler rather than calling
 * `bindActor` directly, because the claim being tested is about the wiring. A
 * unit test of the mixin passes whether or not anything in the service ever
 * binds an actor, which is the state this file was written to leave behind.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createApiToken } from '../../src/repos/apiTokens.js';
import {
  isDbAvailable,
  seedPartner,
  seedUser,
  setupTestDb,
  stubReadinessFetch,
  type TestApp,
  type TestDb,
} from './helpers.js';

const dbUp = await isDbAvailable();

/** Log lines the app wrote, parsed. */
function captureLines(app: FastifyInstance): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  (app.log as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      cb();
    },
  });
  return lines;
}

describe.skipIf(!dbUp)('the actor on a log line', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ctx: TestApp;
  let lines: Array<Record<string, unknown>>;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'actor-log-test-secret-0123456789abcdef',
      // The point of the suite: `setupTestApp` sets 'silent', which would make
      // every assertion below pass against an empty array.
      LOG_LEVEL: 'warn',
    });
    app = buildApp({ config, pool, readinessFetch: stubReadinessFetch() });

    // A route that logs the way the forty-odd real sites do, registered before
    // `ready()` because Fastify will not take a route after it. It sits behind
    // the same `authenticate` preHandler every other authenticated route uses,
    // which is the thing under test.
    app.get('/api/v1/__actor_probe', { preHandler: app.authenticate }, async (req) => {
      req.log.warn({ err: new Error('a webhook would not sign') }, 'probe');
      // Work that outlives the response: the deliberately-unawaited diagnostic
      // writes this service makes are the lines an incident is reconstructed
      // from, and they are written after the handler has returned.
      setTimeout(() => app.log.warn('after the response'), 1);
      return { ok: true };
    });
    await app.ready();
    ctx = { app, pool, teardown: async () => {} };
    lines = captureLines(app);
  });

  afterAll(async () => {
    await app.close();
    await db.teardown();
  });

  const probe = (token: string) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/__actor_probe',
      headers: { authorization: `Bearer ${token}` },
    });

  const probeLines = () => lines.filter((l) => l.msg === 'probe');

  it('names the user on a warn that never becomes a 500', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    lines.length = 0;
    const res = await probe(user.token);
    expect(res.statusCode).toBe(200);

    const [line] = probeLines();
    expect(line, 'the probe line was not captured — LOG_LEVEL is wrong').toBeDefined();
    expect(line!.userId).toBe(user.id);
    // Still correlated: the actor rides the same context the request id does.
    expect(line!.requestId).toBe(line!.reqId);
  });

  it('reaches a line written after the response has gone out', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    lines.length = 0;
    await probe(user.token);
    await new Promise((r) => setTimeout(r, 25));

    const late = lines.find((l) => l.msg === 'after the response');
    expect(late, 'the deferred line was not captured').toBeDefined();
    expect(late!.userId).toBe(user.id);
  });

  it('carries the tenant when the user belongs to one', async () => {
    const partnerId = await seedPartner(ctx, `Actor Log ${Date.now()}`);
    const user = await seedUser(ctx, { roles: ['valuation_user'], partnerId });
    lines.length = 0;
    await probe(user.token);

    const [line] = probeLines();
    expect(line!.partnerId).toBe(partnerId);
    // A session is not an integration; the absence of this key is what says so.
    expect(line).not.toHaveProperty('apiTokenId');
  });

  it('separates an integration from the human whose token it is', async () => {
    // The distinction `requestErrorContext` has claimed to draw since the B-1
    // audit and never once recorded: it read `apiToken.id` while the only
    // assignment writes `tokenId`, so the field was undefined on every request
    // that had a token and pino dropped the key.
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await createApiToken(pool, {
      partnerId: null,
      createdBy: user.id,
      name: 'actor-log',
    });
    lines.length = 0;
    const res = await probe(created.secret);
    expect(res.statusCode).toBe(200);

    const [line] = probeLines();
    expect(line!.userId).toBe(user.id);
    expect(line!.apiTokenId).toBe(created.token.id);
  });

  it('writes no actor for a request nobody authenticated', async () => {
    // The 401s and the rate-limit refusals happen before the preHandler
    // resolves anybody. "No userId" has to keep meaning "nobody was signed in".
    lines.length = 0;
    const res = await app.inject({ method: 'GET', url: '/api/v1/__actor_probe' });
    expect(res.statusCode).toBe(401);
    expect(lines.every((l) => !('userId' in l))).toBe(true);
  });

  it('does not leak one request actor into the next', async () => {
    const first = await seedUser(ctx, { roles: ['valuation_user'] });
    const second = await seedUser(ctx, { roles: ['valuation_user'] });

    lines.length = 0;
    await probe(first.token);
    await probe(second.token);

    const probes = probeLines();
    expect(probes).toHaveLength(2);
    expect(probes[0]!.userId).toBe(first.id);
    expect(probes[1]!.userId).toBe(second.id);
  });
});
