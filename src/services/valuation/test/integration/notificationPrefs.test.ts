import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, forceState, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Notification preferences (P2 #11): default-on matrix, per-channel opt-out
 * consulted at the state-change dispatch points, other users unaffected.
 */

const dbUp = await isDbAvailable();

interface Pref {
  event_type: string;
  in_app: boolean;
  email: boolean;
}

describe.skipIf(!dbUp)('notification preferences', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  const getPrefs = async (token: string) =>
    (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me/notification-preferences',
        headers: authHeader(token),
      })
    ).json().preferences as Pref[];

  const putPrefs = async (token: string, preferences: Pref[]) =>
    ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/me/notification-preferences',
      headers: authHeader(token),
      payload: { preferences },
    });

  const createValuation = async (ownerToken: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ownerToken),
      payload: { kind: '409a', company_name: 'Prefs Co' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  /**
   * Moves the engagement to `state` by the transition the lifecycle table
   * actually has, having first put it on the far side of that edge.
   *
   * The real transition is the part that matters here: what this suite asserts
   * on is what the state-change hook sends, so writing the column directly
   * would arrange away the very thing under test. Only the run-up is arranged.
   */
  const setState = async (id: string, state: string, from: string) => {
    await forceState(ctx, id, from);
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}`,
      headers: authHeader(ops.token),
      payload: { state },
    });
    expect(res.statusCode).toBe(200);
  };

  const outboxRows = async (userId: string, templateKey: string) => {
    // Email dispatch is fire-and-forget after the transaction — settle first.
    await new Promise((r) => setTimeout(r, 150));
    const { rows } = await ctx.pool.query(
      'SELECT id FROM email_outbox WHERE to_user_id = $1 AND template_key = $2',
      [userId, templateKey],
    );
    return rows;
  };

  const notificationRows = async (userId: string, type: string) => {
    const { rows } = await ctx.pool.query('SELECT id FROM notifications WHERE user_id = $1 AND type = $2', [
      userId,
      type,
    ]);
    return rows;
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  it('defaults everything on with zero stored rows', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const prefs = await getPrefs(user.token);
    expect(prefs.length).toBeGreaterThanOrEqual(6);
    expect(prefs.every((p) => p.in_app && p.email)).toBe(true);
    const { rows } = await ctx.pool.query(
      'SELECT count(*)::int AS n FROM notification_preferences WHERE user_id = $1',
      [user.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('round-trips a saved preference', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const res = await putPrefs(user.token, [{ event_type: 'draft_ready', in_app: true, email: false }]);
    expect(res.statusCode).toBe(200);
    const prefs = await getPrefs(user.token);
    expect(prefs.find((p) => p.event_type === 'draft_ready')).toEqual({
      event_type: 'draft_ready',
      in_app: true,
      email: false,
    });
    // Everything else stays default-on.
    expect(prefs.filter((p) => p.event_type !== 'draft_ready').every((p) => p.email)).toBe(true);
  });

  it('rejects unknown event types', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const res = await putPrefs(user.token, [{ event_type: 'password_reset', in_app: false, email: false }]);
    expect(res.statusCode).toBe(422);
  });

  it('suppresses only the opted-out channel for the opted-out user', async () => {
    const owner = await seedUser(ctx, { roles: ['valuation_user'] });
    const control = await seedUser(ctx, { roles: ['valuation_user'] });
    await putPrefs(owner.token, [{ event_type: 'draft_ready', in_app: true, email: false }]);

    const ownVal = await createValuation(owner.token);
    const controlVal = await createValuation(control.token);
    await setState(ownVal, 'drafted', 'reviewed');
    await setState(controlVal, 'drafted', 'reviewed');

    // Owner: email off → no outbox row; in-app still on → notification lands.
    expect(await outboxRows(owner.id, 'draft_ready')).toHaveLength(0);
    expect(await notificationRows(owner.id, 'draft_ready')).toHaveLength(1);
    // Control user is untouched: both channels fire.
    expect(await outboxRows(control.id, 'draft_ready')).toHaveLength(1);
    expect(await notificationRows(control.id, 'draft_ready')).toHaveLength(1);
  });

  it('suppresses in-app while email stays on', async () => {
    const owner = await seedUser(ctx, { roles: ['valuation_user'] });
    await putPrefs(owner.token, [{ event_type: 'draft_ready', in_app: false, email: true }]);

    const vid = await createValuation(owner.token);
    await setState(vid, 'drafted', 'reviewed');

    expect(await outboxRows(owner.id, 'draft_ready')).toHaveLength(1);
    expect(await notificationRows(owner.id, 'draft_ready')).toHaveLength(0);
  });
});
