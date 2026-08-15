import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The firm console is read *against* the engagement list underneath it, so the
 * two have to be counting the same rows.
 *
 * They were not. `buildValuationWhere` (repos/valuations.ts) filters
 * `archived_at IS NULL` for the list, the counts, the buckets and the export;
 * every query in repos/firmDashboard.ts wrote its own `WHERE partner_id = $1`
 * and none of them did. Archiving is the platform's soft delete — the retention
 * sweep stamps it, `retireValuations` stamps it — so a firm that retired three
 * engagements saw a header reading 15 above a list of 12, with no way to
 * reconcile the two. The natural reading of that gap is three engagements it
 * cannot find, not three it retired.
 *
 * Every assertion here is a comparison against the list, not a fixed number.
 * That is the property worth holding: the two surfaces have drifted once and
 * the thing that makes it a bug is the disagreement, not any particular total.
 */
describe.skipIf(!dbUp)('the firm console counts the same engagements its list shows', () => {
  let ctx: TestApp;
  let firmId: string;
  let firmAdmin: Awaited<ReturnType<typeof seedUser>>;
  let reviewer: Awaited<ReturnType<typeof seedUser>>;

  const LIVE_COMPANY = 'Marchetti Robotics';
  const RETIRED_COMPANY = 'Coldbrook Mining';

  const seedValuation = async (args: {
    company: string;
    state?: string;
    reviewerId?: string | null;
    archived?: boolean;
  }): Promise<string> => {
    const id = newUlid();
    await ctx.pool.query(
      `INSERT INTO valuations
         (id, kind, company_name, user_id, partner_id, state, due_date, assigned_reviewer_id, archived_at)
       VALUES ($1, '409a', $2, $3, $4, $5, now() + interval '30 days', $6, $7)`,
      [
        id,
        args.company,
        firmAdmin.id,
        firmId,
        args.state ?? 'review',
        args.reviewerId ?? null,
        args.archived ? new Date() : null,
      ],
    );
    return id;
  };

  const get = async (url: string) => {
    const res = await ctx.app.inject({ method: 'GET', url, headers: authHeader(firmAdmin.token) });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    firmId = await seedPartner(ctx, 'Marchetti Advisors');
    firmAdmin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    reviewer = await seedUser(ctx, { roles: ['analyst'], partnerId: firmId });

    // Two live engagements for one client, and two retired ones for a client
    // the firm no longer has. Both retired rows carry a reviewer and a live
    // state, so nothing but `archived_at` can exclude them.
    await seedValuation({ company: LIVE_COMPANY, reviewerId: reviewer.id });
    await seedValuation({ company: LIVE_COMPANY, state: 'published' });
    await seedValuation({ company: RETIRED_COMPANY, reviewerId: reviewer.id, archived: true });
    await seedValuation({ company: RETIRED_COMPANY, archived: true });
  });

  afterAll(async () => ctx?.teardown());

  it('agrees with the engagement list on how many there are', async () => {
    const { summary } = await get('/api/v1/firm/dashboard');
    const list = await get('/api/v1/valuations?per_page=100');

    expect(list.valuations).toHaveLength(2);
    expect(summary.total).toBe(list.valuations.length);
  });

  it('does not count a retired engagement in any of its state rollups', async () => {
    const { summary } = await get('/api/v1/firm/dashboard');
    // `review` is the retired rows' own state, so a leak lands here first.
    expect(summary.by_state.review).toBe(1);
    expect(summary.active).toBe(1);
    expect(summary.published).toBe(1);
  });

  it('drops a client the firm no longer has from the roster', async () => {
    const { clients, total } = await get('/api/v1/firm/clients?per_page=50');
    const names = clients.map((c: { company_name: string }) => c.company_name);

    expect(names).toEqual([LIVE_COMPANY]);
    expect(names).not.toContain(RETIRED_COMPANY);
    // The roster's own total is a second query with its own WHERE, so it can
    // disagree with the page it is counting.
    expect(total).toBe(clients.length);
  });

  it('stops charging retired work to the reviewer who last held it', async () => {
    const { team } = await get('/api/v1/firm/dashboard');
    const entry = team.find((m: { user_id: string }) => m.user_id === reviewer.id);

    // One live engagement assigned, plus one retired one that must not count.
    expect(entry).toBeDefined();
    expect(entry.assigned).toBe(1);
    expect(entry.active).toBe(1);
  });

  it('leaves retired engagements out of the attention queue', async () => {
    const { attention } = await get('/api/v1/firm/attention');
    const companies = attention.map((a: { company_name: string }) => a.company_name);
    expect(companies).not.toContain(RETIRED_COMPANY);
  });
});
