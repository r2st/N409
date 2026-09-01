/**
 * Every route on the unauthenticated surface, fired at to see whether it is
 * throttled.
 *
 * `routeAudit` already refuses to boot a route that is neither authenticated
 * nor listed in PUBLIC_ROUTES with a reason, so nothing reaches the open
 * internet without somebody having written a sentence about it. What nothing
 * checked is the second half of most of those sentences. Fourteen of them say
 * the route is rate-limited — "each is rate-limited and validates its own
 * credential", "behind a per-IP limiter", "rate-limited and captcha-free by
 * design" — and a sentence is not a limiter.
 *
 * The classification itself no longer lives here. It moved into
 * `domain/rateLimitPolicy.ts` when the published OpenAPI started needing it: a
 * spec that declares a 429 on a liveness probe is the same mistake as a census
 * that files one under the wrong column, and the two cannot disagree if there
 * is only one table. `rateLimitPolicyCensus.test.ts` holds that table to
 * PUBLIC_ROUTES and to the document; this file holds it to the running service.
 *
 * So what remains here is the *proof*. Each throttled route carries the request
 * that trips it, and the test fires that request until the service refuses —
 * refusing no later than one past the limit the table declares, so the number
 * over there stays a description of the route rather than a guess about it. The
 * open column is fired at too: a route parked there because the burst was
 * awkward to write would be caught by its own 429.
 *
 * Thresholds are production's, not injected. The claim being made is about the
 * deployed surface — "a stranger cannot hammer this" — and an injected limiter
 * of two would prove only that a limiter passed into the route works.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { isDbAvailable, setupTestApp } from './helpers.js';
import { PUBLIC_RATE_LIMITS, type RateLimitPolicy } from '../../src/domain/rateLimitPolicy.js';

const dbUp = await isDbAvailable();

/** A throttled route proved by firing one request until it is refused. */
interface Burst {
  kind: 'burst';
  request: InjectOptions;
}

/**
 * A route limited on a key an anonymous burst cannot reach — so the proof names
 * the test that exercises it rather than pretending to run here.
 */
interface Elsewhere {
  kind: 'elsewhere';
  why: string;
}

type Proof = Burst | Elsewhere;

const post = (url: string, payload: unknown): InjectOptions => ({
  method: 'POST',
  url,
  payload: payload as Record<string, unknown>,
});
const get = (url: string): InjectOptions => ({ method: 'GET', url });

const STRONG = 'Correct-Horse-Battery-Staple-9';
const GUESS = 'a'.repeat(40);

/**
 * How each throttled route is proved throttled — one entry per route the policy
 * table calls throttled, and no others. That exactness is what makes adding a
 * limited endpoint come with the burst that demonstrates the limit.
 */
const PROOFS: Record<string, Proof> = {
  'POST /api/v1/auth/register': {
    kind: 'burst',
    request: post('/api/v1/auth/register', { email: 'census-register@test.example.com', password: STRONG }),
  },
  'POST /api/v1/auth/login': {
    kind: 'burst',
    request: post('/api/v1/auth/login', { email: 'census-login@test.example.com', password: STRONG }),
  },
  'POST /api/v1/auth/forgot-password': {
    kind: 'burst',
    request: post('/api/v1/auth/forgot-password', { email: 'census-forgot@test.example.com' }),
  },
  'POST /api/v1/auth/reset-password': {
    kind: 'burst',
    request: post('/api/v1/auth/reset-password', { token: GUESS, password: STRONG }),
  },
  'POST /api/v1/auth/verify-email': {
    kind: 'burst',
    request: post('/api/v1/auth/verify-email', { token: GUESS }),
  },
  'POST /api/v1/auth/invite-info': {
    kind: 'burst',
    request: post('/api/v1/auth/invite-info', { token: GUESS }),
  },
  'POST /api/v1/auth/accept-invite': {
    kind: 'burst',
    request: post('/api/v1/auth/accept-invite', { token: GUESS, password: STRONG }),
  },
  'POST /api/v1/auth/mfa/verify': {
    kind: 'elsewhere',
    why:
      'limited on the user the challenge token resolves to, so a burst carrying a forged challenge is ' +
      'refused as unauthorized before it ever reaches the counter — see mfa.test.ts',
  },

  'POST /api/v1/client-errors': {
    kind: 'burst',
    request: post('/api/v1/client-errors', { kind: 'render', message: 'census' }),
  },

  'POST /api/v1/auditor/portal': {
    kind: 'burst',
    request: post('/api/v1/auditor/portal', { token: GUESS }),
  },
  // Shares the portal's limiter and window: a write is at least as good an
  // oracle for guessing a token as a read is, and it is worth less to the
  // honest caller — an auditor writes a note once and reloads the page a dozen
  // times to write it.
  'POST /api/v1/auditor/portal/notes': {
    kind: 'burst',
    request: post('/api/v1/auditor/portal/notes', {
      token: GUESS,
      disposition: 'question',
      body: 'a note',
    }),
  },
  'POST /api/v1/board/resolution': {
    kind: 'burst',
    request: post('/api/v1/board/resolution', { token: GUESS }),
  },
  'POST /api/v1/board/sign': {
    kind: 'burst',
    request: post('/api/v1/board/sign', { token: GUESS, decision: 'signed' }),
  },
  'POST /api/v1/intake/portal': {
    kind: 'burst',
    request: post('/api/v1/intake/portal', { token: GUESS }),
  },
  'POST /api/v1/intake/portal/answers': {
    kind: 'burst',
    request: post('/api/v1/intake/portal/answers', { token: GUESS, answers: {} }),
  },
  'POST /api/v1/intake/portal/submit': {
    kind: 'burst',
    request: post('/api/v1/intake/portal/submit', { token: GUESS }),
  },

  'GET /scim/v2/ServiceProviderConfig': { kind: 'burst', request: get('/scim/v2/ServiceProviderConfig') },
  'GET /scim/v2/Users': { kind: 'burst', request: get('/scim/v2/Users') },
  'GET /scim/v2/Users/:id': {
    kind: 'burst',
    request: get('/scim/v2/Users/01CENSUS0000000000000000AA'),
  },
  'POST /scim/v2/Users': { kind: 'burst', request: post('/scim/v2/Users', {}) },
  'PATCH /scim/v2/Users/:id': {
    kind: 'burst',
    request: { method: 'PATCH', url: '/scim/v2/Users/01CENSUS0000000000000000AA', payload: {} },
  },
  'DELETE /scim/v2/Users/:id': {
    kind: 'burst',
    request: { method: 'DELETE', url: '/scim/v2/Users/01CENSUS0000000000000000AA' },
  },

  'POST /api/v1/contact': {
    kind: 'burst',
    request: post('/api/v1/contact', {
      name: 'Census',
      email: 'census-contact@test.example.com',
      message: 'A message long enough to pass the schema on this public form.',
    }),
  },
  'GET /api/v1/sample-report/pdf': { kind: 'burst', request: get('/api/v1/sample-report/pdf') },
};

/**
 * The counter a repeated identical request trips first.
 *
 * A policy may check several — sign-in checks one per address and one per
 * caller — and firing the same request advances all of them, so the smallest is
 * the one that refuses. Taking the minimum rather than restating a number keeps
 * the burst bound tied to the table it is proving.
 */
const trippingLimit = (policy: RateLimitPolicy): number =>
  Math.min(...policy.windows.map((window) => window.limit));

const throttledRoutes = Object.entries(PUBLIC_RATE_LIMITS).flatMap(([route, verdict]) =>
  verdict.kind === 'throttled' ? [[route, verdict.policy] as const] : [],
);
const openRoutes = Object.entries(PUBLIC_RATE_LIMITS).flatMap(([route, verdict]) =>
  verdict.kind === 'open' ? [[route, verdict.why] as const] : [],
);

describe.skipIf(!dbUp)('every public route is throttled or deliberately open', () => {
  let app: FastifyInstance;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    app = ctx.app;
    teardown = ctx.teardown;
  }, 120_000);

  afterAll(async () => {
    await teardown?.();
  });

  /**
   * The drift guard. A route the policy table calls throttled and that nothing
   * here fires at is a claim with no evidence behind it; a proof for a route
   * the table calls open is a leftover asserting the opposite of the table.
   */
  it('proves every throttled route and no others', () => {
    expect(Object.keys(PROOFS).sort()).toEqual(throttledRoutes.map(([route]) => route).sort());
  });

  /** And every route either table names is one the service registers. */
  it('names only routes the service registers', () => {
    const registered = new Set(app.routeAudit.all());
    expect(Object.keys(PUBLIC_RATE_LIMITS).filter((key) => !registered.has(key))).toEqual([]);
  });

  /**
   * Fires `request` until the service refuses, and returns how many it took.
   * Bounded a little above the declared limit: overshooting would hide a route
   * whose limiter is an order of magnitude looser than it claims.
   */
  const burstUntilRefused = async (request: InjectOptions, limit: number): Promise<number | null> => {
    const ceiling = limit + 5;
    for (let n = 1; n <= ceiling; n++) {
      if ((await app.inject(request)).statusCode === 429) return n;
    }
    return null;
  };

  const bursts = throttledRoutes.flatMap(([route, policy]) => {
    const proof = PROOFS[route];
    return proof?.kind === 'burst' ? [[route, proof.request, trippingLimit(policy)] as const] : [];
  });

  it.each(bursts)(
    '%s refuses a burst',
    async (_route, request, limit) => {
      const at = await burstUntilRefused(request, limit);
      expect(at, `no 429 within ${limit + 5} requests`).not.toBeNull();
      // Refused no later than one past the declared limit, so the number in the
      // policy table stays a description of the route rather than a guess.
      expect(at).toBeLessThanOrEqual(limit + 1);
    },
    60_000,
  );

  /**
   * The other half, and the one that keeps the open column honest: a route
   * declared open must actually answer a burst. This is also what the published
   * spec now stakes a claim on — those operations declare no 429 at all.
   */
  it.each(openRoutes)(
    '%s answers a burst rather than refusing it',
    async (route, _why) => {
      const [method, url] = route.split(' ') as [string, string];
      const request: InjectOptions = {
        method: method as 'GET',
        url: url.replace(/:(\w+)/g, 'census').replace('/api/v1/unsubscribe', '/api/v1/unsubscribe?token=x'),
        ...(method === 'GET' ? {} : { payload: {} }),
      };
      const codes = new Set<number>();
      for (let n = 0; n < 40; n++) codes.add((await app.inject(request)).statusCode);
      expect([...codes], `${route} refused an unthrottled burst`).not.toContain(429);
    },
    60_000,
  );

  it('fires at both columns', () => {
    // The vacuity guard: an empty table would make every `it.each` above
    // generate no cases and the suite pass by running nothing.
    expect(bursts.length).toBeGreaterThan(15);
    expect(openRoutes.length).toBeGreaterThan(20);
  });
});
