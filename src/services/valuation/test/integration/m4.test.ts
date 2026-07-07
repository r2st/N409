import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('M4 — Polish', () => {
  let ctx: TestApp;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let otherClient: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let reviewer: Awaited<ReturnType<typeof seedUser>>;

  const createValuation = async (companyName: string, token = client.token): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  const patchState = async (id: string, state: string) => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}`,
      headers: authHeader(ops.token),
      payload: { state },
    });
    expect(res.statusCode).toBe(200);
    return res.json().valuation;
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    otherClient = await seedUser(ctx, { roles: ['valuation_user'] });
    ops = await seedUser(ctx, { roles: ['admin'] });
    reviewer = await seedUser(ctx, { roles: ['reviewer'] });
  });
  afterAll(async () => ctx?.teardown());

  // ── Report template management (P1 #20) ────────────────────────────────────
  describe('report templates', () => {
    let v1Id: string;
    let v2Id: string;

    it('creates version 1 as a draft with the versioned label', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/report-templates',
        headers: authHeader(ops.token),
        payload: { name: '409a', kind: '409a', body: '# Report v1' },
      });
      expect(res.statusCode).toBe(201);
      const { template } = res.json();
      v1Id = template.id;
      expect(template.version).toBe(1);
      expect(template.label).toBe('409a.v1');
      expect(template.status).toBe('draft');
    });

    it('creating the same name again mints the next version', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/report-templates',
        headers: authHeader(ops.token),
        payload: { name: '409a', kind: '409a', body: '# Report v2' },
      });
      v2Id = res.json().template.id;
      expect(res.json().template.label).toBe('409a.v2');
    });

    it('edits a draft body', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/report-templates/${v1Id}`,
        headers: authHeader(ops.token),
        payload: { body: '# Report v1 (edited)' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().template.body).toContain('edited');
    });

    it('activating v2 archives the previously active v1', async () => {
      const a1 = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/report-templates/${v1Id}/activate`,
        headers: authHeader(ops.token),
      });
      expect(a1.json().template.status).toBe('active');

      const a2 = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/report-templates/${v2Id}/activate`,
        headers: authHeader(ops.token),
      });
      expect(a2.json().template.status).toBe('active');

      const list = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/report-templates?name=409a',
        headers: authHeader(ops.token),
      });
      const byLabel = Object.fromEntries(
        list.json().templates.map((t: { label: string; status: string }) => [t.label, t.status]),
      );
      expect(byLabel['409a.v1']).toBe('archived');
      expect(byLabel['409a.v2']).toBe('active');
    });

    it('refuses to edit a non-draft version', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/report-templates/${v2Id}`,
        headers: authHeader(ops.token),
        payload: { body: 'sneaky edit' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('is operations-only', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/report-templates',
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── Workflow engine (P1 #22) + auto emails (P1 #21) + notifications (P2) ───
  describe('workflow engine, emails, notifications', () => {
    let vid: string;

    it('auto-advances along the happy path', async () => {
      vid = await createValuation('Workflow Co');
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/workflow/advance`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().valuation.state).toBe('started');
    });

    it('reassigns the reviewer', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/workflow/reassign`,
        headers: authHeader(ops.token),
        payload: { reviewer_id: reviewer.id },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().valuation.assigned_reviewer_id).toBe(reviewer.id);
    });

    it('rejects reassignment to an unknown user', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/workflow/reassign`,
        headers: authHeader(ops.token),
        payload: { reviewer_id: '01JZZZZZZZZZZZZZZZZZZZZZZZ' },
      });
      expect(res.statusCode).toBe(422);
    });

    it('entering review notifies + emails the assigned reviewer', async () => {
      await patchState(vid, 'onboarding_completed');
      await patchState(vid, 'user_finished');
      await patchState(vid, 'completed');
      await patchState(vid, 'review');

      const notifications = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: authHeader(reviewer.token),
      });
      expect(notifications.statusCode).toBe(200);
      const reviewNote = notifications
        .json()
        .notifications.find((n: { type: string }) => n.type === 'review_needed');
      expect(reviewNote).toBeDefined();
      expect(reviewNote.valuation_id).toBe(vid);
      expect(notifications.json().unread_count).toBeGreaterThan(0);

      const outbox = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/admin/email-outbox?valuation_id=${vid}`,
        headers: authHeader(ops.token),
      });
      const emails = outbox.json().emails as Array<{ template_key: string; status: string; to_email: string }>;
      const reviewEmail = emails.find((e) => e.template_key === 'review_needed');
      expect(reviewEmail).toBeDefined();
      expect(reviewEmail!.to_email).toBe(reviewer.email);
      expect(reviewEmail!.status).toBe('sent'); // log transport marks delivery
    });

    it('publishing emails + notifies the owner', async () => {
      await patchState(vid, 'reviewed');
      await patchState(vid, 'drafted');
      await patchState(vid, 'draft_accepted');
      await patchState(vid, 'published');

      const notifications = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/notifications?unread=true',
        headers: authHeader(client.token),
      });
      const types = notifications.json().notifications.map((n: { type: string }) => n.type);
      expect(types).toContain('valuation_completed');
      expect(types).toContain('draft_ready');

      const outbox = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/admin/email-outbox?valuation_id=${vid}`,
        headers: authHeader(ops.token),
      });
      const templates = outbox.json().emails.map((e: { template_key: string }) => e.template_key);
      expect(templates).toContain('valuation_completed');
      expect(templates).toContain('draft_ready');
    });

    it('cannot advance or restart a published valuation', async () => {
      const advance = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/workflow/advance`,
        headers: authHeader(ops.token),
      });
      expect(advance.statusCode).toBe(409);
      const restart = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/workflow/restart`,
        headers: authHeader(ops.token),
      });
      expect(restart.statusCode).toBe(409);
    });

    it('restarts a cancelled valuation back to started', async () => {
      const otherId = await createValuation('Restart Co');
      await patchState(otherId, 'cancelled');
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${otherId}/workflow/restart`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().valuation.state).toBe('started');
    });

    it('workflow actions are operations-only', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/workflow/advance`,
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(403);
    });

    it('marks notifications read individually and in bulk', async () => {
      const list = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/notifications?unread=true',
        headers: authHeader(client.token),
      });
      const first = list.json().notifications[0];
      expect(first).toBeDefined();

      const read = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/notifications/${first.id}/read`,
        headers: authHeader(client.token),
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().notification.read_at).not.toBeNull();

      const readAll = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/notifications/read-all',
        headers: authHeader(client.token),
      });
      expect(readAll.statusCode).toBe(200);

      const count = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/notifications/unread-count',
        headers: authHeader(client.token),
      });
      expect(count.json().unread_count).toBe(0);
    });

    it("cannot read another user's notifications", async () => {
      const list = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: authHeader(otherClient.token),
      });
      expect(
        list.json().notifications.filter((n: { valuation_id: string }) => n.valuation_id === vid),
      ).toEqual([]);
    });
  });

  // ── Bulk actions (P1 #23) ───────────────────────────────────────────────────
  describe('bulk actions', () => {
    it('applies a state change across many valuations with per-item results', async () => {
      const a = await createValuation('Bulk A');
      const b = await createValuation('Bulk B');
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations/bulk',
        headers: authHeader(ops.token),
        payload: { ids: [a, b, '01JZZZZZZZZZZZZZZZZZZZZZZZ'], action: 'set_state', state: 'started' },
      });
      expect(res.statusCode).toBe(200);
      const { results, succeeded, failed } = res.json();
      expect(succeeded).toBe(2);
      expect(failed).toBe(1);
      expect(results.find((r: { ok: boolean }) => !r.ok).error).toBeDefined();
    });

    it('rejects illegal transitions per item instead of failing the batch', async () => {
      const a = await createValuation('Bulk C');
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations/bulk',
        headers: authHeader(ops.token),
        payload: { ids: [a], action: 'set_state', state: 'published' },
      });
      expect(res.json().failed).toBe(1);
      expect(res.json().results[0].error).toContain('Illegal transition');
    });

    it('bulk-assigns a reviewer', async () => {
      const a = await createValuation('Bulk D');
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations/bulk',
        headers: authHeader(ops.token),
        payload: { ids: [a], action: 'assign_reviewer', reviewer_id: reviewer.id },
      });
      expect(res.json().succeeded).toBe(1);
      const detail = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${a}`,
        headers: authHeader(ops.token),
      });
      expect(detail.json().valuation.assigned_reviewer_id).toBe(reviewer.id);
    });

    it('is operations-only', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations/bulk',
        headers: authHeader(client.token),
        payload: { ids: ['x'], action: 'advance' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── Transaction & funding-round history (P1 #24) ────────────────────────────
  describe('funding rounds & transactions', () => {
    let vid: string;
    let roundId: string;

    it('owner records a funding round', async () => {
      vid = await createValuation('History Co');
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/rounds`,
        headers: authHeader(client.token),
        payload: {
          name: 'Series A',
          security_type: 'Preferred',
          closed_on: '2025-11-01',
          amount_raised_cents: 500_000_000,
          pre_money_cents: 2_000_000_000,
          post_money_cents: 2_500_000_000,
          shares_issued: 1_000_000,
        },
      });
      expect(res.statusCode).toBe(201);
      roundId = res.json().round.id;
      expect(res.json().round.name).toBe('Series A');
    });

    it('ops updates the round; the change is audited', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${vid}/rounds/${roundId}`,
        headers: authHeader(ops.token),
        payload: { amount_raised_cents: 550_000_000 },
      });
      expect(res.statusCode).toBe(200);
      expect(Number(res.json().round.amount_raised_cents)).toBe(550_000_000);

      const events = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/events`,
        headers: authHeader(ops.token),
      });
      const types = events.json().events.map((e: { type: string }) => e.type);
      expect(types).toContain('funding_round_added');
      expect(types).toContain('funding_round_updated');
    });

    it('records and deletes share transactions', async () => {
      const created = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/transactions`,
        headers: authHeader(client.token),
        payload: {
          kind: 'secondary_sale',
          occurred_on: '2026-01-15',
          shares: 10_000,
          price_per_share_cents: 250,
          counterparty: 'Employee X',
        },
      });
      expect(created.statusCode).toBe(201);
      const txnId = created.json().transaction.id;

      const list = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/transactions`,
        headers: authHeader(client.token),
      });
      expect(list.json().transactions).toHaveLength(1);

      const del = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${vid}/transactions/${txnId}`,
        headers: authHeader(ops.token),
      });
      expect(del.statusCode).toBe(204);
    });

    it("another client can't even see the valuation's history (404)", async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/rounds`,
        headers: authHeader(otherClient.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── Global search (P2 #32) ──────────────────────────────────────────────────
  describe('global search', () => {
    it('ops finds valuations by name fragment and users by email', async () => {
      await createValuation('Searchable Ventures');
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/search?q=searchable',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(
        res.json().valuations.some((v: { company_name: string }) => v.company_name === 'Searchable Ventures'),
      ).toBe(true);

      const userRes = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/search?q=${encodeURIComponent(client.email.slice(0, 12))}`,
        headers: authHeader(ops.token),
      });
      expect(userRes.json().users.some((u: { id: string }) => u.id === client.id)).toBe(true);
    });

    it('clients are scoped to their own valuations and never see users', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/search?q=searchable',
        headers: authHeader(otherClient.token),
      });
      expect(res.json().valuations).toEqual([]);
      expect(res.json().users).toEqual([]);
    });

    it('rejects queries that are too short', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/search?q=a',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── Rich sort (P2 #30) ──────────────────────────────────────────────────────
  describe('rich sort', () => {
    it('sorts by multiple whitelisted columns', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations?sort=company_name:asc,created_at:desc&per_page=100',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const names = res.json().valuations.map((v: { company_name: string }) => v.company_name);
      expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
    });

    it('rejects non-whitelisted sort columns', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations?sort=password_digest:asc',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── CSV / PDF export (P2) ───────────────────────────────────────────────────
  describe('export', () => {
    it('exports CSV with the caller-visible rows', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations/export?format=csv',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('.csv');
      // merged M3/M4 exporter: the rich projection with joined owner/partner/reviewer
      expect(res.body.split('\r\n')[0]).toBe(
        'id,number,workflow_id,kind,state,company_name,service_name,owner_email,partner_name,source,currency,paid_status,waiting_on_client,reviewer_email,created_at,due_date,published_at',
      );
      expect(res.body).toContain('Searchable Ventures');
    });

    it('client CSV export is scoped to their own valuations', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations/export?format=csv',
        headers: authHeader(otherClient.token),
      });
      expect(res.body).not.toContain('Searchable Ventures');
    });

    it('exports a valid PDF', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations/export?format=pdf',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.rawPayload.subarray(0, 8).toString('latin1')).toContain('%PDF-1.4');
    });
  });

  // ── Sensitivity dashboard (P1 #19) ──────────────────────────────────────────
  describe('sensitivity', () => {
    it('computes the OPM stress grid for ops', async () => {
      const vid = await createValuation('Sensitive Co');
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/sensitivity`,
        headers: authHeader(ops.token),
        payload: {
          equity_value_cents: 5_000_000_000,
          strike_cents: 2_000_000_000,
          volatility: 0.6,
          term_years: 3,
          risk_free_rate: 0.043,
          common_shares: 10_000_000,
          dlom: 0.3,
        },
      });
      expect(res.statusCode).toBe(200);
      const { sensitivity } = res.json();
      expect(sensitivity.rows).toHaveLength(5);
      expect(sensitivity.rows[0]).toHaveLength(5);
      expect(sensitivity.base.fmvPerShareCents).toBeGreaterThan(0);
      expect(sensitivity.dlom).toBe(0.3);
    });

    it('is operations-only', async () => {
      const vid = await createValuation('Sensitive Two');
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${vid}/sensitivity`,
        headers: authHeader(client.token),
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
