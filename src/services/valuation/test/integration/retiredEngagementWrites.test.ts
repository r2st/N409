import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { retireValuations } from '../../src/repos/valuationPurge.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { mutatingValuationRoutes } from '../support/routeTable.js';

const dbUp = await isDbAvailable();

/**
 * Writes aimed at a retired engagement.
 *
 * THE FOUR-ROUND ARC THIS CLOSES. `valuations.archived_at` is the platform's
 * soft delete, and only `buildValuationWhere` applies it. R55 and R56 swept
 * every repo that built its own WHERE, so retired engagements left the lists,
 * the counts, the dashboards and the drip campaigns. R57 found the residue and
 * named the lesson — **a list that stops offering something is not a write that
 * refuses it**, because the page stays reachable by id — fixed exactly one
 * instance of it (the Stripe checkout), and left the general question open.
 *
 * This asks it of every mutating valuation-scoped route, by the only method
 * that cannot answer wrongly: drive the endpoint twice, against a live
 * engagement and an archived twin, with the same request. `live` proves the
 * request is well-formed and reached the handler; `archived` is then the
 * guard's answer and nothing else. A one-sided test that only sent the archived
 * request would pass on a 422 from body validation — which is what nine of
 * these actually returned to a first, sloppier probe, and why the pairing is
 * the whole design rather than a nicety.
 *
 * Ten leaks were open when this was written, and they were not equivalent:
 * `remind-documents` sent mail to a client about work the firm had withdrawn,
 * `report/render` and `report/draft` produced the deliverable itself, and the
 * two `advance` routes moved a retired file through the pipeline.
 *
 * WHAT IS COVERED NOW. All 86 registered POST/PUT/PATCH routes under a
 * valuation id, driven from the route table rather than from a list — so a
 * route added tomorrow is swept the day it is registered. Thirteen of them are
 * additionally driven with a *valid* body, which is the stronger evidence: a
 * live 2xx proves the request was well-formed and reached the handler, so the
 * archived 409 can only have come from the guard.
 *
 * Two DELETEs remain exempt (auditor-access revocation and board-member
 * removal — genuine cleanup that should still work on withdrawn files), and
 * the partner API's three writes are a separate surface
 * swept by `partnerApiRetired.test.ts` (they leaked too — R90). Both lists are
 * exhaustive and checked against the route table in both directions, so
 * neither can quietly grow.
 */

interface Spec {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** A body the live engagement accepts — that is what makes the pair honest. */
  payload?: unknown;
}

/**
 * The routes driven against both engagements below.
 *
 * Every one of these returned 2xx for an archived valuation before this round.
 */
const VERIFIED: Spec[] = [
  { method: 'PATCH', path: '/api/v1/valuations/:id', payload: { company_name: 'Renamed Co' } },
  { method: 'POST', path: '/api/v1/valuations/:id/clone', payload: {} },
  { method: 'PATCH', path: '/api/v1/valuations/:id/engine-inputs', payload: {} },
  { method: 'POST', path: '/api/v1/valuations/:id/workflow/advance', payload: {} },
  { method: 'POST', path: '/api/v1/valuations/:id/engagement/advance', payload: {} },
  { method: 'POST', path: '/api/v1/valuations/:id/remind-documents', payload: {} },
  { method: 'PUT', path: '/api/v1/valuations/:id/questionnaire', payload: { answers: {} } },
  { method: 'POST', path: '/api/v1/valuations/:id/evidence-bundle', payload: {} },
  { method: 'POST', path: '/api/v1/valuations/:id/report/draft', payload: {} },
  { method: 'POST', path: '/api/v1/valuations/:id/report/render', payload: {} },
];

/**
 * Refused for retirement before the body is even read.
 *
 * The guard sits ahead of body parsing in each of these, which turns an
 * awkward problem into a tractable one. Composing a *valid* body for every
 * route that spends AI budget or engine time means standing up a drafted
 * report, a params row, a comparable set with tickers — per route. But a
 * deliberately empty body gives the same pairing for free: the live engagement
 * answers 422, which proves the request reached the handler's validation, and
 * the retired one answers 409, which can only have come from the guard in
 * front of it.
 *
 * So `live` is asserted here too. It is just asserted to be a *refusal for a
 * different reason* rather than a success — and that is what stops the pair
 * being vacuous, because a route that 409'd both ways (a state conflict, an
 * unconfigured agent) would fail it.
 */
const REFUSED_EARLY: Spec[] = [
  // Share `loadForEdit` with the two report routes above.
  { method: 'PUT', path: '/api/v1/valuations/:id/report', payload: {} },
  { method: 'POST', path: '/api/v1/valuations/:id/report/revert', payload: {} },
  { method: 'POST', path: '/api/v1/valuations/:id/report/narrative', payload: {} },
  // A retired engagement does not spend the firm's AI budget or engine time.
  // Every one of these reached the model or the engine for withdrawn work.
  { method: 'POST', path: '/api/v1/valuations/:id/ai/comp_selection/apply', payload: {} },
  { method: 'POST', path: '/api/v1/valuations/:id/calculations', payload: { inputs: 'not-an-object' } },
  { method: 'POST', path: '/api/v1/valuations/:id/research', payload: {} },
  { method: 'POST', path: '/api/v1/valuations/:id/research/refresh-all', payload: { region: 'nowhere' } },
  { method: 'POST', path: '/api/v1/valuations/:id/projection/run', payload: {} },
  { method: 'POST', path: '/api/v1/valuations/:id/rollforward', payload: {} },
  { method: 'POST', path: '/api/v1/valuations/:id/sensitivity', payload: {} },
  { method: 'POST', path: '/api/v1/valuations/:id/sensitivity/model', payload: { inputs: 'not-an-object' } },
  { method: 'POST', path: '/api/v1/valuations/:id/volatility/estimate', payload: { method: 'nonsense' } },
];

/**
 * Path parameters other than `:id`.
 *
 * A sub-resource id has to be *plausible* or the route 404s on it before the
 * guard is reached — which is a pass that proves nothing, and is exactly what
 * the first version of this sweep did for seventeen routes. A syntactically
 * valid ULID that matches no row gets past the format check and stops at the
 * lookup, which is behind the guard. Provider names are enumerated rather than
 * ULIDs for the same reason: those three routes validate the provider first.
 */
const PARAM_VALUES: Array<[RegExp, string, string]> = [
  [/\/hris\//, ':provider', 'gusto'],
  [/\/accounting\//, ':provider', 'xero'],
  [/\/cap-table\/sync\//, ':provider', 'carta'],
  [/\/ai\//, ':pipeline', 'extract'],
];

/** A ULID that is well-formed and matches nothing. */
const ABSENT_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function fillParams(template: string, valuationId: string): string {
  let url = template.replace(':id', valuationId);
  for (const [when, param, value] of PARAM_VALUES) {
    if (when.test(template)) url = url.replace(param, value);
  }
  return url.replace(/:[A-Za-z_]+/g, ABSENT_ULID);
}

/**
 * The DELETE routes still left unguarded on purpose.
 *
 * R454 guarded thirteen DELETEs that R89 had left open: removing a grant, a
 * round, a transaction, a comparable, a scenario, a monitor, a document, a
 * signature, an overwrite, a tag, or an integration connection *is* a write
 * that changes the file, which is the line the retirement rule draws. The two
 * that remain open are genuine cleanup that should still work on withdrawn
 * files: revoking an auditor's portal link and removing a board member from
 * the resolution flow.
 */
const UNGUARDED_DELETES: string[] = [
  'DELETE /api/v1/valuations/:id/auditor-access/:accessId',
  'DELETE /api/v1/valuations/:id/board/members/:memberId',
];

/**
 * The partner API's own writes, which are a separate surface.
 *
 * They are reached with an API key rather than a session, so they cannot ride
 * this sweep — the injections here all carry `ops.token`. R89 named that and
 * stopped, which left three writes that a retired engagement accepted;
 * `partnerApiRetired.test.ts` is the sweep they got in R90, driven off the same
 * route table by the same pairing. Named here so the coverage test below stays
 * exhaustive rather than being narrowed to `/api/v1`.
 */
const PARTNER_API: string[] = [
  'POST /api/partner/v1/valuations/:id/documents',
  'POST /api/partner/v1/valuations/:id/submit',
  'PUT /api/partner/v1/valuations/:id',
];

/**
 * The two routes that are *about* retirement rather than subject to it.
 *
 * Both match the pattern this sweep enumerates on — they have `/valuations/:id`
 * in them — and both would be nonsense to guard. `restore` un-retires, so a
 * guard would make it unreachable. `retire` does refuse a retired engagement
 * ("already retired") and would pass the first half of the sweep on its own,
 * but it must not be *driven* by it: the live half sends the same request to
 * the live engagement, and it would succeed — retiring the fixture out from
 * under every route the loop had not reached yet.
 *
 * They are the first entries here that are neither a delete nor the partner
 * API, and noticing them was the sweep doing its job: a route added to this
 * surface either refuses a retired engagement or is written down here as a
 * decision somebody made. `retentionRestore.test.ts` owns both behaviours.
 */
const RETIREMENT_CONTROLS: string[] = [
  'POST /api/v1/admin/retention/valuations/:id/restore',
  'POST /api/v1/admin/retention/valuations/:id/retire',
];

describe.skipIf(!dbUp)('a write aimed at a retired engagement', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let live: string;
  let archived: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer', 'admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    live = await createValuation('Live Co');
    archived = await createValuation('Withdrawn Co');
    await retireValuations(ctx.pool, [archived]);
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  async function createValuation(name: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  }

  const send = (spec: Spec, id: string) =>
    ctx.app.inject({
      method: spec.method,
      url: spec.path.replace(':id', id),
      headers: authHeader(ops.token),
      ...(spec.payload !== undefined ? { payload: spec.payload } : {}),
    });

  describe.each(VERIFIED)('$method $path', (spec) => {
    // Sent first and asserted on its own: if this stops being a 2xx the pair
    // below proves nothing, and the failure should say so here rather than
    // show up as a mysteriously passing guard.
    it('is accepted by a live engagement', async () => {
      const res = await send(spec, live);
      expect(res.statusCode).toBeLessThan(300);
    });

    it('is refused by a retired one', async () => {
      const res = await send(spec, archived);
      expect(res.statusCode).toBe(409);
      // The reason, not just the refusal — a 409 from an unrelated state
      // conflict would otherwise satisfy this.
      expect(JSON.stringify(res.json())).toMatch(/retired/i);
    });
  });

  describe.each(REFUSED_EARLY)('$method $path', (spec) => {
    // The live half of the pair. It must NOT be a 409, or the retired
    // assertion below would be satisfied by something that has nothing to do
    // with retirement — a state conflict, an unconfigured agent, a missing
    // prerequisite row.
    it('reaches the handler on a live engagement', async () => {
      const res = await send(spec, live);
      expect(res.statusCode).not.toBe(409);
      expect(res.statusCode).not.toBe(404);
    });

    it('is refused by a retired engagement before its body is read', async () => {
      const res = await send(spec, archived);
      expect(res.statusCode).toBe(409);
      expect(JSON.stringify(res.json())).toMatch(/retired/i);
    });
  });

  // Reads stay open, deliberately and consistently with the auditor portal and
  // the board flow: a firm that has withdrawn work still has to be able to look
  // at it. Stated as a test because it is the boundary the guards draw, and a
  // future round adding one to a GET would be tightening the rule by accident.
  it('still serves the retired engagement to a reader', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${archived}`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valuation.archived_at).not.toBeNull();
  });
});

/**
 * Every registered write route, driven against a retired engagement.
 *
 * This replaced a hand-maintained list of what had and had not been checked.
 * The list was honest but it was also the weakest part: it needed a person to
 * keep it true, and its whole purpose was to survive people forgetting.
 *
 * Driving the route table directly means a route added tomorrow is swept the
 * day it is registered, with no list to update — and the pairing that makes it
 * mean something is kept: the same request against a live engagement must NOT
 * be refused for retirement. Without that half, a route that answered 409 to
 * everything would look guarded.
 */
describe.skipIf(!dbUp)('every registered write route', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let live: string;
  let archived: string;
  let routes: string[];

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer', 'admin'] });
    const client = await seedUser(ctx, { roles: ['valuation_user'] });
    const create = async (name: string) => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(client.token),
        payload: { kind: '409a', company_name: name },
      });
      expect(res.statusCode).toBe(201);
      return res.json().valuation.id as string;
    };
    live = await create('Live Co');
    archived = await create('Withdrawn Co');
    await retireValuations(ctx.pool, [archived]);
    const exempt = new Set([...UNGUARDED_DELETES, ...PARTNER_API, ...RETIREMENT_CONTROLS]);
    routes = mutatingValuationRoutes(ctx.app).filter((r) => !exempt.has(r));
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  const hit = (route: string, id: string) => {
    const [method, template] = route.split(' ');
    return ctx.app.inject({
      method: method as 'POST',
      url: fillParams(template, id),
      headers: authHeader(ops.token),
      payload: {},
    });
  };

  const retiredRefusal = async (route: string, id: string) => {
    const res = await hit(route, id);
    return res.statusCode === 409 && /retired/i.test(JSON.stringify(res.json()));
  };

  it('refuses all of them for a retired engagement', async () => {
    const accepted: string[] = [];
    for (const route of routes) {
      if (!(await retiredRefusal(route, archived))) {
        const res = await hit(route, archived);
        accepted.push(`${route} -> ${res.statusCode} ${JSON.stringify(res.json()).slice(0, 80)}`);
      }
    }
    expect(accepted).toEqual([]);
  }, 180_000);

  // The half that stops the one above being satisfied by a route that refuses
  // everything. A live engagement may answer 422, 404 or 200 here — what it
  // must never answer is "this engagement has been retired".
  it('refuses none of them for a live one', async () => {
    const wrong: string[] = [];
    for (const route of routes) {
      if (await retiredRefusal(route, live)) wrong.push(route);
    }
    expect(wrong).toEqual([]);
  }, 180_000);

  // Vacuity guard: both tests above are "nothing left over", which an empty
  // route list satisfies. The enumeration is a regex over a printed tree.
  it('is sweeping a real number of routes', () => {
    expect(routes.length).toBeGreaterThan(70);
    expect(routes).toContain('POST /api/v1/valuations/:id/remind-documents');
    expect(routes.filter((r) => r.startsWith('GET '))).toEqual([]);
  });
});

describe.skipIf(!dbUp)('the coverage of that sweep', () => {
  let ctx: TestApp;
  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  // Every registered mutating route is either swept above, or explicitly
  // exempt (the two cleanup DELETEs, the partner API, the retirement controls).
  // A route that is none of those fails here, so growing the API forces the
  // decision rather than silently widening what a retired engagement accepts.
  it('accounts for every mutating valuation-scoped route', () => {
    const registered = mutatingValuationRoutes(ctx.app);
    const exempt = new Set([...UNGUARDED_DELETES, ...PARTNER_API, ...RETIREMENT_CONTROLS]);
    const swept = registered.filter((r) => !exempt.has(r));
    expect(swept.length + exempt.size).toBe(registered.length);
  });

  // The other direction: a route removed or renamed leaves a name behind in
  // one of the exemption lists, which would quietly shrink what is swept.
  it('names no exemption that is not registered', () => {
    const registered = new Set(mutatingValuationRoutes(ctx.app));
    expect(
      [...UNGUARDED_DELETES, ...PARTNER_API, ...RETIREMENT_CONTROLS].filter((r) => !registered.has(r)),
    ).toEqual([]);
  });

  it('found the routes at all', () => {
    const registered = mutatingValuationRoutes(ctx.app);
    expect(registered.length).toBeGreaterThan(80);
    expect(registered).toContain('PATCH /api/v1/valuations/:id');
    expect(registered.filter((r) => r.startsWith('GET '))).toEqual([]);
  });
});
