import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { findCapTable } from '../../src/repos/capTables.js';
import { MAX_CAP_TABLE_ENTRIES } from '../../src/domain/capTable.js';
import { signCapTableSyncState } from '../../src/auth/jwt.js';
import { runDueCapTableSyncs, syncCapTableConnection } from '../../src/routes/capTableSync.js';
import { findConnection } from '../../src/repos/capTableConnections.js';
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

const CARTA_V1 = {
  companyName: 'Acme Inc',
  shareClasses: [
    { name: 'Common', type: 'common', outstandingShares: 8_000_000 },
    {
      name: 'Series A',
      type: 'preferred',
      outstandingShares: 2_000_000,
      amountInvested: 3_000_000,
      liquidationPreference: 1,
    },
  ],
  optionPools: [{ name: 'Option Pool', outstandingShares: 1_000_000, strikePrice: 0.5 }],
};
// A later pull where Series A grew.
const CARTA_V2 = {
  ...CARTA_V1,
  shareClasses: [
    { name: 'Common', type: 'common', outstandingShares: 8_000_000 },
    {
      name: 'Series A',
      type: 'preferred',
      outstandingShares: 2_500_000,
      amountInvested: 3_500_000,
      liquidationPreference: 1,
    },
  ],
};

/** Fetch mock: token endpoint + Carta capitalization endpoint. */
function mockFetch(capPayload: () => unknown) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/oauth/token')) {
      return jsonResponse({
        access_token: 'tok',
        refresh_token: 'ref',
        expires_in: 3600,
        company_id: 'co_1',
      });
    }
    if (u.includes('/capitalization')) return jsonResponse(capPayload());
    throw new Error(`unexpected fetch ${u}`);
  });
}

const CARTA_ENV = { CARTA_CLIENT_ID: 'cid', CARTA_CLIENT_SECRET: 'csecret' };

describe.skipIf(!dbUp)('cap-table sync (feature 4)', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let payload = CARTA_V1 as unknown;

  beforeAll(async () => {
    ctx = await setupTestApp(CARTA_ENV, {
      capTableSyncFetch: mockFetch(() => payload) as unknown as typeof fetch,
    });
    ops = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  async function seedValuation() {
    return createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Acme Inc', userId: ops.id },
      { actorType: 'human', actorId: ops.id, source: 'test' },
    );
  }

  /** Drive the OAuth callback with a validly signed state to connect. */
  async function connect(valuationId: string) {
    const state = await signCapTableSyncState(
      { valuationId, provider: 'carta', userId: ops.id },
      { secret: 'integration-test-secret-0123456789abcdef', issuer: 'n409', ttlSeconds: 3600 },
    );
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/cap-table-sync/callback?state=${encodeURIComponent(state)}&code=abc&company_id=co_1`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('sync=connected');
  }

  it('lists providers with Carta configured', async () => {
    const v = await seedValuation();
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${v.id}/cap-table/sync`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const carta = res.json().providers.find((p: { provider: string }) => p.provider === 'carta');
    expect(carta.configured).toBe(true);
  });

  it('connects, pulls and applies the cap table on first sync', async () => {
    payload = CARTA_V1;
    const v = await seedValuation();
    await connect(v.id);

    const pull = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/cap-table/sync/carta/pull`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(pull.statusCode).toBe(200);
    const body = pull.json();
    expect(body.applied).toBe(true); // nothing on file → applied
    expect(body.class_count).toBe(3);

    const saved = await findCapTable(ctx.pool, v.id);
    expect(saved?.source_format).toBe('carta');
    expect(saved?.entries.length).toBe(3);
  });

  /**
   * R229, methodology M2 — the row cap the other three writers of
   * `cap_tables.entries` enforce.
   *
   * The import endpoints refuse a table over `MAX_CAP_TABLE_ENTRIES`, on the
   * reasoning that silently storing the first 2,000 rows of somebody's cap
   * table is worse than refusing it. The sync stored whatever the provider
   * sent: its body cap is 16 MB of JSON, and Pulley's payload is a flat
   * `securities` list rather than a list of classes, so tens of thousands of
   * entries is a large company's ordinary shape. All of them land in one JSONB
   * document that every reader of the valuation loads whole.
   */
  it('refuses a provider pull larger than one cap table may hold', async () => {
    const v = await seedValuation();
    await connect(v.id);
    payload = {
      companyName: 'Acme Inc',
      shareClasses: Array.from({ length: MAX_CAP_TABLE_ENTRIES + 1 }, (_, i) => ({
        name: `Holding ${i}`,
        type: 'common',
        outstandingShares: 100,
      })),
    };

    const pull = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/cap-table/sync/carta/pull`,
      headers: authHeader(ops.token),
      payload: { apply: true },
    });
    payload = CARTA_V1;

    expect(pull.statusCode).toBeGreaterThanOrEqual(400);
    expect(pull.json().detail).toContain(String(MAX_CAP_TABLE_ENTRIES));
    // Refused, not truncated: nothing is on file for this valuation.
    expect(await findCapTable(ctx.pool, v.id)).toBeNull();
    // Recorded on the connection, so the scheduler stops re-pulling it.
    const { rows } = await ctx.pool.query<{ last_error: string | null; status: string }>(
      'SELECT last_error, status FROM cap_table_connections WHERE valuation_id = $1',
      [v.id],
    );
    expect(rows[0]?.last_error).toContain('at most');
  });

  it('previews conflicts without applying, then applies when asked', async () => {
    payload = CARTA_V1;
    const v = await seedValuation();
    await connect(v.id);
    // First pull applies V1.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/cap-table/sync/carta/pull`,
      headers: authHeader(ops.token),
      payload: { apply: true },
    });

    // Provider data changes; a plain pull previews the conflict, no overwrite.
    payload = CARTA_V2;
    const preview = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/cap-table/sync/carta/pull`,
      headers: authHeader(ops.token),
      payload: { apply: false },
    });
    expect(preview.statusCode).toBe(200);
    const pbody = preview.json();
    expect(pbody.applied).toBe(false);
    expect(pbody.diff.has_conflicts).toBe(true);
    expect(pbody.diff.changed).toBe(1);
    // On-file table is unchanged (still Series A = 2,000,000).
    const stillOld = await findCapTable(ctx.pool, v.id);
    const seriesA = stillOld?.entries.find((e) => e.security_class === 'Series A');
    expect(seriesA?.shares).toBe(2_000_000);

    // Applying overwrites.
    const applied = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/cap-table/sync/carta/pull`,
      headers: authHeader(ops.token),
      payload: { apply: true },
    });
    expect(applied.json().applied).toBe(true);
    const updated = await findCapTable(ctx.pool, v.id);
    expect(updated?.entries.find((e) => e.security_class === 'Series A')?.shares).toBe(2_500_000);
  });

  it('answers 422, not 500, when the pull body is the wrong shape', async () => {
    // `apply` is the only field, and a client that sends a string for it has
    // written a bad request — not tripped a server fault. The route parsed this
    // body with a throwing `.parse()`, so the ZodError reached the error handler
    // as an ordinary exception and rendered `urn:n409:problem:internal` with a
    // 500: the one status a client is told to retry, for a request that can
    // never succeed.
    payload = CARTA_V1;
    const v = await seedValuation();
    await connect(v.id);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/cap-table/sync/carta/pull`,
      headers: authHeader(ops.token),
      payload: { apply: 'yes' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().type).toBe('urn:n409:problem:validation');
    expect(res.json().errors[0].path).toEqual(['apply']);
  });

  it('defaults apply to false when the body is absent entirely', async () => {
    payload = CARTA_V1;
    const v = await seedValuation();
    await connect(v.id);
    // Nothing on file yet, so the sync applies regardless of `apply` — what is
    // being pinned is that a missing body parses at all rather than 400ing.
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/cap-table/sync/carta/pull`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
  });

  it('runs a due scheduled sync and applies automatically', async () => {
    payload = CARTA_V1;
    const v = await seedValuation();
    await connect(v.id);
    // Set weekly cadence, then force it due.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/cap-table/sync/carta/frequency`,
      headers: authHeader(ops.token),
      payload: { frequency: 'weekly' },
    });
    await ctx.pool.query(
      `UPDATE cap_table_connections SET next_sync_at = now() - interval '1 hour' WHERE valuation_id = $1`,
      [v.id],
    );
    const scan = await runDueCapTableSyncs({
      pool: ctx.pool,
      fetchFn: mockFetch(() => CARTA_V1) as unknown as typeof fetch,
    });
    expect(scan.synced).toBeGreaterThanOrEqual(1);
    const saved = await findCapTable(ctx.pool, v.id);
    expect(saved?.entries.length).toBe(3);
  });

  /**
   * R261 (M5), the cap-table half of the same hole in `setSyncFrequency`. A
   * terminal failure clears `next_sync_at` because no retry can clear it; the
   * cadence dropdown wrote the column back unconditionally, restarting a
   * schedule against an authorisation the provider had ended.
   */
  it('does not restart the schedule when a cadence is set on a connection needing a reconnect', async () => {
    payload = CARTA_V1;
    const v = await seedValuation();
    await connect(v.id);
    await ctx.pool.query(
      `UPDATE cap_table_connections
          SET status = 'error', sync_failures = 3, next_sync_at = NULL,
              reconnect_required = true, sync_frequency = 'manual'
        WHERE valuation_id = $1`,
      [v.id],
    );

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/cap-table/sync/carta/frequency`,
      headers: authHeader(ops.token),
      payload: { frequency: 'daily' },
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await ctx.pool.query<{ sync_frequency: string; next_sync_at: Date | null }>(
      'SELECT sync_frequency, next_sync_at FROM cap_table_connections WHERE valuation_id = $1',
      [v.id],
    );
    expect(rows[0]!.sync_frequency).toBe('daily');
    expect(rows[0]!.next_sync_at).toBeNull();
  });

  /**
   * `recordSync` is the only thing that moves `next_sync_at` (R261, M5). A
   * throw from it leaves the state the catch above it was written to remove —
   * `connected`, a due date already in the past — except reached from a
   * *success*, so nothing was watching: the sweep then re-pulls the provider's
   * whole cap table every fifteen minutes behind a card reading healthy.
   */
  it('records the failure when a successful sync cannot be written down', async () => {
    payload = CARTA_V1;
    const v = await seedValuation();
    await connect(v.id);
    await ctx.pool.query(
      `UPDATE cap_table_connections
          SET sync_frequency = 'weekly', next_sync_at = now() - interval '1 hour'
        WHERE valuation_id = $1`,
      [v.id],
    );

    // `recordSync` writes `last_sync_summary` as jsonb, which the driver
    // refuses outright for a value carrying a NUL or a lone surrogate.
    const restore = interceptPoolQueries(ctx.pool, (sql, phase) => {
      if (phase === 'before' && sql.includes('last_sync_summary')) {
        throw new Error('injected: statement refused');
      }
    });
    try {
      await runDueCapTableSyncs({
        pool: ctx.pool,
        fetchFn: mockFetch(() => CARTA_V1) as unknown as typeof fetch,
      });
    } finally {
      restore();
    }

    // The pull was applied — it is the connection's record of it that was not.
    expect((await findCapTable(ctx.pool, v.id))?.entries.length).toBe(3);
    const { rows } = await ctx.pool.query<{
      status: string;
      next_sync_at: Date | null;
      last_error: string | null;
    }>('SELECT status, next_sync_at, last_error FROM cap_table_connections WHERE valuation_id = $1', [v.id]);
    expect(rows[0]!.status).toBe('error');
    expect(rows[0]!.next_sync_at!.getTime()).toBeGreaterThan(Date.now());
    expect(rows[0]!.last_error).toContain('could not be recorded against this connection');
    expect(rows[0]!.last_error).not.toContain('injected');
  });

  it('renews an expired access token before a scheduled sync (R252)', async () => {
    // Both providers ask for `offline_access` at the authorize URL, and until
    // R252 the refresh token that scope exists to obtain was written to the row
    // and never read. A scheduled sync therefore worked until the first access
    // token expired and then failed `401` — which moved the connection to
    // `error`, took it out of `findDueConnections`, and stopped the schedule
    // permanently while the cap table on file quietly stopped tracking Carta's.
    payload = CARTA_V1;
    const v = await seedValuation();
    await connect(v.id);
    await ctx.pool.query(`UPDATE cap_table_connections SET next_sync_at = now() + interval '30 days'`);
    await ctx.pool.query(
      `UPDATE cap_table_connections
         SET sync_frequency = 'weekly', next_sync_at = now() - interval '1 hour',
             token_expires_at = now() - interval '1 hour'
       WHERE valuation_id = $1`,
      [v.id],
    );

    const grants: string[] = [];
    const capTokens: string[] = [];
    const refreshingFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/oauth/token')) {
        const params = new URLSearchParams(String(init?.body ?? ''));
        grants.push(params.get('grant_type') ?? '');
        return jsonResponse({ access_token: 'renewed', expires_in: 3600 });
      }
      if (u.includes('/capitalization')) {
        const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
        capTokens.push(auth.replace(/^Bearer /, ''));
        return jsonResponse(CARTA_V1);
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const scan = await runDueCapTableSyncs({
      pool: ctx.pool,
      fetchFn: refreshingFetch as unknown as typeof fetch,
      credentials: { carta: { clientId: 'cid', clientSecret: 'csecret' } },
    });

    expect(scan.synced).toBe(1);
    expect(grants).toEqual(['refresh_token']);
    expect(capTokens).toEqual(['renewed']);
    const { rows } = await ctx.pool.query<{ status: string; token_expires_at: Date }>(
      'SELECT status, token_expires_at FROM cap_table_connections WHERE valuation_id = $1',
      [v.id],
    );
    expect(rows[0]!.status).toBe('connected');
    expect(rows[0]!.token_expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('stops and asks for a reconnect when Carta refuses the refresh (R252)', async () => {
    // `invalid_grant` will be answered identically on every fifteen-minute tick
    // until somebody reconnects, so the sweep records a sentence saying that
    // rather than a status code that reads like a transient fault.
    payload = CARTA_V1;
    const v = await seedValuation();
    await connect(v.id);
    await ctx.pool.query(`UPDATE cap_table_connections SET next_sync_at = now() + interval '30 days'`);
    await ctx.pool.query(
      `UPDATE cap_table_connections
         SET sync_frequency = 'weekly', next_sync_at = now() - interval '1 hour',
             token_expires_at = now() - interval '1 hour'
       WHERE valuation_id = $1`,
      [v.id],
    );

    let capCalled = false;
    const refusingFetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/oauth/token')) return jsonResponse({ error: 'invalid_grant' }, 400);
      capCalled = true;
      return jsonResponse(CARTA_V1);
    });

    const scan = await runDueCapTableSyncs({
      pool: ctx.pool,
      fetchFn: refusingFetch as unknown as typeof fetch,
      credentials: { carta: { clientId: 'cid', clientSecret: 'csecret' } },
      log: silentLog,
    });

    expect(scan.synced).toBe(0);
    // The half a bare success count cannot say. `synced: 0` is also what a scan
    // with nothing due returns, so until the tally named all three a schedule
    // in which every provider had refused our authorisation read through the
    // sweep's `info` line and every instrument built on this tick exactly like
    // an idle one — the blind spot R321 closed for the ladders and left open
    // here.
    expect(scan.due).toBe(1);
    expect(scan.failed).toBe(1);
    expect(capCalled).toBe(false);
    const { rows } = await ctx.pool.query<{ status: string; last_error: string }>(
      'SELECT status, last_error FROM cap_table_connections WHERE valuation_id = $1',
      [v.id],
    );
    expect(rows[0]!.status).toBe('error');
    expect(rows[0]!.last_error).toMatch(/reconnect Carta/i);
  });

  it('runs due syncs with bounded concurrency and isolates a failing one (P2-7)', async () => {
    payload = CARTA_V1;
    const N = 6;
    const vals = [];
    for (let i = 0; i < N; i++) {
      const v = await seedValuation();
      await connect(v.id);
      vals.push(v);
    }
    // Make exactly these N connections due (push everything else into the future
    // first so leftovers from earlier tests can't inflate the batch).
    await ctx.pool.query(`UPDATE cap_table_connections SET next_sync_at = now() + interval '30 days'`);
    await ctx.pool.query(
      `UPDATE cap_table_connections
         SET sync_frequency = 'weekly', next_sync_at = now() - interval '1 hour'
       WHERE valuation_id = ANY($1)`,
      [vals.map((v) => v.id)],
    );

    let inFlight = 0;
    let peak = 0;
    let capCalls = 0;
    const trackingFetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/oauth/token')) {
        return jsonResponse({
          access_token: 'tok',
          refresh_token: 'ref',
          expires_in: 3600,
          company_id: 'co_1',
        });
      }
      if (u.includes('/capitalization')) {
        capCalls += 1;
        const myCall = capCalls;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Hold the slot briefly so overlapping calls are observable.
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        // Fail exactly one connection to prove failures don't abort the batch.
        if (myCall === 2) return jsonResponse({ error: 'boom' }, 500);
        return jsonResponse(CARTA_V1);
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const warnings: unknown[] = [];
    const scan = await runDueCapTableSyncs({
      pool: ctx.pool,
      fetchFn: trackingFetch as unknown as typeof fetch,
      log: { warn: (o) => warnings.push(o), error: (o) => warnings.push(o), info: () => {} },
    });

    // All N were attempted; the one 500 is isolated → N-1 succeed.
    expect(capCalls).toBe(N);
    expect(scan.synced).toBe(N - 1);
    // And the isolated one is counted rather than only logged: `failed` is the
    // label `SweepWorkFailing` reads, and it is the difference between this
    // scan and one where nothing was due.
    expect(scan).toEqual({ due: N, synced: N - 1, failed: 1 });
    expect(warnings).toHaveLength(1);
    // Bounded to 4 in flight, yet genuinely concurrent (>1 at once).
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});

/**
 * The window between "there is nothing on file" and the write that relies on it
 * (round 268, methodology M5).
 *
 * A pull asked *not* to apply applies anyway when the valuation has no cap
 * table — "nothing to disturb" — and that read is a separate statement from the
 * write, with a diff, a validation pass and an `await` in between.
 * `saveCapTable` upserts, so an import that commits inside that window was
 * replaced by the provider's table, by a pull that was told not to write, under
 * a `system` actor and with nothing refused anywhere.
 *
 * Reproduced by committing the import from inside the window itself — hooked on
 * the `SELECT` that reads the absence — rather than by racing two timers.
 */
describe.skipIf(!dbUp)('cap-table preview against a table that arrives mid-pull', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp(CARTA_ENV, {
      capTableSyncFetch: mockFetch(() => CARTA_V1) as unknown as typeof fetch,
    });
    ops = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  const SHEET = [
    'class,shares,price,invested',
    'Common Stock,4000000,0.10,',
    '"Series Seed",1000000,1.00,1000000',
  ].join('\n');

  /** A connected Carta connection on a fresh valuation. */
  async function connected(company: string) {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: company, userId: ops.id },
      { actorType: 'human', actorId: ops.id, source: 'test' },
    );
    const state = await signCapTableSyncState(
      { valuationId: v.id, provider: 'carta', userId: ops.id },
      { secret: 'integration-test-secret-0123456789abcdef', issuer: 'n409', ttlSeconds: 3600 },
    );
    const cb = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/cap-table-sync/callback?state=${encodeURIComponent(state)}&code=abc&company_id=co_1`,
    });
    expect(cb.statusCode).toBe(302);
    return { valuationId: v.id, connection: (await findConnection(ctx.pool, v.id, 'carta'))! };
  }

  it('refuses to replace it, and leaves the connection healthy', async () => {
    const { valuationId, connection } = await connected('Race Import Co');

    // The colleague's spreadsheet commits in the window itself: on the way back
    // from the very SELECT that told the pull there was nothing on file.
    let raced = false;
    const restore = interceptPoolQueries(ctx.pool, async (sql, phase) => {
      if (raced || phase !== 'after') return;
      if (!sql.includes('SELECT * FROM cap_tables WHERE valuation_id')) return;
      raced = true;
      const put = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/cap-table`,
        headers: authHeader(ops.token),
        payload: { format: 'generic', csv: SHEET },
      });
      expect(put.statusCode).toBe(200);
    });

    try {
      await expect(
        syncCapTableConnection(
          {
            pool: ctx.pool,
            fetchFn: mockFetch(() => CARTA_V1) as unknown as typeof fetch,
            log: silentLog,
          },
          connection,
          { apply: false, actorId: ops.id },
        ),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      restore();
    }
    expect(raced).toBe(true);

    // The spreadsheet stands, at the version its own import wrote.
    const saved = await findCapTable(ctx.pool, valuationId);
    expect(saved?.source_format).toBe('generic');
    expect(saved?.entries.length).toBe(2);
    expect(saved?.version).toBe(1);

    // And the connection is untouched: nothing about it failed, so nothing may
    // spend a rung of its backoff ladder or put a message on its card.
    const { rows } = await ctx.pool.query<{
      status: string;
      last_error: string | null;
      sync_failures: number;
    }>('SELECT status, last_error, sync_failures FROM cap_table_connections WHERE id = $1', [connection.id]);
    expect(rows[0]).toMatchObject({ status: 'connected', last_error: null, sync_failures: 0 });
  });

  it('still applies a first pull when nothing lands in the window', async () => {
    const { valuationId, connection } = await connected('Quiet Import Co');
    const outcome = await syncCapTableConnection(
      { pool: ctx.pool, fetchFn: mockFetch(() => CARTA_V1) as unknown as typeof fetch, log: silentLog },
      connection,
      { apply: false, actorId: ops.id },
    );
    expect(outcome.applied).toBe(true);
    expect((await findCapTable(ctx.pool, valuationId))?.source_format).toBe('carta');
  });

  /**
   * The sweep is not guarded, and must not be: it always applies, so a person
   * touching the table between two ticks is not a reason to refuse the pull.
   */
  it('lets a pull that was asked to apply replace a table that arrived mid-pull', async () => {
    const { valuationId, connection } = await connected('Applied Import Co');
    let raced = false;
    const restore = interceptPoolQueries(ctx.pool, async (sql, phase) => {
      if (raced || phase !== 'after') return;
      if (!sql.includes('SELECT * FROM cap_tables WHERE valuation_id')) return;
      raced = true;
      await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/cap-table`,
        headers: authHeader(ops.token),
        payload: { format: 'generic', csv: SHEET },
      });
    });
    try {
      const outcome = await syncCapTableConnection(
        { pool: ctx.pool, fetchFn: mockFetch(() => CARTA_V1) as unknown as typeof fetch, log: silentLog },
        connection,
        { apply: true, actorId: ops.id },
      );
      expect(outcome.applied).toBe(true);
    } finally {
      restore();
    }
    expect(raced).toBe(true);
    expect((await findCapTable(ctx.pool, valuationId))?.source_format).toBe('carta');
  });
});
