import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { runDueAutoEmails } from '../../src/hooks/autoEmails.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Migration 0118 — the transactional/promotional line, end to end.
 *
 * The cases worth pinning are the two directions of the asymmetry: a marketing
 * opt-out stops the renewal offer, and it does not stop the message telling a
 * client their draft is ready. Getting the second one wrong is a service
 * failure that looks like compliance, which is why both are here rather than
 * only the first.
 */
describe.skipIf(!dbUp)('promotional auto emails', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  const scan = () =>
    runDueAutoEmails({ pool, publicBaseUrl: 'https://app.example.com', now: new Date('2100-01-01T00:00:00Z') });

  const outbox = async (templateKey: string) => {
    const { rows } = await pool.query<{ body: string; to_email: string }>(
      'SELECT body, to_email FROM email_outbox WHERE template_key = $1 ORDER BY created_at DESC',
      [templateKey],
    );
    return rows;
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { email: 'promo@client.example', roles: ['valuation_user'] });
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('seeds the six marketing campaigns as promotional and everything else as transactional', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/auto-emails',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const campaigns = res.json().auto_emails as Array<{ template_key: string; promotional: boolean }>;

    const promotional = campaigns.filter((c) => c.promotional).map((c) => c.template_key).sort();
    expect(promotional).toEqual(
      [
        'cancelled_followup',
        'ignored_reengagement',
        'material_event_check_in',
        'renewal_reminder',
        'report_feedback',
        'timeout_reengagement',
      ].sort(),
    );
    // Everything that chases a client for something we are blocked on stays
    // transactional — those are messages about work they asked for.
    const nudges = campaigns.filter((c) =>
      ['intake_reminder', 'captable_reminder', 'financials_reminder', 'payment_final_notice'].includes(
        c.template_key,
      ),
    );
    expect(nudges.length).toBeGreaterThan(0);
    expect(nudges.every((c) => !c.promotional)).toBe(true);
  });

  it('accepts and returns the flag on create and patch', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auto-emails',
      headers: authHeader(ops.token),
      payload: {
        name: 'promo_test_campaign',
        trigger_state: 'published',
        template_key: 'report_feedback',
        delay_hours: 0,
        promotional: true,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().auto_email.promotional).toBe(true);

    const id = created.json().auto_email.id as string;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/auto-emails/${id}`,
      headers: authHeader(ops.token),
      payload: { promotional: false },
    });
    expect(patched.json().auto_email.promotional).toBe(false);

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/auto-emails/${id}`,
      headers: authHeader(ops.token),
    });
  });

  it('defaults a new campaign to transactional', async () => {
    // The safe direction: an operator must consciously make something marketing.
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auto-emails',
      headers: authHeader(ops.token),
      payload: {
        name: 'promo_default_campaign',
        trigger_state: 'published',
        template_key: 'report_feedback',
        delay_hours: 0,
      },
    });
    expect(created.json().auto_email.promotional).toBe(false);
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/auto-emails/${created.json().auto_email.id}`,
      headers: authHeader(ops.token),
    });
  });

  it('withholds marketing from an opted-out client and still delivers transactional', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Optout Co' },
    });
    const valuationId = created.json().valuation.id as string;
    await pool.query(`UPDATE valuations SET state = 'published' WHERE id = $1`, [valuationId]);

    // Consent on: the marketing campaign sends.
    const first = await scan();
    expect(first.suppressed).toBe(0);
    const feedback = await outbox('report_feedback');
    expect(feedback.some((r) => r.to_email === client.email)).toBe(true);
    // …with the footer, because it is marketing.
    expect(feedback.find((r) => r.to_email === client.email)!.body).toContain(
      'https://app.example.com/settings',
    );

    // Opt out, and make the campaign due again by clearing its send record.
    await app.inject({
      method: 'PUT',
      url: '/api/v1/me/notification-preferences',
      headers: authHeader(client.token),
      payload: { preferences: [{ event_type: 'marketing', in_app: true, email: false }] },
    });
    await pool.query('DELETE FROM auto_email_sends WHERE valuation_id = $1', [valuationId]);
    await pool.query('DELETE FROM email_outbox WHERE valuation_id = $1', [valuationId]);

    const second = await scan();
    expect(second.suppressed).toBeGreaterThan(0);
    expect((await outbox('report_feedback')).some((r) => r.to_email === client.email)).toBe(false);

    // The transactional side of the same trigger state is untouched: the client
    // who unsubscribed from renewal offers is still told about their own file.
    const transactional = await pool.query<{ template_key: string; body: string }>(
      `SELECT template_key, body FROM email_outbox
        WHERE valuation_id = $1 AND template_key <> 'report_feedback'`,
      [valuationId],
    );
    expect(transactional.rowCount).toBeGreaterThan(0);
    // …and none of them carries an unsubscribe footer.
    expect(transactional.rows.every((r) => !r.body.includes('/settings'))).toBe(true);
  });
});
