import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { ValuationHub } from '../../src/realtime/hub.js';
import { createApiToken, revokeApiToken } from '../../src/repos/apiTokens.js';
import { invalidateValuation } from '../../src/repos/valuations.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import type pg from 'pg';

const dbUp = await isDbAvailable();

interface SseEvent {
  event: string;
  data: Record<string, any>;
}

/** Fetch-based SSE reader mirroring what the frontend hook does. */
async function openStream(base: string, valuationId: string, token: string) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/v1/valuations/${valuationId}/stream`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  const events: SseEvent[] = [];
  // Resolves when the server stops the stream — a client-side abort, or the
  // shutdown drain ending it from the hub.
  let markEnded: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    markEnded = resolve;
  });
  if (res.ok && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() ?? '';
          for (const block of blocks) {
            let event = 'message';
            const data: string[] = [];
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).trim());
            }
            if (data.length > 0) events.push({ event, data: JSON.parse(data.join('\n')) });
          }
        }
      } catch {
        // aborted
      } finally {
        markEnded();
      }
    })();
  } else {
    markEnded();
  }
  return { status: res.status, events, ended, close: () => controller.abort() };
}

async function until<T>(probe: () => T | undefined, what: string, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = probe();
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

describe.skipIf(!dbUp)('improvement 4 — realtime presence + comment stream (SSE)', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let base: string;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let otherClient: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);

    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      AUTO_PIPELINE: 'off',
    });
    app = buildApp({ config, pool });
    // SSE needs a real socket — app.inject buffers the whole response.
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    const seedCtx = { app, pool, teardown: async () => {} };
    ops = await seedUser(seedCtx, { roles: ['reviewer'] });
    client = await seedUser(seedCtx, { roles: ['valuation_user'] });
    otherClient = await seedUser(seedCtx, { roles: ['valuation_user'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'LiveCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  });

  it('streams presence joins/leaves and live comment events to co-viewers', async () => {
    const owner = await openStream(base, valuationId, client.token);
    expect(owner.status).toBe(200);
    const solo = await until(() => owner.events.find((e) => e.event === 'presence'), 'owner presence');
    expect(solo.data.viewers).toHaveLength(1);

    // Second viewer joins → both ends see two viewers.
    const reviewer = await openStream(base, valuationId, ops.token);
    const joined = await until(
      () => owner.events.find((e) => e.event === 'presence' && e.data.viewers.length === 2),
      'two-viewer presence on the owner stream',
    );
    const userIds = joined.data.viewers.map((v: { user_id: string }) => v.user_id).sort();
    expect(userIds).toEqual([client.id, ops.id].sort());
    await until(
      () => reviewer.events.find((e) => e.event === 'presence' && e.data.viewers.length === 2),
      'two-viewer presence on the reviewer stream',
    );

    // A new comment is pushed to every open stream without a refresh.
    const posted = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comments`,
      headers: authHeader(ops.token),
      payload: { kind: 'chat', body: 'Numbers are in — take a look.' },
    });
    expect(posted.statusCode).toBe(201);
    const commentId = posted.json().comment.id;
    for (const stream of [owner, reviewer]) {
      const ev = await until(() => stream.events.find((e) => e.event === 'comment'), 'comment event');
      expect(ev.data).toEqual({ comment_id: commentId, kind: 'chat' });
    }

    // Reviewer disconnects → the owner sees presence shrink back to one.
    reviewer.close();
    await until(() => {
      const last = owner.events.filter((e) => e.event === 'presence').at(-1);
      return last && last.data.viewers.length === 1 ? true : undefined;
    }, 'presence shrink after disconnect');
    owner.close();
  });

  it('rejects viewers who cannot read the valuation', async () => {
    const foreign = await openStream(base, valuationId, otherClient.token);
    expect(foreign.status).toBe(404);

    const unauthenticated = await fetch(`${base}/api/v1/valuations/${valuationId}/stream`);
    expect(unauthenticated.status).toBe(401);
  });

  it('refuses a stream past the per-user ceiling with 429, not a hijacked socket', async () => {
    // A second app on the same pool, with a hub capped at one stream per user.
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      AUTO_PIPELINE: 'off',
    });
    const capped = buildApp({ config, pool, hub: new ValuationHub({ maxPerUser: 1 }) });
    await capped.listen({ port: 0, host: '127.0.0.1' });
    const addr = capped.server.address();
    const cappedBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

    try {
      const first = await openStream(cappedBase, valuationId, client.token);
      expect(first.status).toBe(200);
      await until(() => first.events.find((e) => e.event === 'presence'), 'first presence');

      // The second is turned away as a problem document, with the headers a
      // 429 carries — not left hanging on an event-stream that never opened.
      const second = await fetch(`${cappedBase}/api/v1/valuations/${valuationId}/stream`, {
        headers: { authorization: `Bearer ${client.token}` },
      });
      expect(second.status).toBe(429);
      expect(second.headers.get('content-type')).toContain('application/problem+json');
      expect(second.headers.get('retry-after')).toBe('30');
      expect((await second.json()).detail).toMatch(/realtime streams/i);

      // Another user still gets in — the ceiling is per-user, not global.
      const other = await openStream(cappedBase, valuationId, ops.token);
      expect(other.status).toBe(200);
      other.close();

      // Closing the first frees the slot for a reconnect.
      first.close();
      await until(
        () => (capped.realtimeHub.stats().total === 0 ? true : undefined),
        'the hub to drain after both closes',
      );
      const reconnect = await openStream(cappedBase, valuationId, client.token);
      expect(reconnect.status).toBe(200);
      reconnect.close();
    } finally {
      await capped.close();
    }
  });

  it('one presence badge per user, however many tabs they have open', async () => {
    const tab1 = await openStream(base, valuationId, client.token);
    const tab2 = await openStream(base, valuationId, client.token);
    await until(() => tab2.events.find((e) => e.event === 'presence'), 'presence on the second tab');
    const last = tab2.events.filter((e) => e.event === 'presence').at(-1)!;
    expect(last.data.viewers).toHaveLength(1);
    expect(last.data.viewers[0].user_id).toBe(client.id);
    tab1.close();
    tab2.close();
  });

  /**
   * Shutdown, end to end. An SSE stream is a request in flight for as long as
   * its tab stays open, so to the drain it is indistinguishable from a slow
   * handler: without `closeAll` one open valuation page made every restart wait
   * out the whole drain deadline and then report abandoned requests that were
   * only heartbeats. And before the drain existed at all, `close()` destroyed
   * every socket outright — the stream ended either way, which is why this
   * asserts on the clock as well as on the stream.
   */
  it('ends open streams on close() rather than waiting out the drain deadline', async () => {
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      AUTO_PIPELINE: 'off',
    });
    const closing = buildApp({ config, pool });
    await closing.listen({ port: 0, host: '127.0.0.1' });
    const addr = closing.server.address();
    const closingBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

    const tab = await openStream(closingBase, valuationId, client.token);
    expect(tab.status).toBe(200);
    await until(() => tab.events.find((e) => e.event === 'presence'), 'presence before shutdown');
    expect(closing.realtimeHub.stats().total).toBe(1);

    const startedAt = Date.now();
    await closing.close();

    // The stream was ended by the server, not left for the client to notice.
    await tab.ended;
    expect(closing.realtimeHub.stats()).toEqual({ total: 0, rooms: 0, users: 0 });
    // Released rather than waited out: the drain deadline is five seconds.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

/**
 * Revocation. Every other route on this service re-reads the principal's roles,
 * partner and session epoch from the database per request, so a permission
 * taken away lands on the very next call. A stream was the exception: authorized
 * once at connect and then served for as long as a tab stayed open, with a
 * heartbeat holding it up. These run against an app whose re-check interval is
 * milliseconds rather than the deployed minute.
 */
describe.skipIf(!dbUp)('realtime streams re-check that they are still allowed to be open', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let base: string;
  let seedCtx: { app: FastifyInstance; pool: pg.Pool; teardown: () => Promise<void> };
  let reviewer: Awaited<ReturnType<typeof seedUser>>;

  /**
   * A fresh account per test. Two of these bump `session_epoch`, which is the
   * whole point of them and also what kills every other token this user holds —
   * sharing one owner across the block would have each test signing the next
   * one out.
   */
  const newOwner = () => seedUser(seedCtx, { roles: ['valuation_user'] });

  const newValuation = async (token: string): Promise<string> => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { kind: '409a', company_name: 'RevokeCo' },
    });
    expect(created.statusCode).toBe(201);
    return created.json().valuation.id as string;
  };

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      AUTO_PIPELINE: 'off',
    });
    app = buildApp({ config, pool, streamRevalidateMs: 50 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    seedCtx = { app, pool, teardown: async () => {} };
    reviewer = await seedUser(seedCtx, { roles: ['reviewer'] });
  });

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  });

  /**
   * "Sign out everywhere" and a password change bump `session_epoch`, which
   * kills every JWT minted before it. The REST calls from that tab start 401ing
   * at once; the stream beside them used to go on pushing for as long as the tab
   * lived, which is exactly what the button promised not to leave behind.
   */
  it('ends a stream whose session was signed out everywhere', async () => {
    const owner = await newOwner();
    const valuationId = await newValuation(owner.token);
    const tab = await openStream(base, valuationId, owner.token);
    expect(tab.status).toBe(200);
    await until(() => tab.events.find((e) => e.event === 'presence'), 'presence before the sign-out');

    // What POST /auth/logout-all does, and what a password change does with it.
    await pool.query('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1', [owner.id]);

    const revoked = await until(() => tab.events.find((e) => e.event === 'revoked'), 'the revoked frame');
    expect(revoked.data).toEqual({ reason: 'unauthorized' });
    // Told, then hung up on — and off the hub's books, so it is not still
    // holding a slot against the per-user ceiling.
    await tab.ended;
    await until(() => (app.realtimeHub.stats().total === 0 ? true : undefined), 'the hub to drain');
  });

  /**
   * Losing read access. The stream carried presence and comment pushes for an
   * engagement the reader could no longer open — and their name stayed in
   * everyone else's presence badges, so the screen stated that someone who had
   * been removed was reading along.
   */
  it('ends a stream when the reader loses access, and drops them from presence', async () => {
    const owner = await newOwner();
    const valuationId = await newValuation(owner.token);
    const ownerTab = await openStream(base, valuationId, owner.token);
    const reviewerTab = await openStream(base, valuationId, reviewer.token);
    expect(ownerTab.status).toBe(200);
    expect(reviewerTab.status).toBe(200);
    await until(
      () => reviewerTab.events.find((e) => e.event === 'presence' && e.data.viewers.length === 2),
      'both viewers present',
    );

    // The owner's scope is their own engagements; reassigning it is what an
    // ops handover does. Invalidated by hand because this writes the row behind
    // the repo: `findValuationById` reads through a 5s cache that every writer
    // in the service drops after its own statement, and a raw UPDATE here would
    // otherwise be testing the cache's TTL rather than the re-check.
    await pool.query('UPDATE valuations SET user_id = $1 WHERE id = $2', [reviewer.id, valuationId]);
    invalidateValuation(valuationId);

    const revoked = await until(
      () => ownerTab.events.find((e) => e.event === 'revoked'),
      'the revoked frame on the reassigned owner stream',
    );
    expect(revoked.data).toEqual({ reason: 'forbidden' });
    await ownerTab.ended;

    // The reviewer keeps their stream — they can still read it — and their
    // badge list no longer claims the removed reader is watching.
    const shrunk = await until(() => {
      const last = reviewerTab.events.filter((e) => e.event === 'presence').at(-1);
      return last && last.data.viewers.length === 1 ? last : undefined;
    }, 'presence to drop the revoked viewer');
    expect(shrunk.data.viewers[0].user_id).toBe(reviewer.id);
    expect(reviewerTab.events.some((e) => e.event === 'revoked')).toBe(false);
    reviewerTab.close();
  });

  /**
   * A closed account. `app.authenticate` refuses a soft-deleted user on every
   * request; the stream it already had was the one thing still being served to
   * them.
   */
  it('ends a stream held by an account that is deleted', async () => {
    const owner = await newOwner();
    const valuationId = await newValuation(owner.token);
    const tab = await openStream(base, valuationId, owner.token);
    await until(() => tab.events.find((e) => e.event === 'presence'), 'presence before the deletion');

    await pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [owner.id]);

    const revoked = await until(() => tab.events.find((e) => e.event === 'revoked'), 'the revoked frame');
    expect(revoked.data).toEqual({ reason: 'unauthorized' });
    await tab.ended;
  });

  /**
   * A token-authenticated stream answers to the token's own revocation and not
   * to the session epoch — the same split `plugins/auth.ts` draws, because
   * revoking browser sessions must not break a partner's running integration.
   */
  it('ends a stream held open by an API token when that token is revoked', async () => {
    const owner = await newOwner();
    const valuationId = await newValuation(owner.token);
    const { token, secret } = await createApiToken(pool, {
      partnerId: null,
      createdBy: owner.id,
      name: 'stream token',
    });
    const tab = await openStream(base, valuationId, secret);
    expect(tab.status).toBe(200);
    await until(() => tab.events.find((e) => e.event === 'presence'), 'presence on the token stream');

    // A session sign-out must not touch it.
    await pool.query('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1', [owner.id]);
    await sleep(200);
    expect(tab.events.some((e) => e.event === 'revoked')).toBe(false);

    await revokeApiToken(pool, token.id);
    const revoked = await until(() => tab.events.find((e) => e.event === 'revoked'), 'the revoked frame');
    expect(revoked.data).toEqual({ reason: 'unauthorized' });
    await tab.ended;
  });

  /**
   * The hazard the shared predicate exists to rule out. The client reconnects
   * three seconds after a close, so a re-check even slightly stricter than the
   * connect check is not a revocation — it is an endless connect/close loop
   * against a permission that never actually changed. Both paths call
   * `authorizeStream`, and this is what says so: many ticks, nothing revoked.
   */
  it('leaves a stream whose access never changed alone, tick after tick', async () => {
    const owner = await newOwner();
    const valuationId = await newValuation(owner.token);
    const tab = await openStream(base, valuationId, owner.token);
    expect(tab.status).toBe(200);
    await until(() => tab.events.find((e) => e.event === 'presence'), 'presence');

    // Twenty-odd re-checks at the 50ms interval this app was built with.
    await sleep(1100);
    expect(tab.events.some((e) => e.event === 'revoked')).toBe(false);
    // This room, not the process — other tests in this file hold streams of
    // their own, and what is being asserted is that this one survived.
    expect(app.realtimeHub.viewers(valuationId)).toHaveLength(1);

    // Still live: a comment posted after all those checks still arrives.
    const posted = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comments`,
      headers: authHeader(owner.token),
      payload: { kind: 'chat', body: 'still here' },
    });
    expect(posted.statusCode).toBe(201);
    await until(() => tab.events.find((e) => e.event === 'comment'), 'a comment on a long-held stream');
    tab.close();
  });
});
