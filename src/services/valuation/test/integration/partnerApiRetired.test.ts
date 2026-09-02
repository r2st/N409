import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';
import { retireValuations } from '../../src/repos/valuationPurge.js';
import {
  authHeader,
  isDbAvailable,
  SEEDED_PASSWORD,
  seedPartner,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';
import { mutatingValuationRoutes } from '../support/routeTable.js';

const dbUp = await isDbAvailable();

/**
 * The partner API's own writes, aimed at a retired engagement.
 *
 * R89 swept all 86 session-authenticated writes under a valuation id and left
 * this surface out with a reason that was true and incomplete: the partner API
 * is reached with an API key rather than a session and has its own state
 * machine, so it could not ride the same sweep. What it did not have was a
 * sweep of its own — `partnerApi.test.ts` covers scoping, idempotency and the
 * state machine, and none of those ask about `archived_at`.
 *
 * All three writes accepted a withdrawn engagement. The severity ordering is
 * the same one the session sweep found, and the ranking is not obvious from
 * the verbs:
 *
 *   * `POST /valuations/{id}/submit` walked a retired file from `pending` to
 *     `user_finished` — three state transitions, each with its own audit event
 *     and its own hook, which is how a withdrawn engagement reappears in the
 *     review queue and in the SLA figures the firm reports on.
 *   * `POST /valuations/{id}/documents` stored a client's file against work
 *     nobody will look at, which is a retention question as much as a
 *     correctness one.
 *   * `PUT /valuations/{id}` renamed the company on it.
 *
 * WHY THE GUARDS SIT WHERE THEY DO. `loadScoped` is shared with the three
 * GETs, so the check is per-write, exactly as R89 kept it out of `loadForEdit`:
 * a partner that had work withdrawn must still be able to read it. On `submit`
 * it is also *ahead of the idempotency key claim*, which the upload route had
 * already established as the rule for refusals on this API — a throw inside
 * `withIdempotency`'s `run()` leaves the key in flight until the takeover
 * window, so a client retrying a refused submit under the same key would be
 * told its request was still running instead of why it was refused. That is
 * asserted below rather than left to the comment.
 *
 * WHAT THE READ SIDE GAINED. A retired engagement is filtered out of `GET
 * /valuations` by `buildValuationWhere` but stays fetchable by id — and until
 * now the response said nothing about it. An integration polling `state` saw a
 * value that would never change again, with no reason given, and its next
 * write got a 409 out of nowhere. `retired_at` is that reason, on the response
 * it was already reading.
 */
describe.skipIf(!dbUp)('the partner API and a retired engagement', () => {
  let ctx: TestApp;
  let apiKey: string;
  let live: string;
  let archived: string;

  const keyHeader = () => ({ authorization: `Bearer ${apiKey}` });

  beforeAll(async () => {
    const docsDir = await mkdtemp(path.join(tmpdir(), 'n409-partner-retired-'));
    ctx = await setupTestApp(
      { DOCUMENTS_DIR: docsDir, AUTO_PIPELINE: 'off' },
      { partnerApiLimiter: new FixedWindowRateLimiter(1000, 60_000) },
    );
    const partnerId = await seedPartner(ctx, 'Withdrawn Work LLP');
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId });
    const minted = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnerId}/tokens`,
      headers: authHeader(admin.token),
      payload: { current_password: SEEDED_PASSWORD, name: 'retirement sweep' },
    });
    expect(minted.statusCode).toBe(201);
    apiKey = minted.json().secret as string;

    live = await create('Still Engaged Co');
    archived = await create('Withdrawn Co');
    await retireValuations(ctx.pool, [archived]);
  }, 120_000);

  afterAll(async () => ctx?.teardown());

  async function create(name: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers: keyHeader(),
      payload: { kind: '409a', company_name: name, currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  }

  /**
   * The pairing that makes any of this mean something.
   *
   * Each request is sent twice with the same body — once at a live engagement
   * and once at its withdrawn twin. The live half proves the body is
   * well-formed and reached the handler, so the 409 from the other half can
   * only have come from the guard. A one-sided probe passes on a validation
   * error, which is how the session sweep's first attempt gave nine routes a
   * clean bill of health they had not earned.
   */
  const cases: Array<{ name: string; method: 'POST' | 'PUT'; path: string; payload: unknown }> = [
    {
      name: 'PUT /valuations/{id}',
      method: 'PUT',
      path: '',
      payload: { company_name: 'Renamed By Partner' },
    },
    { name: 'POST /valuations/{id}/submit', method: 'POST', path: '/submit', payload: {} },
    {
      name: 'POST /valuations/{id}/documents',
      method: 'POST',
      path: '/documents',
      payload: {
        filename: 'cap-table.csv',
        kind: 'cap_table',
        content_type: 'text/csv',
        content_base64: Buffer.from('holder,shares\nFounder,1000\n').toString('base64'),
      },
    },
  ];

  describe.each(cases)('$name', (spec) => {
    it('is accepted by a live engagement', async () => {
      const res = await ctx.app.inject({
        method: spec.method,
        url: `/api/partner/v1/valuations/${live}${spec.path}`,
        headers: keyHeader(),
        payload: spec.payload,
      });
      expect(res.statusCode).toBeLessThan(300);
    });

    it('is refused by a retired one', async () => {
      const res = await ctx.app.inject({
        method: spec.method,
        url: `/api/partner/v1/valuations/${archived}${spec.path}`,
        headers: keyHeader(),
        payload: spec.payload,
      });
      expect(res.statusCode).toBe(409);
      // The reason, not just the refusal: `PUT` and `submit` both have their
      // own unrelated 409s (past review, dead-end state) and this must not be
      // satisfiable by one of those.
      expect(JSON.stringify(res.json())).toMatch(/retired/i);
    });
  });

  /**
   * The refusal happens before the key is claimed.
   *
   * Sent under a key, then retried under the same key. If the guard ran inside
   * `withIdempotency`, the first call would leave the row `in_flight` and the
   * retry would answer "still in flight" — a 409 either way, which is why the
   * assertion is on the message and not the status.
   */
  it('refuses a keyed submit without burning the idempotency key', async () => {
    const send = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/partner/v1/valuations/${archived}/submit`,
        headers: { ...keyHeader(), 'idempotency-key': 'retired-submit-1' },
        payload: {},
      });
    const first = await send();
    expect(first.statusCode).toBe(409);
    expect(JSON.stringify(first.json())).toMatch(/retired/i);

    const retry = await send();
    expect(retry.statusCode).toBe(409);
    expect(JSON.stringify(retry.json())).toMatch(/retired/i);
    expect(JSON.stringify(retry.json())).not.toMatch(/in flight/i);
  });

  // Reads stay open, the same boundary the session API draws. A partner whose
  // work was withdrawn is still entitled to look at what they created.
  it('still serves the retired engagement, and says that it is retired', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/partner/v1/valuations/${archived}`,
      headers: keyHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valuation.retired_at).toEqual(expect.any(String));

    const results = await ctx.app.inject({
      method: 'GET',
      url: `/api/partner/v1/valuations/${archived}/results`,
      headers: keyHeader(),
    });
    expect(results.statusCode).toBe(200);
  });

  it('reports null for one that is not retired, and keeps it out of the list', async () => {
    const one = await ctx.app.inject({
      method: 'GET',
      url: `/api/partner/v1/valuations/${live}`,
      headers: keyHeader(),
    });
    expect(one.json().valuation.retired_at).toBeNull();

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/partner/v1/valuations?per_page=100',
      headers: keyHeader(),
    });
    const ids = list.json().valuations.map((v: { id: string }) => v.id);
    expect(ids).toContain(live);
    expect(ids).not.toContain(archived);
  });

  /**
   * Every partner write under a valuation id, driven from the route table.
   *
   * The three above are named because they are the ones that leaked and the
   * bodies are worth reading. This is the half that survives somebody adding a
   * fourth: it reads the registered routes rather than a list, so a write
   * added tomorrow is swept the day it is registered. An empty body is enough
   * here — the guards sit ahead of body parsing, so a live engagement answers
   * something-other-than-retired and the withdrawn one answers 409.
   */
  it('refuses every registered partner write under a valuation id', async () => {
    const routes = mutatingValuationRoutes(ctx.app).filter((r) => / \/api\/partner\//u.test(r));
    // Vacuity guard: the enumeration is a regex over a printed route tree, and
    // "nothing left over" is satisfied by having found nothing.
    expect(routes.length).toBeGreaterThanOrEqual(3);
    expect(routes).toContain('POST /api/partner/v1/valuations/:id/submit');

    const hit = (route: string, id: string) => {
      const [method, template] = route.split(' ');
      return ctx.app.inject({
        method: method as 'POST',
        url: template.replace(':id', id),
        headers: keyHeader(),
        payload: {},
      });
    };
    const refusedForRetirement = async (route: string, id: string) => {
      const res = await hit(route, id);
      return res.statusCode === 409 && /retired/i.test(JSON.stringify(res.json()));
    };

    const accepted: string[] = [];
    for (const route of routes) {
      if (!(await refusedForRetirement(route, archived))) {
        const res = await hit(route, archived);
        accepted.push(`${route} -> ${res.statusCode} ${JSON.stringify(res.json()).slice(0, 80)}`);
      }
    }
    expect(accepted).toEqual([]);

    // And the half that stops that being satisfied by a route which refuses
    // everything for some other reason.
    const wrong: string[] = [];
    for (const route of routes) {
      if (await refusedForRetirement(route, live)) wrong.push(route);
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});
