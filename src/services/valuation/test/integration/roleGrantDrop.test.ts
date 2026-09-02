import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { assignRoles } from '../../src/repos/users.js';
import { adminPatchUser } from '../../src/repos/adminUsers.js';
import type { RoleKey } from '../../src/domain/roles.js';

/**
 * A grant the database cannot honour used to commit as a smaller grant.
 *
 * `assignRoles` selects the `roles` rows whose `key` is in the set and inserts
 * one `user_roles` row per row it finds. A key with no seeded row matched
 * nothing, so it contributed nothing and raised nothing — and every caller
 * reports the set it *asked* for, not the set that landed. `adminPatchUser` is
 * the sharp end: it replaces the whole set, `DELETE FROM user_roles` first, so
 * an operator moving somebody onto an unseeded key left that account holding no
 * roles at all over a 204.
 *
 * `roleSeedCensus.test.ts` is what stops the two lists drifting in the first
 * place, without a database. This is the behaviour underneath it: what happens
 * when they have drifted anyway — a migration applied half way, a deploy on a
 * database one release behind. The unseeded key is manufactured here by
 * deleting a seeded row rather than by inventing one, because `RoleKey` is a
 * closed union and the case worth pinning is a key this build *does* declare.
 */

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('a role grant the roles table cannot honour', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(() => ctx.teardown());

  const rolesOf = async (userId: string): Promise<string[]> => {
    const { rows } = await ctx.pool.query<{ key: string }>(
      'SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.key',
      [userId],
    );
    return rows.map((r) => r.key);
  };

  /** Take one seeded key out of the table, the way a missing migration would. */
  const unseed = async (key: RoleKey): Promise<void> => {
    await ctx.pool.query('DELETE FROM user_roles WHERE role_id = (SELECT id FROM roles WHERE key = $1)', [
      key,
    ]);
    await ctx.pool.query('DELETE FROM roles WHERE key = $1', [key]);
  };

  it('grants every seeded key it is given', async () => {
    // The discriminator. A refusal that fired unconditionally would pass the
    // assertions below and grant nobody anything.
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const client = await ctx.pool.connect();
    try {
      await assignRoles(client, user.id, ['reviewer', 'data']);
    } finally {
      client.release();
    }
    expect(await rolesOf(user.id)).toEqual(['data', 'reviewer', 'valuation_user']);
  });

  it('refuses a key with no roles row instead of dropping it', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    await unseed('investor');
    const client = await ctx.pool.connect();
    try {
      await expect(assignRoles(client, user.id, ['reviewer', 'investor'])).rejects.toThrow(
        /no roles row for investor/,
      );
    } finally {
      client.release();
    }
  });

  it('leaves a role replacement whole rather than emptying it', async () => {
    // The 204 that took every role off an account. `adminPatchUser` runs the
    // DELETE and the insert in one transaction, so the refusal has to take the
    // DELETE back with it — the account keeps the roles it had.
    const user = await seedUser(ctx, { roles: ['valuation_user', 'reviewer'] });
    await unseed('spa');
    await expect(adminPatchUser(ctx.pool, user.id, { roles: ['spa'] })).rejects.toThrow(
      /no roles row for spa/,
    );
    expect(await rolesOf(user.id)).toEqual(['reviewer', 'valuation_user']);
  });
});
