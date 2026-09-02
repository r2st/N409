import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * What a file download reads, asserted over the statements and not the response
 * (R351, M8).
 *
 * The three formats of `GET /valuations/export` were answered by two different
 * readers: CSV and XLSX through `exportValuations`, which selects seventeen
 * named columns under a LIMIT, and the PDF through `listValuations`, which is
 * the *screen's* reader. That cost the PDF arm two things at the ten-thousand
 * row cap. `listValuations` selects `*` — forty-odd columns read out of the
 * table and parsed by the driver to print the nine that fit a printable table —
 * and it runs a `count(*)` over the whole filtered book alongside the page,
 * because a screen prints a total. This route destructured `items` and dropped
 * that number on the floor.
 *
 * A guard over the response cannot see either of those: the PDF looked right
 * both before and after, which is R322's lesson about what an endpoint returns.
 * So this reads the statements the request issues.
 *
 * The parity half — that the PDF names the same engagements as the CSV — is
 * `exportDisplayParity.test.ts`, and it is the reason the two arms sharing one
 * reader is a correctness change as well as a cost one.
 */
describe.skipIf(!dbUp)('the list export reader', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    for (const name of ['Alpha Co', 'Beta Co']) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(ops.token),
        payload: { company_name: name, kind: '409a' },
      });
      expect(res.statusCode).toBe(201);
    }
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  /** Every statement one request issues, in order. */
  async function statementsFor(url: string): Promise<string[]> {
    const seen: string[] = [];
    const restore = interceptPoolQueries(ctx.pool, (sql, phase) => {
      if (phase === 'before') seen.push(sql);
    });
    try {
      const res = await ctx.app.inject({ method: 'GET', url, headers: authHeader(ops.token) });
      expect(res.statusCode).toBe(200);
    } finally {
      restore();
    }
    return seen;
  }

  /** Statements that read the engagement book itself, rather than the audit row after it. */
  const bookReads = (issued: string[]): string[] =>
    issued.filter((sql) => /\bFROM valuations\b/i.test(sql));

  for (const format of ['csv', 'xlsx', 'pdf'] as const) {
    it(`counts nothing to build the ${format}`, async () => {
      const reads = bookReads(await statementsFor(`/api/v1/valuations/export?format=${format}`));
      expect(reads.length).toBeGreaterThan(0);
      for (const sql of reads) expect(sql).not.toMatch(/count\(\*\)/i);
    });

    it(`reads named columns to build the ${format}`, async () => {
      const reads = bookReads(await statementsFor(`/api/v1/valuations/export?format=${format}`));
      // `SELECT *` off the engagement table, in any spacing. The narrow reader
      // names its columns, so nothing here may open with a bare star.
      for (const sql of reads) expect(sql).not.toMatch(/SELECT\s+\*/i);
    });
  }

  it('answers all three formats with the same statement', async () => {
    const shapes = await Promise.all(
      (['csv', 'xlsx', 'pdf'] as const).map(async (format) =>
        bookReads(await statementsFor(`/api/v1/valuations/export?format=${format}`)).join('\n'),
      ),
    );
    expect(new Set(shapes).size).toBe(1);
  });
});
