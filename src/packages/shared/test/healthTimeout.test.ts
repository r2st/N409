import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  CHECK_FAILED,
  CHECK_OK,
  CHECK_TIMEOUT_MS,
  checkTimedOut,
  registerHealth,
  withTimeout,
} from '../src/health.js';
import { INTERNAL_TOKEN_ENV, INTERNAL_TOKEN_HEADER } from '../src/internalAuth.js';

/**
 * A dependency check that never answers.
 *
 * `/ready` fanned out to every check and awaited each one with no bound of its
 * own. Every check registered today carries some bound, so the endpoint was
 * slow rather than infinite — but the bounds are larger than the endpoint's
 * shape suggests and none of them is the endpoint's own. `probeReady` stops at
 * 3s; the Postgres check is `pool.query('SELECT 1')`, which can spend
 * `connectionTimeoutMillis` (10s) waiting for a connection and then
 * `statement_timeout` (15s) running the query. Twenty-five seconds of a
 * liveness-adjacent endpoint returning nothing.
 *
 * Nothing enforced even that. The bound lived in each check rather than in the
 * fan-out, so the next dependency added — a Redis client with no timeout
 * configured, an external API called with bare `fetch`, which has none by
 * default — would have widened `/ready` to its own worst case without anything
 * in this file noticing.
 *
 * ## Why hanging is worse than failing
 *
 * These are not the same outcome arriving at different speeds. A 503 takes the
 * instance out of rotation immediately, which is the entire purpose of the
 * endpoint. A hung socket leaves that decision to the prober's own timeout, and
 * until it fires the load balancer keeps sending real traffic to a process that
 * would have said it could not serve it. The coalescing cache — one shared
 * in-flight run, so probes join rather than duplicate — turns one stuck check
 * into every concurrent prober hanging at once.
 *
 * So the property under test is not "checks are fast". It is that the endpoint
 * answers within a bound it owns, whatever the dependency does.
 */

const TOKEN = 'internal-secret-token';

/** Never settles. The dependency that is down but still holding the socket. */
const hangs = () => new Promise<void>(() => {});

function appWith(
  checks: Record<string, () => Promise<void>>,
  opts: { checkTimeoutMs?: number; checkTimeoutsMs?: Record<string, number> } = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  registerHealth(app, {
    service: 'test-svc',
    checks,
    // Coalescing off: these tests are about one run's bound, and a cached
    // result from a previous test's run would answer for it.
    readyCacheMs: 0,
    ...opts,
  });
  return app;
}

let savedToken: string | undefined;

beforeEach(() => {
  savedToken = process.env[INTERNAL_TOKEN_ENV];
});

afterEach(() => {
  if (savedToken === undefined) delete process.env[INTERNAL_TOKEN_ENV];
  else process.env[INTERNAL_TOKEN_ENV] = savedToken;
  vi.useRealTimers();
});

describe('a check that never answers', () => {
  it('is reported unavailable rather than left hanging', async () => {
    const app = appWith({ postgres: hangs }, { checkTimeoutMs: 20 });
    const res = await app.inject({ method: 'GET', url: '/ready' });

    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('unavailable');
    expect(res.json().checks).toEqual({ postgres: CHECK_FAILED });
  });

  it('does not take the healthy checks down with it, or wait for it', async () => {
    // The fan-out is concurrent, so a 20ms deadline on one hung check must not
    // become a 20ms floor on the others — and the answer must still name which
    // dependency is the broken one.
    process.env[INTERNAL_TOKEN_ENV] = TOKEN;
    const app = appWith({ postgres: hangs, ai: async () => {} }, { checkTimeoutMs: 20 });
    const res = await app.inject({
      method: 'GET',
      url: '/ready',
      headers: { [INTERNAL_TOKEN_HEADER]: TOKEN },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual({ postgres: checkTimedOut(20), ai: CHECK_OK });
  });

  it('says it timed out, to an operator and not to the internet', async () => {
    // Same rule the rest of `/ready` follows: the reason is the operator's and
    // the public body carries pass/fail only. A timeout is not sensitive on its
    // own, but "which dependency, and how long we wait for it" is topology.
    process.env[INTERNAL_TOKEN_ENV] = TOKEN;
    const app = appWith({ postgres: hangs }, { checkTimeoutMs: 20 });

    const operator = await app.inject({
      method: 'GET',
      url: '/ready',
      headers: { [INTERNAL_TOKEN_HEADER]: TOKEN },
    });
    expect(operator.json().checks.postgres).toBe('timed out after 20ms');

    const stranger = await app.inject({ method: 'GET', url: '/ready' });
    expect(stranger.json().checks).toEqual({ postgres: CHECK_FAILED });
    expect(stranger.payload).not.toContain('timed out');
    expect(stranger.payload).not.toContain('20ms');
  });

  it('answers within its own bound, not the dependency’s', async () => {
    // The claim that matters, measured rather than asserted structurally. A
    // generous ceiling — the point is that it is finite and near the deadline,
    // not that the box is fast.
    const app = appWith({ postgres: hangs }, { checkTimeoutMs: 30 });
    const startedAt = Date.now();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    const elapsed = Date.now() - startedAt;

    expect(res.statusCode).toBe(503);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('the deadline is configurable', () => {
  it('defaults to 5s — under the deploy wait loop and over every real check', async () => {
    // Pinned as a number because the value is a contract with things outside
    // this repository: the deploy wait loop and whatever fronts the estate.
    expect(CHECK_TIMEOUT_MS).toBe(5000);
  });

  it('takes a per-check override for the one dependency that is slower', async () => {
    process.env[INTERNAL_TOKEN_ENV] = TOKEN;
    // `slow` is given room; `fast` keeps the strict default, so one generous
    // dependency does not relax the bound on all the others.
    const app = appWith(
      { slow: () => new Promise((r) => setTimeout(r, 40)), fast: hangs },
      { checkTimeoutMs: 15, checkTimeoutsMs: { slow: 400 } },
    );
    const res = await app.inject({
      method: 'GET',
      url: '/ready',
      headers: { [INTERNAL_TOKEN_HEADER]: TOKEN },
    });

    expect(res.json().checks).toEqual({ slow: CHECK_OK, fast: checkTimedOut(15) });
  });

  it('can be switched off, which is the only thing a fake clock allows', async () => {
    // A test that drives timers itself cannot also be racing a real one.
    const app = appWith({ ok: async () => {} }, { checkTimeoutMs: 0 });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
  });
});

describe('withTimeout', () => {
  it('returns the value when the work wins', async () => {
    await expect(
      withTimeout(
        async () => 'done',
        1000,
        () => new Error('nope'),
      ),
    ).resolves.toBe('done');
  });

  it('propagates a real failure rather than reporting it as a timeout', async () => {
    // The distinction an operator acts on: ECONNREFUSED is a dependency that
    // answered, and it must not be relabelled as one that did not.
    await expect(
      withTimeout(
        async () => {
          throw new Error('ECONNREFUSED');
        },
        1000,
        () => new Error('timed out'),
      ),
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('does not leave the losing work as an unhandled rejection', async () => {
    // `crash.ts` treats an unhandled rejection as fatal, so a check that
    // rejects *after* losing the race would take the process down — turning a
    // slow dependency into an outage. The rejection arrives well after the
    // deadline, which is exactly the window that was dangerous.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(
        withTimeout(
          () => new Promise((_r, reject) => setTimeout(() => reject(new Error('late')), 30)),
          5,
          () => new Error('timed out after 5ms'),
        ),
      ).rejects.toThrow('timed out after 5ms');
      await new Promise((r) => setTimeout(r, 60));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('clears its timer when the work wins, so nothing holds the loop open', async () => {
    // A 5s handle left behind by every fast check is 5s of shutdown that
    // nothing is waiting for. Asserted through the clock rather than by
    // inspecting handles: with fake timers, an uncleared timer is still
    // pending.
    vi.useFakeTimers();
    const settled = withTimeout(
      async () => 'quick',
      5000,
      () => new Error('nope'),
    );
    await expect(settled).resolves.toBe('quick');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs unbounded when the deadline is zero or nonsense', async () => {
    for (const ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        withTimeout(
          async () => 'ran',
          ms,
          () => new Error('nope'),
        ),
      ).resolves.toBe('ran');
    }
  });
});
