import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { listMarketResearch } from '../../src/repos/marketResearch.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/** Engagements across the estate; the caller owns a handful of them. */
const VALUATIONS = 2_000;
/** Research rows and board signoffs spread over those engagements. */
const RESEARCH = 40_000;
const SIGNOFFS = 40_000;
/** What one customer actually has open. */
const OWNED = 3;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Rows Removed by Filter'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];
const blocks = (n: PlanNode) => (n['Shared Hit Blocks'] ?? 0) + (n['Shared Read Blocks'] ?? 0);

interface Explainer {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

async function explain(client: Explainer, sql: string, params: unknown[] = []): Promise<PlanNode[]> {
  const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  return flatten((rows[0]!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan);
}

/** Runs `body` with `indexName` dropped inside a transaction that is rolled back. */
async function without<T>(pool: pg.Pool, indexName: string, body: (c: Explainer) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DROP INDEX ${indexName}`);
    return await body(client as unknown as Explainer);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/** `listMarketResearch`, both ways round. */
const RESEARCH_SQL = `
  SELECT * FROM market_research
   WHERE valuation_id = $1
     AND ($2::boolean OR superseded_at IS NULL)
   ORDER BY created_at DESC`;

/** The board-signoff counter from `onboardingFacts`. */
const SIGNOFF_SQL = `
  WITH scoped AS (SELECT id FROM valuations WHERE user_id = $1)
  SELECT (SELECT count(*) FROM board_signoffs b JOIN scoped s ON s.id = b.valuation_id
           WHERE b.status = 'signed')::text AS n`;

/**
 * Two per-engagement reads that answered a question about one engagement by
 * reading every engagement's rows (migration 0173).
 *
 * Both had the same shape and neither was visible in a route test: the query is
 * correct, the page renders, and the cost is a function of how much *other*
 * customers' data is in the table. `market_research` carried one partial index
 * whose predicate the evidence bundle deliberately turns off, so that caller had
 * no index at all; `board_signoffs` is keyed by resolution everywhere except the
 * onboarding card, which joins on the one column that had none.
 *
 * The assertions are differential — this plan against the same plan with the
 * index dropped — because an absolute block count pins the seed size rather than
 * the property, and the property is that neither read scales with the estate.
 */
describe.skipIf(!dbUp)('reads keyed by engagement do not scan the estate (migration 0173)', () => {
  let db: TestDb;
  let ownerId: string;
  let otherId: string;
  let ownedValuation: string;

  beforeAll(async () => {
    db = await setupTestDb();
    ownerId = newUlid();
    otherId = newUlid();
    await db.pool.query(
      `INSERT INTO users (id, email, password_digest)
       VALUES ($1, 'owner@test.example.com', 'x'), ($2, 'other@test.example.com', 'x')`,
      [ownerId, otherId],
    );
    // Uppercase hex is a subset of Crockford base32, so a padded counter
    // satisfies the `ulid` domain without a generator in the database.
    await db.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id)
       SELECT upper(lpad(to_hex(g + 1000000), 26, '0')), '409a', 'Co ' || g,
              CASE WHEN g <= ${OWNED} THEN $1 ELSE $2 END
         FROM generate_series(1, ${VALUATIONS}) AS g`,
      [ownerId, otherId],
    );
    await db.pool.query(
      `INSERT INTO market_research
         (id, valuation_id, topic, question, answer, model, created_at, superseded_at)
       SELECT upper(lpad(to_hex(g + 2000000), 26, '0')),
              upper(lpad(to_hex((g % ${VALUATIONS}) + 1000001), 26, '0')),
              'topic' || (g % 8), 'q', 'a', 'm',
              now() - (g || ' minutes')::interval,
              -- A third superseded, so the partial index excludes something real.
              CASE WHEN g % 3 = 0 THEN now() ELSE NULL END
         FROM generate_series(1, ${RESEARCH}) AS g`,
    );
    await db.pool.query(
      `INSERT INTO board_resolutions
         (id, valuation_id, valuation_date, fmv_conclusion, methodology_summary,
          appraiser_qualifications, body_html, created_by)
       SELECT upper(lpad(to_hex(g + 3000000), 26, '0')),
              upper(lpad(to_hex((g % ${VALUATIONS}) + 1000001), 26, '0')),
              current_date, 1.23, 'm', 'q', '<p>x</p>', $1
         FROM generate_series(1, ${VALUATIONS}) AS g`,
      [otherId],
    );
    await db.pool.query(
      `INSERT INTO board_signoffs
         (id, resolution_id, valuation_id, member_name, member_email,
          token_sha256, token_expires_at, status)
       SELECT upper(lpad(to_hex(g + 4000000), 26, '0')),
              upper(lpad(to_hex((g % ${VALUATIONS}) + 3000001), 26, '0')),
              upper(lpad(to_hex((g % ${VALUATIONS}) + 1000001), 26, '0')),
              'M' || g, 'm' || g || '@test.example.com', md5(g::text),
              now() + interval '30 days',
              CASE WHEN g % 2 = 0 THEN 'signed' ELSE 'pending' END::board_signoff_status
         FROM generate_series(1, ${SIGNOFFS}) AS g`,
    );
    await db.pool.query('ANALYZE valuations');
    await db.pool.query('ANALYZE market_research');
    await db.pool.query('ANALYZE board_signoffs');
    ownedValuation =
      `${'0'.repeat(26 - (1000001).toString(16).length)}${(1000001).toString(16)}`.toUpperCase();
  }, 180_000);
  afterAll(async () => db?.teardown());

  describe('market_research_valuation_created_idx', () => {
    it('leads with the engagement and orders by recency', async () => {
      const { rows } = await db.pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'market_research' AND indexname = $1`,
        ['market_research_valuation_created_idx'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.indexdef).toMatch(/\(valuation_id, created_at DESC\)/);
      // Not partial: the caller that was worst off is the one that asks for the
      // superseded rows too, which is exactly what a partial index excludes.
      expect(rows[0]!.indexdef).not.toMatch(/WHERE/);
    });

    it.each([
      ['the live set', false],
      ['the evidence bundle, which includes superseded rows', true],
    ])('keeps %s off a sequential scan', async (_what, includeSuperseded) => {
      const plan = await explain(db.pool, RESEARCH_SQL, [ownedValuation, includeSuperseded]);
      const scan = plan.find((n) => n['Relation Name'] === 'market_research');
      expect(scan?.['Node Type']).not.toBe('Seq Scan');
    });

    it('reads an order of magnitude fewer blocks than the scan it replaced', async () => {
      const params = [ownedValuation, true];
      const withIndex = await explain(db.pool, RESEARCH_SQL, params);
      const withoutIndex = await without(db.pool, 'market_research_valuation_created_idx', (c) =>
        explain(c, RESEARCH_SQL, params),
      );

      const seq = withoutIndex.find((n) => n['Relation Name'] === 'market_research');
      expect(seq?.['Node Type']).toBe('Seq Scan');
      expect(seq?.['Rows Removed by Filter'] ?? 0).toBeGreaterThan(RESEARCH / 2);
      expect(Math.max(...withIndex.map(blocks))).toBeLessThan(Math.max(...withoutIndex.map(blocks)) / 10);
    });

    it('still returns what the repo asked for, both ways round', async () => {
      const live = await listMarketResearch(db.pool, ownedValuation);
      const all = await listMarketResearch(db.pool, ownedValuation, { includeSuperseded: true });
      expect(all.length).toBeGreaterThan(live.length);
      expect(live.every((r) => r.superseded_at === null)).toBe(true);
      const times = all.map((r) => r.created_at.getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });
  });

  describe('board_signoffs_valuation_idx', () => {
    it('indexes the column the onboarding card joins on', async () => {
      const { rows } = await db.pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'board_signoffs' AND indexname = $1`,
        ['board_signoffs_valuation_idx'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.indexdef).toMatch(/\(valuation_id\)/);
    });

    it('counts one customer’s signoffs without reading every other customer’s', async () => {
      const withIndex = await explain(db.pool, SIGNOFF_SQL, [ownerId]);
      const withoutIndex = await without(db.pool, 'board_signoffs_valuation_idx', (c) =>
        explain(c, SIGNOFF_SQL, [ownerId]),
      );

      expect(withoutIndex.find((n) => n['Relation Name'] === 'board_signoffs')?.['Node Type']).toBe(
        'Seq Scan',
      );
      expect(withIndex.find((n) => n['Relation Name'] === 'board_signoffs')?.['Node Type']).not.toBe(
        'Seq Scan',
      );
      expect(Math.max(...withIndex.map(blocks))).toBeLessThan(Math.max(...withoutIndex.map(blocks)) / 5);
    });

    it('counts the caller’s signed resolutions and nobody else’s', async () => {
      const { rows } = await db.pool.query<{ n: string }>(SIGNOFF_SQL, [ownerId]);
      const { rows: mine } = await db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM board_signoffs b
          JOIN valuations v ON v.id = b.valuation_id
         WHERE v.user_id = $1 AND b.status = 'signed'`,
        [ownerId],
      );
      expect(rows[0]!.n).toBe(mine[0]!.n);
      expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    });
  });
});
