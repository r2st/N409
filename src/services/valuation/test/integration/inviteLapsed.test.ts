import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Re-inviting an address whose invitation was never accepted.
 *
 * Two things claim to know whether an address has an invitation outstanding,
 * and they disagreed. `hasPendingInvitation` — and every other reader — asks
 * for `expires_at > now()`, so a lapsed invitation is dead. The partial unique
 * index behind the table (`user_invitations_pending_email_key`, migration 0044)
 * cannot ask that, because `now()` is not immutable and Postgres will not index
 * on it, so it holds the address for any unaccepted, unrevoked row forever.
 *
 * The route sat between the two: its guard said the address was free, and the
 * INSERT then collided with the index and raised a 23505 nothing caught. A 500
 * on the invite form for an address the system had just declared available.
 * The TTL is seven days, so this was not an edge case — it was the fate of
 * every invitation nobody accepted.
 */
describe.skipIf(!dbUp)('inviting an address whose invitation lapsed', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  const auth = () => authHeader(admin.token);
  let seq = 0;
  const address = () => `lapsed.${(seq += 1)}.${Date.now()}@example.com`;

  const invite = (email: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users/invite',
      headers: auth(),
      payload: { email, roles: ['valuation_user'] },
    });

  /** Ages an invitation past its expiry, as seven quiet days would. */
  const lapse = (email: string) =>
    ctx.pool.query(
      `UPDATE user_invitations SET expires_at = now() - interval '1 day'
        WHERE lower(email) = lower($1) AND accepted_at IS NULL AND revoked_at IS NULL`,
      [email],
    );

  it('is a real collision: the index holds a lapsed row', async () => {
    // Not an assertion about our code — an assertion about the premise every
    // test below rests on. If the index ever stops holding an expired row, the
    // retirement in `createInvitation` becomes dead code and these tests would
    // keep passing while testing nothing.
    const email = address();
    await invite(email);
    await lapse(email);
    await expect(
      ctx.pool.query(
        `INSERT INTO user_invitations (id, email, roles, invited_by, token_sha256, expires_at)
         VALUES ($1, $2, ARRAY['valuation_user'], $3, $4, now() + interval '7 days')`,
        ['01JC0000000000000000000000'.slice(0, 26), email, admin.id, `premise-${Date.now()}`],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'user_invitations_pending_email_key' });
  });

  it('mints a fresh invitation instead of 500ing on the index', async () => {
    const email = address();
    expect((await invite(email)).statusCode).toBe(201);
    await lapse(email);

    const again = await invite(email);
    expect(again.statusCode, again.body).toBe(201);
    // A usable one: unexpired, unaccepted, unrevoked — which is what every
    // reader of this table requires before it will honour a token.
    const { rows } = await ctx.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM user_invitations
        WHERE lower(email) = lower($1)
          AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
      [email],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('retires the lapsed row rather than deleting it', async () => {
    const email = address();
    await invite(email);
    await lapse(email);
    await invite(email);

    // Both rows survive: who invited whom, and when, is the audit trail. The
    // dead one is recorded as revoked, which is what a link that can never be
    // redeemed is.
    const { rows } = await ctx.pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM user_invitations WHERE lower(email) = lower($1) ORDER BY created_at',
      [email],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.revoked_at).not.toBeNull();
    expect(rows[1]?.revoked_at).toBeNull();
  });

  it('still refuses while the first invitation is live', async () => {
    const email = address();
    expect((await invite(email)).statusCode).toBe(201);
    const second = await invite(email);
    expect(second.statusCode).toBe(409);
    expect(second.json().detail ?? second.body).toMatch(/already pending/i);
  });

  it('reports a raced duplicate as a conflict, not a 500', async () => {
    // Two admins inviting one address at the same moment. Both pass the
    // route's `hasPendingInvitation` check before either inserts — it is a
    // reading, not a reservation — so the unique index is the only thing that
    // can settle it, and what it settles must be a 409 with the same words the
    // guard uses rather than an unhandled driver error.
    const email = address();
    const [a, b] = await Promise.all([invite(email), invite(email)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().detail ?? loser.body).toMatch(/already pending/i);

    // And exactly one live invitation exists — the race did not mint two
    // tokens for one address.
    const { rows } = await ctx.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM user_invitations
        WHERE lower(email) = lower($1) AND accepted_at IS NULL AND revoked_at IS NULL`,
      [email],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('does not supersede a live invitation held by a concurrent re-invite', async () => {
    // The retirement is deliberately narrow: only lapsed rows. If it revoked
    // live ones, a second invite would silently invalidate a link already
    // sitting in someone's inbox and re-role them without saying so.
    const email = address();
    await invite(email);
    const { rows: before } = await ctx.pool.query<{ token_sha256: string }>(
      'SELECT token_sha256 FROM user_invitations WHERE lower(email) = lower($1)',
      [email],
    );
    await invite(email); // 409
    const { rows: after } = await ctx.pool.query<{ token_sha256: string }>(
      'SELECT token_sha256 FROM user_invitations WHERE lower(email) = lower($1)',
      [email],
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.token_sha256).toBe(before[0]?.token_sha256);
  });
});
