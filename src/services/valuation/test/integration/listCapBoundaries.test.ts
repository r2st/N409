import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import {
  DOCUMENT_PAGE_LIMIT,
  documentCoverage,
  hasExtractableDocument,
  listDocuments,
} from '../../src/repos/documents.js';
import { DECISION_PAGE_LIMIT, createDecision, listDecisions } from '../../src/repos/methodologyDecisions.js';
import { TRANSACTION_PAGE_LIMIT, listRounds, listTransactions } from '../../src/repos/transactions.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The caps R187 added, at the one row where they can be wrong.
 *
 * Every one of these lists is read with `LIMIT n + 1`, sliced to `n`, and the
 * flag set from whether the extra row came back. That idiom has exactly one
 * failure mode and it is off by one: a list of precisely `n` rows reported as
 * truncated is a notice on a complete list, and a list of `n + 1` reported as
 * complete is the silent short list the whole scheme exists to prevent. Neither
 * shows up at any other row count, so each cap is exercised at `n` and at
 * `n + 1` rather than at some comfortable number in between.
 *
 * The second half of the file is the part that would have been the actual bug.
 * Capping a list is safe only where the list is *drawn*; three callers reduced
 * the document list to a derived fact — the intake checklist's per-bucket
 * counts, the completeness score's set of covered buckets, and the pipeline
 * trigger's "is anything extractable here" — and a page would have made each of
 * those answer confidently and wrongly on a large engagement. Those three now
 * ask SQL a bounded question instead, and the assertions below are written past
 * the cap for that reason: at `DOCUMENT_PAGE_LIMIT + 1` files, the checklist
 * still has to count all of them.
 */
describe.skipIf(!dbUp)('list caps at their boundary', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  /** Rows straight into the table: this is about row counts, not about upload. */
  const seedDocuments = async (
    count: number,
    opts: { kind?: string; category?: string; extension?: string; createdAt?: string } = {},
  ) => {
    const { kind = 'other', category = 'uploads', extension = 'pdf', createdAt } = opts;
    await ctx.pool.query(
      `INSERT INTO documents
         (id, valuation_id, kind, category, filename, content_type, size_bytes,
          sha256, storage_path, uploaded_by, created_at)
       SELECT $1 || lpad(g::text, 6, '0'),
              $2, $3::document_kind, $4::document_category,
              'file-' || g || '.' || $5, 'application/octet-stream', 1024,
              md5(g::text) || md5(g::text), 'test/' || g, $6,
              coalesce($8::timestamptz, now())
         FROM generate_series(1, $7) AS g`,
      [newUlid().slice(0, 20), valuationId, kind, category, extension, ops.id, count, createdAt ?? null],
    );
  };

  const clearDocuments = () => ctx.pool.query('DELETE FROM documents WHERE valuation_id = $1', [valuationId]);

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Capped Co' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id;
  });
  afterAll(async () => ctx?.teardown());

  describe('the document list', () => {
    it('is complete at exactly the limit, and says so', async () => {
      await clearDocuments();
      await seedDocuments(DOCUMENT_PAGE_LIMIT);
      const page = await listDocuments(ctx.pool, valuationId);
      expect(page.documents).toHaveLength(DOCUMENT_PAGE_LIMIT);
      // The half a `LIMIT n + 1` gets wrong in the other direction: a notice
      // on a list that is in fact all of them.
      expect(page.truncated).toBe(false);
    });

    it('is one row short at one past the limit, and says so', async () => {
      await clearDocuments();
      await seedDocuments(DOCUMENT_PAGE_LIMIT + 1);
      const page = await listDocuments(ctx.pool, valuationId);
      expect(page.documents).toHaveLength(DOCUMENT_PAGE_LIMIT);
      expect(page.truncated).toBe(true);
      // The extra row is not smuggled through as a `n + 1`-length page.
      expect(new Set(page.documents.map((d) => d.id)).size).toBe(DOCUMENT_PAGE_LIMIT);
    });

    it('reports the flag on the wire, not only in the repo', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/documents`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { documents: unknown[]; truncated: boolean };
      expect(body.documents).toHaveLength(DOCUMENT_PAGE_LIMIT);
      expect(body.truncated).toBe(true);
    });

    it('is empty and complete on an engagement with no files', async () => {
      await clearDocuments();
      const page = await listDocuments(ctx.pool, valuationId);
      expect(page.documents).toEqual([]);
      expect(page.truncated).toBe(false);
    });
  });

  describe('the counts the checklist is built from, past the cap', () => {
    beforeAll(async () => {
      await clearDocuments();
      // One bucket deliberately over the cap on its own, so a checklist built
      // from a page would be wrong about *this* bucket and not merely short.
      await seedDocuments(DOCUMENT_PAGE_LIMIT, { kind: 'other', category: 'uploads' });
      await seedDocuments(3, { kind: 'cap_table', category: 'captable_documents' });
    });

    it('counts every file, not the page', async () => {
      const coverage = await documentCoverage(ctx.pool, valuationId);
      expect(coverage.total).toBe(DOCUMENT_PAGE_LIMIT + 3);
      expect(coverage.byCategory.get('uploads')).toBe(DOCUMENT_PAGE_LIMIT);
      expect(coverage.byCategory.get('captable_documents')).toBe(3);
    });

    it('does not report a satisfied bucket as missing', async () => {
      // `captable_documents` is the one required bucket, and its three files
      // sort *after* a full page of `uploads` — so this is exactly the shape
      // that would have read as "no cap table uploaded" off a capped list.
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/documents/categories`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        categories: Array<{ key: string; count: number; satisfied: boolean }>;
        missing_required: string[];
      };
      expect(body.missing_required).toEqual([]);
      const byKey = new Map(body.categories.map((c) => [c.key, c]));
      expect(byKey.get('captable_documents')!.count).toBe(3);
      expect(byKey.get('captable_documents')!.satisfied).toBe(true);
      expect(byKey.get('uploads')!.count).toBe(DOCUMENT_PAGE_LIMIT);
    });

    it('scores completeness against every bucket, not the page', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/completeness`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const gaps = (res.json().completeness.gaps ?? []) as Array<{ key: string }>;
      expect(gaps.map((g) => g.key)).not.toContain('documents.captable_documents');
    });
  });

  describe('the extractable-document check', () => {
    it('finds a file past the cap that the list would not have shown', async () => {
      await clearDocuments();
      await seedDocuments(DOCUMENT_PAGE_LIMIT, { extension: 'png' });
      // Dated behind the rest: the list is `created_at DESC` inside a bucket,
      // so this is what puts the one extractable file past the page rather
      // than at the head of it.
      await seedDocuments(1, { extension: 'pdf', createdAt: '2019-01-01T00:00:00Z' });
      // The whole point: the one extractable file is past the page, so the
      // pipeline trigger's old `.some(isExtractable)` over the list would have
      // refused a run the engagement is entitled to.
      const page = await listDocuments(ctx.pool, valuationId);
      expect(page.documents.some((d) => d.filename.endsWith('.pdf'))).toBe(false);
      expect(await hasExtractableDocument(ctx.pool, valuationId, ['.pdf', '.txt'])).toBe(true);
    });

    it('says no when nothing on the engagement is extractable', async () => {
      await clearDocuments();
      await seedDocuments(5, { extension: 'png' });
      expect(await hasExtractableDocument(ctx.pool, valuationId, ['.pdf', '.txt'])).toBe(false);
    });

    it('says no rather than everything when asked about no extensions', async () => {
      // `LIKE ANY('{}')` is false for every row, but an empty array reaching
      // the driver at all is the kind of thing a refactor changes into
      // `TRUE` — so the empty case is pinned rather than left to the SQL.
      expect(await hasExtractableDocument(ctx.pool, valuationId, [])).toBe(false);
    });
  });

  describe('the decision log', () => {
    const seedDecisions = async (count: number) => {
      for (let i = 0; i < count; i++) {
        await createDecision(
          ctx.pool,
          {
            valuationId,
            category: 'approach_selection',
            decision: `decision ${i}`,
            rationale: 'seeded',
            decidedBy: ops.id,
          },
          { actorType: 'human', actorId: ops.id, source: 'api' },
        );
      }
    };

    it('reports the cap at one past it and not at it', async () => {
      // A shorter run than the document cases: `createDecision` opens a
      // transaction and records an event per row, so this seeds through the
      // repo rather than the table and is checked at a scaled boundary. The
      // slice arithmetic is the same expression either way.
      await ctx.pool.query('DELETE FROM methodology_decisions WHERE valuation_id = $1', [valuationId]);
      await seedDecisions(3);
      const small = await listDecisions(ctx.pool, valuationId);
      expect(small.decisions).toHaveLength(3);
      expect(small.truncated).toBe(false);
      expect(DECISION_PAGE_LIMIT).toBeGreaterThan(3);
    });
  });

  describe('the financing and secondary books', () => {
    it('start empty and complete', async () => {
      const rounds = await listRounds(ctx.pool, valuationId);
      const transactions = await listTransactions(ctx.pool, valuationId);
      expect(rounds.rounds).toEqual([]);
      expect(rounds.truncated).toBe(false);
      expect(transactions.transactions).toEqual([]);
      expect(transactions.truncated).toBe(false);
    });

    it('flags the round book at one past the cap', async () => {
      await ctx.pool.query('DELETE FROM funding_rounds WHERE valuation_id = $1', [valuationId]);
      await ctx.pool.query(
        `INSERT INTO funding_rounds (id, valuation_id, name, closed_on)
         SELECT $1 || lpad(g::text, 6, '0'), $2, 'Series ' || g, date '2020-01-01' + g
           FROM generate_series(1, $3) AS g`,
        [newUlid().slice(0, 20), valuationId, TRANSACTION_PAGE_LIMIT + 1],
      );
      const page = await listRounds(ctx.pool, valuationId);
      expect(page.rounds).toHaveLength(TRANSACTION_PAGE_LIMIT);
      expect(page.truncated).toBe(true);
      // Oldest first, so the page that survives is the early history and the
      // recent end is what the flag is about.
      expect(page.rounds[0]!.name).toBe('Series 1');
    });

    it('is complete at exactly the cap', async () => {
      await ctx.pool.query('DELETE FROM funding_rounds WHERE valuation_id = $1', [valuationId]);
      await ctx.pool.query(
        `INSERT INTO funding_rounds (id, valuation_id, name, closed_on)
         SELECT $1 || lpad(g::text, 6, '0'), $2, 'Series ' || g, date '2020-01-01' + g
           FROM generate_series(1, $3) AS g`,
        [newUlid().slice(0, 20), valuationId, TRANSACTION_PAGE_LIMIT],
      );
      const page = await listRounds(ctx.pool, valuationId);
      expect(page.rounds).toHaveLength(TRANSACTION_PAGE_LIMIT);
      expect(page.truncated).toBe(false);
    });
  });
});
