import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { runRetentionSweep } from '../../src/routes/retention.js';

const dbUp = await isDbAvailable();

/**
 * Transactional mail about an engagement names the engagement.
 *
 * `email_outbox.valuation_id` is a predicate, not a label. `purgeOutbox`'s
 * legal-hold clause is `h.scope = 'valuation' AND h.reference_id =
 * e.valuation_id`, so a hold placed over one engagement freezes exactly the
 * outbox rows that name it — and `sendTransactionalEmail`, which is every
 * transactional send the platform makes, could not set the column: the field
 * was absent from its input type while `enqueueEmail` underneath already
 * accepted one. Every such row therefore carried NULL, a valuation-scoped hold
 * froze none of them, and the age sweep went on deleting the correspondence the
 * hold was placed to preserve.
 *
 * `retentionOutboxPurge` could not see this. It builds its rows by calling
 * `enqueueEmail` directly with an explicit `valuationId`, which proves the hold
 * clause works over a column nothing in production filled — a check that passes
 * by having nothing left to ask.
 *
 * So this drives the sends themselves and then runs the real sweep over what
 * they produced.
 */
describe.skipIf(!dbUp)('outbox rows for engagement mail name their engagement', () => {
  let ctx: TestApp;
  let pool: pg.Pool;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let analyst: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    pool = ctx.pool;
    admin = await seedUser(ctx, { roles: ['admin'] });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    analyst = await seedUser(ctx, { roles: ['data'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Outbox Scope Inc' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;

    // Overdue, with somebody to chase.
    const view = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/engagement`,
      headers: authHeader(ops.token),
    });
    expect(view.statusCode).toBe(200);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/engagement/assign`,
      headers: authHeader(ops.token),
      payload: { analyst_id: analyst.id },
    });
    await pool.query(
      `UPDATE engagements SET stage_entered_at = now() - interval '400 days' WHERE valuation_id = $1`,
      [valuationId],
    );
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  const outboxFor = async (templateKey: string) =>
    (
      await pool.query<{ id: string; valuation_id: string | null }>(
        'SELECT id, valuation_id FROM email_outbox WHERE template_key = $1',
        [templateKey],
      )
    ).rows;

  it('stamps the engagement on an overdue reminder', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/engagements/remind-overdue',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reminded).toContain(valuationId);

    const rows = await outboxFor('engagement_overdue');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valuation_id).toBe(valuationId);
  });

  it('stamps the engagement on a document reminder', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/remind-documents`,
      headers: authHeader(ops.token),
    });
    // A 409 here means every required document is already provided, which
    // would make the assertion below vacuous — the send never happened.
    expect(res.statusCode).toBe(200);

    const rows = await outboxFor('document_reminder');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valuation_id).toBe(valuationId);
  });

  it('a valuation-scoped legal hold freezes that engagement’s mail', async () => {
    // The consequence, end to end. Both messages above are backdated past the
    // policy age; a hold over the engagement must keep them, and the sweep must
    // count them as held rather than report a clean run.
    await pool.query(`UPDATE email_outbox SET status = 'sent', created_at = now() - interval '900 days'`);
    const before = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM email_outbox');
    expect(before.rows[0]!.n).toBeGreaterThan(0);

    await pool.query(
      `INSERT INTO legal_holds (id, scope, reference_id, reason, active)
       VALUES ($1, 'valuation', $2, 'R284 outbox scope', true)`,
      [newUlid(), valuationId],
    );
    const policy = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/retention/policies/email_outbox',
      headers: authHeader(admin.token),
      payload: { archive_after_days: null, retention_days: 730, enabled: true },
    });
    expect(policy.statusCode).toBe(200);

    const result = await runRetentionSweep(pool);
    expect(result.purged).toBe(0);
    const after = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM email_outbox');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});
