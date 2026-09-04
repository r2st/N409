import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The two render deps, asserted through the door rather than on the hook (R408).
 *
 * `notificationDataFidelity.test.ts` pins what `onStateChanged` renders — by
 * calling it directly, with `publicBaseUrl` and `settings` handed in. That is a
 * statement about the hook and not about any route, and it is why the workflow
 * module could drop both on the floor for as long as it did: the transition
 * fires, the mail queues, the send succeeds, and the only trace is an empty
 * string where the client's link should be.
 *
 * `TransitionRenderDeps` is spelled out in `hooks/stateChange.ts` precisely
 * because "a spread-out list of two optional fields is how one of them ends up
 * with only the first". This drives the operator's own controls and reads the
 * `email_outbox` row the transport is handed.
 */

/** The config default; `setupTestApp` builds the app from `loadConfig`. */
const BASE = 'http://localhost:3000';

/**
 * Asserted exactly, not merely as non-empty: an unwired `settings` store
 * renders `{{support_email}}` as the empty string, and the default the store
 * falls back to is a different address from this one — so a store that never
 * reached the hook cannot pass by accident.
 */
const SUPPORT_EMAIL = 'support@n409.test';

const PROBE = 'link=[{{valuation_link}}] pay=[{{payment_link}}] support=[{{support_email}}]';

const pairs = (body: string): Record<string, string> =>
  Object.fromEntries([...body.matchAll(/(\w+)=\[([^\]]*)\]/g)].map((m) => [m[1]!, m[2]!]));

describe.skipIf(!dbUp)('a transition fired from the workflow routes', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    app = ctx.app;
    pool = ctx.pool;
    client = await seedUser(ctx, { email: 'owner@client.example', roles: ['valuation_user'] });
    ops = await seedUser(ctx, { email: 'ana@ops.example', roles: ['admin'] });
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('support_email', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(SUPPORT_EMAIL)],
    );
    await pool.query(
      `UPDATE communication_templates SET subject = $1, body = $2, enabled = true WHERE key = 'draft_ready'`,
      ['Draft ready', PROBE],
    );
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  /** An engagement parked one advance short of `drafted`. */
  async function seedReviewed(companyName: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().valuation.id as string;
    await pool.query(`UPDATE valuations SET state = 'reviewed' WHERE id = $1`, [id]);
    return id;
  }

  async function draftReadyBody(valuationId: string): Promise<string> {
    const { rows } = await pool.query<{ body: string }>(
      `SELECT body FROM email_outbox WHERE valuation_id = $1 AND template_key = 'draft_ready'`,
      [valuationId],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!.body;
  }

  it('puts a real link in the client email it sends from /workflow/advance', async () => {
    const id = await seedReviewed('Advance Probe Co');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/workflow/advance`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valuation.state).toBe('drafted');

    expect(pairs(await draftReadyBody(id))).toEqual({
      // The empty string is what an absent `publicBaseUrl` renders as, so the
      // failure this pins is a gap in the sentence rather than braces.
      link: `${BASE}/valuations/${id}`,
      pay: `${BASE}/valuations/${id}`,
      support: SUPPORT_EMAIL,
    });
  });

  it('puts a real link in the client email it sends from a bulk set_state', async () => {
    const id = await seedReviewed('Bulk Probe Co');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations/bulk',
      headers: authHeader(ops.token),
      payload: { action: 'set_state', ids: [id], state: 'drafted' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ id, ok: true, state: 'drafted' });

    expect(pairs(await draftReadyBody(id))).toEqual({
      link: `${BASE}/valuations/${id}`,
      pay: `${BASE}/valuations/${id}`,
      support: SUPPORT_EMAIL,
    });
  });
});
