import { setTimeout as sleep } from 'node:timers/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DRAIN_TIMEOUT_MS, InFlightRequests, registerRequestDrain } from '../src/drain.js';

describe('InFlightRequests', () => {
  it('resolves immediately when nothing is in flight', async () => {
    const tracker = new InFlightRequests();
    const result = await tracker.drain({ timeoutMs: 50 });
    expect(result).toEqual({ drained: true, remaining: 0, waitedMs: 0 });
  });

  it('waits for the last request to finish, then resolves', async () => {
    const tracker = new InFlightRequests();
    const first = tracker.enter();
    const second = tracker.enter();
    expect(tracker.inFlight).toBe(2);

    const drained = tracker.drain({ timeoutMs: 2_000 });
    first();
    // One outstanding request still holds it.
    expect(tracker.inFlight).toBe(1);
    second();

    await expect(drained).resolves.toMatchObject({ drained: true, remaining: 0 });
    expect(tracker.inFlight).toBe(0);
  });

  it('gives up at the deadline and reports what is still outstanding', async () => {
    const tracker = new InFlightRequests();
    tracker.enter();
    tracker.enter();
    const result = await tracker.drain({ timeoutMs: 20 });
    expect(result.drained).toBe(false);
    expect(result.remaining).toBe(2);
  });

  /**
   * The completion callback is wired to a response `close` event, and a caller
   * that ends a hijacked response itself will also see that event. Counting the
   * departure twice would take the count below zero, so it could never return
   * to zero again and every later drain would sit out its whole deadline.
   */
  it('counts one departure however many times its callback is called', async () => {
    const tracker = new InFlightRequests();
    const leave = tracker.enter();
    const other = tracker.enter();
    leave();
    leave();
    leave();
    expect(tracker.inFlight).toBe(1);
    other();
    expect(tracker.inFlight).toBe(0);
    await expect(tracker.drain({ timeoutMs: 20 })).resolves.toMatchObject({ drained: true });
  });

  it('does not leave a waiter behind after a timed-out drain', async () => {
    const tracker = new InFlightRequests();
    const leave = tracker.enter();
    await expect(tracker.drain({ timeoutMs: 20 })).resolves.toMatchObject({ drained: false });
    // The abandoned wait must not still be holding a resolver that a later
    // departure would try to wake.
    leave();
    await expect(tracker.drain({ timeoutMs: 20 })).resolves.toMatchObject({ drained: true, remaining: 0 });
  });
});

describe('registerRequestDrain — served requests survive close()', () => {
  const apps: FastifyInstance[] = [];
  const build = (opts: Parameters<typeof registerRequestDrain>[1] = {}) => {
    const app = Fastify();
    apps.push(app);
    return { app, tracker: registerRequestDrain(app, opts) };
  };

  afterEach(async () => {
    for (const app of apps.splice(0)) {
      try {
        app.server.closeAllConnections();
        await app.close();
      } catch {
        /* already closed by the test */
      }
    }
  });

  /**
   * The regression this module exists for. Fastify 5 resolves
   * `forceCloseConnections` to `'idle'` by default, and then spends it through
   * the `closeAllConnections()` branch because the `'idle'` branch is gated on
   * a `serverFactory` these services do not pass — so a request being served
   * when `close()` lands had its socket destroyed under it. The client saw a
   * connection reset with no status code, which nothing retries and no error
   * rate records.
   */
  it('completes a request that was in flight when close() was called', async () => {
    const { app } = build();
    app.get('/slow', async () => {
      await sleep(300);
      return { ok: true };
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };

    const inFlight = fetch(`http://127.0.0.1:${port}/slow`);
    // Let the request reach the handler before shutting down.
    await sleep(50);
    await app.close();

    const res = await inFlight;
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('still closes promptly when nothing is in flight', async () => {
    const { app } = build();
    app.get('/quick', async () => ({ ok: true }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };
    await (await fetch(`http://127.0.0.1:${port}/quick`)).json();

    const startedAt = Date.now();
    await app.close();
    // An idle keep-alive socket is left for the force-close, so this must not
    // approach the drain deadline.
    expect(Date.now() - startedAt).toBeLessThan(DEFAULT_DRAIN_TIMEOUT_MS / 2);
  });

  it('gives up on a request that outlasts the deadline rather than hanging', async () => {
    const warns: Record<string, unknown>[] = [];
    const { app } = build({
      timeoutMs: 100,
      log: { info: () => {}, warn: (obj) => warns.push(obj) },
    });
    app.get('/wedged', async () => {
      await sleep(5_000);
      return { ok: true };
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };

    const wedged = fetch(`http://127.0.0.1:${port}/wedged`).catch(() => 'dropped');
    await sleep(50);
    const startedAt = Date.now();
    await app.close();

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(warns).toContainEqual(expect.objectContaining({ remaining: 1, timeoutMs: 100 }));
    await expect(wedged).resolves.toBe('dropped');
  });

  /**
   * A hijacked reply never runs the `onResponse` hook, so a tracker built on
   * that hook would count every stream ever opened and discount none — and the
   * drain would then time out on a service with no work left to do. The
   * departure is taken from the raw response's `close` instead, which fires for
   * a hijacked reply too.
   */
  it('discounts a hijacked (SSE) reply when its stream ends', async () => {
    const { app, tracker } = build({ timeoutMs: 100 });
    let end: (() => void) | undefined;
    app.get('/stream', async (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.raw.write(': connected\n\n');
      end = () => reply.raw.end();
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };

    const res = await fetch(`http://127.0.0.1:${port}/stream`);
    await res.body!.getReader().read();
    expect(tracker.inFlight).toBe(1);

    end!();
    for (let i = 0; tracker.inFlight > 0 && i < 100; i++) await sleep(10);
    expect(tracker.inFlight).toBe(0);
  });

  it('runs onDrainStart before waiting, so long-lived streams can be released', async () => {
    const order: string[] = [];
    let end: (() => void) | undefined;
    const { app } = build({
      timeoutMs: 2_000,
      onDrainStart: () => {
        order.push('release');
        end?.();
      },
    });
    app.get('/stream', async (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.raw.write(': connected\n\n');
      end = () => {
        order.push('ended');
        reply.raw.end();
      };
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/stream`);
    await res.body!.getReader().read();

    const startedAt = Date.now();
    await app.close();
    // Released rather than waited out: the drain deadline is 2s.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(order).toEqual(['release', 'ended']);
  });

  it('drains anyway when onDrainStart throws', async () => {
    const warns: Record<string, unknown>[] = [];
    const { app } = build({
      timeoutMs: 100,
      log: { info: () => {}, warn: (obj) => warns.push(obj) },
      onDrainStart: () => {
        throw new Error('hub blew up');
      },
    });
    app.get('/quick', async () => ({ ok: true }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    await expect(app.close()).resolves.toBeUndefined();
    expect(warns.some((w) => w.err instanceof Error)).toBe(true);
  });
});
