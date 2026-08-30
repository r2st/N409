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
     */
    const v = await connectedValuation();
    const restore = interceptPoolQueries(ctx.pool, (sql) => {
      if (!/INSERT INTO option_grants/i.test(sql)) return undefined;
      const err = Object.assign(
        new Error('duplicate key value violates unique constraint "option_grants_external_idx"'),
        { code: '23505', constraint: 'option_grants_external_idx', table: 'option_grants' },
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
      log: { warn: (o) => warnings.push(o) },
    });

    expect(rosterCalls).toBe(N);
    expect(processed).toBe(N - 1);
    expect(warnings).toHaveLength(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});
