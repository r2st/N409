import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { retireValuations } from '../../src/repos/valuationPurge.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

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
 * WHAT IS NOT CLAIMED. 104 mutating valuation-scoped routes are registered and
 * 13 are verified here. The other 91 are listed by name below rather than
 * quietly omitted, because "not swept" and "safe" are different facts and the
 * gap between them is exactly where R57's residue lived. The coverage test is
 * what makes the list load-bearing: a route added tomorrow belongs to neither
 * set and fails, so somebody has to decide which it is.
 */

/** `METHOD /path` for every mutating route registered under a valuation id. */
export function mutatingValuationRoutes(app: FastifyInstance): string[] {
  // Parsed out of the printed tree because Fastify does not otherwise expose
  // its route table. Each line carries its own indentation and the segment is
  // relative to the last shallower one, so the full path is rebuilt from a
  // stack rather than read off the line.
  const stack: Array<{ indent: number; seg: string }> = [];
  const found = new Set<string>();
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = /^([\s│├└─]*)(\S[^(]*?)\s*\(([A-Z, ]+)\)\s*$/u.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const full = stack.map((s) => s.seg).join('') + m[2].trim();
    stack.push({ indent, seg: m[2].trim() });
    if (!/\/valuations\/:id\b/u.test(full)) continue;
    for (const method of m[3].split(',').map((x) => x.trim())) {
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        found.add(`${method} ${full}`);
      }
    }
  }
  return [...found].sort();
}

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
 * These three share `loadForEdit` with the two report routes above and take the
 * guard on the same line, but a valid body for them needs a report that has
 * been drafted and versioned first. They are asserted one-sided on purpose, and
 * the pairing they lack is supplied by `report/draft` and `report/render`
 * sitting beside them in the same file with the same guard.
 */
const REFUSED_EARLY: Spec[] = [
  { method: 'PUT', path: '/api/v1/valuations/:id/report', payload: {} },
  { method: 'POST', path: '/api/v1/valuations/:id/report/revert', payload: {} },
  { method: 'POST', path: '/api/v1/valuations/:id/report/narrative', payload: {} },
];

/**
 * Registered, mutating, and **not** exercised against an archived engagement.
 *
 * Not a safe list — an unswept one. Several of these almost certainly refuse
 * already (the auditor-access and board routes were fixed in earlier rounds and
 * have their own tests; `payments/checkout` was R57's). Several probably do
 * not. Writing them out is the point: the next round can pick from a list
 * rather than rediscover the question, and nothing here can be mistaken for a
 * clean bill of health.
 */
const UNSWEPT: string[] = [
  'DELETE /api/v1/valuations/:id/accounting/:provider',
  'DELETE /api/v1/valuations/:id/auditor-access/:accessId',
  'DELETE /api/v1/valuations/:id/board/members/:memberId',
  'DELETE /api/v1/valuations/:id/cap-table/sync/:provider',
  'DELETE /api/v1/valuations/:id/comparables/:itemId',
  'DELETE /api/v1/valuations/:id/documents/:documentId',
  'DELETE /api/v1/valuations/:id/grants/:grantId',
  'DELETE /api/v1/valuations/:id/hris/:provider',
  'DELETE /api/v1/valuations/:id/monitor',
  'DELETE /api/v1/valuations/:id/overwrites/:field_key',
  'DELETE /api/v1/valuations/:id/rounds/:roundId',
  'DELETE /api/v1/valuations/:id/scenarios/:scenarioId',
  'DELETE /api/v1/valuations/:id/signatures/:role',
  'DELETE /api/v1/valuations/:id/tags/:slug',
  'DELETE /api/v1/valuations/:id/transactions/:transactionId',
  'PATCH /api/v1/valuations/:id/company-profile',
  'PATCH /api/v1/valuations/:id/comparables/:itemId',
  'PATCH /api/v1/valuations/:id/entity',
  'PATCH /api/v1/valuations/:id/grants/:grantId',
  'PATCH /api/v1/valuations/:id/params',
  'PATCH /api/v1/valuations/:id/pipeline',
  'PATCH /api/v1/valuations/:id/rounds/:roundId',
  'PATCH /api/v1/valuations/:id/tags/:slug',
  'PATCH /api/v1/valuations/:id/workbook',
  'POST /api/partner/v1/valuations/:id/documents',
  'POST /api/partner/v1/valuations/:id/submit',
  'POST /api/v1/valuations/:id/accounting/:provider/connect',
  'POST /api/v1/valuations/:id/accounting/:provider/import',
  'POST /api/v1/valuations/:id/ai/:pipeline',
  'POST /api/v1/valuations/:id/ai/anonymize',
  'POST /api/v1/valuations/:id/ai/comp_selection/apply',
  'POST /api/v1/valuations/:id/ai/company_profile/apply',
  'POST /api/v1/valuations/:id/ai/extract/apply',
  'POST /api/v1/valuations/:id/ai/tagging/apply',
  'POST /api/v1/valuations/:id/asc718',
  'POST /api/v1/valuations/:id/auditor-access',
  'POST /api/v1/valuations/:id/board',
  'POST /api/v1/valuations/:id/board/members',
  'POST /api/v1/valuations/:id/board/members/:memberId/send',
  'POST /api/v1/valuations/:id/calculations',
  'POST /api/v1/valuations/:id/calculations/preflight',
  'POST /api/v1/valuations/:id/cap-table/preview',
  'POST /api/v1/valuations/:id/cap-table/sync/:provider/connect',
  'POST /api/v1/valuations/:id/cap-table/sync/:provider/frequency',
  'POST /api/v1/valuations/:id/cap-table/sync/:provider/pull',
  'POST /api/v1/valuations/:id/cap-table/upload',
  'POST /api/v1/valuations/:id/comments',
  'POST /api/v1/valuations/:id/comparables',
  'POST /api/v1/valuations/:id/comparables/refresh',
  'POST /api/v1/valuations/:id/comparables/screen',
  'POST /api/v1/valuations/:id/decisions',
  'POST /api/v1/valuations/:id/documents',
  'POST /api/v1/valuations/:id/documents/:documentId/review',
  'POST /api/v1/valuations/:id/engagement/assign',
  'POST /api/v1/valuations/:id/grants',
  'POST /api/v1/valuations/:id/health-checks',
  'POST /api/v1/valuations/:id/hris/:provider/connect',
  'POST /api/v1/valuations/:id/hris/:provider/frequency',
  'POST /api/v1/valuations/:id/hris/:provider/pull',
  'POST /api/v1/valuations/:id/monitor',
  'POST /api/v1/valuations/:id/monitor/new-valuation',
  'POST /api/v1/valuations/:id/payments/checkout',
  'POST /api/v1/valuations/:id/pipeline/runs',
  'POST /api/v1/valuations/:id/projection/:projectionId/apply',
  'POST /api/v1/valuations/:id/projection/run',
  'POST /api/v1/valuations/:id/qa',
  'POST /api/v1/valuations/:id/questionnaire/submit',
  'POST /api/v1/valuations/:id/research',
  'POST /api/v1/valuations/:id/research/refresh-all',
  'POST /api/v1/valuations/:id/review/decision',
  'POST /api/v1/valuations/:id/rollforward',
  'POST /api/v1/valuations/:id/rollforward/:runId/apply',
  'POST /api/v1/valuations/:id/rounds',
  'POST /api/v1/valuations/:id/scenarios',
  'POST /api/v1/valuations/:id/scenarios/preview',
  'POST /api/v1/valuations/:id/sensitivity',
  'POST /api/v1/valuations/:id/sensitivity/model',
  'POST /api/v1/valuations/:id/signatures',
  'POST /api/v1/valuations/:id/specialty',
  'POST /api/v1/valuations/:id/tags',
  'POST /api/v1/valuations/:id/tasks',
  'POST /api/v1/valuations/:id/transactions',
  'POST /api/v1/valuations/:id/volatility/:estimateId/apply',
  'POST /api/v1/valuations/:id/volatility/estimate',
  'POST /api/v1/valuations/:id/wacc/preview',
  'POST /api/v1/valuations/:id/workflow/reassign',
  'POST /api/v1/valuations/:id/workflow/restart',
  'PUT /api/partner/v1/valuations/:id',
  'PUT /api/v1/valuations/:id/asc718/settings',
  'PUT /api/v1/valuations/:id/cap-table',
  'PUT /api/v1/valuations/:id/overwrites/:field_key',
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

describe.skipIf(!dbUp)('the coverage of that sweep', () => {
  let ctx: TestApp;
  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  const covered = () => [...VERIFIED, ...REFUSED_EARLY].map((s) => `${s.method} ${s.path}`);

  // The load-bearing one. A mutating valuation-scoped route added tomorrow is
  // in neither list, so this fails and somebody has to say which it is —
  // verified, or knowingly unswept. That is the opposite of a guard that
  // silently keeps passing as the surface grows past it.
  it('accounts for every mutating valuation-scoped route', () => {
    const registered = mutatingValuationRoutes(ctx.app);
    const accounted = new Set([...covered(), ...UNSWEPT]);
    expect(registered.filter((r) => !accounted.has(r))).toEqual([]);
  });

  // And the other direction: a route removed or renamed leaves a name behind in
  // one of these lists, which would quietly shrink what the first test checks.
  it('names no route that is not registered', () => {
    const registered = new Set(mutatingValuationRoutes(ctx.app));
    expect([...covered(), ...UNSWEPT].filter((r) => !registered.has(r))).toEqual([]);
  });

  // Vacuity guard. Both tests above are "nothing left over", which an empty
  // enumeration satisfies perfectly — and the enumeration is a regex over a
  // printed tree, which is exactly the kind of thing that starts returning
  // nothing after a Fastify upgrade changes its box-drawing characters.
  it('found the routes at all', () => {
    const registered = mutatingValuationRoutes(ctx.app);
    expect(registered.length).toBeGreaterThan(80);
    expect(registered).toContain('POST /api/v1/valuations/:id/remind-documents');
    expect(registered).toContain('PATCH /api/v1/valuations/:id');
    // GETs must not be in it — the sweep is about writes, and a parser that
    // swept them in would make the unswept list meaningless.
    expect(registered.filter((r) => r.startsWith('GET '))).toEqual([]);
  });

  it('has no duplicates between the two lists', () => {
    const both = covered().filter((r) => UNSWEPT.includes(r));
    expect(both).toEqual([]);
  });
});
