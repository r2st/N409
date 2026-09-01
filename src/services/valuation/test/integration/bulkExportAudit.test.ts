/**
 * The copies that are taken of everybody at once.
 *
 * `identityAudit.test.ts` holds the per-subject half: one person's personal
 * data leaving writes `user_data_exported`, at `critical`, from the admin
 * route and from the self-serve one. The route that copies the contact
 * details of *every* account — `GET /users/export`, a CSV of email, phone,
 * name, job title, employer and SSO provider — wrote nothing at all, so the
 * trail named the administrators who exported one row and stayed silent about
 * the one who took the directory. That is the wrong way round: the directory
 * is the larger disclosure and the one a compromised administrator account
 * reaches for first.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

interface EventRow {
  type: string;
  actor_id: string | null;
  subject_type: string;
  subject_id: string | null;
  subject_label: string | null;
  payload: Record<string, unknown>;
}

describe.skipIf(!dbUp)('bulk personal-data exports reach the audit spine', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const directoryEvents = async (): Promise<EventRow[]> => {
    const { rows } = await ctx.pool.query<EventRow>(
      `SELECT type, actor_id, subject_type, subject_id, subject_label, payload
         FROM admin_events WHERE type = 'user_directory_exported' ORDER BY occurred_at`,
    );
    return rows;
  };

  it('records the directory export, which nothing did', async () => {
    const before = (await directoryEvents()).length;
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users/export',
      headers: authHeader(admin.token),
    });
    expect(res.statusCode).toBe(200);
    // The file really did carry addresses — otherwise this asserts a row about
    // a disclosure that did not happen.
    expect(res.body).toContain(admin.email);

    const rows = await directoryEvents();
    expect(rows).toHaveLength(before + 1);
    const row = rows.at(-1)!;
    expect(row.actor_id).toBe(admin.id);
    // No one row is the subject; the email-suppression events file the same
    // shape under `system` for the same reason.
    expect(row.subject_type).toBe('system');
    expect(row.subject_id).toBeNull();
    expect(row.subject_label).toBe('User directory');
    expect(row.payload.format).toBe('csv');
    expect(row.payload.truncated).toBe(false);
    expect(Number(row.payload.rows)).toBeGreaterThanOrEqual(2);
  });

  it('carries the filters, so a partner slice is distinguishable from the whole book', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users/export?q=nobody-matches-this&role=admin',
      headers: authHeader(admin.token),
    });
    expect(res.statusCode).toBe(200);

    const row = (await directoryEvents()).at(-1)!;
    expect(row.payload.filters).toMatchObject({
      q: 'nobody-matches-this',
      role: 'admin',
      partner_id: null,
    });
    // An export that matched nothing is still an export that was attempted,
    // and the row says so rather than being suppressed as uninteresting.
    expect(Number(row.payload.rows)).toBe(0);
  });

  it('writes nothing when the caller is refused', async () => {
    const outsider = await seedUser(ctx, { roles: ['valuation_user'] });
    const before = (await directoryEvents()).length;
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users/export',
      headers: authHeader(outsider.token),
    });
    expect(res.statusCode).toBe(403);
    expect(await directoryEvents()).toHaveLength(before);
  });
});
