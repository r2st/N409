import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Firm console routes. Two properties matter: the rollups are the firm's own
 * book and nobody else's, and a firm principal cannot reach another firm's
 * console by naming its id.
 */

const dbUp = await isDbAvailable();

const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000);

describe.skipIf(!dbUp)('firm dashboard', () => {
  let ctx: TestApp;
  let firmId: string;
  let rivalId: string;
  let firmAdmin: { id: string; token: string };
  let reviewer: { id: string; token: string; email: string };

  const seedValuation = async (args: {
    partnerId: string | null;
    userId: string;
    company: string;
    state?: string;
    dueDate?: Date | null;
    waiting?: boolean;
    reviewerId?: string | null;
    lastCommentAt?: Date | null;
    createdAt?: Date;
  }) => {
    const id = newUlid();
    await ctx.pool.query(
      `INSERT INTO valuations
         (id, kind, company_name, user_id, partner_id, state, due_date, waiting_on_client,
          assigned_reviewer_id, last_comment_at, created_at, published_at)
       VALUES ($1, '409a', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        args.company,
        args.userId,
        args.partnerId,
        args.state ?? 'review',
        args.dueDate === undefined ? daysFromNow(30) : args.dueDate,
        args.waiting ?? false,
        args.reviewerId ?? null,
        args.lastCommentAt ?? new Date(),
        args.createdAt ?? new Date(),
        args.state === 'published' ? new Date() : null,
      ],
    );
    return id;
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    firmId = await seedPartner(ctx, 'Meridian Valuation');
    rivalId = await seedPartner(ctx, 'Rival Advisory');
    firmAdmin = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    reviewer = await seedUser(ctx, { roles: ['reviewer'] });

    // The firm's book: one overdue, one unassigned in review, one healthy,
    // one published, plus a repeat client.
    await seedValuation({
      partnerId: firmId,
      userId: firmAdmin.id,
      company: 'Northwind Robotics',
      dueDate: daysFromNow(-5),
      reviewerId: reviewer.id,
    });
    await seedValuation({
      partnerId: firmId,
      userId: firmAdmin.id,
      company: 'Helio Bio',
      state: 'drafted',
      dueDate: null,
      reviewerId: null,
    });
    await seedValuation({
      partnerId: firmId,
      userId: firmAdmin.id,
      company: 'Calder Logistics',
      reviewerId: reviewer.id,
    });
    await seedValuation({
      partnerId: firmId,
      userId: firmAdmin.id,
      company: 'Northwind Robotics',
      state: 'published',
      dueDate: null,
      reviewerId: reviewer.id,
      createdAt: daysFromNow(-400),
    });

    // Another firm's engagement, and a direct client with no firm at all.
    await seedValuation({
      partnerId: rivalId,
      userId: firmAdmin.id,
      company: 'Rival Client Co',
      dueDate: daysFromNow(-30),
    });
    await seedValuation({ partnerId: null, userId: firmAdmin.id, company: 'Unattached Ltd' });
  });
  afterAll(() => ctx.teardown());

  const dashboard = (token: string, query = '') =>
    ctx.app.inject({ method: 'GET', url: `/api/v1/firm/dashboard${query}`, headers: authHeader(token) });

  it('rolls up only the caller’s own firm', async () => {
    const res = await dashboard(firmAdmin.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Four engagements are the firm's; the rival's and the unattached one are not.
    expect(body.summary.total).toBe(4);
    expect(body.summary.active).toBe(3);
    expect(body.summary.published).toBe(1);
    expect(body.summary.overdue).toBe(1);
    expect(body.summary.unassigned).toBe(1);
    expect(body.firm.id).toBe(firmId);
  });

  /**
   * The console greets the firm by the name its own clients read, which is
   * `publicPartnerName` and is gated on white label. This handler spelled the
   * fallback out by hand as `brand_name?.trim() || name` and so dropped the
   * gate: a firm that had typed a brand name into the branding form and not
   * turned white label on was greeted by a brand that existed nowhere else.
   */
  it('greets the firm by its live name, not by a brand it has only staged', async () => {
    await ctx.pool.query(
      `UPDATE partners SET brand_name = 'Ridgeline Capital Advisors', white_label_enabled = false
        WHERE id = $1`,
      [firmId],
    );
    expect((await dashboard(firmAdmin.token)).json().firm.name).toBe('Meridian Valuation');

    await ctx.pool.query('UPDATE partners SET white_label_enabled = true WHERE id = $1', [firmId]);
    expect((await dashboard(firmAdmin.token)).json().firm.name).toBe('Ridgeline Capital Advisors');

    await ctx.pool.query(`UPDATE partners SET brand_name = null, white_label_enabled = false WHERE id = $1`, [
      firmId,
    ]);
  });

  it('ranks the attention queue and never names another firm’s client', async () => {
    const {
      attention,
      attention_counts: counts,
      attention_total: total,
    } = (await dashboard(firmAdmin.token)).json();

    expect(attention[0]).toMatchObject({ company_name: 'Northwind Robotics', reason: 'overdue', days: 5 });
    expect(attention[1]).toMatchObject({ company_name: 'Helio Bio', reason: 'unassigned' });
    expect(counts).toMatchObject({ overdue: 1, unassigned: 1 });
    expect(total).toBe(2);
    expect(JSON.stringify(attention)).not.toContain('Rival Client Co');
  });

  it('reports workload per reviewer', async () => {
    const { team } = (await dashboard(firmAdmin.token)).json();
    const row = team.find((t: { user_id: string }) => t.user_id === reviewer.id);
    // Three assigned in this firm — two active, one published — and one overdue.
    expect(row).toMatchObject({ assigned: 3, active: 2, overdue: 1, email: reviewer.email });
  });

  it('groups the client roster by company rather than engagement', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/firm/clients',
      headers: authHeader(firmAdmin.token),
    });
    const { clients, total } = res.json();

    expect(total).toBe(3);
    const northwind = clients.find((c: { company_name: string }) => c.company_name === 'Northwind Robotics');
    expect(northwind).toMatchObject({ engagements: 2, active: 1 });
    expect(northwind.last_published_at).not.toBeNull();
  });

  it('searches the roster', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/firm/clients?search=helio',
      headers: authHeader(firmAdmin.token),
    });
    const { clients, total } = res.json();
    expect(total).toBe(1);
    expect(clients[0].company_name).toBe('Helio Bio');
  });

  it('pages the roster', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/firm/clients?per_page=2&page=2',
      headers: authHeader(firmAdmin.token),
    });
    const { clients, total, page } = res.json();
    expect(total).toBe(3);
    expect(page).toBe(2);
    expect(clients).toHaveLength(1);
  });

  it('refuses to show one firm another firm’s console', async () => {
    for (const url of ['/api/v1/firm/dashboard', '/api/v1/firm/clients', '/api/v1/firm/attention']) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `${url}?partner_id=${rivalId}`,
        headers: authHeader(firmAdmin.token),
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('turns away a direct client with no firm', async () => {
    const client = await seedUser(ctx, { roles: ['valuation_user'] });
    expect((await dashboard(client.token)).statusCode).toBe(403);
  });

  it('requires a session', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/firm/dashboard' })).statusCode).toBe(401);
  });

  it('lets ops open any firm’s console by naming it', async () => {
    const ops = await seedUser(ctx, { roles: ['admin'] });
    const res = await dashboard(ops.token, `?partner_id=${rivalId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().summary.total).toBe(1);
    // ...and must say which firm, since ops belong to none.
    expect((await dashboard(ops.token)).statusCode).toBe(400);
  });

  it('serves the full attention queue separately from the dashboard’s top slice', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/firm/attention',
      headers: authHeader(firmAdmin.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(2);
  });

  it('reports an empty book without failing', async () => {
    const quiet = await seedPartner(ctx, 'Quiet Firm');
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId: quiet });
    const body = (await dashboard(admin.token)).json();
    expect(body.summary.total).toBe(0);
    expect(body.attention).toEqual([]);
    expect(body.team).toEqual([]);
    expect(body.attention_counts.overdue).toBe(0);
  });
});
