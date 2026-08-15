import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { HOUSEKEEPING_TARGETS } from '../../src/domain/housekeeping.js';
import { runHousekeepingSweep } from '../../src/hooks/housekeeping.js';
import { isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The rows nothing ever deleted.
 *
 * Five tables of machine bookkeeping — spent reset tokens, spent verification
 * tokens, settled invitations, lapsed "remember this device" cookies, used
 * idempotency records — had grown monotonically since the day each was added.
 * `saml_assertions_seen` was the only table in the schema with a purge.
 *
 * Two properties are being tested, and the second is the one worth writing
 * down. That the sweep removes what it should is the easy half; that it leaves
 * a *live* credential alone is what stops this becoming the reason someone
 * cannot reset their password. Every case below asserts both directions.
 */
describe.skipIf(!dbUp)('housekeeping sweep', () => {
  let ctx: TestApp;
  let user: Awaited<ReturnType<typeof seedUser>>;
  let partnerId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    user = await seedUser(ctx, { roles: ['valuation_user'] });
    partnerId = await seedPartner(ctx, 'Housekeeping LLP');
  });
  afterAll(async () => ctx?.teardown());

  /** Sweeps with a short retention so a fixture "ages" without waiting. */
  const sweep = () => runHousekeepingSweep({ pool: ctx.pool, retention: '1 second' });

  const exists = async (table: string, where: string, params: unknown[]): Promise<boolean> => {
    const { rows } = await ctx.pool.query(`SELECT 1 FROM ${table} WHERE ${where}`, params);
    return rows.length > 0;
  };

  it('sweeps every target it declares', async () => {
    // The list and the runner are separate files, and a target added to one
    // without a table in the other is a silent no-op. Running each predicate
    // proves the table exists and the SQL parses.
    const result = await sweep();
    expect(Object.keys(result.removed).length).toBeLessThanOrEqual(HOUSEKEEPING_TARGETS.length);
    for (const target of HOUSEKEEPING_TARGETS) {
      await expect(
        ctx.pool.query(`SELECT count(*) FROM ${target.table} WHERE ${target.where}`, ['30 days']),
      ).resolves.toBeTruthy();
    }
  });

  it('removes a spent password reset token and keeps a live one', async () => {
    const spent = newUlid();
    const live = newUlid();
    await ctx.pool.query(
      `INSERT INTO password_reset_tokens (id, user_id, token_sha256, expires_at, used_at, created_at)
       VALUES ($1, $3, $4, now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour'),
              ($2, $3, $5, now() + interval '1 hour', NULL, now() - interval '1 hour')`,
      [spent, live, user.id, `h-${spent}`, `h-${live}`],
    );

    await sweep();
    expect(await exists('password_reset_tokens', 'id = $1', [spent])).toBe(false);
    // The live one is mid-flow: someone has the link in their inbox right now.
    expect(await exists('password_reset_tokens', 'id = $1', [live])).toBe(true);
  });

  it('removes a lapsed verification token and keeps an unexpired one', async () => {
    const lapsed = newUlid();
    const live = newUlid();
    await ctx.pool.query(
      `INSERT INTO email_verification_tokens (id, user_id, email, token_sha256, expires_at, created_at)
       VALUES ($1, $3, 'a@example.com', $4, now() - interval '1 hour', now() - interval '1 hour'),
              ($2, $3, 'b@example.com', $5, now() + interval '1 day', now() - interval '1 hour')`,
      [lapsed, live, user.id, `h-${lapsed}`, `h-${live}`],
    );

    await sweep();
    expect(await exists('email_verification_tokens', 'id = $1', [lapsed])).toBe(false);
    expect(await exists('email_verification_tokens', 'id = $1', [live])).toBe(true);
  });

  it('removes settled invitations and keeps the ones an admin is waiting on', async () => {
    const accepted = newUlid();
    const lapsed = newUlid();
    const pending = newUlid();
    await ctx.pool.query(
      `INSERT INTO user_invitations
         (id, email, roles, invited_by, token_sha256, expires_at, accepted_at, created_at)
       VALUES ($1, $5, ARRAY['valuation_user'], $4, $6,
               now() + interval '1 day', now(), now() - interval '1 hour'),
              ($2, $7, ARRAY['valuation_user'], $4, $8,
               now() - interval '1 hour', NULL, now() - interval '1 hour'),
              ($3, $9, ARRAY['valuation_user'], $4, $10,
               now() + interval '1 day', NULL, now() - interval '1 hour')`,
      [
        accepted,
        lapsed,
        pending,
        user.id,
        `accepted.${accepted}@example.com`,
        `h-${accepted}`,
        `lapsed.${lapsed}@example.com`,
        `h-${lapsed}`,
        `pending.${pending}@example.com`,
        `h-${pending}`,
      ],
    );

    await sweep();
    expect(await exists('user_invitations', 'id = $1', [accepted])).toBe(false);
    expect(await exists('user_invitations', 'id = $1', [lapsed])).toBe(false);
    // Unaccepted, unrevoked and still in date — this is the row the admin
    // console exists to show, and the one holding the address in the index.
    expect(await exists('user_invitations', 'id = $1', [pending])).toBe(true);
  });

  it('removes an expired trusted device and keeps one still trusted', async () => {
    const expired = newUlid();
    const trusted = newUlid();
    await ctx.pool.query(
      `INSERT INTO mfa_trusted_devices (id, user_id, token_hash, expires_at)
       VALUES ($1, $3, $4, now() - interval '1 hour'),
              ($2, $3, $5, now() + interval '30 days')`,
      [expired, trusted, user.id, `h-${expired}`, `h-${trusted}`],
    );

    await sweep();
    expect(await exists('mfa_trusted_devices', 'id = $1', [expired])).toBe(false);
    // Still inside its window: deleting it would silently re-challenge a
    // browser the user told us to remember.
    expect(await exists('mfa_trusted_devices', 'id = $1', [trusted])).toBe(true);
  });

  it('removes an aged idempotency record and keeps a recent one', async () => {
    await ctx.pool.query(
      `INSERT INTO partner_api_idempotency
         (partner_id, idempotency_key, request_hash, response_status, response_body, created_at, completed_at)
       VALUES ($1, 'old-key', 'h', 201, '{}'::jsonb, now() - interval '1 hour', now() - interval '1 hour'),
              ($1, 'new-key', 'h', 201, '{}'::jsonb, now(), now())`,
      [partnerId],
    );

    await sweep();
    const key = 'partner_id = $1 AND idempotency_key = $2';
    expect(await exists('partner_api_idempotency', key, [partnerId, 'old-key'])).toBe(false);
    // Inside the window a retry still has to replay rather than re-create.
    expect(await exists('partner_api_idempotency', key, [partnerId, 'new-key'])).toBe(true);
  });

  it('reports what it removed, per table', async () => {
    const id = newUlid();
    await ctx.pool.query(
      `INSERT INTO mfa_trusted_devices (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() - interval '1 hour')`,
      [id, user.id, `h-${id}`],
    );

    const result = await sweep();
    expect(result.removed.mfa_trusted_devices).toBeGreaterThanOrEqual(1);
    expect(result.total).toBeGreaterThanOrEqual(1);
    // Tables with nothing to do are absent rather than reported as zero, so the
    // log line names only what actually happened.
    expect(Object.values(result.removed).every((n) => n > 0)).toBe(true);
  });

  it('stops at the batch size and says so, leaving the rest for the next pass', async () => {
    const rows = Array.from({ length: 4 }, () => newUlid());
    for (const id of rows) {
      await ctx.pool.query(
        `INSERT INTO mfa_trusted_devices (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() - interval '1 hour')`,
        [id, user.id, `h-${id}`],
      );
    }

    const first = await runHousekeepingSweep({ pool: ctx.pool, retention: '1 second', batch: 2 });
    expect(first.removed.mfa_trusted_devices).toBe(2);
    expect(first.capped).toContain('mfa_trusted_devices');

    // The backlog drains over ticks rather than in one statement — which is the
    // whole point of the cap, since the first sweep after this ships faces
    // everything that has accumulated since these tables were created.
    const second = await runHousekeepingSweep({ pool: ctx.pool, retention: '1 second', batch: 10 });
    expect(second.removed.mfa_trusted_devices).toBe(2);
    expect(second.capped).not.toContain('mfa_trusted_devices');
  });

  it('does not touch anything under the retention window', async () => {
    // The default retention is 30 days and every fixture above is minutes old,
    // so a sweep at the real setting must find nothing — the grace period is
    // what keeps an incident reconstructable, and it has to actually apply.
    const id = newUlid();
    await ctx.pool.query(
      `INSERT INTO mfa_trusted_devices (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() - interval '1 hour')`,
      [id, user.id, `h-${id}`],
    );

    await runHousekeepingSweep({ pool: ctx.pool });
    expect(await exists('mfa_trusted_devices', 'id = $1', [id])).toBe(true);
  });
});
