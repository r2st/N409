import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { createApiToken } from '../../src/repos/apiTokens.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The suspension, reaching the one credential it never reached.
 *
 * `ignored` is this platform's suspension and `auth/rbac.ts` says what that
 * means: it subtracts. `valuationScope` answers `none`, `isOps` and
 * `canManageUsers` answer false, and R211 swept the four privilege predicates
 * that had not been subtracting for themselves.
 *
 * All of those are questions asked *of a principal*, and the partner API is the
 * surface that never asks one. Its authority comes off the token row —
 * `loadScoped` compares `valuation.partner_id` with `token.partnerId`, and the
 * listing hand-builds `{ kind: 'partner', partnerId: token.partnerId }` rather
 * than calling `valuationScope`. Deliberate, and documented in `resolveApiToken`:
 * an integration must not break because a seat's roles were edited. What it
 * meant was that suspending a firm's org admin took away every engagement they
 * could open in the product and left their key the firm's entire book — read
 * it, create engagements in it, upload to it, walk it through the workflow —
 * with the suspended account's id on the audit spine as the actor of each.
 *
 * The session half is asserted beside it, because that is the half that already
 * worked and the reason the gap was invisible: the same person, suspended, sees
 * nothing through the app.
 */
describe.skipIf(!dbUp)('a suspended account cannot act through its partner API key', () => {
  let ctx: TestApp;
  let partnerId: string;
  let member: { id: string; token: string };
  let apiKey: string;

  const suspend = async (on: boolean) => {
    if (on) {
      await ctx.pool.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT $1, id FROM roles WHERE key = 'ignored'
         ON CONFLICT DO NOTHING`,
        [member.id],
      );
    } else {
      await ctx.pool.query(
        `DELETE FROM user_roles WHERE user_id = $1
           AND role_id IN (SELECT id FROM roles WHERE key = 'ignored')`,
        [member.id],
      );
    }
  };

  const list = async (key: string) =>
    ctx.app.inject({ method: 'GET', url: '/api/partner/v1/valuations', headers: authHeader(key) });

  beforeAll(async () => {
    ctx = await setupTestApp();
    partnerId = await seedPartner(ctx, `Suspendable Firm ${Date.now()}`);
    member = await seedUser(ctx, { roles: ['org_admin'], partnerId });
    const { secret } = await createApiToken(ctx.pool, {
      partnerId,
      createdBy: member.id,
      name: 'the-firms-integration',
    });
    apiKey = secret;
    await ctx.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id, state, partner_id)
       VALUES ($1, '409a', 'Northwind Robotics', $2, 'drafted', $3)`,
      [newUlid(), member.id, partnerId],
    );
  });

  afterAll(async () => ctx?.teardown());

  it('works while the account is in good standing', async () => {
    // Without this the refusals below pass for a fixture that could never
    // authenticate at all.
    const res = await list(apiKey);
    expect(res.statusCode).toBe(200);
    expect(res.json().valuations.length).toBeGreaterThan(0);
  });

  it('refuses the key once the account is suspended', async () => {
    await suspend(true);
    const res = await list(apiKey);
    expect(res.statusCode).toBe(403);
    expect(res.json().detail as string).toContain('suspended');
  });

  it('refuses the writing half too, not only the reads', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers: authHeader(apiKey),
      payload: { company_name: 'Created While Suspended', kind: '409a' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('is the same answer the app already gave the same person', async () => {
    // `valuationScope` reduces a suspended principal to `none`, which is why
    // the session half of this was never the hole. Asserted so the two doors
    // are held to one reading of the suspension.
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/valuations',
      headers: authHeader(member.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valuations).toEqual([]);
  });

  it('resumes on its own when the suspension is lifted', async () => {
    // Refused, not revoked: lifting a suspension is one DELETE, and nothing
    // about the key changed while it was in place.
    await suspend(false);
    expect((await list(apiKey)).statusCode).toBe(200);
  });
});
