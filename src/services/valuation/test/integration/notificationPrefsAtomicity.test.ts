import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { getPreferenceMatrix, replacePreferences } from '../../src/repos/notificationPreferences.js';
import type { NotificationEventType } from '../../src/domain/emailWorkflows.js';

const dbUp = await isDbAvailable();

/**
 * The notification settings screen submits the whole matrix as a unit, and the
 * route used to apply it as a loop of independent upserts. A failure part-way
 * left some switches moved and some not, while returning an error that implied
 * nothing had saved — so the screen re-read a matrix matching neither the old
 * state nor the submitted one, and nothing told the user to look.
 */
describe.skipIf(!dbUp)('notification preferences save atomically', () => {
  let ctx: TestApp;
  let user: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    user = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const matrix = () => getPreferenceMatrix(ctx.pool, user.id);
  const find = (rows: Awaited<ReturnType<typeof matrix>>, type: NotificationEventType) =>
    rows.find((r) => r.event_type === type)!;

  it('defaults every channel on when nothing has been stored', async () => {
    expect(await matrix()).toContainEqual(
      expect.objectContaining({ event_type: 'draft_ready', in_app: true, email: true }),
    );
  });

  it('applies a whole batch through the route', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/me/notification-preferences',
      headers: authHeader(user.token),
      payload: {
        preferences: [
          { event_type: 'draft_ready', in_app: false, email: false },
          { event_type: 'review_needed', in_app: true, email: false },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const rows = await matrix();
    expect(find(rows, 'draft_ready')).toMatchObject({ in_app: false, email: false });
    expect(find(rows, 'review_needed')).toMatchObject({ in_app: true, email: false });
    // Untouched types keep their default rather than being reset.
    expect(find(rows, 'valuation_completed')).toMatchObject({ in_app: true, email: true });
  });

  it('rolls the whole batch back when one entry fails to write', async () => {
    const before = await matrix();
    expect(find(before, 'draft_ready')).toMatchObject({ in_app: false, email: false });

    await expect(
      replacePreferences(ctx.pool, user.id, [
        // Would flip draft_ready back on…
        { event_type: 'draft_ready', in_app: true, email: true },
        // …but this row violates the NOT NULL on in_app, so the batch fails
        // after the first statement has already run.
        {
          event_type: 'valuation_cancelled',
          in_app: null as unknown as boolean,
          email: true,
        },
      ]),
    ).rejects.toThrow();

    const after = await matrix();
    // The point of the fix: the first write did not survive the failure.
    expect(find(after, 'draft_ready')).toMatchObject({ in_app: false, email: false });
    expect(find(after, 'valuation_cancelled')).toMatchObject({ in_app: true, email: true });
  });

  it('leaves the pool usable after a rolled-back batch', async () => {
    // A transaction helper that leaks its client, or releases one still inside
    // an aborted transaction, poisons every later query on that connection.
    await replacePreferences(ctx.pool, user.id, [{ event_type: 'draft_ready', in_app: true, email: true }]);
    expect(find(await matrix(), 'draft_ready')).toMatchObject({ in_app: true, email: true });
  });

  it('rejects an unknown event type at the route boundary', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/me/notification-preferences',
      headers: authHeader(user.token),
      payload: { preferences: [{ event_type: 'not_a_real_event', in_app: true, email: true }] },
    });
    expect(res.statusCode).toBe(422);
  });
});
