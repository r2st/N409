import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXTRA_LOCKS, VERSION_COLUMNS } from '../../src/domain/concurrency.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The roster of optimistic locks, checked against the database and against the
 * running routes rather than against what anybody remembers.
 *
 * This exists because of how round 93's bug survived. `valuation_params` was
 * given a `version` in migration 0158 and every writer moved it from that day
 * on; the engine-inputs editor sent it back as `If-Match`; and the *other*
 * editor of the same row — the methodology form, forty-odd fields, the panel
 * analysts live in — never read the header at all. Nothing failed, because a
 * missing guard produces no symptom of its own. The evidence that it was
 * missing was a column nobody had cross-referenced against the routes.
 *
 * Two halves, and both matter:
 *
 *  1. Every `version` column in the schema has an entry saying what it is. A
 *     new one cannot be added without deciding whether it is a lock, which is
 *     the decision 0158 made and 0158's routes only half-carried out.
 *  2. Every route claimed as guarded is *asked*, over HTTP, with a malformed
 *     `If-Match`. A route that has stopped parsing the header cannot answer
 *     "Malformed If-Match header" — it will answer something about the body,
 *     or nothing at all. That is what keeps this from being a list checked
 *     against itself.
 */
describe.skipIf(!dbUp)('optimistic lock census', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'Census Co' },
    });
    valuationId = created.json().valuation.id;
  });
  afterAll(async () => ctx?.teardown());

  const lockTables = () =>
    Object.entries(VERSION_COLUMNS).filter(([, entry]) => entry.kind === 'lock') as Array<
      [string, Extract<(typeof VERSION_COLUMNS)[string], { kind: 'lock' }>]
    >;

  const allGuardedRoutes = () => [
    ...lockTables().flatMap(([, entry]) => entry.guardedRoutes),
    ...EXTRA_LOCKS.flatMap((l) => l.guardedRoutes),
  ];

  /**
   * The half that cannot be satisfied by editing the list: every `version`
   * column the database actually has needs an entry, and every entry needs a
   * column. A migration that adds one and stops there fails here.
   */
  it('has an entry for every version column in the schema, and no entry for a column that is gone', async () => {
    const { rows } = await ctx.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'version'
       ORDER BY table_name`,
    );
    const inSchema = rows.map((r) => r.table_name).sort();
    const registered = Object.keys(VERSION_COLUMNS).sort();
    expect(registered).toEqual(inSchema);
  });

  it('says what every non-lock version column is for instead', () => {
    for (const [table, entry] of Object.entries(VERSION_COLUMNS)) {
      if (entry.kind !== 'not-a-lock') continue;
      // A reason short enough to be a shrug is not a reason. The entries this
      // file exists to force are the ones somebody had to think about.
      expect(entry.reason.length, table).toBeGreaterThan(40);
    }
  });

  it('names only routes the service actually registers', () => {
    const registered = new Set(ctx.app.routeAudit.all());
    for (const route of allGuardedRoutes()) {
      expect(registered.has(route), `${route} is claimed as guarded but is not a registered route`).toBe(
        true,
      );
    }
  });

  /**
   * The behavioural half. A malformed `If-Match` has to be refused *by name* —
   * an unguarded route ignores the header entirely and answers about something
   * else, so the assertion is on the message and not merely on the status.
   *
   * The body is deliberately empty. Every one of these routes parses the header
   * before it parses the body, which is what makes one probe work for all of
   * them; a route that stopped doing so would report a body problem here and
   * fail, which is also the right answer — a header checked after the body is
   * a header a malformed request never reaches.
   */
  it.each(
    [...lockTables().flatMap(([table, e]) => e.guardedRoutes.map((r) => [table, r] as const))].concat(
      EXTRA_LOCKS.flatMap((l) => l.guardedRoutes.map((r) => [l.anchor, r] as const)),
    ),
  )('%s: %s refuses a malformed If-Match by name', async (_anchor, route) => {
    const [method, template] = route.split(' ') as [string, string];
    const res = await ctx.app.inject({
      method: method as 'PUT' | 'PATCH',
      url: template.replace(':id', valuationId),
      headers: { ...authHeader(ops.token), 'if-match': '"not-a-version"' },
      payload: {},
    });
    expect(res.statusCode, `${route}: ${res.body}`).toBe(422);
    expect(res.json().detail, route).toContain('If-Match');
  });

  /**
   * R277, methodology M19. Echoing the header back is right — "malformed" alone
   * leaves a client hand-rolling it guessing whether the quotes, the `W/` or the
   * value was the problem. But the six routes each interpolated `raw`, and a
   * request header's length and bytes belong to the caller: this `detail` is
   * drawn by the SPA, printed by whatever terminal a curl caller is looking at,
   * and repeated into a partner's integration log.
   *
   * Probed on one route, because there is one sentence now (`malformedIfMatch`)
   * and the census above is what proves all six reach it.
   */
  it('bounds and scrubs the header it quotes back', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}`,
      headers: { ...authHeader(ops.token), 'if-match': `"${'v'.repeat(2_000)}\u0007"` },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    const detail = String(res.json().detail);
    expect(detail).toContain('If-Match');
    expect(detail.length).toBeLessThan(200);
    // The bell is not something a terminal draws; it is something it does.
    expect(detail).not.toContain('\u0007');
    // And the refusal still says what to send instead.
    expect(detail).toMatch(/ETag/);
  });

  /**
   * And the reverse: a well-formed `If-Match` must not be answered with the
   * malformed-header message. Without this the probe above would pass on a
   * route that rejected every If-Match it was given, which is a guard nobody
   * can use — the same defect as no guard, wearing the opposite face.
   */
  it.each(allGuardedRoutes())('%s accepts a well-formed If-Match as a version', async (route) => {
    const [method, template] = route.split(' ') as [string, string];
    const res = await ctx.app.inject({
      method: method as 'PUT' | 'PATCH',
      url: template.replace(':id', valuationId),
      headers: { ...authHeader(ops.token), 'if-match': '"1"' },
      payload: {},
    });
    const detail = String(res.json().detail ?? '');
    expect(detail, route).not.toContain('Malformed If-Match');
  });
});
