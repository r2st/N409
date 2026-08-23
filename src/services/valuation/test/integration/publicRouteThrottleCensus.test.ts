/**
 * Every route on the unauthenticated surface, and whether it is throttled.
 *
 * `routeAudit` already refuses to boot a route that is neither authenticated
 * nor listed in PUBLIC_ROUTES with a reason, so nothing reaches the open
 * internet without somebody having written a sentence about it. What nothing
 * checked is the second half of most of those sentences. Fourteen of them say
 * the route is rate-limited — "each is rate-limited and validates its own
 * credential", "behind a per-IP limiter", "rate-limited and captcha-free by
 * design" — and a sentence is not a limiter. `publicRateLimits.test.ts` proves
 * ten of the routes refuse a burst; the other forty-three were covered by the
 * comment alone, and a public route added tomorrow would be covered by nothing.
 *
 * So this is a census rather than a set of cases: the table below has to name
 * every entry in PUBLIC_ROUTES and no others, which makes adding a public
 * endpoint fail here until somebody decides which column it belongs in. The
 * `throttled` column is not taken on trust — each of its entries carries the
 * request that trips it, and the test fires that request until the service
 * refuses. `open` is the column that needs the argument, and each entry
 * carries one.
 *
 * Thresholds are production's, not injected. The claim being made is about the
 * deployed surface — "a stranger cannot hammer this" — and an injected limiter
 * of two would prove only that a limiter passed into the route works.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { isDbAvailable, setupTestApp } from './helpers.js';
import { PUBLIC_ROUTES } from '../../src/plugins/routeAudit.js';

const dbUp = await isDbAvailable();

/** A public route that answers a burst from one address without ever refusing. */
interface Open {
  kind: 'open';
  /** Why an unbounded rate is acceptable here. */
  why: string;
}

/** A public route that refuses a burst, and the request that proves it. */
interface Throttled {
  kind: 'throttled';
  /** The limit as configured, so the burst below can be bounded meaningfully. */
  limit: number;
  request: InjectOptions;
}

/**
 * A route limited on a key an anonymous burst cannot reach — so the census
 * records the limit and names the test that exercises it, rather than
 * pretending to prove it here.
 */
interface Elsewhere {
  kind: 'elsewhere';
  why: string;
}

type Verdict = Open | Throttled | Elsewhere;

const post = (url: string, payload: unknown): InjectOptions => ({
  method: 'POST',
  url,
  payload: payload as Record<string, unknown>,
});
const get = (url: string): InjectOptions => ({ method: 'GET', url });

const STRONG = 'Correct-Horse-Battery-Staple-9';
const GUESS = 'a'.repeat(40);

const CENSUS: Record<string, Verdict> = {
  // ── Probes and self-description. No state read, nothing to guess ─────────
  'GET /': { kind: 'open', why: 'a static banner naming the health endpoints' },
  'GET /health': { kind: 'open', why: 'liveness probe; the proxy and systemd poll it continuously' },
  'GET /ready': { kind: 'open', why: 'readiness probe, polled on the same schedule' },
  'GET /metrics': {
    kind: 'open',
    why: 'a Prometheus scrape is a fixed-rate poll, and the route is unregistered in production without a token',
  },
  'GET /api/v1/auth/providers': { kind: 'open', why: 'which sign-in buttons to render; config, not data' },
  'GET /api/v1/auth/saml/metadata': {
    kind: 'open',
    why: 'SP metadata is a published document by specification',
  },
  'GET /api/partner/v1/docs': { kind: 'open', why: 'the partner API documentation page' },
  'GET /api/partner/v1/openapi.json': {
    kind: 'open',
    why: 'the same documentation as a spec; built from a static registry',
  },

  // ── Pre-login chrome and marketing reads ─────────────────────────────────
  'GET /api/v1/public/branding/:key': { kind: 'open', why: 'the logo and colours on the sign-in page' },
  'GET /api/v1/public/branding': { kind: 'open', why: 'the same chrome resolved from the tenant subdomain' },
  'GET /api/v1/public/partners/:key/branding': {
    kind: 'open',
    why: 'the same chrome, addressed by partner key',
  },
  'GET /api/v1/public/settings': {
    kind: 'open',
    why: 'is registration open, is the platform in maintenance',
  },
  'GET /api/v1/blog/posts': {
    kind: 'open',
    why: 'a published article index; a blog a crawler cannot read is not a blog',
  },
  'GET /api/v1/blog/posts/:slug': { kind: 'open', why: 'a published marketing article' },
  'GET /api/v1/sample-report': {
    kind: 'open',
    why: "the deliverable's chapter outline as JSON; static content, and the render behind it is limited separately",
  },
  'POST /api/v1/valuation-selector': {
    kind: 'open',
    why: 'the "which valuation?" quiz — a pure function of a bounded enum body, no database and nothing stored',
  },
  'POST /api/v1/fmv-estimator': {
    kind: 'open',
    why: 'the free estimator — likewise pure, with every numeric field capped in the schema',
  },

  // ── Redirect halves of a handshake, authenticated by a signed state ──────
  'GET /api/v1/auth/google': { kind: 'open', why: 'starts the OIDC redirect; issues a state and redirects' },
  'GET /api/v1/auth/google/callback': {
    kind: 'open',
    why: 'the return leg; a forged state is rejected before any lookup',
  },
  'GET /api/v1/auth/saml/login': { kind: 'open', why: 'emits the AuthnRequest redirect' },
  'POST /api/v1/auth/saml/acs': {
    kind: 'open',
    why: 'assertion consumer; an unsigned assertion is rejected on signature',
  },
  'GET /api/v1/accounting/callback': {
    kind: 'open',
    why: 'OAuth return leg, authenticated by the signed accounting state',
  },
  'GET /api/v1/cap-table-sync/callback': {
    kind: 'open',
    why: 'OAuth return leg, authenticated by the signed cap-table state',
  },
  'GET /api/v1/hris/callback': {
    kind: 'open',
    why: 'OAuth return leg, authenticated by the signed HRIS state',
  },

  // ── Server-to-server callbacks, authenticated by a signature over the body ─
  'POST /api/v1/stripe/webhook': {
    kind: 'open',
    why: 'Stripe retries on its own schedule; a throttle would drop a real event',
  },
  'POST /api/v1/billing/webhook': { kind: 'open', why: 'the same, on the billing half' },
  'POST /api/v1/webhooks/email/:provider': {
    kind: 'open',
    why: 'a mail provider bursts delivery signals by design, and the route is unregistered without EMAIL_WEBHOOK_SECRET',
  },

  // ── Signed-token endpoints where refusing would be the worse failure ─────
  'POST /api/v1/unsubscribe': {
    kind: 'open',
    why: 'RFC 8058 one-click; a 429 to a mailbox provider reads as "this sender does not honour unsubscribe"',
  },
  'GET /api/v1/unsubscribe': {
    kind: 'open',
    why: 'the footer link a person clicks; same token, same reasoning',
  },
  'POST /api/v1/auth/logout': {
    kind: 'open',
    why: 'clears a cookie; refusing it would leave a session the user asked to end',
  },

  // ── Throttled: token oracles, account minting, and mail triggers ─────────
  'POST /api/v1/auth/register': {
    kind: 'throttled',
    limit: 10,
    request: post('/api/v1/auth/register', { email: 'census-register@test.example.com', password: STRONG }),
  },
  'POST /api/v1/auth/login': {
    kind: 'throttled',
    limit: 10,
    request: post('/api/v1/auth/login', { email: 'census-login@test.example.com', password: STRONG }),
  },
  'POST /api/v1/auth/forgot-password': {
    kind: 'throttled',
    limit: 3,
    request: post('/api/v1/auth/forgot-password', { email: 'census-forgot@test.example.com' }),
  },
  'POST /api/v1/auth/reset-password': {
    kind: 'throttled',
    limit: 20,
    request: post('/api/v1/auth/reset-password', { token: GUESS, password: STRONG }),
  },
  'POST /api/v1/auth/verify-email': {
    kind: 'throttled',
    limit: 20,
    request: post('/api/v1/auth/verify-email', { token: GUESS }),
  },
  'POST /api/v1/auth/invite-info': {
    kind: 'throttled',
    limit: 20,
    request: post('/api/v1/auth/invite-info', { token: GUESS }),
  },
  'POST /api/v1/auth/accept-invite': {
    kind: 'throttled',
    limit: 20,
    request: post('/api/v1/auth/accept-invite', { token: GUESS, password: STRONG }),
  },
  'POST /api/v1/auth/mfa/verify': {
    kind: 'elsewhere',
    why:
      'limited 10 per 15 minutes on the user the challenge token resolves to, so a burst carrying a forged ' +
      'challenge is refused as unauthorized before it ever reaches the counter — see mfa.test.ts',
  },

  'POST /api/v1/auditor/portal': {
    kind: 'throttled',
    limit: 30,
    request: post('/api/v1/auditor/portal', { token: GUESS }),
  },
  'POST /api/v1/board/resolution': {
    kind: 'throttled',
    limit: 30,
    request: post('/api/v1/board/resolution', { token: GUESS }),
  },
  'POST /api/v1/board/sign': {
    kind: 'throttled',
    limit: 30,
    request: post('/api/v1/board/sign', { token: GUESS, decision: 'signed' }),
  },
  'POST /api/v1/intake/portal': {
    kind: 'throttled',
    limit: 120,
    request: post('/api/v1/intake/portal', { token: GUESS }),
  },
  'POST /api/v1/intake/portal/answers': {
    kind: 'throttled',
    limit: 120,
    request: post('/api/v1/intake/portal/answers', { token: GUESS, answers: {} }),
  },
  'POST /api/v1/intake/portal/submit': {
    kind: 'throttled',
    limit: 120,
    request: post('/api/v1/intake/portal/submit', { token: GUESS }),
  },

  'GET /scim/v2/ServiceProviderConfig': {
    kind: 'throttled',
    limit: 600,
    request: get('/scim/v2/ServiceProviderConfig'),
  },
  'GET /scim/v2/Users': { kind: 'throttled', limit: 600, request: get('/scim/v2/Users') },
  'GET /scim/v2/Users/:id': {
    kind: 'throttled',
    limit: 600,
    request: get('/scim/v2/Users/01CENSUS0000000000000000AA'),
  },
  'POST /scim/v2/Users': { kind: 'throttled', limit: 600, request: post('/scim/v2/Users', {}) },
  'PATCH /scim/v2/Users/:id': {
    kind: 'throttled',
    limit: 600,
    request: { method: 'PATCH', url: '/scim/v2/Users/01CENSUS0000000000000000AA', payload: {} },
  },
  'DELETE /scim/v2/Users/:id': {
    kind: 'throttled',
    limit: 600,
    request: { method: 'DELETE', url: '/scim/v2/Users/01CENSUS0000000000000000AA' },
  },

  'POST /api/v1/contact': {
    kind: 'throttled',
    limit: 5,
    request: post('/api/v1/contact', {
      name: 'Census',
      email: 'census-contact@test.example.com',
      message: 'A message long enough to pass the schema on this public form.',
    }),
  },
  'GET /api/v1/sample-report/pdf': {
    kind: 'throttled',
    limit: 10,
    request: get('/api/v1/sample-report/pdf'),
  },
};

const key = (method: string, url: string) => `${method.toUpperCase()} ${url}`;

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
   * The drift guard, and the reason this is a census. A public route added
   * without an entry fails here, which is the point at which somebody has to
   * decide whether a stranger may call it as fast as they like.
   */
  it('names every public route and no others', () => {
    const declared = Object.keys(CENSUS).sort();
    const listed = PUBLIC_ROUTES.map((r) => key(r.method, r.url)).sort();
    expect(declared).toEqual(listed);
  });

  /** And every route the census names is one the service registers. */
  it('names only routes the service registers', () => {
    const registered = new Set(app.routeAudit.all());
    expect(Object.keys(CENSUS).filter((k) => !registered.has(k))).toEqual([]);
  });

  const throttled = Object.entries(CENSUS).filter(
    (entry): entry is [string, Throttled] => entry[1].kind === 'throttled',
  );
  const open = Object.entries(CENSUS).filter((entry): entry is [string, Open] => entry[1].kind === 'open');

  /**
   * Fires `request` until the service refuses, and returns how many it took.
   * Bounded a little above the configured limit: overshooting would hide a
   * route whose limiter is an order of magnitude looser than it claims.
   */
  const burstUntilRefused = async (request: InjectOptions, limit: number): Promise<number | null> => {
    const ceiling = limit + 5;
    for (let n = 1; n <= ceiling; n++) {
      if ((await app.inject(request)).statusCode === 429) return n;
    }
    return null;
  };

  it.each(throttled)(
    '%s refuses a burst',
    async (_route, verdict) => {
      const at = await burstUntilRefused(verdict.request, verdict.limit);
      expect(at, `no 429 within ${verdict.limit + 5} requests`).not.toBeNull();
      // Refused no later than one past the declared limit, so the number in the
      // table stays a description of the route rather than a guess about it.
      expect(at).toBeLessThanOrEqual(verdict.limit + 1);
    },
    60_000,
  );

  /**
   * The other half, and the one that keeps the `open` column honest: a route
   * declared open must actually answer a burst. An entry parked there because
   * the burst was awkward to write would be caught by its own 429.
   */
  it.each(open)(
    '%s answers a burst rather than refusing it',
    async (route, _verdict) => {
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
});
