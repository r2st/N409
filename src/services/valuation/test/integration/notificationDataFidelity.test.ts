import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { runDueAutoEmails } from '../../src/hooks/autoEmails.js';
import { onStateChanged } from '../../src/hooks/stateChange.js';
import { collectPlaceholders, TEMPLATE_VARIABLES } from '../../src/domain/templateVariables.js';
import { findValuationById } from '../../src/repos/valuations.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * What a client actually reads, on both send paths (R173).
 *
 * The unit census beside this one pins the variable *builders*. This pins the
 * wiring: that the drip scan's candidate query and the state-change hook put
 * real values in front of `renderTemplate`, rather than a subset that renders
 * a correct-looking preview and a broken email.
 *
 * Both paths are asserted on the `email_outbox` row, which is the message —
 * the transport is handed exactly this subject and body, and the retry sweep
 * re-sends exactly this row.
 */

const BASE = 'https://app.example.com';

/** Every name an engagement-scoped send must answer, as `name=[{{name}}]`. */
const PROBE = TEMPLATE_VARIABLES.filter(
  (v) =>
    v.scope === 'always' || v.scope === 'valuation' || ['valuation_link', 'payment_link'].includes(v.name),
)
  .map((v) => `${v.name}=[{{${v.name}}}]`)
  .join(' ');

/** The `name=[value]` pairs out of a rendered probe body. */
const pairs = (body: string): Record<string, string> =>
  Object.fromEntries([...body.matchAll(/(\w+)=\[([^\]]*)\]/g)].map((m) => [m[1]!, m[2]!]));

describe.skipIf(!dbUp)('notification data fidelity', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let partnerId: string;

  const settings = { get: async () => 'support@n409.test' };

  beforeAll(async () => {
    ctx = await setupTestApp();
    app = ctx.app;
    pool = ctx.pool;
    client = await seedUser(ctx, { email: 'dana@client.example', roles: ['valuation_user'] });
    await pool.query(`UPDATE users SET first_name = 'Dana' WHERE id = $1`, [client.id]);
    partnerId = await seedPartner(ctx, 'Fidelity');
    await pool.query('UPDATE system_settings SET value = $1 WHERE key = $2', [
      JSON.stringify('support@n409.test'),
      'support_email',
    ]);
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  /** A partner engagement with every field a template can name. */
  async function seedEngagement(companyName: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().valuation.id as string;
    await pool.query(
      `UPDATE valuations SET partner_id = $2, due_date = '2026-08-21T14:03:00Z' WHERE id = $1`,
      [id, partnerId],
    );
    // The measurement date is an engine input, not a valuation column (0041).
    await pool.query(
      `INSERT INTO valuation_params (valuation_id, engine_inputs)
       VALUES ($1, jsonb_build_object('valuation_date', '2026-08-07'))
       ON CONFLICT (valuation_id) DO UPDATE SET engine_inputs = EXCLUDED.engine_inputs`,
      [id],
    );
    return id;
  }

  it('renders every catalog variable on a drip campaign send', async () => {
    const valuationId = await seedEngagement('Probe Campaign Co');
    await pool.query(`UPDATE valuations SET state = 'published' WHERE id = $1`, [valuationId]);
    await pool.query(
      `UPDATE communication_templates SET subject = $1, body = $2, enabled = true WHERE key = 'report_feedback'`,
      ['Probe {{company_name}}', PROBE],
    );

    await runDueAutoEmails({
      pool,
      publicBaseUrl: BASE,
      settings,
      now: new Date('2100-01-01T00:00:00Z'),
    });

    const { rows } = await pool.query<{ body: string }>(
      `SELECT body FROM email_outbox WHERE valuation_id = $1 AND template_key = 'report_feedback'`,
      [valuationId],
    );
    expect(rows).toHaveLength(1);
    const body = rows[0]!.body;

    // No name the operator could pick out of the palette arrives as braces.
    expect(collectPlaceholders(body)).toEqual([]);
    const got = pairs(body);
    expect(got).toMatchObject({
      recipient_name: 'Dana',
      platform_name: 'Fidelity',
      support_email: 'support@n409.test',
      company_name: 'Probe Campaign Co',
      kind: '409a',
      kind_label: '409A',
      valuation_date: '2026-08-07',
      due_date: '2026-08-21',
      state_label: 'Published',
      partner_name: 'Fidelity',
      valuation_link: `${BASE}/valuations/${valuationId}`,
      payment_link: `${BASE}/valuations/${valuationId}`,
    });
    // The engagement number a client quotes, not an empty gap.
    expect(got.valuation_number).toMatch(/^\d+$/);
  });

  it('renders every catalog variable on a state-change workflow send', async () => {
    const valuationId = await seedEngagement('Probe Workflow Co');
    await pool.query(
      `UPDATE communication_templates SET subject = $1, body = $2, enabled = true WHERE key = 'draft_ready'`,
      ['Draft {{company_name}}', PROBE],
    );

    const valuation = (await findValuationById(pool, valuationId))!;
    await onStateChanged({ pool, log: app.log, publicBaseUrl: BASE, settings }, valuation, 'drafted');

    const { rows } = await pool.query<{ body: string; to_email: string }>(
      `SELECT body, to_email FROM email_outbox WHERE valuation_id = $1 AND template_key = 'draft_ready'`,
      [valuationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.to_email).toBe(client.email);

    expect(collectPlaceholders(rows[0]!.body)).toEqual([]);
    expect(pairs(rows[0]!.body)).toMatchObject({
      // Addressed to the owner, by name — the variable that previewed as "Dana"
      // and shipped as "{{recipient_name}}".
      recipient_name: 'Dana',
      company_name: 'Probe Workflow Co',
      // Read off valuation_params, which nothing on this path used to open.
      valuation_date: '2026-08-07',
      due_date: '2026-08-21',
      // Read off the partner row this hook already fetched and discarded.
      partner_name: 'Fidelity',
      platform_name: 'Fidelity',
      valuation_link: `${BASE}/valuations/${valuationId}`,
    });
  });

  it('addresses each recipient of one transition by their own name', async () => {
    // A transition can address the owner and the reviewer, and `recipient_name`
    // is an answer about who is being written to. Rendering the overrides once
    // for the whole transition would put the owner's name on the reviewer's
    // copy — which is why the rendering moved inside the per-recipient loop.
    const reviewer = await seedUser(ctx, { email: 'rey@ops.example', roles: ['admin'] });
    await pool.query(`UPDATE users SET first_name = 'Rey' WHERE id = $1`, [reviewer.id]);
    const valuationId = await seedEngagement('Two Recipient Co');
    await pool.query('UPDATE valuations SET assigned_reviewer_id = $2 WHERE id = $1', [
      valuationId,
      reviewer.id,
    ]);
    await pool.query(
      `UPDATE communication_templates SET subject = 'x', body = $1, enabled = true WHERE key = 'review_needed'`,
      ['Hi {{recipient_name}}'],
    );

    const valuation = (await findValuationById(pool, valuationId))!;
    await onStateChanged({ pool, log: app.log, publicBaseUrl: BASE, settings }, valuation, 'review');

    const { rows } = await pool.query<{ body: string; to_email: string }>(
      `SELECT body, to_email FROM email_outbox WHERE valuation_id = $1 AND template_key = 'review_needed'`,
      [valuationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.to_email).toBe(reviewer.email);
    expect(rows[0]!.body).toBe('Hi Rey');
  });

  it('writes nothing to a deactivated recipient', async () => {
    // Deactivation is `users.deleted_at`, and the drip-campaign candidate query
    // already refused it. The state-change hook resolved recipients through
    // `findUsersByIds`, which did not — so a deactivated account kept receiving
    // workflow email and in-app notifications.
    const gone = await seedUser(ctx, { email: 'gone@client.example', roles: ['valuation_user'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(gone.token),
      payload: { kind: '409a', company_name: 'Deactivated Co' },
    });
    const valuationId = created.json().valuation.id as string;
    await pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [gone.id]);

    const valuation = (await findValuationById(pool, valuationId))!;
    await onStateChanged({ pool, log: app.log, publicBaseUrl: BASE, settings }, valuation, 'drafted');

    const mail = await pool.query('SELECT 1 FROM email_outbox WHERE valuation_id = $1', [valuationId]);
    expect(mail.rowCount).toBe(0);
    const notes = await pool.query('SELECT 1 FROM notifications WHERE user_id = $1', [gone.id]);
    expect(notes.rowCount).toBe(0);
  });

  it('keeps one tenant out of another tenants mail', async () => {
    // Recipient isolation: the owner and the assigned reviewer are the only two
    // roles a transition addresses, so an unrelated account on another partner
    // must receive nothing at all from this engagement.
    const outsider = await seedUser(ctx, { email: 'outsider@other.example', roles: ['valuation_user'] });
    const valuationId = await seedEngagement('Isolation Co');
    const valuation = (await findValuationById(pool, valuationId))!;
    await onStateChanged({ pool, log: app.log, publicBaseUrl: BASE, settings }, valuation, 'published');

    const { rows } = await pool.query<{ to_email: string }>(
      'SELECT to_email FROM email_outbox WHERE valuation_id = $1',
      [valuationId],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.to_email === client.email)).toBe(true);
    const leaked = await pool.query('SELECT 1 FROM notifications WHERE user_id = $1', [outsider.id]);
    expect(leaked.rowCount).toBe(0);
  });
});
