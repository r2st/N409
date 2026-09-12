import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * A clone under a withdrawn firm (R449).
 *
 * `partners.archived_at` is the firm's soft delete, and the rule it states —
 * "a withdrawn firm acquires no fresh work" — is asked at `POST /valuations`
 * (R348), at the intake conversion and at the partner API's key. `POST
 * /valuations/:id/clone` copies `partner_id` off the source with the other
 * cloned columns and asked nothing: archiving a firm does not sign its people
 * out, so a member with last year's 409A open could roll it forward into a
 * fresh engagement under the firm the platform had withdrawn, and ops
 * cloning on the owner's behalf did the same.
 *
 * Paired with the live firm so the refusal can only be the archive's.
 */
describe.skipIf(!dbUp)('cloning an engagement of a withdrawn firm', () => {
  let ctx: TestApp;
  let firmId: string;
  let member: { id: string; token: string };
  let ops: { id: string; token: string };
  let source: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    firmId = await seedPartner(ctx, 'Withdrawn Rollforward LLP');
    member = await seedUser(ctx, { roles: ['partner'], partnerId: firmId });
    ops = await seedUser(ctx, { roles: ['admin'] });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(member.token),
      payload: { kind: '409a', company_name: 'Last Year Co' },
    });
    expect(res.statusCode).toBe(201);
    source = res.json().valuation.id as string;
  });
  afterAll(async () => ctx?.teardown());

  const clone = (token: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${source}/clone`,
      headers: authHeader(token),
      payload: { roll_forward: true },
    });
  const archive = (at: string | null) =>
    ctx.pool.query(`UPDATE partners SET archived_at = ${at === null ? 'NULL' : 'now()'} WHERE id = $1`, [
      firmId,
    ]);

  it('rolls forward while the firm is live', async () => {
    await archive(null);
    expect((await clone(member.token)).statusCode).toBe(201);
  });

  it('refuses the member once the firm is withdrawn, and says which firm', async () => {
    await archive('now');
    const res = await clone(member.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain('withdrawn from the platform');
    expect(res.json().detail).toContain('restore');
  });

  it('refuses ops cloning on the owner’s behalf for the same reason', async () => {
    await archive('now');
    const res = await clone(ops.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain('withdrawn from the platform');
  });

  it('files nothing under the withdrawn firm', async () => {
    await archive('now');
    const { rows: before } = await ctx.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM valuations WHERE partner_id = $1',
      [firmId],
    );
    await clone(member.token);
    await clone(ops.token);
    const { rows: after } = await ctx.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM valuations WHERE partner_id = $1',
      [firmId],
    );
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});
