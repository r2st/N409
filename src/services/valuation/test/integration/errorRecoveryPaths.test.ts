import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createValuation } from '../../src/repos/valuations.js';
import { listGrants } from '../../src/repos/grants.js';
import { findCapTable } from '../../src/repos/capTables.js';
import { signCapTableSyncState, signHrisState } from '../../src/auth/jwt.js';
import { runDueCapTableSyncs } from '../../src/routes/capTableSync.js';
import { runDueHrisSyncs } from '../../src/routes/hris.js';
import { oldestActiveJobs } from '../../src/repos/jobs.js';
import { AI_JOB_STALE_MS, createAiJob, reapStaleAiJobs } from '../../src/repos/aiJobs.js';
import {
  authHeader,
  interceptPoolQueries,
  isDbAvailable,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * What is left behind when an operation dies halfway (round 186, methodology
 * M5, adapted from integration points to *internal* failure modes).
 *
 * R165's suite next door asks what happens when a dependency answers badly.
 * This one asks the question one layer in: the dependency answered perfectly,
 * and then *we* failed — a constraint refused a row, a lock was taken by
 * somebody else, a pool ran dry, a process stopped existing. Every operation
 * exercised here has the same three-part shape, and the failures all landed in
 * part two:
 *
 *   1. fetch or compute something,
 *   2. write it,
 *   3. record that step 2 happened.
 *
 * Step 3 is where the status a person reads comes from, and it was reachable
 * only along the success path. So a step-2 failure left the operation's own
 * bookkeeping untouched — which does not read as "unknown", it reads as
 * *whatever the last success said*: a connection whose page says it is healthy
 * and last synced on Tuesday, over an engagement holding half an import.
 *
 * Three of the four also had a second, worse consequence. `recordSync` is the
 * only thing that advances `next_sync_at`, so a sync that threw past it left
 * the connection permanently due: the scheduler re-picked it every fifteen
 * minutes, re-spent the provider quota, and failed the same way, forever, with
 * nothing on any screen. Each section below asserts the loop is closed as well
 * as the status corrected — the "does the scheduler come back for it" test is
 * the one that fails against the code this round replaced.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const SECRET = 'integration-test-secret-0123456789abcdef';
const jwtOpts = { secret: SECRET, issuer: 'n409', ttlSeconds: 3600 };

// ── Provider doubles ────────────────────────────────────────────────────────

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
          optionsGranted: 10_000,
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
      equityGrants: [{ id: 'g2', optionsGranted: 5_000, strikePrice: 1.25, grantDate: '2025-06-01' }],
    },
  ],
};

const CARTA = {
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

const xeroRow = (label: string, value: string) => ({ Cells: [{ Value: label }, { Value: value }] });

const XERO_PL = {
  Reports: [
    {
      Fields: [
        { Id: 'Currency', Value: 'USD' },
        { Id: 'FromDate', Value: '2025-07-01' },
        { Id: 'ToDate', Value: '2026-06-30' },
      ],
      Rows: [
        {
          Rows: [
            { Cells: [{ Value: 'Total Income' }, { Value: '500000' }, { Value: '400000' }] },
            { Cells: [{ Value: 'Net Profit' }, { Value: '75000' }] },
          ],
        },
      ],
    },
  ],
};

const XERO_BALANCE_SHEET = {
  Reports: [
    {
      Fields: [
        { Id: 'ToDate', Value: '2026-06-30' },
        { Id: 'Currency', Value: 'USD' },
      ],
      Rows: [
        { Rows: [xeroRow('Total Assets', '900000.00')] },
        { Rows: [xeroRow('Total Liabilities', '250000.00')] },
      ],
    },
  ],
};

const hrisFetch = vi.fn(async (url: string | URL | Request) => {
  const u = String(url);
  if (u.includes('/token')) return json({ access_token: 'tok', expires_in: 3600, company_id: 'co1' });
  if (u.includes('/employees')) return json(ROSTER);
  throw new Error(`unexpected HRIS fetch ${u}`);
});

const capTableFetch = vi.fn(async (url: string | URL | Request) => {
  const u = String(url);
  if (u.includes('/oauth/token'))
    return json({ access_token: 'tok', refresh_token: 'ref', expires_in: 3600, company_id: 'co_1' });
  if (u.includes('/capitalization')) return json(CARTA);
  throw new Error(`unexpected Carta fetch ${u}`);
});

const accountingFetch = vi.fn(async (input: string | URL | Request) => {
  const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (u.includes('identity.xero.com/connect/token'))
    return json({ access_token: 'xero-access', refresh_token: 'xero-refresh', expires_in: 1800 });
  if (u.includes('/connections')) return json([{ tenantId: 'tenant-1', tenantName: 'Acme' }]);
  if (u.includes('BalanceSheet')) return json(XERO_BALANCE_SHEET);
  if (u.includes('ProfitAndLoss')) return json(XERO_PL);
  return json({});
});

describe.skipIf(!dbUp)('what an operation leaves behind when it dies halfway', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let restore: (() => void) | null = null;

  beforeAll(async () => {
    ctx = await setupTestApp(
      {
        RIPPLING_CLIENT_ID: 'cid',
        RIPPLING_CLIENT_SECRET: 'sec',
        CARTA_CLIENT_ID: 'carta-id',
        CARTA_CLIENT_SECRET: 'carta-secret',
        XERO_CLIENT_ID: 'xero-client',
        XERO_CLIENT_SECRET: 'xero-secret',
      },
      {
        hrisFetch: hrisFetch as unknown as typeof fetch,
        capTableSyncFetch: capTableFetch as unknown as typeof fetch,
        accountingFetch: accountingFetch as unknown as typeof fetch,
      },
    );
    ops = await seedUser(ctx, { roles: ['reviewer'] });
  });

  afterEach(() => {
    restore?.();
    restore = null;
  });

  afterAll(async () => ctx?.teardown());

  /**
   * Make the *n*th query whose text contains `needle` reject, and nothing else.
   *
   * Counted rather than matched once, because the failures worth staging are
   * mid-loop: "the second grant INSERT" is the case that produces a partial
   * import, and failing the first would only produce an import that did not
   * start.
   */
  const failNth = (needle: string, nth: number, message: string) => {
    let seen = 0;
    restore = interceptPoolQueries(ctx.pool, (sql, phase) => {
      if (phase !== 'before' || !sql.includes(needle)) return undefined;
      seen += 1;
      if (seen === nth) throw new Error(message);
      return undefined;
    });
  };

  const seedValuation = (company: string) =>
    createValuation(
      ctx.pool,
      { kind: '409a', companyName: company, userId: ops.id },
      { actorType: 'human', actorId: ops.id, source: 'test' },
    );

  // ── 1. HRIS: an import that stops between two grants ──────────────────────

  describe('an HRIS roster import that stops between two grants', () => {
    let valuationId: string;
    let connectionId: string;

    const connectionRow = async () => {
      const { rows } = await ctx.pool.query<{
        id: string;
        status: string;
        last_error: string | null;
        last_synced_at: Date | null;
        next_sync_at: Date | null;
      }>('SELECT id, status, last_error, last_synced_at, next_sync_at FROM hris_connections WHERE id = $1', [
        connectionId,
      ]);
      return rows[0]!;
    };

    const pull = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/hris/rippling/pull`,
        headers: authHeader(ops.token),
      });

    beforeAll(async () => {
      const v = await seedValuation('Halfway HRIS Co');
      valuationId = v.id;
      const state = await signHrisState({ valuationId: v.id, provider: 'rippling', userId: ops.id }, jwtOpts);
      const cb = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/hris/callback?state=${encodeURIComponent(state)}&code=abc&company_id=co1`,
      });
      expect(cb.statusCode).toBe(302);
      const { rows } = await ctx.pool.query<{ id: string }>(
        'SELECT id FROM hris_connections WHERE valuation_id = $1',
        [v.id],
      );
      connectionId = rows[0]!.id;
      // Scheduled, and overdue: this is the connection shape the sweep picks
      // up, and the state the loop below is asked not to leave it in.
      await ctx.pool.query(
        `UPDATE hris_connections SET sync_frequency = 'daily', next_sync_at = now() - interval '1 hour'
          WHERE id = $1`,
        [connectionId],
      );
    });

    it('writes the grants it got to before the fault', async () => {
      failNth('INSERT INTO option_grants', 2, 'duplicate key value violates unique constraint "x"');
      const res = await pull();
      expect(res.statusCode).toBe(422);

      const { grants } = await listGrants(ctx.pool, valuationId);
      expect(grants).toHaveLength(1);
      expect(grants[0]!.grantee_email).toBe('ada@acme.com');
    });

    it('says on the connection that it failed, and how far it got', async () => {
      // The route answers "the details are in the connection's last error".
      // Nothing put anything there for this failure until R186 — the loop threw
      // straight past both `recordSyncError` and `recordSync` — so the sentence
      // pointed the analyst at an empty field.
      const row = await connectionRow();
      expect(row.status).toBe('error');
      expect(row.last_error).toContain('imported 1 of 2 grants');
      // …and nothing Postgres said. `last_error` reaches the caller verbatim.
      expect(row.last_error).not.toContain('constraint');
      expect(row.last_synced_at).toBeNull();
    });

    it('the scheduler does not come back for it every fifteen minutes', async () => {
      // The load-bearing assertion of this section. `recordSync` is the only
      // thing that moves `next_sync_at`, so a loop that threw past it left the
      // connection `status = 'connected'` with a due date in the past: every
      // tick re-pulled the provider's whole roster and failed the same way,
      // billed the quota, and reported nothing anywhere. Recording the failure
      // takes the row out of `findDueConnections` — which is what this asks.
      const processed = await runDueHrisSyncs({
        pool: ctx.pool,
        fetchFn: hrisFetch as unknown as typeof fetch,
      });
      expect(processed).toBe(0);
    });

    it('completes on a retry once the fault clears, skipping what it already has', async () => {
      const res = await pull();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ grants_created: 1, grants_skipped: 1 });

      const { grants } = await listGrants(ctx.pool, valuationId);
      expect(grants).toHaveLength(2);
      const row = await connectionRow();
      expect(row.status).toBe('connected');
      expect(row.last_error).toBeNull();
      expect(row.last_synced_at).not.toBeNull();
    });
  });

  // ── 2. Cap table: a pull that cannot be saved ─────────────────────────────

  describe('a cap-table sync whose save fails after the provider answered', () => {
    let valuationId: string;
    let connectionId: string;

    const connectionRow = async () => {
      const { rows } = await ctx.pool.query<{
        status: string;
        last_error: string | null;
        last_synced_at: Date | null;
      }>('SELECT status, last_error, last_synced_at FROM cap_table_connections WHERE id = $1', [
        connectionId,
      ]);
      return rows[0]!;
    };

    beforeAll(async () => {
      const v = await seedValuation('Halfway Carta Co');
      valuationId = v.id;
      const state = await signCapTableSyncState(
        { valuationId: v.id, provider: 'carta', userId: ops.id },
        jwtOpts,
      );
      const cb = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/cap-table-sync/callback?state=${encodeURIComponent(state)}&code=abc&company_id=co_1`,
      });
      expect(cb.statusCode).toBe(302);
      const { rows } = await ctx.pool.query<{ id: string }>(
        'SELECT id FROM cap_table_connections WHERE valuation_id = $1',
        [v.id],
      );
      connectionId = rows[0]!.id;
      await ctx.pool.query(
        `UPDATE cap_table_connections SET sync_frequency = 'daily', next_sync_at = now() - interval '1 hour'
          WHERE id = $1`,
        [connectionId],
      );
    });

    it('stores no cap table and records the failure on the connection', async () => {
      // `saveCapTable` bumps an optimistic-lock counter and writes an audit
      // event, so this half fails for reasons the pull cannot: an analyst
      // saving in another tab, a retired engagement, a pool with nothing left.
      failNth('INSERT INTO cap_tables', 1, 'could not serialize access due to concurrent update');
      const processed = await runDueCapTableSyncs({
        pool: ctx.pool,
        fetchFn: capTableFetch as unknown as typeof fetch,
      });
      expect(processed).toBe(0);

      expect(await findCapTable(ctx.pool, valuationId)).toBeNull();
      const row = await connectionRow();
      expect(row.status).toBe('error');
      // The count of what happened, not the driver's wording: `last_error` is
      // served verbatim, so it carries only text this codebase authored.
      expect(row.last_error).toBe('the provider cap table was pulled but could not be saved');
      expect(row.last_synced_at).toBeNull();
    });

    it('the scheduler does not come back for it either', async () => {
      const processed = await runDueCapTableSyncs({
        pool: ctx.pool,
        fetchFn: capTableFetch as unknown as typeof fetch,
      });
      expect(processed).toBe(0);
      // Not merely "processed nothing" — the provider was not dialled at all.
      // A connection left due keeps spending the quota on a call whose result
      // it cannot store.
      const before = capTableFetch.mock.calls.length;
      await runDueCapTableSyncs({ pool: ctx.pool, fetchFn: capTableFetch as unknown as typeof fetch });
      expect(capTableFetch.mock.calls.length).toBe(before);
    });
  });

  // ── 3. Accounting: a ledger applied halfway ───────────────────────────────

  describe('an accounting import that fails while applying', () => {
    let valuationId: string;

    const connectionRow = async () => {
      const { rows } = await ctx.pool.query<{
        status: string;
        last_error: string | null;
        last_import_at: Date | null;
      }>('SELECT status, last_error, last_import_at FROM accounting_connections WHERE valuation_id = $1', [
        valuationId,
      ]);
      return rows[0]!;
    };

    const runImport = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/accounting/xero/import`,
        headers: authHeader(ops.token),
      });

    beforeAll(async () => {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(ops.token),
        payload: { kind: '409a', company_name: 'Halfway Ledger Co' },
      });
      expect(created.statusCode).toBe(201);
      valuationId = created.json().valuation.id;
      const started = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/accounting/xero/connect`,
        headers: authHeader(ops.token),
      });
      const state = new URL(started.json().authorize_url).searchParams.get('state')!;
      const cb = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/accounting/callback?state=${encodeURIComponent(state)}&code=auth-code&realmId=tenant-1`,
      });
      expect(cb.statusCode).toBe(302);
    });

    it('does not report the last successful import as though nothing happened', async () => {
      // The import is two writes through two repos, each in its own
      // transaction: revenue params, then the balance sheet as engine input.
      // Failing the second leaves the engagement holding half a ledger — and,
      // before R186, a connection still reporting its previous state, because
      // `recordImport` is downstream of the throw.
      failNth('engine_inputs = engine_inputs ||', 1, 'deadlock detected');
      const res = await runImport();
      expect(res.statusCode).toBe(500);

      const row = await connectionRow();
      expect(row.status).toBe('error');
      expect(row.last_error).toContain('fetched, then failed while applying');
      expect(row.last_error).not.toContain('deadlock');
      expect(row.last_import_at).toBeNull();
    });

    it('a retry after the fault clears completes it and clears the error', async () => {
      const res = await runImport();
      expect(res.statusCode).toBe(200);
      const row = await connectionRow();
      expect(row.status).toBe('connected');
      expect(row.last_error).toBeNull();
      expect(row.last_import_at).not.toBeNull();
    });
  });

  // ── 4. AI jobs: the row nothing was ever going to settle ──────────────────

  describe('an AI job left running by a process that stopped existing', () => {
    let valuationId: string;

    const age = (id: string, ms: number) =>
      ctx.pool.query(`UPDATE ai_jobs SET created_at = now() - ($2 || ' ms')::interval WHERE id = $1`, [
        id,
        String(ms),
      ]);

    const statusOf = async (id: string) => {
      const { rows } = await ctx.pool.query<{
        status: string;
        error: string | null;
        completed_at: Date | null;
      }>('SELECT status, error, completed_at FROM ai_jobs WHERE id = $1', [id]);
      return rows[0]!;
    };

    beforeAll(async () => {
      valuationId = (await seedValuation('Orphaned Job Co')).id;
    });

    it('ages without bound while every reader calls it in flight', async () => {
      // `createAiJob` inserts at 'running' *before* the AI-service call. The
      // unified job feed anchors an `ai_job`'s `due_at` at `created_at`, so a
      // row orphaned between the insert and the settlement is counted as owed
      // and overdue by `oldestActiveJobs` — which is the number
      // `evaluateJobAlerts` compares against the queue's `stall_minutes`. This
      // is the state a deploy landing mid-extraction creates.
      const job = await createAiJob(ctx.pool, {
        valuationId,
        pipeline: 'extract',
        input: {},
        createdBy: ops.id,
      });
      await age(job.id, AI_JOB_STALE_MS * 4);

      const before = await oldestActiveJobs(ctx.pool);
      expect(before.find((q) => q.source === 'ai_job')?.active).toBe(1);

      const reaped = await reapStaleAiJobs(ctx.pool);
      expect(reaped.map((r) => r.id)).toEqual([job.id]);

      const settled = await statusOf(job.id);
      expect(settled.status).toBe('failed');
      expect(settled.error).toContain('reaped');
      expect(settled.completed_at).not.toBeNull();

      // The point of settling it: the queue can now be quiet, so a stall alert
      // opened by this row is able to resolve. Before R186 nothing in the
      // system could produce this state.
      const after = await oldestActiveJobs(ctx.pool);
      expect(after.find((q) => q.source === 'ai_job')).toBeUndefined();
    });

    it('says in the audit trail that it was reaped rather than that it finished', async () => {
      const job = await createAiJob(ctx.pool, {
        valuationId,
        pipeline: 'tagging',
        input: {},
        createdBy: ops.id,
      });
      await age(job.id, AI_JOB_STALE_MS * 2);
      await reapStaleAiJobs(ctx.pool);

      const { rows } = await ctx.pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM valuation_events
          WHERE valuation_id = $1 AND payload->>'job_id' = $2`,
        [valuationId, job.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toMatchObject({ status: 'failed', reaped: true });
      // Null rather than an invented duration: nobody knows how long it ran.
      expect(rows[0]!.payload.latency_ms).toBeNull();
    });

    it('leaves a job that could still be running alone', async () => {
      // The deliberately-broken half of the reaper: a threshold that swept
      // eagerly would fail live pipelines, which is a worse bug than the one it
      // fixes. `AI_JOB_STALE_MS` is five times the whole-call budget.
      const fresh = await createAiJob(ctx.pool, {
        valuationId,
        pipeline: 'extract',
        input: {},
        createdBy: ops.id,
      });
      await age(fresh.id, AI_JOB_STALE_MS / 2);
      const reaped = await reapStaleAiJobs(ctx.pool);
      expect(reaped.map((r) => r.id)).not.toContain(fresh.id);
      expect((await statusOf(fresh.id)).status).toBe('running');

      // …and is reaped once it passes the threshold, so "not yet" is a delay
      // and not an exemption.
      await age(fresh.id, AI_JOB_STALE_MS * 3);
      expect((await reapStaleAiJobs(ctx.pool)).map((r) => r.id)).toContain(fresh.id);
    });

    it('settles a job whose own failure write could not be recorded', async () => {
      // `runAiPipeline` now records *any* failure of the call, not only an
      // `InternalServiceError` — but that write can itself fail, which is
      // likely precisely when the database is the thing that is unwell. The two
      // mechanisms compose: the row stays running, and the reaper is what
      // closes it.
      const job = await createAiJob(ctx.pool, {
        valuationId,
        pipeline: 'explain',
        input: {},
        createdBy: ops.id,
      });
      failNth('UPDATE ai_jobs', 1, 'terminating connection due to administrator command');
      await expect(
        ctx.pool.query(`UPDATE ai_jobs SET status = 'failed' WHERE id = $1`, [job.id]),
      ).rejects.toThrow(/terminating connection/);
      restore?.();
      restore = null;

      expect((await statusOf(job.id)).status).toBe('running');
      await age(job.id, AI_JOB_STALE_MS * 2);
      expect((await reapStaleAiJobs(ctx.pool)).map((r) => r.id)).toContain(job.id);
      expect((await statusOf(job.id)).status).toBe('failed');
    });
  });
});
