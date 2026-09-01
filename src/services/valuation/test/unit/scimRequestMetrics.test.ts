import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { MetricsRegistry } from '@n409/shared';
import {
  recordScimRequest,
  refuseScimRequest,
  registerScimMetrics,
  resetScimMetrics,
} from '../../src/observability/scimRequests.js';
import { registerScimRoutes } from '../../src/routes/scim.js';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';

/**
 * A directory token that has drifted (R337, methodology M11).
 *
 * `/scim/v2/*` is the third door onto this platform whose whole authority is a
 * shared secret held on two machines neither of which tells the other when it
 * changes. R329 gave the other two — the inbound webhooks and the two SSO flows
 * — a counter and a rule each, on the argument that an integration refusing
 * everything looks exactly like one nobody is using. This door was left, and it
 * is the one where the silence costs the most.
 *
 * A SCIM bearer rotated in the admin console, revoked, or retyped wrong in
 * Okta / Entra / OneLogin makes `requireToken` answer 401 to every create,
 * every `PATCH active:false` and every `DELETE`. Nothing logged it and nothing
 * counted it: the only trace was a 4xx in `http_requests_total`, a class this
 * box has no rule on at all, on a route whose other reader is the IdP's own
 * connector log inside somebody else's tenant.
 *
 * What stops is the automated half of offboarding. Since R336 the directory's
 * deprovision is what drops a departing employee's roles and releases their
 * engagements and review tasks; a refused token stops all of it and the account
 * stays live, signed in, and assigned.
 */

const GOOD = 'a-token-this-deployment-holds';

/** A pool that answers the token lookup and the listing, and nothing else. */
function fakePool(opts: { verifies: boolean }) {
  return {
    query: async (sql: string) => {
      if (sql.includes('UPDATE scim_tokens')) {
        return { rows: opts.verifies ? [{ id: 'scim_token_1' }] : [] };
      }
      if (sql.includes('count(*)')) return { rows: [{ total: '0' }] };
      return { rows: [] };
    },
  } as never;
}

async function buildScim(opts: { verifies: boolean; limit?: number }): Promise<{
  app: FastifyInstance;
  registry: MetricsRegistry;
  lines: Array<{ obj: Record<string, unknown>; msg: string }>;
}> {
  const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const app = Fastify({ logger: false });
  const registry = new MetricsRegistry();
  registerScimMetrics(registry);
  app.addHook('onRequest', (req, _reply, done) => {
    req.log = {
      ...req.log,
      warn: (obj: Record<string, unknown>, msg: string) => void lines.push({ obj, msg }),
    } as typeof req.log;
    done();
  });
  registerScimRoutes(app, {
    pool: fakePool({ verifies: opts.verifies }),
    limiter: new FixedWindowRateLimiter(opts.limit ?? 600, 5 * 60 * 1000),
  });
  await app.ready();
  return { app, registry, lines };
}

describe('the SCIM request counter', () => {
  afterEach(() => resetScimMetrics());

  it('separates a stranger from a token that has drifted', () => {
    // The distinction is the whole point, and it is the same one the webhook
    // door draws between `unsigned` and `bad_signature`: this prefix is on the
    // open internet, so a request carrying no bearer at all is the endpoint
    // working. A well-formed bearer that does not verify is the directory the
    // firm relies on, holding a key this deployment does not have.
    const registry = new MetricsRegistry();
    registerScimMetrics(registry);

    recordScimRequest('accepted');
    recordScimRequest('bad_token');
    recordScimRequest('unauthenticated');
    recordScimRequest('rate_limited');

    const text = registry.render();
    expect(text).toContain('scim_requests_total{outcome="accepted"} 1');
    expect(text).toContain('scim_requests_total{outcome="bad_token"} 1');
    expect(text).toContain('scim_requests_total{outcome="unauthenticated"} 1');
    expect(text).toContain('scim_requests_total{outcome="rate_limited"} 1');
  });

  it('says in the log which refusals are ours, and stays quiet about the stranger', () => {
    const said: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const log = { warn: (obj: Record<string, unknown>, msg: string) => void said.push({ obj, msg }) };

    refuseScimRequest(log, 'unauthenticated');
    expect(said, 'a scanner must not choose how much this box logs').toEqual([]);

    refuseScimRequest(log, 'bad_token');
    expect(said).toHaveLength(1);
    expect(said[0]!.obj).toEqual({ source: 'scim', outcome: 'bad_token' });
    expect(said[0]!.msg).toMatch(/drifted/);
  });

  it('counts even the refusal it does not log', () => {
    // The line and the series answer different questions: the scrape is what a
    // rule fires on, and `unauthenticated` is what keeps the ratio honest.
    const registry = new MetricsRegistry();
    registerScimMetrics(registry);
    refuseScimRequest({ warn: () => {} }, 'unauthenticated');
    expect(registry.render()).toContain('scim_requests_total{outcome="unauthenticated"} 1');
  });

  it('is inert before registration rather than throwing', () => {
    expect(() => recordScimRequest('accepted')).not.toThrow();
    expect(() => refuseScimRequest({ warn: () => {} }, 'bad_token')).not.toThrow();
  });
});

describe('the SCIM door, end to end', () => {
  afterEach(() => resetScimMetrics());

  it('counts and names a bearer the directory holds and this deployment does not', async () => {
    const { app, registry, lines } = await buildScim({ verifies: false });
    const res = await app.inject({
      method: 'PATCH',
      url: '/scim/v2/Users/01J0000000000000000000000A',
      headers: { authorization: `Bearer ${GOOD}`, 'content-type': 'application/scim+json' },
      payload: JSON.stringify({ Operations: [{ op: 'replace', value: { active: false } }] }),
    });
    await app.close();

    // The refusal a departing employee's deprovision gets, and what it used to
    // leave behind: a 401 and nothing else.
    expect(res.statusCode).toBe(401);
    expect(registry.render()).toContain('scim_requests_total{outcome="bad_token"} 1');
    expect(lines.map((l) => l.msg)).toContainEqual(expect.stringMatching(/did not verify/));
  });

  it('does not log or count a scanner as a drifted token', async () => {
    const { app, registry, lines } = await buildScim({ verifies: false });
    const res = await app.inject({ method: 'GET', url: '/scim/v2/Users' });
    await app.close();

    expect(res.statusCode).toBe(401);
    const text = registry.render();
    expect(text).toContain('scim_requests_total{outcome="unauthenticated"} 1');
    expect(text).not.toContain('scim_requests_total{outcome="bad_token"}');
    expect(lines).toEqual([]);
  });

  it('records the denominator when the token verifies', async () => {
    const { app, registry } = await buildScim({ verifies: true });
    const res = await app.inject({
      method: 'GET',
      url: '/scim/v2/Users',
      headers: { authorization: `Bearer ${GOOD}` },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    // Without this the refusal count has no denominator, and one scanner
    // looks exactly like a secret that has been wrong since Tuesday.
    expect(registry.render()).toContain('scim_requests_total{outcome="accepted"} 1');
  });

  it('counts the throttle, which stops a resync just as completely', async () => {
    const { app, registry, lines } = await buildScim({ verifies: true, limit: 1 });
    const headers = { authorization: `Bearer ${GOOD}` };
    await app.inject({ method: 'GET', url: '/scim/v2/Users', headers });
    const res = await app.inject({ method: 'GET', url: '/scim/v2/Users', headers });
    await app.close();

    expect(res.statusCode).toBe(429);
    expect(registry.render()).toContain('scim_requests_total{outcome="rate_limited"} 1');
    expect(lines.map((l) => l.msg)).toContainEqual(expect.stringMatching(/throttled/));
  });
});
