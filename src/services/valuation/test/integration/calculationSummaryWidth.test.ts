import { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createCalculation, listCalculationSummaries } from '../../src/repos/calculations.js';
import {
  authHeader,
  interceptPoolQueries,
  isDbAvailable,
  seedUser,
  setupTestDb,
  type TestDb,
} from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The two surfaces that read a run's headline and throw the documents away.
 *
 * `packageView` and the specialty tab each map the twenty-run window down to
 * seven scalar columns, and both were handed `inputs` and `results` — the whole
 * engine payload and the whole engine answer — for every row, out of the table,
 * over the socket and through the driver's JSON parser, to be dropped one line
 * later. A `results` document is 11 kB on a ten-class cap table, 67 kB at fifty
 * and 613 kB at the 200-class cap.
 *
 * p1p2's package-explorer test already asserted `not.toHaveProperty('results')`
 * on the *response*, which is what made this invisible: the narrowing was real,
 * it just happened after the read. So the assertion here is over the statements
 * the endpoint issues, not over what it returns.
 */
describe.skipIf(!dbUp)('calculation summary width', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    const config = loadConfig({ DATABASE_URL: db.url, JWT_SECRET: 'x'.repeat(32) });
    app = buildApp({ config, pool });
    await app.ready();

    const seedCtx = { app, pool, teardown: async () => {} };
    ops = await seedUser(seedCtx, { roles: ['reviewer'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'WidthCo' },
    });
    valuationId = created.json().valuation.id;
    const actor = { actorType: 'human', actorId: ops.id } as const;

    // A 409A run: no `endpoint` at all, and a results document worth not
    // reading twice.
    await createCalculation(
      pool,
      {
        valuationId,
        engineVersion: 'py-stub',
        status: 'succeeded',
        inputs: { valuation_date: '2026-06-30', share_classes: [{ name: 'Common', shares: 1 }] },
        results: { equity_value: 20_000_000, fmv_per_share: 1.5, approaches: { opm_backsolve: {} } },
        equityValue: 20_000_000,
        fmvPerShare: 1.5,
        createdBy: ops.id,
      },
      actor,
    );
    // A specialty run.
    await createCalculation(
      pool,
      {
        valuationId,
        engineVersion: 'py-stub',
        status: 'succeeded',
        inputs: { endpoint: '/engine/v1/qsbs' },
        results: { kind: 'qsbs', specialty: { eligible: true } },
        createdBy: ops.id,
      },
      actor,
    );
    // And a decoy whose `endpoint` is not a string. `->>` renders a number as
    // text, so a probe that only asked for the text would have to re-derive the
    // filter's `typeof === 'string'` rule in SQL; `jsonb_typeof` is that rule.
    await createCalculation(
      pool,
      {
        valuationId,
        engineVersion: 'py-stub',
        status: 'failed',
        inputs: { endpoint: 7 },
        error: 'nope',
        createdBy: ops.id,
      },
      actor,
    );
  });

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  });

  /** Statements this request issued that read the calculations table. */
  const calculationReads = async (url: string): Promise<string[]> => {
    const seen: string[] = [];
    const restore = interceptPoolQueries(pool, (sql, phase) => {
      if (phase === 'before' && /\bFROM calculations\b/i.test(sql)) seen.push(sql);
      return undefined;
    });
    try {
      const res = await app.inject({ method: 'GET', url, headers: authHeader(ops.token) });
      expect(res.statusCode).toBe(200);
      return seen;
    } finally {
      restore();
    }
  };

  it('the package explorer never reads a run document', async () => {
    const reads = await calculationReads(`/api/v1/valuations/${valuationId}/package`);
    expect(reads.length).toBeGreaterThan(0);
    for (const sql of reads) {
      expect(sql).not.toMatch(/\bresults\b/);
      expect(sql).not.toMatch(/\binputs\b(?!\s*->)/);
    }
  });

  it('the specialty tab reads one document, for the run it is rendering', async () => {
    const reads = await calculationReads(`/api/v1/valuations/${valuationId}/specialty`);
    // `latestSucceededSpecialtyCalculation` reads the one run whose
    // `results.specialty` the tab draws. The *history* beside it must not.
    const wide = reads.filter((sql) => /\bresults\b/.test(sql));
    expect(wide).toHaveLength(1);
    expect(wide[0]).toMatch(/LIMIT 1/);
  });

  it('keeps the endpoint filter the documents used to answer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/specialty`,
      headers: authHeader(ops.token),
    });
    const { history } = res.json() as { history: Array<{ engine_version: string; status: string }> };
    // The specialty run, and neither the 409A one nor the numeric-endpoint decoy.
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe('succeeded');
  });

  it('the narrow reader carries the endpoint and neither document', async () => {
    const { calculations, truncated } = await listCalculationSummaries(pool, valuationId);
    expect(truncated).toBe(false);
    expect(calculations).toHaveLength(3);
    for (const row of calculations) {
      expect(row).not.toHaveProperty('results');
      expect(row).not.toHaveProperty('inputs');
    }
    expect(calculations.map((c) => c.input_endpoint).sort()).toEqual(['/engine/v1/qsbs', null, null]);
  });
});
