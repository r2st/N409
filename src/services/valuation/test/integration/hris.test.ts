import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { createGrant, listGrants } from '../../src/repos/grants.js';
import { existingGrantExternalIds } from '../../src/repos/hrisConnections.js';
import { signCapTableSyncState, signHrisState } from '../../src/auth/jwt.js';
import { runDueHrisSyncs } from '../../src/routes/hris.js';
import {
  authHeader,
  interceptPoolQueries,
  isDbAvailable,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';

/** A sweep logger that keeps nothing — these cases assert on the row. */
const silentLog = { warn: () => {}, error: () => {}, info: () => {} };

const dbUp = await isDbAvailable();

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ROSTER = {
  companyName: 'Acme',
  employees: [
    {
      id: 'e1',
      fullName: 'Ada Lovelace',
      workEmail: 'ada@acme.com',
      equityGrants: [
        {
          id: 'g1',
          optionsGranted: 10000,
          strikePrice: 1.25,
          grantDate: '2025-03-01',
          vesting: { months: 48, cliffMonths: 12 },
        },
      ],
    },
    {
      id: 'e2',
      fullName: 'Alan Turing',
      workEmail: 'alan@acme.com',
      equityGrants: [{ id: 'g2', optionsGranted: 5000, strikePrice: 1.25, grantDate: '2025-06-01' }],
    },
  ],
};

/** Swapped per test; the mock reads it at request time. */
let rosterBody: unknown = ROSTER;
/** When set, the roster endpoint answers 503 — a provider-side failure. */
let rosterFails = false;
/** When set, the roster endpoint answers 429 with this `Retry-After` header. */
let rosterRateLimitedFor: string | null = null;
/** Every form body the provider's token endpoint was posted, in order. */
let tokenCalls: Array<Record<string, string>> = [];
/** Every bearer token the roster endpoint was presented, in order. */
let rosterTokens: string[] = [];
/** Swapped per test to make the token endpoint answer a refresh differently. */
const defaultTokenResponder = (params: URLSearchParams): Response =>
  params.get('grant_type') === 'refresh_token'
    ? jsonResponse({ access_token: 'refreshed', expires_in: 3600 })
    : jsonResponse({ access_token: 'tok', expires_in: 3600, refresh_token: 'r1', company_id: 'co1' });
let tokenResponder: (params: URLSearchParams) => Response = defaultTokenResponder;

function mockFetch() {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/token')) {
      const params = new URLSearchParams(String(init?.body ?? ''));
      tokenCalls.push(Object.fromEntries(params));
      return tokenResponder(params);
    }
    if (u.includes('/employees')) {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
      rosterTokens.push(auth.replace(/^Bearer /, ''));
      if (rosterRateLimitedFor !== null) {
        return new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': rosterRateLimitedFor },
        });
      }
      return rosterFails ? jsonResponse({ error: 'upstream' }, 503) : jsonResponse(rosterBody);
    }
    throw new Error(`unexpected fetch ${u}`);
  });
}

describe.skipIf(!dbUp)('HRIS sync for ASC 718 (feature 11)', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp(
      { RIPPLING_CLIENT_ID: 'cid', RIPPLING_CLIENT_SECRET: 'sec' },
      { hrisFetch: mockFetch() as unknown as typeof fetch },
    );
    ops = await seedUser(ctx, { roles: ['reviewer'] });
  });
  beforeEach(() => {
    rosterBody = ROSTER;
    rosterFails = false;
    rosterRateLimitedFor = null;
    tokenCalls = [];
    rosterTokens = [];
    tokenResponder = defaultTokenResponder;
  });
  afterAll(async () => ctx?.teardown());

  async function connectedValuation() {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Acme', userId: ops.id },
      { actorType: 'human', actorId: ops.id, source: 'test' },
    );
    const state = await signHrisState(
      { valuationId: v.id, provider: 'rippling', userId: ops.id },
      { secret: 'integration-test-secret-0123456789abcdef', issuer: 'n409', ttlSeconds: 3600 },
    );
    const cb = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/hris/callback?state=${encodeURIComponent(state)}&code=abc&company_id=co1`,
    });
    expect(cb.statusCode).toBe(302);
    return v;
  }

  it('refuses a cap-table-sync state at the HRIS callback', async () => {
    // The callback is unauthenticated by design — the signed state is its only
    // credential — so a state minted for a different integration must not be
    // redeemable here, however identical its payload looks.
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Confusable', userId: ops.id },
      { actorType: 'human', actorId: ops.id, source: 'test' },
    );
    const foreignState = await signCapTableSyncState(
      { valuationId: v.id, provider: 'rippling', userId: ops.id },
      { secret: 'integration-test-secret-0123456789abcdef', issuer: 'n409', ttlSeconds: 3600 },
    );
    const cb = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/hris/callback?state=${encodeURIComponent(foreignState)}&code=abc&company_id=co1`,
    });
    expect(cb.statusCode).toBe(422);
  });

  it('lists providers with Rippling configured', async () => {
    const v = await connectedValuation();
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${v.id}/hris`,
      headers: authHeader(ops.token),
    });
    const rippling = res.json().providers.find((p: { provider: string }) => p.provider === 'rippling');
    expect(rippling.configured).toBe(true);
    expect(rippling.connection.status).toBe('connected');
  });

  it('pulls the roster + grants into ASC 718 and re-syncs idempotently', async () => {
    const v = await connectedValuation();

    const pull = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/hris/rippling/pull`,
      headers: authHeader(ops.token),
    });
    expect(pull.statusCode).toBe(200);
    expect(pull.json()).toMatchObject({
      roster_count: 2,
      grants_found: 2,
      grants_created: 2,
      grants_skipped: 0,
    });

    const { grants } = await listGrants(ctx.pool, v.id);
    expect(grants).toHaveLength(2);
    const ada = grants.find((g) => g.grantee_email === 'ada@acme.com')!;
    expect(ada.options_count).toBe(10000);
    expect(ada.vesting_template).toBe('imported');

    // Re-sync: nothing new, all skipped (idempotent on external_id).
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/hris/rippling/pull`,
      headers: authHeader(ops.token),
    });
    expect(again.json()).toMatchObject({ grants_created: 0, grants_skipped: 2 });
    expect((await listGrants(ctx.pool, v.id)).grants).toHaveLength(2);
  });

  /**
   * The dedupe set is bounded by the pull, not by the cap table.
   *
   * This is the one read in this file that may never be capped: the caller
   * skips a grant it finds in the set, so a short set is a duplicate grant
   * rather than a short list. The bound therefore has to come from the pull —
   * the set is complete for everything the caller is about to iterate no
   * matter how many grants the valuation already holds.
   *
   * The discriminator is the 200 grants seeded below, none of which appear in
   * the roster. Under the previous spelling — `SELECT external_id FROM
   * option_grants WHERE valuation_id = $1` — all 200 came back to answer a
   * question about two, and this test asserts the size that spelling would
   * report. It is a bound, not a behaviour: idempotency itself is asserted
   * above, and holds either way.
   */
  it('asks the grant dedupe set about the pull, not about the whole cap table', async () => {
    const v = await connectedValuation();
    const ids = Array.from({ length: 200 }, (_, i) => `unrelated-${i}`);
    for (const externalId of ids) {
      await createGrant(
        ctx.pool,
        {
          valuationId: v.id,
          granteeName: 'Prior Holder',
          granteeEmail: `prior-${externalId}@acme.com`,
          grantDate: '2024-01-01',
          optionsCount: 100,
          exercisePrice: 1,
          currency: 'USD',
          vestingTemplate: 'imported',
          vestingStartDate: '2024-01-01',
          vestingMonths: 48,
          cliffMonths: 12,
          frequencyMonths: 1,
          createdBy: ops.id,
          externalId,
        },
        { actorType: 'system', actorId: 'test', source: 'hris_sync' },
      );
    }

    const seen = await existingGrantExternalIds(ctx.pool, v.id, ['g1', 'unrelated-7']);
    expect([...seen].sort()).toEqual(['unrelated-7']);
    expect(seen.size).toBe(1);

    // Nothing to ask about is not a table scan either.
    expect((await existingGrantExternalIds(ctx.pool, v.id, [])).size).toBe(0);

    // And the sync still skips what it has already imported.
    const pull = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/hris/rippling/pull`,
      headers: authHeader(ops.token),
    });
    expect(pull.json()).toMatchObject({ grants_created: 2, grants_skipped: 0 });
    const repeat = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/hris/rippling/pull`,
      headers: authHeader(ops.token),
    });
    expect(repeat.json()).toMatchObject({ grants_created: 0, grants_skipped: 2 });
  });

  /**
   * One provider row carrying a day that is not a day.
   *
   * `grant_date` is `date NOT NULL`, and the insert loop in
   * `syncHrisConnection` has no catch of its own — so before the mapper held
   * provider dates to a real calendar, `2026-02-31` reached the driver, raised
   * `date/time field value out of range`, and took the whole sync with it: the
   * grants ahead of it in the loop committed, the ones behind it never ran,
   * and `recordSync` was never reached, so the connection's next-due never
   * advanced and the scheduled sweep failed it identically on every pass.
   */
  it('imports the rest of a roster when one provider grant is dated to a day that does not exist', async () => {
    rosterBody = {
      companyName: 'Acme',
      employees: [
        {
          id: 'e1',
          fullName: 'Ada Lovelace',
          workEmail: 'ada@acme.com',
          equityGrants: [
            { id: 'bad', optionsGranted: 10000, strikePrice: 1, grantDate: '2026-02-31' },
            { id: 'good', optionsGranted: 5000, strikePrice: 1, grantDate: '2026-03-01' },
          ],
        },
      ],
    };
    const v = await connectedValuation();

    const pull = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/hris/rippling/pull`,
      headers: authHeader(ops.token),
    });
    // Previously a 500: the impossible day reached a `date NOT NULL` column.
    expect(pull.statusCode).toBe(200);
    expect(pull.json()).toMatchObject({ grants_found: 1, grants_created: 1 });

    const { grants } = await listGrants(ctx.pool, v.id);
    expect(grants.map((g) => g.external_id)).toEqual(['good']);
  });

  it("answers a provider failure in the provider's terms", async () => {
    // The half of the catch that is safe to forward, and the reason the
    // forwarding existed: `IntegrationError` messages name who failed and how,
    // and carry nothing from the response body.
    const v = await connectedValuation();
    rosterFails = true;
    const pull = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/hris/rippling/pull`,
      headers: authHeader(ops.token),
    });
    expect(pull.statusCode).toBe(422);
    expect(pull.json().detail).toBe('Sync failed: Rippling roster fetch failed (503)');
  });

  it("does not answer a driver error with the driver's wording", async () => {
    /*
     * The rule under test is the route's, not the mapper's: when
     * `syncHrisConnection` throws something that is not an `IntegrationError`,
     * the analyst gets this service's own constant and the real error goes to
     * the log and the connection's last-error row.
     *
     * The vehicle used to be an options count past int4, which reached
     * `options_count integer NOT NULL` and came back as `value "3000000000" is
     * out of range for type integer`. R201 stopped that input at the mapper —
     * see the case below — so the failure is staged at the driver directly.
     * That is the more honest shape anyway: the claim is about what the route
     * does with a database error, not about which payload happens to cause
     * one.
     *
     * A check violation rather than the unique violation this staged until
     * R261, which now has a meaning of its own: a collision on
     * `option_grants_external_idx` is the other door having imported the same
     * grant a moment earlier, and is counted as skipped rather than raised.
     * Every other refusal from this insert is still a refusal.
     */
    const v = await connectedValuation();
    const restore = interceptPoolQueries(ctx.pool, (sql) => {
      if (!/INSERT INTO option_grants/i.test(sql)) return undefined;
      const err = Object.assign(
        new Error(
          'new row for relation "option_grants" violates check constraint "option_grants_options_count_check"',
        ),
        { code: '23514', constraint: 'option_grants_options_count_check', table: 'option_grants' },
      );
      throw err;
    });
    try {
      const pull = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${v.id}/hris/rippling/pull`,
        headers: authHeader(ops.token),
      });
      expect(pull.statusCode).toBe(422);
      const { detail } = pull.json();
      expect(detail).toBe("Rippling sync failed \u2014 the details are in the connection's last error");
      for (const leak of ['duplicate key', 'constraint', 'option_grants', 'external_idx'])
        expect(detail, leak).not.toContain(leak);
    } finally {
      restore();
    }
  });

  /**
   * A provider record this platform will not store (round 201, M6).
   *
   * Each of these used to be mapped and handed to the driver, which refused
   * the row — and the insert loop is not transactional, so the refusal ended
   * the import with the grants before it written and the ones after it never
   * attempted. On the next scheduled pass the same payload failed the same
   * way. One bad record in a directory of four hundred meant nobody's grants
   * imported, indefinitely.
   *
   * The fix holds the import to the bounds `POST /grants` enforces, drops what
   * cannot be stored the way `mapGrant` already dropped a grant with no date —
   * and *counts* the drops, so a short roster is visible rather than silent.
   */
  it.each([
    ['an options count past int4', { optionsGranted: 3_000_000_000 }],
    ['a negative strike price', { strikePrice: -5 }],
    ['a strike price past the bound the form enforces', { strikePrice: 1e12 }],
    ['an external id longer than the unique index can hold', { id: 'g'.repeat(4000) }],
    ['an external id that is not a string', { id: { nested: true } }],
    [
      'a NUL byte in the grantee name, which no text column takes',
      {},
      { fullName: `Ada${String.fromCharCode(0)}Lovelace` },
    ],
    ['a grant date in year zero, which SQL has no day in', { grantDate: '0000-03-01' }],
  ])('rejects %s without ending the import', async (_label, grantPatch, empPatch = {}) => {
    rosterBody = {
      companyName: 'Acme',
      employees: [
        {
          id: 'bad',
          fullName: 'Bad Record',
          workEmail: 'bad@acme.com',
          ...empPatch,
          equityGrants: [
            { id: 'bad-1', optionsGranted: 100, strikePrice: 1, grantDate: '2025-03-01', ...grantPatch },
          ],
        },
        {
          id: 'good',
          fullName: 'Grace Hopper',
          workEmail: 'grace@acme.com',
          equityGrants: [{ id: 'good-1', optionsGranted: 250, strikePrice: 2, grantDate: '2025-04-01' }],
        },
      ],
    };
    const v = await connectedValuation();
    const pull = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/hris/rippling/pull`,
      headers: authHeader(ops.token),
    });
    // The sync completes, and says what it would not take.
    expect(pull.statusCode).toBe(200);
    expect(pull.json()).toMatchObject({ grants_found: 1, grants_created: 1, grants_rejected: 1 });

    // The employee after the bad record is imported, which is the half the
    // aborted loop lost.
    const { grants } = await listGrants(ctx.pool, v.id);
    expect(grants.map((g) => g.external_id)).toEqual(['good-1']);
  });

  it('leaves the connection healthy after rejecting a record, so the next sync runs', async () => {
    rosterBody = {
      companyName: 'Acme',
      employees: [
        {
          id: 'e1',
          fullName: 'Ada Lovelace',
          equityGrants: [{ id: 'g1', optionsGranted: -1, grantDate: '2025-03-01' }],
        },
      ],
    };
    const v = await connectedValuation();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/hris/rippling/pull`,
      headers: authHeader(ops.token),
    });
    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${v.id}/hris`,
      headers: authHeader(ops.token),
    });
    const connection = listed
      .json()
      .providers.find((p: { provider: string }) => p.provider === 'rippling').connection;
    // Not `error`, and no message: nothing failed. A record was refused at the
    // door and reported in the summary, which is a different thing from the
    // import breaking.
    expect(connection.status).toBe('connected');
    expect(connection.last_error).toBeNull();
  });

  describe('an access token that has expired (R252)', () => {
    /**
     * The connection row has held a refresh token and an expiry since the
     * feature shipped and nothing read either, so a scheduled sync worked for
     * as long as the first access token did — two hours at Gusto — and then
     * failed `401` forever, dropping out of `findDueConnections` on the first
     * failure and never being tried again.
     */
    const expireToken = async (valuationId: string) =>
      ctx.pool.query(
        `UPDATE hris_connections SET token_expires_at = now() - interval '1 hour'
          WHERE valuation_id = $1`,
        [valuationId],
      );

    it('spends the refresh token and pulls with the new one', async () => {
      const v = await connectedValuation();
      await expireToken(v.id);
      tokenResponder = (params) =>
        params.get('grant_type') === 'refresh_token'
          ? jsonResponse({ access_token: 'fresh', expires_in: 3600 })
          : jsonResponse({ access_token: 'tok', expires_in: 3600, refresh_token: 'r1' });

      const pull = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${v.id}/hris/rippling/pull`,
        headers: authHeader(ops.token),
      });

      expect(pull.statusCode).toBe(200);
      expect(tokenCalls.at(-1)).toMatchObject({ grant_type: 'refresh_token', client_id: 'cid' });
      // The pull used the renewed credential, not the expired one it was
      // holding when the sync started.
      expect(rosterTokens).toEqual(['fresh']);
      const { rows } = await ctx.pool.query<{ token_expires_at: Date; status: string }>(
        'SELECT token_expires_at, status FROM hris_connections WHERE valuation_id = $1',
        [v.id],
      );
      expect(rows[0]!.status).toBe('connected');
      expect(rows[0]!.token_expires_at.getTime()).toBeGreaterThan(Date.now());
    });

    it('keeps the refresh token the provider did not rotate', async () => {
      // Most providers answer a refresh with an access token alone. Writing the
      // absent one back as NULL would make this the last refresh the
      // connection could ever perform.
      const v = await connectedValuation();
      await ctx.pool.query(
        `UPDATE hris_connections SET token_expires_at = now() - interval '1 hour' WHERE valuation_id = $1`,
        [v.id],
      );
      const before = await ctx.pool.query<{ refresh_token: string | null }>(
        'SELECT refresh_token FROM hris_connections WHERE valuation_id = $1',
        [v.id],
      );
      tokenResponder = (params) =>
        params.get('grant_type') === 'refresh_token'
          ? jsonResponse({ access_token: 'fresh', expires_in: 3600 })
          : jsonResponse({ access_token: 'tok', expires_in: 3600, refresh_token: 'r1' });

      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${v.id}/hris/rippling/pull`,
        headers: authHeader(ops.token),
      });

      const after = await ctx.pool.query<{ refresh_token: string | null }>(
        'SELECT refresh_token FROM hris_connections WHERE valuation_id = $1',
        [v.id],
      );
      expect(after.rows[0]!.refresh_token).toBe(before.rows[0]!.refresh_token);
      expect(after.rows[0]!.refresh_token).not.toBeNull();
    });

    it('says so in words when the provider refuses the refresh', async () => {
      const v = await connectedValuation();
      await expireToken(v.id);
      tokenResponder = (params) =>
        params.get('grant_type') === 'refresh_token'
          ? jsonResponse({ error: 'invalid_grant' }, 400)
          : jsonResponse({ access_token: 'tok', expires_in: 3600, refresh_token: 'r1' });

      const pull = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${v.id}/hris/rippling/pull`,
        headers: authHeader(ops.token),
      });

      expect(pull.statusCode).toBe(422);
      expect(pull.json().detail).toMatch(/reconnect Rippling/i);
      // The roster was never asked for with a credential we knew was spent.
      expect(rosterTokens).toEqual([]);
      const { rows } = await ctx.pool.query<{ status: string; last_error: string }>(
        'SELECT status, last_error FROM hris_connections WHERE valuation_id = $1',
        [v.id],
      );
      expect(rows[0]!.status).toBe('error');
      expect(rows[0]!.last_error).toMatch(/reconnect Rippling/i);
    });

    it('leaves a briefly unwell token endpoint to the next tick', async () => {
      // A 5xx from the auth server is not an ended authorisation, so the
      // message must not tell anybody to reconnect.
      const v = await connectedValuation();
      await expireToken(v.id);
      tokenResponder = (params) =>
        params.get('grant_type') === 'refresh_token'
          ? jsonResponse({ error: 'upstream' }, 503)
          : jsonResponse({ access_token: 'tok', expires_in: 3600, refresh_token: 'r1' });

      const pull = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${v.id}/hris/rippling/pull`,
        headers: authHeader(ops.token),
      });

      expect(pull.statusCode).toBe(422);
      expect(pull.json().detail).not.toMatch(/reconnect/i);
      const { rows } = await ctx.pool.query<{ last_error: string }>(
        'SELECT last_error FROM hris_connections WHERE valuation_id = $1',
        [v.id],
      );
      expect(rows[0]!.last_error).toMatch(/token refresh failed \(503\)/);
    });

    it('does not renew a token on a connection that was revoked', async () => {
      // `updateTokens` is guarded like every other writer on the row: a revoke
      // landing mid-sync ends the connection, and writing a live token back
      // over the blanked one would hand it a working credential again.
      const v = await connectedValuation();
      await expireToken(v.id);
      const { updateTokens } = await import('../../src/repos/hrisConnections.js');
      const { rows: before } = await ctx.pool.query<{ id: string }>(
        'SELECT id FROM hris_connections WHERE valuation_id = $1',
        [v.id],
      );
      await ctx.pool.query(
        `UPDATE hris_connections SET status = 'revoked', access_token = '', refresh_token = NULL
          WHERE id = $1`,
        [before[0]!.id],
      );

      await updateTokens(ctx.pool, before[0]!.id, {
        accessToken: 'fresh',
        refreshToken: 'r2',
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      const { rows } = await ctx.pool.query<{ access_token: string; refresh_token: string | null }>(
        'SELECT access_token, refresh_token FROM hris_connections WHERE id = $1',
        [before[0]!.id],
      );
      expect(rows[0]!.access_token).toBe('');
      expect(rows[0]!.refresh_token).toBeNull();
    });
  });

  describe('a sync that failed (R252)', () => {
    /**
     * `recordSyncError` writes `status = 'error'` and `findDueConnections`
     * asked for `status = 'connected'`, so the first failure of any kind ended
     * the schedule permanently — one 503 at three in the morning and the daily
     * sync was over, with the panel still showing the cadence somebody chose.
     */
    const connectionRow = async (valuationId: string) => {
      const { rows } = await ctx.pool.query<{
        id: string;
        status: string;
        sync_failures: number;
        next_sync_at: Date | null;
        reconnect_required: boolean;
      }>(
        `SELECT id, status, sync_failures, next_sync_at, reconnect_required
           FROM hris_connections WHERE valuation_id = $1`,
        [valuationId],
      );
      return rows[0]!;
    };

    const makeDue = (valuationId: string) =>
      ctx.pool.query(
        `UPDATE hris_connections
            SET sync_frequency = 'weekly', next_sync_at = now() - interval '1 hour'
          WHERE valuation_id = $1`,
        [valuationId],
      );

    it('schedules a retry on a backoff after a provider failure', async () => {
      const v = await connectedValuation();
      await makeDue(v.id);
      rosterFails = true;

      await runDueHrisSyncs({
        pool: ctx.pool,
        fetchFn: mockFetch() as unknown as typeof fetch,
        log: silentLog,
      });

      const row = await connectionRow(v.id);
      expect(row.status).toBe('error');
      expect(row.sync_failures).toBe(1);
      // Not the ordinary fifteen-minute tick — that is how a provider's rate
      // limit becomes a longer one — and not never, which is what it used to be.
      const waitMinutes = (row.next_sync_at!.getTime() - Date.now()) / 60_000;
      expect(waitMinutes).toBeGreaterThan(10);
      expect(waitMinutes).toBeLessThan(20);
      // Nothing is being asked of anybody, and since R256 the row says so — a
      // card that asks for a reconnect here sends somebody to redo a working
      // authorisation to fix a hiccup that clears itself in fifteen minutes.
      expect(row.reconnect_required).toBe(false);
    });

    /**
     * R261 (M5). `providerRefused` has read `Retry-After` since R255 and spent
     * it on the sentence an analyst reads — "try again in about 7200s" — while
     * the column that decides when the sweep actually returns never saw it. So
     * a provider naming two hours got another request in fifteen minutes, and
     * another thirty minutes after that: the failure this ladder's own comment
     * says it exists to avoid.
     */
    it('waits at least as long as a rate-limiting provider asked', async () => {
      const v = await connectedValuation();
      await makeDue(v.id);
      rosterRateLimitedFor = '7200';

      await runDueHrisSyncs({
        pool: ctx.pool,
        fetchFn: mockFetch() as unknown as typeof fetch,
        log: silentLog,
      });

      const row = await connectionRow(v.id);
      expect(row.status).toBe('error');
      // The ladder's first rung is fifteen minutes; the provider said two hours.
      const waitMinutes = (row.next_sync_at!.getTime() - Date.now()) / 60_000;
      expect(waitMinutes).toBeGreaterThan(115);
      expect(waitMinutes).toBeLessThan(125);
      expect(row.reconnect_required).toBe(false);
    });

    it('keeps the ladder when the provider asked for less than it', async () => {
      // A floor, not the answer: the header knows when this provider will next
      // serve a request, the ladder knows how long this connection has been
      // failing, and the later of the two can only ever wait longer.
      const v = await connectedValuation();
      await makeDue(v.id);
      rosterRateLimitedFor = '30';

      await runDueHrisSyncs({
        pool: ctx.pool,
        fetchFn: mockFetch() as unknown as typeof fetch,
        log: silentLog,
      });

      const waitMinutes = ((await connectionRow(v.id)).next_sync_at!.getTime() - Date.now()) / 60_000;
      expect(waitMinutes).toBeGreaterThan(10);
      expect(waitMinutes).toBeLessThan(20);
    });

    it('picks the connection up again when the retry falls due, and clears the count', async () => {
      const v = await connectedValuation();
      await makeDue(v.id);
      rosterFails = true;
      await runDueHrisSyncs({
        pool: ctx.pool,
        fetchFn: mockFetch() as unknown as typeof fetch,
        log: silentLog,
      });
      expect((await connectionRow(v.id)).status).toBe('error');

      // The provider comes back, and the retry time arrives.
      rosterFails = false;
      await ctx.pool.query(
        `UPDATE hris_connections SET next_sync_at = now() - interval '1 minute' WHERE valuation_id = $1`,
        [v.id],
      );
      const recovered: Array<Record<string, unknown>> = [];
      const processed = await runDueHrisSyncs({
        pool: ctx.pool,
        fetchFn: mockFetch() as unknown as typeof fetch,
        log: { ...silentLog, info: (fields) => void recovered.push(fields as Record<string, unknown>) },
      });

      expect(processed).toBeGreaterThanOrEqual(1);
      const row = await connectionRow(v.id);
      expect(row.status).toBe('connected');
      expect(row.sync_failures).toBe(0);
      // And the log closes the loop it opened (R258). Without this the journal
      // holds a warn about a connector that has been healthy ever since, and
      // the only way to tell that from one still broken is to read the row.
      expect(recovered).toEqual([
        expect.objectContaining({ valuationId: v.id, provider: 'rippling', priorFailures: 1 }),
      ]);
    });

    it('backs off further on each consecutive failure', async () => {
      const v = await connectedValuation();
      await makeDue(v.id);
      rosterFails = true;
      const waits: number[] = [];
      for (let i = 0; i < 3; i++) {
        await ctx.pool.query(
          `UPDATE hris_connections SET next_sync_at = now() - interval '1 minute' WHERE valuation_id = $1`,
          [v.id],
        );
        await runDueHrisSyncs({
          pool: ctx.pool,
          fetchFn: mockFetch() as unknown as typeof fetch,
          log: silentLog,
        });
        const row = await connectionRow(v.id);
        waits.push((row.next_sync_at!.getTime() - Date.now()) / 60_000);
      }
      expect((await connectionRow(v.id)).sync_failures).toBe(3);
      expect(waits.map(Math.round)).toEqual([15, 30, 60]);
    });

    it('stops retrying, and waits for a person, when the authorisation has ended', async () => {
      const v = await connectedValuation();
      await makeDue(v.id);
      await ctx.pool.query(
        `UPDATE hris_connections SET token_expires_at = now() - interval '1 hour' WHERE valuation_id = $1`,
        [v.id],
      );
      tokenResponder = () => jsonResponse({ error: 'invalid_grant' }, 400);

      const lines: Array<{ level: string; fields: Record<string, unknown> }> = [];
      await runDueHrisSyncs({
        pool: ctx.pool,
        fetchFn: mockFetch() as unknown as typeof fetch,
        credentials: { rippling: { clientId: 'cid', clientSecret: 'sec' } },
        log: {
          warn: (fields) => void lines.push({ level: 'warn', fields: fields as Record<string, unknown> }),
          error: (fields) => void lines.push({ level: 'error', fields: fields as Record<string, unknown> }),
          info: (fields) => void lines.push({ level: 'info', fields: fields as Record<string, unknown> }),
        },
      });

      // And the log says which of the two failures this was (R258). It said
      // `warn` for both, which in this estate is a written promise that the
      // retry is coming — and for this one the row two lines down says it is
      // not.
      expect(lines).toHaveLength(1);
      expect(lines[0]!.level).toBe('error');
      expect(lines[0]!.fields).toMatchObject({
        alert: true,
        retried: false,
        reconnect_required: true,
        valuationId: v.id,
        provider: 'rippling',
      });

      const row = await connectionRow(v.id);
      expect(row.status).toBe('error');
      // A refresh token the provider has refused will be refused identically
      // every eight hours forever, so this one is deliberately not retried.
      expect(row.next_sync_at).toBeNull();
      // And `next_sync_at` alone cannot carry that: a `manual` connection has
      // none in either state. See migration 0196.
      expect(row.reconnect_required).toBe(true);
    });

    it('restores the schedule when the client reconnects', async () => {
      // What the reconnect message asks for is the schedule back. A reconnect
      // that only cleared the error would leave the cadence select reading
      // "Weekly" over a connection that never syncs again.
      const v = await connectedValuation();
      await makeDue(v.id);
      await ctx.pool.query(
        `UPDATE hris_connections
            SET status = 'error', sync_failures = 4, next_sync_at = NULL,
                reconnect_required = true
          WHERE valuation_id = $1`,
        [v.id],
      );

      const state = await signHrisState(
        { valuationId: v.id, provider: 'rippling', userId: ops.id },
        { secret: 'integration-test-secret-0123456789abcdef', issuer: 'n409', ttlSeconds: 3600 },
      );
      await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/hris/callback?state=${encodeURIComponent(state)}&code=abc&company_id=co1`,
      });

      const row = await connectionRow(v.id);
      expect(row.status).toBe('connected');
      expect(row.sync_failures).toBe(0);
      expect(row.next_sync_at).not.toBeNull();
      expect(row.reconnect_required).toBe(false);
    });

    /**
     * R261 (M5). A terminal failure is the one state that says no sweep will
     * ever pick this row up again, and the alert `logConnectorSyncFailure`
     * writes is spent on the strength of that. Setting a cadence wrote
     * `next_sync_at` unconditionally, so the dropdown un-finalised it without
     * anybody touching the authorisation the provider had ended: the sweep
     * came back, spent a refresh token already refused, and re-alerted — while
     * `connectorHealth`, which reads `reconnect_required` first, went on
     * drawing "Not syncing" over a connection on a schedule.
     */
    it('does not restart the schedule when a cadence is set on a connection needing a reconnect', async () => {
      const v = await connectedValuation();
      await ctx.pool.query(
        `UPDATE hris_connections
            SET status = 'error', sync_failures = 3, next_sync_at = NULL,
                reconnect_required = true, sync_frequency = 'manual'
          WHERE valuation_id = $1`,
        [v.id],
      );

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${v.id}/hris/rippling/frequency`,
        headers: authHeader(ops.token),
        payload: { frequency: 'daily' },
      });
      expect(res.statusCode).toBe(200);

      // The choice is recorded — it is what the reconnect will start.
      const { rows } = await ctx.pool.query<{ sync_frequency: string; next_sync_at: Date | null }>(
        'SELECT sync_frequency, next_sync_at FROM hris_connections WHERE valuation_id = $1',
        [v.id],
      );
      expect(rows[0]!.sync_frequency).toBe('daily');
      expect(rows[0]!.next_sync_at).toBeNull();

      // And nothing is due, so no sweep spends the refused credential again.
      rosterFails = true;
      const processed = await runDueHrisSyncs({
        pool: ctx.pool,
        fetchFn: mockFetch() as unknown as typeof fetch,
        log: silentLog,
      });
      expect(processed).toBe(0);
      expect((await connectionRow(v.id)).sync_failures).toBe(3);
    });

    it('starts the cadence chosen while the connection was dead once it reconnects', async () => {
      const v = await connectedValuation();
      await ctx.pool.query(
        `UPDATE hris_connections
            SET status = 'error', next_sync_at = NULL, reconnect_required = true,
                sync_frequency = 'manual'
          WHERE valuation_id = $1`,
        [v.id],
      );
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${v.id}/hris/rippling/frequency`,
        headers: authHeader(ops.token),
        payload: { frequency: 'weekly' },
      });

      const state = await signHrisState(
        { valuationId: v.id, provider: 'rippling', userId: ops.id },
        { secret: 'integration-test-secret-0123456789abcdef', issuer: 'n409', ttlSeconds: 3600 },
      );
      await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/hris/callback?state=${encodeURIComponent(state)}&code=abc&company_id=co1`,
      });

      const row = await connectionRow(v.id);
      expect(row.reconnect_required).toBe(false);
      expect(row.next_sync_at).not.toBeNull();
    });
  });

  /**
   * The two statements the R186 catches did not cover (R261, methodology M5).
   *
   * R186 guarded the fetch and the insert loop, on the reasoning that a sync
   * escaping without bookkeeping leaves `connected` over a due date in the
   * past — so `findDueConnections` re-pulls the provider's whole roster every
   * fifteen minutes, forever, behind a card reading healthy. Two statements
   * were left outside: the dedupe read three lines above the loop, and
   * `recordSync` itself, which is the only thing that moves `next_sync_at`.
   */
  describe('a sync that escaped without bookkeeping (R261)', () => {
    const connectionRow = async (valuationId: string) => {
      const { rows } = await ctx.pool.query<{
        status: string;
        next_sync_at: Date | null;
        last_error: string | null;
      }>('SELECT status, next_sync_at, last_error FROM hris_connections WHERE valuation_id = $1', [
        valuationId,
      ]);
      return rows[0]!;
    };

    const dueWeekly = (valuationId: string) =>
      ctx.pool.query(
        `UPDATE hris_connections
            SET sync_frequency = 'weekly', next_sync_at = now() - interval '1 hour'
          WHERE valuation_id = $1`,
        [valuationId],
      );

    /** Fails every statement whose text contains `marker`, once armed. */
    const failStatement = (marker: string) =>
      interceptPoolQueries(ctx.pool, (sql, phase) => {
        if (phase === 'before' && sql.includes(marker)) throw new Error('injected: statement refused');
      });

    it('records the failure when the dedupe read throws', async () => {
      const v = await connectedValuation();
      await dueWeekly(v.id);
      const restore = failStatement('external_id = ANY');
      try {
        await runDueHrisSyncs({
          pool: ctx.pool,
          fetchFn: mockFetch() as unknown as typeof fetch,
          log: silentLog,
        });
      } finally {
        restore();
      }

      const row = await connectionRow(v.id);
      // Out of the due query, so the re-pull every fifteen minutes stops.
      expect(row.status).toBe('error');
      expect(row.next_sync_at!.getTime()).toBeGreaterThan(Date.now());
      // And not a word of the driver's — `last_error` is served verbatim.
      expect(row.last_error).toContain('stopped before finishing');
      expect(row.last_error).not.toContain('injected');
    });

    /**
     * The grant the other door imported while this pull was in flight (R261).
     *
     * Two doors reach `syncHrisConnection` — the fifteen-minute tick and the
     * analyst's Import button — with no lock between them, and `seen` is a
     * snapshot taken before the loop. The loser of the race hit
     * `option_grants_external_idx`, which threw past the rest of the roster,
     * moved a healthy connection to `error` on a backoff, and told the analyst
     * their import "stopped before finishing" — for a grant that had *just*
     * been imported successfully by the other door.
     */
    it('counts a grant a concurrent sync already created as skipped, not as a failure', async () => {
      const v = await connectedValuation();
      await dueWeekly(v.id);

      // The other door lands between the dedupe read and the insert of `g1`.
      let raced = false;
      const restore = interceptPoolQueries(ctx.pool, async (sql, phase) => {
        if (phase !== 'after' || raced || !sql.includes('external_id = ANY')) return;
        raced = true;
        await createGrant(
          ctx.pool,
          {
            valuationId: v.id,
            granteeName: 'Ada Lovelace',
            granteeEmail: 'ada@acme.com',
            grantDate: '2025-03-01',
            optionsCount: 10000,
            exercisePrice: 1.25,
            currency: 'USD',
            vestingTemplate: 'imported',
            vestingStartDate: '2025-03-01',
            vestingMonths: 48,
            cliffMonths: 12,
            frequencyMonths: 1,
            createdBy: ops.id,
            source: 'hris:rippling',
            externalId: 'g1',
          },
          { actorType: 'system', actorId: 'other-door', source: 'hris_sync' },
        );
      });
      let processed = 0;
      try {
        processed = await runDueHrisSyncs({
          pool: ctx.pool,
          fetchFn: mockFetch() as unknown as typeof fetch,
          log: silentLog,
        });
      } finally {
        restore();
      }

      expect(raced).toBe(true);
      expect(processed).toBe(1);
      // Both grants exist exactly once, and the connection is healthy.
      const grants = await listGrants(ctx.pool, v.id);
      expect(grants.grants.map((g) => g.external_id).sort()).toEqual(['g1', 'g2']);
      const row = await connectionRow(v.id);
      expect(row.status).toBe('connected');
      expect(row.last_error).toBeNull();

      // And the summary calls it what it is: already imported.
      const { rows } = await ctx.pool.query<{ last_sync_summary: Record<string, unknown> }>(
        'SELECT last_sync_summary FROM hris_connections WHERE valuation_id = $1',
        [v.id],
      );
      expect(rows[0]!.last_sync_summary).toMatchObject({ grants_created: 1, grants_skipped: 1 });
    });

    it('records the failure when the success itself cannot be written', async () => {
      const v = await connectedValuation();
      await dueWeekly(v.id);
      // `recordSync` writes `last_sync_summary` as jsonb, which the driver
      // refuses outright for a value carrying a NUL or a lone surrogate.
      const restore = failStatement('last_sync_summary');
      try {
        await runDueHrisSyncs({
          pool: ctx.pool,
          fetchFn: mockFetch() as unknown as typeof fetch,
          log: silentLog,
        });
      } finally {
        restore();
      }

      // The grants really were imported; it is the connection's record of it
      // that did not land, and the row says exactly that.
      expect((await listGrants(ctx.pool, v.id)).grants.length).toBe(2);
      const row = await connectionRow(v.id);
      expect(row.status).toBe('error');
      expect(row.next_sync_at!.getTime()).toBeGreaterThan(Date.now());
      expect(row.last_error).toContain('could not be recorded against this connection');
    });
  });

  describe('the connect and disconnect on the audit spine (R256)', () => {
    /**
     * Connecting a payroll system grants this platform standing read access to
     * a client's roster, in a named person's name. Neither that nor ending it
     * was recorded anywhere: the only trace of a connect was `connected_by` /
     * `connected_at` on the row, overwritten by the next one, and a disconnect
     * left the row still naming whoever had *started* the connection.
     */
    const integrationEvents = async (valuationId: string) => {
      const { rows } = await ctx.pool.query<{
        type: string;
        actor_id: string | null;
        payload: Record<string, unknown>;
      }>(
        `SELECT type, actor_id, payload FROM valuation_events
          WHERE valuation_id = $1 AND type LIKE 'integration_%'
          ORDER BY seq ASC`,
        [valuationId],
      );
      return rows;
    };

    it('records who connected the provider, and who ended it', async () => {
      const v = await connectedValuation();
      expect(await integrationEvents(v.id)).toEqual([
        expect.objectContaining({
          type: 'integration_connected',
          actor_id: ops.id,
          payload: expect.objectContaining({ family: 'hris', provider: 'rippling' }),
        }),
      ]);

      const res = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${v.id}/hris/rippling`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(204);

      const after = await integrationEvents(v.id);
      expect(after.map((e) => e.type)).toEqual(['integration_connected', 'integration_disconnected']);
      expect(after[1]!.actor_id).toBe(ops.id);
    });

    it('does not record a second disconnect, because there was not one', async () => {
      // `revoked` is terminal and the write is guarded on it, so the repeat
      // updates no row. The event is written from what the statement returned
      // rather than beside it, so nothing is recorded for a transition that
      // did not happen — and the route still answers 404.
      const v = await connectedValuation();
      const del = () =>
        ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/valuations/${v.id}/hris/rippling`,
          headers: authHeader(ops.token),
        });
      expect((await del()).statusCode).toBe(204);
      expect((await del()).statusCode).toBe(404);

      const types = (await integrationEvents(v.id)).map((e) => e.type);
      expect(types).toEqual(['integration_connected', 'integration_disconnected']);
    });

    /**
     * The third transition of the same row (R258). Setting a cadence is a
     * person arranging for a third party to be read every day from here on
     * without anybody being asked again, and setting it back to Manual is that
     * arrangement ending — after which the connection simply stops producing
     * data and the only record of why is a column saying what it is now.
     */
    const setFrequency = (valuationId: string, frequency: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/hris/rippling/frequency`,
        headers: authHeader(ops.token),
        payload: { frequency },
      });

    it('records who put the pull on a schedule, and what it was before', async () => {
      const v = await connectedValuation();
      expect((await setFrequency(v.id, 'daily')).statusCode).toBe(200);

      const events = await integrationEvents(v.id);
      expect(events.map((e) => e.type)).toEqual(['integration_connected', 'integration_schedule_changed']);
      expect(events[1]!.actor_id).toBe(ops.id);
      expect(events[1]!.payload).toMatchObject({
        family: 'hris',
        provider: 'rippling',
        // The `{ changes: { field: { from, to } } }` shape, so the trail reads
        // "Sync frequency: manual → daily" rather than naming a field called
        // `value` — see `extractChanges`.
        changes: { sync_frequency: { from: 'manual', to: 'daily' } },
      });
    });

    it('records nothing for a cadence set to what it already was', async () => {
      const v = await connectedValuation();
      await setFrequency(v.id, 'daily');
      expect((await setFrequency(v.id, 'daily')).statusCode).toBe(200);
      expect((await integrationEvents(v.id)).map((e) => e.type)).toEqual([
        'integration_connected',
        'integration_schedule_changed',
      ]);
      // The write still happened, which is what pressing Daily on a daily
      // connection has always done: `next_sync_at` is re-based from now.
      const { rows } = await ctx.pool.query<{ next_sync_at: Date | null }>(
        'SELECT next_sync_at FROM hris_connections WHERE valuation_id = $1',
        [v.id],
      );
      expect(rows[0]!.next_sync_at).not.toBeNull();
    });
  });

  describe('a cadence changed while the sync was running (R256)', () => {
    /**
     * `recordSync` used to be handed `connection.sync_frequency` — the value
     * read off the row before the provider was called. The window between that
     * read and the write is the whole sync: a provider round trip plus one
     * INSERT and one audit event per grant, on a roster that can be hundreds.
     * Changing the cadence during it is ordinary, for the same reason pressing
     * Disconnect during it is: the sync is doing something somebody wants
     * changed.
     *
     * The success then wrote back the schedule from before the change, and
     * nothing on the card could say so — the select shows the cadence that was
     * saved, and the next-sync time that disagrees with it is not drawn at all.
     */
    const rowFor = async (valuationId: string) => {
      const { rows } = await ctx.pool.query<{
        sync_frequency: string;
        next_sync_at: Date | null;
      }>('SELECT sync_frequency, next_sync_at FROM hris_connections WHERE valuation_id = $1', [valuationId]);
      return rows[0]!;
    };

    /** A roster fetch that applies `change` to the connection while it is in flight. */
    const fetchThatChangesCadence = (valuationId: string, frequency: string) =>
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('/token'))
          return jsonResponse({ access_token: 'tok', expires_in: 3600, company_id: 'co1' });
        if (u.includes('/employees')) {
          const res = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/valuations/${valuationId}/hris/rippling/frequency`,
            headers: authHeader(ops.token),
            payload: { frequency },
          });
          expect(res.statusCode).toBe(200);
          return jsonResponse(ROSTER);
        }
        throw new Error(`unexpected fetch ${u}`);
      });

    const makeWeeklyAndDue = (valuationId: string) =>
      ctx.pool.query(
        `UPDATE hris_connections
            SET sync_frequency = 'weekly', next_sync_at = now() - interval '1 hour'
          WHERE valuation_id = $1`,
        [valuationId],
      );

    it('schedules from the cadence on the row rather than the one the pull started under', async () => {
      const v = await connectedValuation();
      await makeWeeklyAndDue(v.id);

      await runDueHrisSyncs({
        pool: ctx.pool,
        fetchFn: fetchThatChangesCadence(v.id, 'daily') as unknown as typeof fetch,
        log: silentLog,
      });

      const row = await rowFor(v.id);
      expect(row.sync_frequency).toBe('daily');
      // A day, not the week the pull began under. The old spelling left the
      // card reading Daily over a connection that would not run for seven.
      const hours = (row.next_sync_at!.getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(20);
      expect(hours).toBeLessThan(28);
    });

    it('leaves a cadence switched to Manual mid-sync with no next sync at all', async () => {
      const v = await connectedValuation();
      await makeWeeklyAndDue(v.id);

      await runDueHrisSyncs({
        pool: ctx.pool,
        fetchFn: fetchThatChangesCadence(v.id, 'manual') as unknown as typeof fetch,
        log: silentLog,
      });

      const row = await rowFor(v.id);
      expect(row.sync_frequency).toBe('manual');
      // `findDueConnections` skips a manual connection whatever its time says,
      // so the old row was not re-synced — it just carried a next-sync date for
      // a schedule that had been turned off.
      expect(row.next_sync_at).toBeNull();
    });
  });

  it('forbids HRIS import for non-ops users', async () => {
    const client = await seedUser(ctx, { roles: ['valuation_user'] });
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Acme', userId: client.id },
      { actorType: 'human', actorId: client.id, source: 'test' },
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/hris/rippling/connect`,
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('runs due HRIS syncs with bounded concurrency and isolates a failing one (P2-7)', async () => {
    const N = 6;
    const vals = [];
    for (let i = 0; i < N; i++) {
      vals.push(await connectedValuation());
    }
    await ctx.pool.query(`UPDATE hris_connections SET next_sync_at = now() + interval '30 days'`);
    await ctx.pool.query(
      `UPDATE hris_connections
         SET sync_frequency = 'weekly', next_sync_at = now() - interval '1 hour'
       WHERE valuation_id = ANY($1)`,
      [vals.map((v) => v.id)],
    );

    let inFlight = 0;
    let peak = 0;
    let rosterCalls = 0;
    const trackingFetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/token'))
        return jsonResponse({ access_token: 'tok', expires_in: 3600, company_id: 'co1' });
      if (u.includes('/employees')) {
        rosterCalls += 1;
        const myCall = rosterCalls;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        if (myCall === 2) return jsonResponse({ error: 'boom' }, 500);
        return jsonResponse(ROSTER);
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const warnings: unknown[] = [];
    const processed = await runDueHrisSyncs({
      pool: ctx.pool,
      fetchFn: trackingFetch as unknown as typeof fetch,
      log: { warn: (o) => warnings.push(o), error: (o) => warnings.push(o), info: () => {} },
    });

    expect(rosterCalls).toBe(N);
    expect(processed).toBe(N - 1);
    expect(warnings).toHaveLength(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});
