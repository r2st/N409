import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { findValuationsByIds } from '../../src/repos/valuations.js';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('feature 10 — valuation monitoring', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'MonitorCo' },
    });
    valuationId = created.json().valuation.id;
    // A concluded FMV + a completed-ish state + baseline revenue.
    await createCalculation(
      pool,
      {
        valuationId,
        engineVersion: 't',
        status: 'succeeded',
        inputs: {},
        results: {},
        equityValue: 1,
        fmvPerShare: 2,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );
    await pool.query("UPDATE valuations SET state = 'published', assigned_reviewer_id = $2 WHERE id = $1", [
      valuationId,
      ops.id,
    ]);
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(ops.token),
      payload: { last_year_revenue_cents: 100_000_000 }, // $1,000,000
    });
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('enables monitoring and snapshots a baseline', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/monitor`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().monitor.enabled).toBe(true);
    expect(res.json().monitor.baseline.annual_revenue).toBe(1_000_000);
  });

  it('reports green immediately after enabling', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/monitor`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('green');
    expect(res.json().triggers).toHaveLength(0);
  });

  it('fires a revenue trigger when revenue moves past materiality', async () => {
    // Move revenue +40% from the baseline.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(ops.token),
      payload: { last_year_revenue_cents: 140_000_000 },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/monitor`,
      headers: authHeader(ops.token),
    });
    expect(res.json().status).toBe('red');
    expect(res.json().triggers.some((t: any) => t.type === 'revenue_change' && t.level === 'red')).toBe(true);
  });

  /*
   * The expiry trigger's twelve months are §409A's, and the sentence it fires
   * with says so. A specialty run has no §409A safe harbor to lapse, and the
   * scan quotes this sentence verbatim into the alert email that reaches the
   * assigned reviewer — so the wording has to come off the run that concluded
   * the engagement, not off a constant.
   */
  describe('the expiry sentence follows the engine that wrote the run', () => {
    const seedAged = async (kind: string, results: Record<string, unknown>) => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(client.token),
        payload: { kind, company_name: `Aged ${kind}` },
      });
      const id = created.json().valuation.id;
      await createCalculation(
        pool,
        {
          valuationId: id,
          engineVersion: 't',
          status: 'succeeded',
          inputs: {},
          results,
          equityValue: 3_000_000,
          fmvPerShare: 1.2,
          createdBy: ops.id,
        },
        { actorType: 'human', actorId: ops.id },
      );
      // Published two years ago: the safe-harbor clock reads off `published_at`
      // when there is no board resolution.
      await pool.query(
        `UPDATE valuations SET state = 'published', published_at = now() - interval '2 years' WHERE id = $1`,
        [id],
      );
      const enabled = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/monitor`,
        headers: authHeader(ops.token),
      });
      expect(enabled.statusCode).toBe(201);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/monitor`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      return res.json().triggers.find((t: { type: string }) => t.type === 'expiry');
    };

    it('claims no §409A safe harbor over a UK EMI run', async () => {
      // What `routes/specialty.ts` persists: the engine result under
      // `specialty`, with the kind beside it. The typed columns still hold a
      // figure — that is what made every 409A-shaped reader of this row look
      // fine — but `fmv_per_share` there is the restricted AMV.
      const expiry = await seedAged('emi', { kind: 'emi', specialty: { amv_per_share: 1.2 } });
      expect(expiry.level).toBe('red');
      expect(expiry.message).not.toContain('safe-harbor');
      expect(expiry.message).toMatch(/months old — over 12 months since the valuation date/);
      expect(expiry.detail).toMatchObject({ safe_harbor: false, kind: 'emi' });
      // Unchanged, because it is the dedupe key against `monitoring_alerts`.
      expect(expiry.signature).toBe('expiry:12');
    });

    it('keeps it over a run of the 409A engine', async () => {
      // The same row shape a 409A run persists: the engine's own document,
      // which has no `specialty` key at all.
      const expiry = await seedAged('409a', { fmv_per_share: 1.2, approaches: {} });
      expect(expiry.level).toBe('red');
      expect(expiry.message).toContain('12-month safe-harbor window');
      expect(expiry.detail).toMatchObject({ safe_harbor: true, kind: null });
    });
  });

  it('scans and emails the reviewer once, then dedupes', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/monitors/scan',
      headers: authHeader(ops.token),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().alerts_sent).toBeGreaterThanOrEqual(1);

    const outbox = await pool.query('SELECT count(*)::int AS n FROM email_outbox WHERE subject LIKE $1', [
      'Revaluation trigger:%',
    ]);
    const firstCount = outbox.rows[0].n as number;
    expect(firstCount).toBeGreaterThanOrEqual(1);

    // Re-scanning does not re-alert the same trigger.
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/monitors/scan',
      headers: authHeader(ops.token),
    });
    expect(second.json().alerts_sent).toBe(0);
    const outbox2 = await pool.query('SELECT count(*)::int AS n FROM email_outbox WHERE subject LIKE $1', [
      'Revaluation trigger:%',
    ]);
    expect(outbox2.rows[0].n).toBe(firstCount);
  });

  it('lists the monitor on the dashboard with status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/monitors',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const mine = res.json().monitors.find((m: any) => m.valuation_id === valuationId);
    expect(mine.status).toBe('red');
  });

  it('one-click roll-forward creates a fresh valuation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/monitor/new-valuation`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().valuation.id).not.toBe(valuationId);
    expect(res.json().valuation.company_name).toBe('MonitorCo');
    expect(res.json().valuation.state).toBe('pending');
  });

  const disabledEvents = async (): Promise<number> => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM valuation_events
        WHERE valuation_id = $1 AND type = 'monitoring_disabled'`,
      [valuationId],
    );
    return Number(rows[0]!.n);
  };

  it('disables monitoring', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/valuations/${valuationId}/monitor`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(204);
    const after = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/monitor`,
      headers: authHeader(ops.token),
    });
    expect(after.json().monitor).toBeNull();
  });

  it('records the stop once however many times it is pressed', async () => {
    // `findMonitor` is the route's whole existence check and returns the row
    // whether the watch is on or off, so a second DELETE answered 204 and put
    // another `monitoring_disabled` on the engagement's trail for a watch that had
    // already stopped (round 356, methodology M3). The answer stays 204 — the
    // caller asked for a state the monitor is already in.
    const enable = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/monitor`,
      headers: authHeader(ops.token),
    });
    expect(enable.statusCode).toBe(201);
    const before = await disabledEvents();

    for (const _ of [1, 2]) {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${valuationId}/monitor`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(204);
    }
    expect((await disabledEvents()) - before).toBe(1);
  });

  it('is operations-only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/monitor`,
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(403);
  });
});

/**
 * The dashboard and the scan used to call findValuationById once per enabled
 * monitor, so the number of round trips before any real work grew linearly with
 * the number of monitored companies. These tests pin the batched fetch by
 * counting queries, not just by checking the output still looks right.
 */
describe.skipIf(!dbUp)('feature 10 — monitoring fetches valuations in one query', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  const monitored: string[] = [];

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    const client = await seedUser(ctx, { roles: ['valuation_user'] });

    for (let i = 0; i < 5; i++) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(client.token),
        payload: { kind: '409a', company_name: `BatchCo ${i}` },
      });
      const id = created.json().valuation.id as string;
      await createCalculation(
        pool,
        {
          valuationId: id,
          engineVersion: 't',
          status: 'succeeded',
          inputs: {},
          results: {},
          equityValue: 1,
          fmvPerShare: 2,
          createdBy: ops.id,
        },
        { actorType: 'human', actorId: ops.id },
      );
      await pool.query("UPDATE valuations SET state = 'published' WHERE id = $1", [id]);
      await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/monitor`,
        headers: authHeader(ops.token),
      });
      monitored.push(id);
    }
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  /** Runs `fn` with pool.query instrumented, returning every SQL string issued. */
  const recordQueries = async (fn: () => Promise<unknown>): Promise<string[]> => {
    const seen: string[] = [];
    type QueryFn = (...args: unknown[]) => unknown;
    const spied = pool as unknown as { query: QueryFn };
    const original = spied.query.bind(pool) as QueryFn;
    spied.query = (...args: unknown[]) => {
      const [first] = args;
      seen.push(typeof first === 'string' ? first : String((first as { text?: string })?.text ?? ''));
      return original(...args);
    };
    try {
      await fn();
    } finally {
      spied.query = original;
    }
    return seen;
  };

  const singleFetches = (queries: string[]) =>
    queries.filter((q) => /SELECT \* FROM valuations WHERE id = \$1\s*$/.test(q.trim()));
  const batchedFetches = (queries: string[]) =>
    queries.filter((q) => /SELECT \* FROM valuations WHERE id = ANY\(\$1\)/.test(q));

  it('loads every monitored valuation in one batched query on the dashboard', async () => {
    const queries = await recordQueries(async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/monitors',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().monitors.length).toBeGreaterThanOrEqual(5);
    });

    expect(batchedFetches(queries)).toHaveLength(1);
    expect(singleFetches(queries)).toHaveLength(0);
  });

  it('loads every monitored valuation in one batched query on a scan', async () => {
    const queries = await recordQueries(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/monitors/scan',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().scanned).toBeGreaterThanOrEqual(5);
    });

    expect(batchedFetches(queries)).toHaveLength(1);
    expect(singleFetches(queries)).toHaveLength(0);
  });

  it('still reports each monitored company on the dashboard', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/monitors',
      headers: authHeader(ops.token),
    });
    const ids = res.json().monitors.map((m: { valuation_id: string }) => m.valuation_id);
    for (const id of monitored) expect(ids).toContain(id);
  });

  it('omits unknown ids from the batch rather than throwing', async () => {
    // The callers skip monitors whose valuation is missing, so the map must
    // simply not contain the id — this is what replaced a per-id null check.
    const found = await findValuationsByIds(pool, [monitored[0]!, newUlid()]);
    expect(found.size).toBe(1);
    expect(found.get(monitored[0]!)?.id).toBe(monitored[0]);
  });

  it('deduplicates repeated ids and returns an empty map for no ids', async () => {
    const found = await findValuationsByIds(pool, [monitored[0]!, monitored[0]!]);
    expect(found.size).toBe(1);
    expect((await findValuationsByIds(pool, [])).size).toBe(0);
  });
});

/**
 * A baseline snapshotted before `conversion_ratio` reached the fully-diluted
 * denominator holds a 1:1 count, and the live half of the comparison has been
 * recomputed on read since d946f0d — so a monitored engagement with a ratchet
 * fired a `cap_table_change` reporting a move nobody made, on every scan, until
 * somebody re-enabled monitoring. `baseline` is JSONB written once and nothing
 * rewrites one, so writing the old count straight into the column is the only
 * way to reproduce a row that predates the rule change.
 */
describe.skipIf(!dbUp)('feature 10 — a baseline that predates the as-converted count', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const RATCHET_CSV = [
    'class,shares,price,invested,conversion_ratio',
    'Common,8000000,0.10,,',
    'Series A,2000000,1.00,2000000,2',
  ].join('\n');

  const capTableTriggers = (triggers: { type: string }[]) =>
    triggers.filter((t) => t.type === 'cap_table_change');

  const getMonitor = async () =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/monitor`,
        headers: authHeader(ops.token),
      })
    ).json();

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    const client = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'RatchetCo' },
    });
    valuationId = created.json().valuation.id;
    await createCalculation(
      pool,
      {
        valuationId,
        engineVersion: 't',
        status: 'succeeded',
        inputs: {},
        results: {},
        equityValue: 1,
        fmvPerShare: 2,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );
    await pool.query("UPDATE valuations SET state = 'published', assigned_reviewer_id = $2 WHERE id = $1", [
      valuationId,
      ops.id,
    ]);
    await app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: authHeader(client.token),
      payload: { format: 'generic', csv: RATCHET_CSV },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/monitor`,
      headers: authHeader(ops.token),
    });
    // Age the stored baseline the way the schema change did: the Series A goes
    // back to being counted 1:1, so 12M as-converted reads as 10M.
    await pool.query(
      `UPDATE valuation_monitors
          SET baseline = jsonb_set(baseline, '{fully_diluted_shares}', '10000000')
        WHERE valuation_id = $1`,
      [valuationId],
    );
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('snapshots the as-converted count when monitoring is enabled today', async () => {
    // The fixture wrote 10,000,000 over it; what enabling stored was 12,000,000.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT baseline->>'fully_diluted_shares' AS n FROM valuation_monitors WHERE valuation_id = $1`,
      [valuationId],
    );
    expect(rows[0]!.n).toBe('10000000');
    const capTable = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: authHeader(ops.token),
    });
    expect(capTable.json().cap_table.validation.summary.fully_diluted_shares).toBe(12_000_000);
  });

  it('fires no cap-table trigger against the stale count', async () => {
    const body = await getMonitor();
    expect(capTableTriggers(body.triggers)).toHaveLength(0);
    expect(body.status).toBe('green');
  });

  it('shows the reconciled baseline beside the triggers, not the stored one', async () => {
    // Returning the stored figure would put a 2,000,000-share difference on
    // screen that the empty trigger list denies.
    const body = await getMonitor();
    expect(body.monitor.baseline.fully_diluted_shares).toBe(12_000_000);
    expect(body.current.fully_diluted_shares).toBe(12_000_000);
  });

  it('leaves the rest of the stored baseline alone', async () => {
    const body = await getMonitor();
    const { rows } = await pool.query<{ baseline: Record<string, unknown> }>(
      'SELECT baseline FROM valuation_monitors WHERE valuation_id = $1',
      [valuationId],
    );
    // Read-time reconciliation, not a rewrite: the column still holds the old
    // count, and only that one field of the returned snapshot differs from it.
    expect(rows[0]!.baseline.fully_diluted_shares).toBe(10_000_000);
    expect({ ...body.monitor.baseline, fully_diluted_shares: null }).toEqual({
      ...rows[0]!.baseline,
      fully_diluted_shares: null,
    });
  });

  it('reports green on the dashboard and alerts nobody on a scan', async () => {
    const dash = await app.inject({
      method: 'GET',
      url: '/api/v1/monitors',
      headers: authHeader(ops.token),
    });
    const mine = dash.json().monitors.find((m: { valuation_id: string }) => m.valuation_id === valuationId);
    expect(capTableTriggers(mine.triggers)).toHaveLength(0);
    expect(mine.status).toBe('green');

    const scan = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/monitors/scan',
      headers: authHeader(ops.token),
    });
    expect(scan.statusCode).toBe(200);
    const alerts = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM monitor_alerts a
         JOIN valuation_monitors m ON m.id = a.monitor_id
        WHERE m.valuation_id = $1 AND a.trigger_type = 'cap_table_change'`,
      [valuationId],
    );
    expect(alerts.rows[0]!.n).toBe(0);
  });

  it('still fires when the cap table is genuinely rewritten afterwards', async () => {
    // The reconciliation is bounded by `cap_tables.updated_at`: once the table
    // is written again the rows behind the live count are no longer the rows
    // the baseline was taken from, so a difference has to be reported.
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: authHeader(ops.token),
      payload: {
        format: 'generic',
        csv: [
          'class,shares,price,invested,conversion_ratio',
          'Common,8000000,0.10,,',
          'Series A,2000000,1.00,2000000,2',
          'Series B,3000000,2.00,6000000,1',
        ].join('\n'),
      },
    });
    expect(res.statusCode).toBe(200);

    const body = await getMonitor();
    const [trigger] = capTableTriggers(body.triggers);
    expect(trigger).toBeDefined();
    // And the baseline is the stored one again, stale count and all: the
    // entries it was taken from are gone, so there is nothing left to recompute
    // it from. The trigger is right that the table moved and overstates the
    // move by the 2,000,000 the old summary never counted — which is the bound
    // on this fix, and the reason it is a read-time correction rather than a
    // claim that the stored figure has been repaired.
    expect(body.monitor.baseline.fully_diluted_shares).toBe(10_000_000);
    expect(body.current.fully_diluted_shares).toBe(15_000_000);
  });
});
