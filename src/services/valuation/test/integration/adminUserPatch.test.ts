import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { adminPatchUser, type AdminUserPatch } from '../../src/repos/adminUsers.js';

/**
 * adminPatchUser builds its SET clause by interpolating the patch's keys as raw
 * SQL identifiers. The route validates its body, but the repo is the layer that
 * touches SQL, so the allow-list has to live there too — otherwise any future
 * caller that forwards a wider object turns `users` into a free-form write.
 */

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('adminPatchUser column allow-list', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(() => ctx.teardown());

  const readUser = async (id: string) => {
    const { rows } = await ctx.pool.query<{
      first_name: string | null;
      password_digest: string;
      session_epoch: number;
      deleted_at: Date | null;
    }>('SELECT first_name, password_digest, session_epoch, deleted_at FROM users WHERE id = $1', [id]);
    return rows[0]!;
  };

  it('applies the columns it is meant to', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    await adminPatchUser(ctx.pool, user.id, { first_name: 'Ada', job_title: 'Analyst' });
    const after = await readUser(user.id);
    expect(after.first_name).toBe('Ada');
  });

  it('ignores keys outside the allow-list instead of writing them', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const before = await readUser(user.id);

    // What a caller forwarding an unvalidated body would hand us. The cast is
    // the point: TypeScript is not the control here, the Set is.
    await adminPatchUser(ctx.pool, user.id, {
      first_name: 'Grace',
      password_digest: 'attacker-controlled-hash',
      session_epoch: 9999,
      deleted_at: null,
    } as unknown as AdminUserPatch);

    const after = await readUser(user.id);
    expect(after.first_name).toBe('Grace'); // allowed column still applied
    expect(after.password_digest).toBe(before.password_digest);
    expect(after.session_epoch).toBe(before.session_epoch);
  });

  it('is a no-op when every supplied key is rejected', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const before = await readUser(user.id);
    await adminPatchUser(ctx.pool, user.id, {
      password_digest: 'nope',
    } as unknown as AdminUserPatch);
    expect(await readUser(user.id)).toEqual(before);
  });

  it('still replaces roles alongside a rejected field patch', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    await adminPatchUser(ctx.pool, user.id, {
      roles: ['admin'],
      session_epoch: 1234,
    } as unknown as AdminUserPatch);
    const { rows } = await ctx.pool.query<{ key: string }>(
      'SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1',
      [user.id],
    );
    expect(rows.map((r) => r.key)).toEqual(['admin']);
    expect((await readUser(user.id)).session_epoch).not.toBe(1234);
  });
});
