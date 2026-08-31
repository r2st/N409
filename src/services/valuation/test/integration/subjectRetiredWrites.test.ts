import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { retireValuations } from '../../src/repos/valuationPurge.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const ROUTES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routes');

/**
 * Writes that reach a retired engagement without naming it in the path.
 *
 * THE SHAPE, which is now five rounds old. R89 asked the retirement question of
 * every mutating route *under a valuation id*, driven out of Fastify's route
 * table so a route added tomorrow is swept the day it is registered. That
 * property is the reason the sweep has held for two hundred rounds — and it is
 * also the reason it has a blind spot it structurally cannot see past: a
 * request addressed by the subject's own id does not mention the engagement,
 * so the engagement is only reachable by a second read that the handler alone
 * knows to make.
 *
 * R279 found the first surface out there — the whole ASC 820 measurement
 * surface, where a fund portfolio and a debt instrument are addressed by their
 * own ids, and where not one of the ten mutating routes carried a retirement
 * check. R282 asked whether that was the only one, and it was not. Three more
 * writes reach a withdrawn file from outside the sweep's reach, and all three
 * have the same tell: **the guard is on the create and not on the edit**,
 * because the create is under a valuation id and the edit is not.
 *
 *   * `PATCH /api/v1/tasks/:id` — `POST /valuations/:id/tasks` has refused to
 *     open a task on withdrawn work since R89. The edit let the same task be
 *     retitled, reassigned, given a new due date or moved to done, writing a
 *     `review_task_updated` onto a spine `valuation_events_immutable` will not
 *     let anything erase.
 *   * `PATCH /api/v1/comments/:commentId` — the same pair over the thread the
 *     client and the reviewer read, with `POST /valuations/:id/comments`
 *     guarded since R89 and the edit not.
 *   * `POST /api/v1/organizations/:id/entities` — the same *write* as
 *     `PATCH /valuations/:id/entity`, through the other door. Both set the
 *     engagement's `organization_id` and `entity_type`; only the one under a
 *     valuation id was swept, so withdrawn work could still be added to a
 *     consolidation group and counted into a roll-up.
 *
 * Same method as the census it extends, and for the same reason: every request
 * is sent twice, once against a live engagement and once against a retired
 * one, with an identical body. The live 2xx proves the request was well-formed
 * and reached the handler, so the retired 409 can only have come from the
 * guard. A one-sided test would pass on a 422 from body validation.
 */
describe.skipIf(!dbUp)('subject-addressed writes against a retired engagement', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  /** { live, retired } subjects, per surface. */
  let liveTask: string;
  let retiredTask: string;
  let liveComment: string;
  let retiredComment: string;
  let liveValuation: string;
  let retiredValuation: string;
  let organization: string;
  /** The registered route patterns this file drove a 409 out of. */
  const refused = new Set<string>();

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    ops = await seedUser(ctx, { roles: ['reviewer'] });

    const valuation = async (name: string): Promise<string> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(ops.token),
        payload: { kind: '409a', company_name: name },
      });
      expect(res.statusCode).toBe(201);
      return res.json().valuation.id as string;
    };
    const task = async (valuationId: string): Promise<string> => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/tasks`,
        headers: authHeader(ops.token),
        payload: { kind: 'other', title: 'Chase the cap table', assignee_id: ops.id },
      });
      expect(res.statusCode).toBe(201);
      return res.json().task.id as string;
    };
    const comment = async (valuationId: string): Promise<string> => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/comments`,
        headers: authHeader(ops.token),
        payload: { kind: 'note', body: 'Waiting on the 2025 financials.' },
      });
      expect(res.statusCode).toBe(201);
      return res.json().comment.id as string;
    };

    liveValuation = await valuation('Live Engagement');
    retiredValuation = await valuation('Retired Engagement');
    liveTask = await task(liveValuation);
    retiredTask = await task(retiredValuation);
    liveComment = await comment(liveValuation);
    retiredComment = await comment(retiredValuation);

    const org = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authHeader(ops.token),
      payload: { name: 'Holdco Group' },
    });
    expect(org.statusCode).toBe(201);
    organization = org.json().organization.id as string;

    // Everything above was set up while the work was live. The withdrawal is
    // the last act, exactly as it is in life — and through `retireValuations`
    // rather than a raw UPDATE, because `findValuationById` reads through a
    // cache that already holds every one of these rows. A hand-written UPDATE
    // leaves the guard under test reading `archived_at: null`, which is a
    // vacuous pass rather than a real one.
    const retired = await retireValuations(ctx.pool, [retiredValuation]);
    expect(retired.retired).toEqual([retiredValuation]);
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  /**
   * Drive one request against both subjects. `live` is the control.
   *
   * `route` is the registered pattern the concrete URL below stands for, and a
   * retired 409 records it. The census at the bottom then checks its guarded
   * list against what this file actually refused, so a route cannot be listed
   * as guarded on the strength of the list saying so.
   */
  async function pair(
    route: string,
    method: 'POST' | 'PUT' | 'PATCH',
    url: (subject: string) => string,
    payload: (subject: string) => unknown,
    subjects: { live: string; retired: string },
  ): Promise<{ live: number; retired: number }> {
    const send = async (s: string) =>
      (await app.inject({ method, url: url(s), headers: authHeader(ops.token), payload: payload(s) }))
        .statusCode;
    const live = await send(subjects.live);
    const retired = await send(subjects.retired);
    if (retired === 409) refused.add(`${method} ${route}`);
    return { live, retired };
  }

  it('refuses editing a task on a retired engagement', async () => {
    const { live, retired } = await pair(
      '/api/v1/tasks/:id',
      'PATCH',
      (t) => `/api/v1/tasks/${t}`,
      () => ({ status: 'done' }),
      { live: liveTask, retired: retiredTask },
    );
    expect(live).toBe(200);
    expect(retired).toBe(409);
  });

  it('refuses editing a comment on a retired engagement', async () => {
    const { live, retired } = await pair(
      '/api/v1/comments/:commentId',
      'PATCH',
      (c) => `/api/v1/comments/${c}`,
      () => ({ body: 'Client says the financials are coming Friday.' }),
      { live: liveComment, retired: retiredComment },
    );
    expect(live).toBe(200);
    expect(retired).toBe(409);
  });

  it('refuses adding a retired engagement to a consolidation group', async () => {
    const { live, retired } = await pair(
      '/api/v1/organizations/:id/entities',
      'POST',
      () => `/api/v1/organizations/${organization}/entities`,
      (v) => ({ valuation_id: v, entity_type: 'subsidiary' }),
      { live: liveValuation, retired: retiredValuation },
    );
    expect(live).toBe(204);
    expect(retired).toBe(409);
  });

  /**
   * The gate that makes the next one of these fail rather than ship.
   *
   * The population is small and nameable: the mutating routes registered in a
   * route file that *already knows about retirement*, minus the ones under a
   * valuation id, which R89's sweep drives out of the route table on its own.
   * A file that imports a guard has had the question put to it, so every write
   * it registers owes an answer — and the three bugs above are precisely the
   * writes that sat in such a file with no answer and nothing asking.
   *
   * Scanned from source rather than from the route table because the route
   * table cannot say which *file* a route came from, and the file is the unit
   * that carries the knowledge. Both directions are checked: an unclassified
   * route fails, and a classified route that no longer exists fails too, so a
   * rename cannot leave a line behind that reads as coverage.
   */
  describe('the census behind the sweep', () => {
    /** Refuses a write aimed at a retired engagement, and is driven above. */
    const OWNED = [
      'PATCH /api/v1/comments/:commentId',
      'PATCH /api/v1/tasks/:id',
      'POST /api/v1/organizations/:id/entities',
    ];

    /**
     * Guarded, and driven by `measurementRetiredWrites.test.ts` — which owns
     * its own census of this surface, taken against the route table rather
     * than against source, and proves its own guarded list the same way.
     * Listed here so this census stays exhaustive over its population; a guard
     * removed from one of these fails there, not here.
     */
    const CROSS_REFERENCED = [
      'PATCH /api/v1/funds/:id',
      'PATCH /api/v1/funds/:id/positions/:pid',
      'POST /api/v1/funds/:id/positions',
      'POST /api/v1/funds/:id/positions/:pid/marks',
      'POST /api/v1/funds/:id/positions/:pid/rollforward',
      'PUT /api/v1/funds/:id/lp-terms',
      'PUT /api/v1/funds/:id/valuation',
      'POST /api/v1/debt/instruments/:id/value',
      'PUT /api/v1/debt/instruments/:id',
      'PUT /api/v1/debt/instruments/:id/credit-terms',
      'PUT /api/v1/debt/instruments/:id/valuation',
    ];

    /**
     * Open on a withdrawn file, each for a reason.
     *
     * A route landing here needs the argument made about it, which is the
     * whole point of the list: the failure mode is a genuinely mutating route
     * parked here to make the census pass.
     */
    const EXEMPT: Record<string, string> = {
      // Cleanup on a withdrawn file is the standing exemption the board flow
      // made before there was a rule, and `DELETE /funds/:id` depends on it:
      // it tells the caller to detach first.
      'DELETE /api/v1/comments/:commentId': 'cleanup',
      'DELETE /api/v1/funds/:id': 'cleanup',
      'DELETE /api/v1/funds/:id/positions/:pid': 'cleanup',
      'DELETE /api/v1/debt/instruments/:id': 'cleanup',
      'DELETE /api/v1/organizations/:id': 'cleanup',
      'DELETE /api/v1/organizations/:id/entities/:valuationId': 'cleanup',
      // Creates nothing on an engagement — the subject is unlinked at birth,
      // and linking it is a separate, guarded route.
      'POST /api/v1/funds': 'creates an unlinked subject',
      'POST /api/v1/debt/instruments': 'creates an unlinked subject',
      'POST /api/v1/organizations': 'creates an unlinked subject',
      // The organization's own row. A consolidation group is not an
      // engagement and has no `archived_at`; what belongs to it is guarded on
      // the two routes that change membership.
      'PATCH /api/v1/organizations/:id': 'not an engagement',
      'POST /api/v1/valuations': 'creates the engagement itself',
      // Calculators: they read, call the engine and return the answer,
      // persisting nothing, so they are reads by the doctrine's definition.
      'POST /api/v1/funds/:id/waterfall': 'persists nothing',
      'POST /api/v1/funds/:id/calibrate': 'persists nothing',
      'POST /api/v1/debt/rating-spread': 'persists nothing',
      // Names no engagement: the roster is the sweep's own, and each already
      // applies the retirement rule per row it touches.
      'POST /api/v1/admin/engagements/remind-overdue': 'sweep over its own roster',
      'POST /api/v1/admin/monitors/scan': 'sweep over its own roster',
      'POST /api/v1/admin/webhooks/retry': 'sweep over its own roster',
      'POST /api/v1/admin/webhooks/deliveries/replay': 'sweep over its own roster',
      'POST /api/v1/valuations/bulk': 'bulk surface, swept by bulkRetired.test.ts',
      'POST /api/v1/valuations/bulk-action': 'bulk surface, swept by bulkRetired.test.ts',
      // Inbound client mail, deliberately still captured. Refusing it would
      // drop a message the client has already sent, which is worse than
      // recording it against work the firm has withdrawn — and unlike every
      // other write here, nobody on the firm's side asked for it.
      'POST /api/v1/inbox/email': 'inbound mail is captured, never refused',
    };

    /** `METHOD /path` for every mutating route in a retirement-aware file. */
    function subjectAddressedWrites(): string[] {
      const rx = /app\.(post|put|patch|delete)\(\s*\n?\s*'([^']+)'/gu;
      const found: string[] = [];
      for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
        const text = readFileSync(path.join(ROUTES, file), 'utf8');
        if (!text.includes('domain/retiredEngagement.js')) continue;
        for (const m of text.matchAll(rx)) {
          if (m[2]!.includes('/valuations/:id')) continue;
          found.push(`${m[1]!.toUpperCase()} ${m[2]!}`);
        }
      }
      return found.sort();
    }

    it('finds the files it means to scan', () => {
      // A scan that matched nothing would pass every assertion below.
      expect(subjectAddressedWrites().length).toBeGreaterThan(20);
    });

    it('classifies every subject-addressed write in a retirement-aware file', () => {
      expect(subjectAddressedWrites()).toEqual(
        [...OWNED, ...CROSS_REFERENCED, ...Object.keys(EXEMPT)].sort(),
      );
    });

    it('drove a refusal out of every route it calls its own', () => {
      expect(OWNED.filter((route) => !refused.has(route))).toEqual([]);
    });
  });
});
