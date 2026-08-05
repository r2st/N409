import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { ValuationHub } from '../../src/realtime/hub.js';
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
      }
    })();
  }
  return { status: res.status, events, close: () => controller.abort() };
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
});
