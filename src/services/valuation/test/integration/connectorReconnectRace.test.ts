import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import {
  findConnection,
  recordSync,
  recordSyncError,
  setSyncFrequency,
  updateTokens,
  upsertConnection,
  type HrisConnectionRow,
} from '../../src/repos/hrisConnections.js';
import {
  findConnection as findCapTableConnection,
  recordSyncError as recordCapTableSyncError,
  updateTokens as updateCapTableTokens,
  upsertConnection as upsertCapTable,
} from '../../src/repos/capTableConnections.js';

const dbUp = await isDbAvailable();

/**
 * A sync's bookkeeping arriving after the analyst has reconnected.
 *
 * A pull is a long round trip against a third party, and a person reconnecting
 * is a thing that happens *during* one — often because the sync is what looked
 * wrong. `upsertConnection` installs new tokens, clears `sync_failures` and
 * `reconnect_required` and puts the schedule back; the in-flight pull, still
 * carrying the superseded credential, then lands and writes its outcome over
 * all of it.
 *
 * `status <> 'revoked'` — the guard every writer on this row already had —
 * cannot express the difference. It asks whether the connection has ended, not
 * whether this is still the same connection.
 *
 * The damaging version is also the likely one: many providers invalidate the
 * old refresh token when a user re-authorises, so the credential the old pull
 * holds is refused *because of* the reconnect. That is a
 * `ReconnectRequiredError`, which is terminal — `reconnect_required = true`,
 * `next_sync_at = NULL` — on a connection whose authorisation is seconds old
 * and working.
 */
describe.skipIf(!dbUp)('connector bookkeeping across a reconnect', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  const ACTOR = { actorType: 'human', actorId: null } as const;

  const connect = async (company: string): Promise<HrisConnectionRow> => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: company },
    });
    const valuationId = created.json().valuation.id as string;
    return upsertConnection(
      ctx.pool,
      {
        valuationId,
        provider: 'gusto',
        tokens: { accessToken: 'tok-1', refreshToken: 'ref-1', expiresAt: null },
        connectedBy: ops.id,
      },
      { ...ACTOR, actorId: ops.id },
    );
  };

  /** A connection on the standing daily pull, which is where the race lives. */
  const connectScheduled = async (company: string): Promise<HrisConnectionRow> => {
    const row = await connect(company);
    await setSyncFrequency(ctx.pool, row.id, 'daily', { ...ACTOR, actorId: ops.id });
    return (await findConnection(ctx.pool, row.valuation_id, 'gusto'))!;
  };

  const reconnect = (row: HrisConnectionRow) =>
    upsertConnection(
      ctx.pool,
      {
        valuationId: row.valuation_id,
        provider: 'gusto',
        tokens: { accessToken: 'tok-2', refreshToken: 'ref-2', expiresAt: null },
        connectedBy: ops.id,
      },
      { ...ACTOR, actorId: ops.id },
    );

  it('bumps the generation on a reconnect and not on anything else', () => {
    // The property the pin rests on, stated where it can fail: reconnecting is
    // a new authorisation, and a token refresh is the same one continuing.
    expect.assertions(2);
    return connect('GenerationCo').then(async (first) => {
      expect(first.auth_generation).toBe(1);
      const again = await reconnect(first);
      expect(again.auth_generation).toBe(2);
    });
  });

  it('does not mark a freshly reconnected connector as needing a reconnect', async () => {
    const stale = await connectScheduled('LateTerminalCo');
    const fresh = await reconnect(stale);

    // The pull that was already running when the analyst reconnected finally
    // returns, and the provider has refused the credential it was holding —
    // which is what re-authorising did to it.
    await recordSyncError(ctx.pool, stale, 'refresh token rejected', { terminal: true });

    const live = (await findConnection(ctx.pool, fresh.valuation_id, 'gusto'))!;
    expect(live.status).toBe('connected');
    expect(live.reconnect_required).toBe(false);
    expect(live.last_error).toBeNull();
    // And the schedule the reconnect restored is still there — the whole point
    // of reconnecting is the standing pull.
    expect(live.next_sync_at).not.toBeNull();
  });

  it('does not put a fresh connector on a backoff for the old one’s outage', async () => {
    const stale = await connectScheduled('LateTransientCo');
    const fresh = await reconnect(stale);
    const restored = fresh.next_sync_at!.getTime();

    await recordSyncError(ctx.pool, stale, 'provider returned 503');

    const live = (await findConnection(ctx.pool, fresh.valuation_id, 'gusto'))!;
    expect(live.status).toBe('connected');
    expect(live.sync_failures).toBe(0);
    expect(live.next_sync_at!.getTime()).toBe(restored);
  });

  it('does not credit the new authorisation with the old one’s success', async () => {
    const stale = await connect('LateSuccessCo');
    const fresh = await reconnect(stale);

    await recordSync(ctx.pool, stale, { roster_count: 3 });

    const live = (await findConnection(ctx.pool, fresh.valuation_id, 'gusto'))!;
    expect(live.last_synced_at).toBeNull();
    expect(live.last_sync_summary).toBeNull();
  });

  it('closes the same race on the cap-table family, not just the HRIS one', async () => {
    // The three connector families are the same row three times, and a guard
    // written to one spelling missing its twin is this estate's recurring
    // shape. `accounting_connections` is deliberately not here: it is
    // manual-import only, so it has no standing pull to outlive a reconnect.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'CapTableRaceCo' },
    });
    const valuationId = created.json().valuation.id as string;
    const tokens = { accessToken: 'tok-1', refreshToken: 'ref-1', expiresAt: null };
    const stale = await upsertCapTable(
      ctx.pool,
      { valuationId, provider: 'carta', tokens, connectedBy: ops.id },
      { ...ACTOR, actorId: ops.id },
    );
    await upsertCapTable(
      ctx.pool,
      {
        valuationId,
        provider: 'carta',
        tokens: { accessToken: 'tok-2', refreshToken: 'ref-2', expiresAt: null },
        connectedBy: ops.id,
      },
      { ...ACTOR, actorId: ops.id },
    );

    await recordCapTableSyncError(ctx.pool, stale, 'refresh token rejected', { terminal: true });

    const live = (await findCapTableConnection(ctx.pool, valuationId, 'carta'))!;
    expect(live.status).toBe('connected');
    expect(live.reconnect_required).toBe(false);
  });

  /*
   * The refresh, which is the writer with the credential in its hands.
   *
   * `accessTokenFor` renews *inside* the pull, on the row the scheduler read at
   * the top of the tick, so it has the same window the pull has. Writing a
   * token minted from the superseded refresh token over the one the reconnect
   * installed is not a superseded summary the next tick corrects — on the
   * premise migration 0197 is built on (a provider invalidating the old refresh
   * token family when a user re-authorises) it is a dead credential stored as
   * the live one, and the next sync's 401 is read as "reconnect required".
   */
  it('does not overwrite a reconnect’s credential with the old authorisation’s refresh', async () => {
    const stale = await connectScheduled('LateRefreshCo');
    const fresh = await reconnect(stale);

    await updateTokens(ctx.pool, stale, {
      accessToken: 'tok-1-refreshed',
      refreshToken: 'ref-1-refreshed',
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const live = (await findConnection(ctx.pool, fresh.valuation_id, 'gusto'))!;
    expect(live.access_token).toBe('tok-2');
    expect(live.refresh_token).toBe('ref-2');
    // And the schedule the reconnect restored is untouched, so the standing
    // pull is not waiting on a credential nobody can spend.
    expect(live.next_sync_at).not.toBeNull();
  });

  it('closes the refresh race on the cap-table family too', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'CapTableRefreshRaceCo' },
    });
    const valuationId = created.json().valuation.id as string;
    const stale = await upsertCapTable(
      ctx.pool,
      {
        valuationId,
        provider: 'pulley',
        tokens: { accessToken: 'tok-1', refreshToken: 'ref-1', expiresAt: null },
        connectedBy: ops.id,
      },
      { ...ACTOR, actorId: ops.id },
    );
    await upsertCapTable(
      ctx.pool,
      {
        valuationId,
        provider: 'pulley',
        tokens: { accessToken: 'tok-2', refreshToken: 'ref-2', expiresAt: null },
        connectedBy: ops.id,
      },
      { ...ACTOR, actorId: ops.id },
    );

    await updateCapTableTokens(ctx.pool, stale, {
      accessToken: 'tok-1-refreshed',
      refreshToken: 'ref-1-refreshed',
      expiresAt: null,
    });

    const live = (await findCapTableConnection(ctx.pool, valuationId, 'pulley'))!;
    expect(live.access_token).toBe('tok-2');
    expect(live.refresh_token).toBe('ref-2');
  });

  it('still stores a refresh the current authorisation asked for', async () => {
    // The pin has to be narrow enough that the ordinary renewal still lands —
    // an unstorable refresh is the 401 loop R252 removed, back again.
    const row = await connect('OrdinaryRefreshCo');
    await updateTokens(ctx.pool, row, {
      accessToken: 'tok-renewed',
      refreshToken: 'ref-renewed',
      expiresAt: null,
    });
    const after = (await findConnection(ctx.pool, row.valuation_id, 'gusto'))!;
    expect(after.access_token).toBe('tok-renewed');
    expect(after.refresh_token).toBe('ref-renewed');
  });

  it('still records the outcome of a pull nothing superseded', async () => {
    // The pin has to be narrow enough that the ordinary sync still writes —
    // a guard that refuses everything is the same outage in a new place.
    const row = await connect('OrdinarySyncCo');
    await recordSync(ctx.pool, row, { roster_count: 7 });
    const after = (await findConnection(ctx.pool, row.valuation_id, 'gusto'))!;
    expect(after.last_synced_at).not.toBeNull();

    await recordSyncError(ctx.pool, after, 'provider returned 503');
    const errored = (await findConnection(ctx.pool, row.valuation_id, 'gusto'))!;
    expect(errored.status).toBe('error');
    expect(errored.sync_failures).toBe(1);
  });
});
