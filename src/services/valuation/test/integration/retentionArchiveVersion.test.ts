import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { markValuationsArchived } from '../../src/repos/retention.js';
import { authHeader, forceState, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * `markValuationsArchived` must bump `version` so a concurrent state
 * transition's `expectedVersion` check fails.
 *
 * Before R383 the UPDATE stamped `archived_at` without touching `version`.
 * A route that read the engagement before the archive and wrote a state
 * change afterwards found the version unchanged and the write succeeded —
 * moving an archived engagement through the pipeline with all of the
 * downstream side effects (emails, webhooks, audit events).
 */

const dbUp = await isDbAvailable();
const actor = { actorType: 'human' as const, actorId: 'test', source: 'test' };

describe.skipIf(!dbUp)('markValuationsArchived bumps version', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
  });

  afterAll(async () => ctx?.teardown());

  it('increments version when archiving', async () => {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Version Bump Co', userId: admin.id },
      { ...actor, actorId: admin.id },
    );
    const before = await ctx.pool.query<{ version: number }>(
      'SELECT version FROM valuations WHERE id = $1',
      [v.id],
    );
    const versionBefore = before.rows[0]!.version;

    await markValuationsArchived(ctx.pool, [v.id]);

    const after = await ctx.pool.query<{ version: number; archived_at: Date | null }>(
      'SELECT version, archived_at FROM valuations WHERE id = $1',
      [v.id],
    );
    expect(after.rows[0]!.archived_at).not.toBeNull();
    expect(after.rows[0]!.version).toBe(versionBefore + 1);
  });

  it('a state transition after archive is rejected by version mismatch', async () => {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Race Guard Co', userId: admin.id },
      { ...actor, actorId: admin.id },
    );
    await forceState(ctx, v.id, 'started');

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${v.id}`,
      headers: authHeader(admin.token),
    });
    const etag = read.headers.etag as string;
    expect(read.statusCode).toBe(200);

    await markValuationsArchived(ctx.pool, [v.id]);

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${v.id}`,
      headers: { ...authHeader(admin.token), 'if-match': etag },
      payload: { state: 'completed' },
    });
    expect(patch.statusCode).toBe(409);
  });
});
