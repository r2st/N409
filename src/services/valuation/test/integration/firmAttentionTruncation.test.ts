import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { firmAttentionCandidates } from '../../src/repos/firmDashboard.js';

const dbUp = await isDbAvailable();

/**
 * The firm attention queue says when it could not see all of it.
 *
 * `firmAttentionCandidates` has always read at most ATTENTION_SCAN_LIMIT rows.
 * What was missing was any way to know the cap had bitten — and both callers
 * derive headline figures from what comes back: the dashboard's
 * `attention_total` and `attention_counts`, and `/firm/attention`'s own
 * `total`. For a firm with more live engagements than the cap, every one of
 * those reported the cap. A partner reads "1000 need attention", works the
 * list, and the rest of the backlog is not late — it is invisible, and nothing
 * anywhere says so.
 *
 * Every other capped list in this service already carries the flag (`listHolds`,
 * `listEnabledMonitors`, the comment and template pages). This one had a number
 * riding on it, which is what made it the one worth finding.
 *
 * Seeded past the real ceiling with one bulk INSERT rather than tested against
 * a lowered constant: the figure the product ships with is the one a firm can
 * actually cross, and a test that moves the ceiling would not have caught a
 * route that read the constant and forgot to pass the flag on.
 */
describe.skipIf(!dbUp)('firm attention queue truncation', () => {
  let ctx: TestApp;
  let firmId: string;
  let firmAdmin: { id: string; token: string };

  /**
   * Live engagements in a state the attention scan considers.
   *
   * One statement over unnested arrays rather than a thousand inserts: the
   * ceiling being crossed is the shipped one (1000), so the seeding has to be
   * cheap enough that using the real figure is not itself the reason to lower
   * it. Ids come from `newUlid` because `valuations.id` is a domain with a
   * Crockford-base32 CHECK on it.
   */
  const seedBulk = async (n: number, prefix: string): Promise<void> => {
    const ids = Array.from({ length: n }, () => newUlid());
    const names = ids.map((_, i) => `${prefix} ${i}`);
    await ctx.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id, partner_id, state, due_date, created_at)
       SELECT s.id, '409a', s.name, $3, $4, 'review',
              (now() + make_interval(days => (s.ord % 40)::int))::date,
              now() - make_interval(mins => s.ord::int)
         FROM unnest($1::ulid[], $2::text[]) WITH ORDINALITY AS s(id, name, ord)`,
      [ids, names, firmAdmin.id, firmId],
    );
  };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    firmId = await seedPartner(ctx, 'Broad Book Advisory');
    firmAdmin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  it('reports the queue as complete while it fits inside the scan', async () => {
    await seedBulk(5, 'Small Book');
    const { candidates, truncated } = await firmAttentionCandidates(ctx.pool, firmId, 1000);
    expect(candidates.length).toBe(5);
    expect(truncated).toBe(false);
  });

  it('flags the cut and returns exactly the limit, not the limit plus its probe row', async () => {
    // The read asks for limit + 1 to know whether there is a next row; that
    // extra row must not reach the caller, or the page would be one longer than
    // the ceiling it was asked for.
    const { candidates, truncated } = await firmAttentionCandidates(ctx.pool, firmId, 3);
    expect(candidates.length).toBe(3);
    expect(truncated).toBe(true);
  });

  it('carries the flag through GET /firm/attention', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/firm/attention?partner_id=${firmId}`,
      headers: authHeader(firmAdmin.token),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.truncated, 'a small book is not truncated').toBe(false);
    expect(body.total).toBe(body.attention.length);
    // The ceiling travels with the answer, so a caller can tell "1000 exactly"
    // from "1000 and counting" without knowing the constant.
    expect(body.scan_limit).toBeGreaterThan(0);
  });

  it('carries the flag through the firm dashboard', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/firm/dashboard?partner_id=${firmId}`,
      headers: authHeader(firmAdmin.token),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.attention_truncated).toBe(false);
    expect(body.attention_scan_limit).toBeGreaterThan(0);
  });

  describe('a book larger than the scan', () => {
    beforeAll(async () => {
      // Past the shipped ceiling. One statement, so the cost is a single round
      // trip rather than a thousand.
      await seedBulk(1_050, 'Wide Book');
    }, 60_000);

    it('tells the dashboard its totals are a floor, not a count', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/firm/dashboard?partner_id=${firmId}`,
        headers: authHeader(firmAdmin.token),
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.attention_truncated, 'the scan hit its ceiling and said nothing').toBe(true);
      // The figure itself is still the cap — that is the point. Before the flag
      // it was indistinguishable from a firm with exactly that many.
      expect(body.attention_total).toBe(body.attention_scan_limit);
    });

    it('tells GET /firm/attention the same thing', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/firm/attention?partner_id=${firmId}`,
        headers: authHeader(firmAdmin.token),
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.truncated).toBe(true);
      expect(body.total).toBe(body.scan_limit);
      expect(body.attention.length).toBe(body.scan_limit);
    });
  });
});
