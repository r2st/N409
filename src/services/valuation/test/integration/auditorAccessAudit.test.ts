import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

/**
 * Granting and withdrawing an auditor link are on the engagement's spine (R392,
 * methodology M11).
 *
 * The link is the only door that hands a reader with no account the
 * deliverable, the conclusion, the assumptions and the QA record. The board's
 * narrower external link has written `board_member_added`/`board_member_removed`
 * since it existed and the auditor's reply writes `auditor_note_received`, but
 * the grant and the revocation wrote nothing anywhere — and `revoked_at` has no
 * actor column, so "who withdrew this" had no answer at all. Every case below
 * finds no event against the pre-fix repo.
 */
describe.skipIf(!dbUp)('auditor access on the audit spine', () => {
  let ctx: TestApp;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const seedValuation = () =>
    createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Auditee Inc', userId: owner.id },
      { ...actor, actorId: owner.id },
    );

  async function events(valuationId: string) {
    const { rows } = await ctx.pool.query<{
      type: string;
      actor_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT type, actor_id, payload FROM valuation_events
        WHERE valuation_id = $1 AND type LIKE 'auditor_access_%'
        ORDER BY seq`,
      [valuationId],
    );
    return rows;
  }

  it('records the grant, naming the label and the expiry and never the token', async () => {
    const v = await seedValuation();
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/auditor-access`,
      headers: authHeader(owner.token),
      payload: { label: 'PwC', expires_in_days: 30 },
    });
    expect(created.statusCode).toBe(201);
    const token = created.json().token as string;

    const rows = await events(v.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('auditor_access_granted');
    expect(rows[0]!.actor_id).toBe(owner.id);
    expect(rows[0]!.payload.access_id).toBe(created.json().access.id);
    expect(rows[0]!.payload.label).toBe('PwC');
    expect(typeof rows[0]!.payload.expires_at).toBe('string');
    // The secret is returned once to the caller and is not a payload field —
    // nor is its stored hash. The trail is read by six surfaces.
    expect(JSON.stringify(rows[0]!.payload)).not.toContain(token);
    expect(Object.keys(rows[0]!.payload).sort()).toEqual(['access_id', 'expires_at', 'label']);
  });

  it('records the withdrawal, naming whose grant went and who took it', async () => {
    const v = await seedValuation();
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/auditor-access`,
      headers: authHeader(owner.token),
      payload: { label: 'Deloitte', expires_in_days: 30 },
    });
    const accessId = created.json().access.id as string;

    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/valuations/${v.id}/auditor-access/${accessId}`,
      headers: authHeader(owner.token),
    });
    expect(revoked.statusCode).toBe(204);

    const rows = await events(v.id);
    expect(rows.map((r) => r.type)).toEqual(['auditor_access_granted', 'auditor_access_revoked']);
    // The label comes off the row as it was: after the statement, nothing else
    // can say which auditor lost their access.
    expect(rows[1]!.payload).toMatchObject({ access_id: accessId, label: 'Deloitte' });
    expect(rows[1]!.actor_id).toBe(owner.id);
  });

  it('writes nothing for a second withdrawal of the same grant', async () => {
    const v = await seedValuation();
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/auditor-access`,
      headers: authHeader(owner.token),
      payload: { label: 'KPMG', expires_in_days: 30 },
    });
    const accessId = created.json().access.id as string;
    const url = `/api/v1/valuations/${v.id}/auditor-access/${accessId}`;

    expect(
      (await ctx.app.inject({ method: 'DELETE', url, headers: authHeader(owner.token) })).statusCode,
    ).toBe(204);
    // `revoked_at IS NULL` makes the second pass a no-op, so the route answers
    // 404 and the trail does not carry two withdrawals for one grant.
    expect(
      (await ctx.app.inject({ method: 'DELETE', url, headers: authHeader(owner.token) })).statusCode,
    ).toBe(404);
    expect((await events(v.id)).map((r) => r.type)).toEqual([
      'auditor_access_granted',
      'auditor_access_revoked',
    ]);
  });
});
