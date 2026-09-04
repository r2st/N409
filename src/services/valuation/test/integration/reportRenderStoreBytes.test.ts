import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createReport, findReportByValuation, storeRenderedPdf } from '../../src/repos/reports.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Storing a render must not carry the render back (R417, methodology M8).
 *
 * `storeRenderedPdf` did two things with the deliverable that nothing asked for.
 * Its lock read selected `v.pdf` in order to compare it against null, and its
 * UPDATE said `RETURNING *`, which handed back the bytes the same statement had
 * just carried up plus the whole authored body beside them. The route's only
 * call site is a bare `await` with no assignment, so every one of those bytes
 * was decoded into a Buffer and dropped — inside the transaction that holds the
 * version's row lock for the rest of the write.
 *
 * Measured on a 723 kB render: the lock read 3.12 ms against 0.22, the UPDATE
 * 5.70 against 3.70, and about 1.5 MB of short-lived Buffer per render.
 *
 * These assertions are about the *work*. `storeRenderedPdf` returns nothing and
 * always did in effect, so no assertion over an answer — the row, the response,
 * the stored bytes, the event — could distinguish the two versions of it. The
 * instrument is a tap that weighs what each statement hands **back**, which is
 * also why it is not a check on SQL spelling: a future rewrite that reaches the
 * bytes by some other wording still fails it.
 */

const dbUp = await isDbAvailable();

/** A render big enough that carrying it back is unmistakable in the totals. */
const PDF = Buffer.alloc(700 * 1024, 0x41);

const CONTENT = {
  sections: Array.from({ length: 12 }, (_, i) => ({
    id: `s${i}`,
    title: `Section ${i}`,
    html: `<p>${'body text '.repeat(200)}</p>`,
  })),
} as never;

/**
 * Total bytes of `bytea` handed back to this process, per statement.
 *
 * `interceptPoolQueries` reports the SQL and not the result, and the result is
 * the whole question here — so this taps `pool.connect` the same way (a write
 * runs on a checked-out client, where a `pool.query` tap sees nothing at all)
 * and weighs the Buffers in the rows that come out.
 */
function weighReturnedBuffers(pool: pg.Pool): {
  rows: () => Array<{ sql: string; bytes: number }>;
  reset: () => void;
  stop: () => void;
} {
  let seen: Array<{ sql: string; bytes: number }> = [];
  const originalConnect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;

  const weigh = (result: unknown): number => {
    const rows = (result as { rows?: Array<Record<string, unknown>> })?.rows ?? [];
    let n = 0;
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (Buffer.isBuffer(value)) n += value.length;
        // A jsonb column arrives parsed; its weight is what it cost to ship and
        // re-parse, which is what the JSON text of it measures.
        else if (value !== null && typeof value === 'object') n += JSON.stringify(value).length;
      }
    }
    return n;
  };

  (pool as unknown as { connect: unknown }).connect = (...args: unknown[]) => {
    if (typeof args[0] === 'function') {
      return (originalConnect as unknown as (...a: unknown[]) => unknown)(...args);
    }
    return originalConnect().then((client) => {
      const clientQuery = client.query.bind(client);
      (client as unknown as { query: unknown }).query = async (...a: unknown[]) => {
        const sql = typeof a[0] === 'string' ? a[0] : ((a[0] as { text?: string })?.text ?? '');
        const result = await (clientQuery as (...x: unknown[]) => Promise<unknown>)(...a);
        seen.push({ sql: sql.replace(/\s+/g, ' ').trim(), bytes: weigh(result) });
        return result;
      };
      const release = client.release.bind(client);
      (client as unknown as { release: unknown }).release = (...a: unknown[]) => {
        (client as unknown as { query: unknown }).query = clientQuery;
        return (release as (...x: unknown[]) => unknown)(...a);
      };
      return client;
    });
  };

  return {
    rows: () => seen,
    reset: () => (seen = []),
    stop: () => void ((pool as unknown as { connect: unknown }).connect = originalConnect),
  };
}

describe.skipIf(!dbUp)('storing a render does not carry the render back', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const actor = () => ({ actorType: 'human' as const, actorId: ops.id, source: 'test' });

  async function seedReport(name: string) {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(created.statusCode).toBe(201);
    const vid = created.json().valuation.id as string;
    await createReport(ctx.pool, {
      valuationId: vid,
      templateVersion: '409a.v1',
      content: CONTENT,
      actor: actor(),
    });
    return (await findReportByValuation(ctx.pool, vid))!;
  }

  it('hands back none of the deliverable, on the first render or a re-render', async () => {
    const report = await seedReport('Render Bytes Co');
    const tap = weighReturnedBuffers(ctx.pool);
    try {
      // The first render, where the version has no stored bytes yet: the only
      // copy of the PDF that may move is the one going up as a parameter.
      await storeRenderedPdf(ctx.pool, { report, version: report.current_version, pdf: PDF, actor: actor() });
      const first = tap.rows();
      expect(first.length, 'the tap saw no statements — it is not attached').toBeGreaterThan(2);
      expect(first.reduce((n, r) => n + r.bytes, 0)).toBeLessThan(PDF.length);

      // And the re-render, which is the case that had bytes to fetch: the lock
      // read now finds a stored PDF, and asking whether one is there must not
      // be answered by shipping it.
      tap.reset();
      await storeRenderedPdf(ctx.pool, { report, version: report.current_version, pdf: PDF, actor: actor() });
      const again = tap.rows();
      const heaviest = again.reduce((a, b) => (a.bytes > b.bytes ? a : b));
      expect(
        heaviest.bytes,
        `a statement handed back ${heaviest.bytes} bytes: ${heaviest.sql.slice(0, 120)}`,
      ).toBeLessThan(PDF.length);
    } finally {
      tap.stop();
    }
  });

  it('does not move with the size of the stored render, which is the whole point', async () => {
    // The difference form. A count taken at one size cannot tell a read that
    // fetches the bytes from one that probes for them; deepen the stored
    // deliverable tenfold and the bytes coming back must not move.
    const small = await seedReport('Small Render Co');
    const large = await seedReport('Large Render Co');
    await storeRenderedPdf(ctx.pool, {
      report: small,
      version: small.current_version,
      pdf: Buffer.alloc(64 * 1024, 0x42),
      actor: actor(),
    });
    await storeRenderedPdf(ctx.pool, {
      report: large,
      version: large.current_version,
      pdf: Buffer.alloc(640 * 1024, 0x42),
      actor: actor(),
    });

    const tap = weighReturnedBuffers(ctx.pool);
    try {
      const weigh = async (report: Awaited<ReturnType<typeof seedReport>>, pdf: Buffer) => {
        tap.reset();
        await storeRenderedPdf(ctx.pool, { report, version: report.current_version, pdf, actor: actor() });
        return tap.rows().reduce((n, r) => n + r.bytes, 0);
      };
      const a = await weigh(small, Buffer.alloc(64 * 1024, 0x43));
      const b = await weigh(large, Buffer.alloc(640 * 1024, 0x43));
      expect(b - a).toBeLessThan(16 * 1024);
    } finally {
      tap.stop();
    }
  });

  it('still refuses a re-render over a delivered version', async () => {
    // The check the lock read exists for, over the probe rather than the bytes.
    const report = await seedReport('Delivered Render Co');
    await storeRenderedPdf(ctx.pool, { report, version: report.current_version, pdf: PDF, actor: actor() });
    await ctx.pool.query(`UPDATE valuations SET state = 'published' WHERE id = $1`, [report.valuation_id]);

    await expect(
      storeRenderedPdf(ctx.pool, { report, version: report.current_version, pdf: PDF, actor: actor() }),
    ).rejects.toThrow(/already been delivered/);
  });

  it('still throws when the version is not there', async () => {
    const report = await seedReport('Missing Version Co');
    await expect(
      storeRenderedPdf(ctx.pool, { report, version: 99, pdf: PDF, actor: actor() }),
    ).rejects.toThrow(/not found/);
  });
});
