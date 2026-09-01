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
 * Legacy document triage (design §9.2, P2-16).
 *
 * The queue is only worth having if it is exactly the rows a human should
 * look at, and if working through it leaves a trail. Both are asserted here:
 * a file someone deliberately filed under "Other documents" with a stated kind
 * is not in the queue, and a re-filing writes an event on the engagement.
 */
describe.skipIf(!dbUp)('document triage queue', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const upload = async (filename: string, fields: Record<string, string> = {}) => {
    const boundary = '----n409triage';
    const parts = Object.entries(fields).map(
      ([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
    );
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: text/plain\r\n\r\ncontents of ${filename}\r\n`,
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/documents`,
      headers: {
        ...authHeader(admin.token),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.from(`${parts.join('')}--${boundary}--\r\n`),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().document as { id: string; category: string; kind: string };
  };

  interface TriageRow {
    id: string;
    filename: string;
    company_name: string;
    valuation_number: number;
    suggestion: { category: string; matched: string } | null;
  }

  const queue = async (token = admin.token) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/documents/triage',
      headers: authHeader(token),
    });
    return res;
  };

  const queueBody = async () => {
    const res = await queue();
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as {
      documents: TriageRow[];
      total: number;
      truncated: boolean;
      suggested: number;
      max_assign: number;
      categories: Array<{ key: string; label: string }>;
    };
  };

  const file = async (assignments: Array<{ document_id: string; category: string }>, token = admin.token) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/documents/triage',
      headers: authHeader(token),
      payload: { assignments },
    });

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await seedUser(ctx, { roles: ['admin'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Legacy Co' },
    });
    valuationId = created.json().valuation.id;
  });
  afterAll(async () => ctx?.teardown());

  it('queues exactly the uploads with no category and no kind', async () => {
    const unfiled = await upload('Bylaws_Amended_2023.pdf');
    expect(unfiled).toMatchObject({ category: 'uploads', kind: 'other' });

    // Filed on purpose under `uploads` with a stated kind — the uploader saw
    // the choices and chose. Not a triage row.
    await upload('deliberate.txt', { category: 'uploads', kind: 'cap_table' });
    // Filed into a named bucket. Also not a triage row.
    await upload('deck.txt', { category: 'pitch_deck' });

    const body = await queueBody();
    expect(body.documents.map((d) => d.filename)).toEqual(['Bylaws_Amended_2023.pdf']);
    expect(body.total).toBe(1);
    expect(body.truncated).toBe(false);
    expect(body.documents[0]!.company_name).toBe('Legacy Co');
  });

  it('offers the buckets to file into, and never “uploads” itself', async () => {
    const body = await queueBody();
    expect(body.categories.map((c) => c.key)).not.toContain('uploads');
    expect(body.categories.map((c) => c.key)).toContain('board_resolutions');
  });

  it('suggests a bucket with the term it matched, and pre-selects nothing', async () => {
    const body = await queueBody();
    const row = body.documents.find((d) => d.filename === 'Bylaws_Amended_2023.pdf')!;
    expect(row.suggestion).toEqual({ category: 'corporate_documents', matched: 'bylaws' });
    expect(body.suggested).toBe(1);

    // The suggestion has not moved anything: the row is still in the queue,
    // which is the whole difference between a suggestion and a sweep.
    const docs = await ctx.pool.query('SELECT category FROM documents WHERE id = $1', [row.id]);
    expect(docs.rows[0].category).toBe('uploads');
  });

  it('leaves an ambiguous filename without a suggestion', async () => {
    await upload('scan_0012.pdf');
    const body = await queueBody();
    const row = body.documents.find((d) => d.filename === 'scan_0012.pdf')!;
    expect(row.suggestion).toBeNull();
  });

  it('re-files a selected set, moving the bucket and not the extractor’s kind', async () => {
    const doc = await upload('Acme 2021 Stock Option Plan.pdf');
    const res = await file([{ document_id: doc.id, category: 'stock_option_plan' }]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ succeeded: 1, failed: 0 });

    // The kind stays `other`: the operator answered "which thing we asked for
    // is this", not "which extractor should read it".
    const { rows } = await ctx.pool.query('SELECT category, kind FROM documents WHERE id = $1', [doc.id]);
    expect(rows[0]).toEqual({ category: 'stock_option_plan', kind: 'other' });

    // And it leaves the queue.
    const body = await queueBody();
    expect(body.documents.map((d) => d.id)).not.toContain(doc.id);
  });

  it('takes the bucket’s kind where `other` does not fit it', async () => {
    // The finance buckets refuse `other`, so a re-file into one has to state a
    // kind — a (kind, category) pair that contradicts itself cannot be written.
    const doc = await upload('mystery-spreadsheet.xlsx');
    const res = await file([{ document_id: doc.id, category: 'balance_sheets' }]);
    expect(res.statusCode, res.body).toBe(200);
    const { rows } = await ctx.pool.query('SELECT category, kind FROM documents WHERE id = $1', [doc.id]);
    expect(rows[0]).toEqual({ category: 'balance_sheets', kind: 'balance_sheet' });
  });

  it('records the move on the engagement’s trail, with the bucket it came from', async () => {
    const doc = await upload('Board Consent March.pdf');
    await file([{ document_id: doc.id, category: 'board_resolutions' }]);

    const { rows } = await ctx.pool.query(
      `SELECT payload FROM valuation_events
        WHERE valuation_id = $1 AND type = 'document_refiled'
        ORDER BY occurred_at DESC LIMIT 1`,
      [valuationId],
    );
    expect(rows[0].payload).toMatchObject({
      document_id: doc.id,
      from_category: 'uploads',
      to_category: 'board_resolutions',
      from_kind: 'other',
      to_kind: 'other',
    });
  });

  it('refuses to “file” something back into uploads', async () => {
    const doc = await upload('nothing-in-particular.pdf');
    const res = await file([{ document_id: doc.id, category: 'uploads' }]);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { failed: number; results: Array<{ error?: string }> };
    expect(body.failed).toBe(1);
    expect(body.results[0]!.error).toMatch(/not a filing/i);
  });

  it('reports a row that was filed since the list loaded, and keeps the rest', async () => {
    const stale = await upload('already-done.pdf');
    const fresh = await upload('still-open.pdf');
    await file([{ document_id: stale.id, category: 'corporate_documents' }]);

    // Re-submitting the whole selection, as an operator working from a list
    // that is a page load old would.
    const res = await file([
      { document_id: stale.id, category: 'corporate_documents' },
      { document_id: fresh.id, category: 'intellectual_property' },
    ]);
    const body = res.json() as {
      succeeded: number;
      failed: number;
      results: Array<{ document_id: string; ok: boolean; error?: string }>;
    };
    expect(body).toMatchObject({ succeeded: 1, failed: 1 });
    expect(body.results.find((r) => r.document_id === stale.id)!.error).toMatch(/already filed/i);

    const { rows } = await ctx.pool.query('SELECT category FROM documents WHERE id = $1', [fresh.id]);
    expect(rows[0].category).toBe('intellectual_property');
  });

  it('reports an unknown id without failing the batch', async () => {
    const doc = await upload('good-one.pdf');
    const res = await file([
      { document_id: 'not-a-ulid', category: 'corporate_documents' },
      { document_id: doc.id, category: 'corporate_documents' },
    ]);
    expect(res.json()).toMatchObject({ succeeded: 1, failed: 1 });
  });

  /**
   * The batch is now fetched with one `= ANY($1)` rather than a lookup per
   * assignment, so an id that is well-formed but matches nothing reaches the
   * query and comes back simply absent — a different path from the malformed
   * id above, which never reaches the database at all.
   */
  it('reports a well-formed id that matches no document, and files the rest', async () => {
    const doc = await upload('real-one.pdf');
    const res = await file([
      { document_id: '01N409DOC0000000000000001A', category: 'corporate_documents' },
      { document_id: doc.id, category: 'corporate_documents' },
    ]);
    const body = res.json() as {
      succeeded: number;
      failed: number;
      results: Array<{ document_id: string; ok: boolean; error?: string }>;
    };
    expect(body).toMatchObject({ succeeded: 1, failed: 1 });
    expect(body.results.find((r) => !r.ok)!.error).toMatch(/unknown document/i);
  });

  /**
   * The batch is read once, so a document named twice in the same list is the
   * case where a snapshot could disagree with the database. The second
   * assignment must see what the first one did — otherwise it silently files
   * the document a second time, into a different bucket, and reports success
   * for both, which is exactly the double-filing the "already filed" guard
   * exists to refuse.
   */
  it('refuses the second of two assignments naming the same document', async () => {
    const doc = await upload('listed-twice.pdf');
    const res = await file([
      { document_id: doc.id, category: 'corporate_documents' },
      { document_id: doc.id, category: 'intellectual_property' },
    ]);
    const body = res.json() as {
      succeeded: number;
      failed: number;
      results: Array<{ ok: boolean; error?: string }>;
    };
    expect(body).toMatchObject({ succeeded: 1, failed: 1 });
    expect(body.results[1]!.error).toMatch(/already filed/i);

    const { rows } = await ctx.pool.query('SELECT category FROM documents WHERE id = $1', [doc.id]);
    expect(rows[0].category).toBe('corporate_documents');
  });

  /**
   * One refused write is one row, not the batch (R301, methodology M6).
   *
   * Every other refusal in this route is already reported per row — that is
   * what `results` is for. The write itself was not: a `refileDocument` that
   * threw on the second of three escaped the loop, and the operator got a 500
   * with no `results` at all. The first document was already committed by its
   * own transaction, the third never ran, and nothing in the answer
   * distinguished the two — nor did the `documents_refiled` admin event, which
   * the throw skipped entirely.
   *
   * Staged through the pooled client rather than `pool.query`, because the
   * refile is a transaction: see `interceptPoolQueries`.
   */
  it('contains a failed re-file to its own row and finishes the batch', async () => {
    const first = await upload('contained-first.pdf');
    const second = await upload('contained-second.pdf');
    const third = await upload('contained-third.pdf');

    let seen = 0;
    const restore = interceptPoolQueries(ctx.pool, (sql, phase) => {
      if (phase !== 'before' || !sql.includes('UPDATE documents SET category')) return undefined;
      seen += 1;
      if (seen === 2) throw new Error('deadlock detected on relation "documents"');
      return undefined;
    });
    let res;
    try {
      res = await file([
        { document_id: first.id, category: 'corporate_documents' },
        { document_id: second.id, category: 'corporate_documents' },
        { document_id: third.id, category: 'corporate_documents' },
      ]);
    } finally {
      restore();
    }

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      succeeded: number;
      failed: number;
      results: Array<{ document_id: string; ok: boolean; error?: string }>;
    };
    expect(body).toMatchObject({ succeeded: 2, failed: 1 });
    expect(body.results.map((r) => r.ok)).toEqual([true, false, true]);
    // Not the driver's wording: `deadlock`, the relation name and the values it
    // refused are all in the log line, and none of them in the operator's body.
    expect(body.results[1]!.error).toBe('Could not be re-filed — the reason is in the service log.');
    expect(body.results[1]!.error).not.toMatch(/deadlock|relation/i);

    // The row after the failure was filed, which is the half the throw took.
    const { rows } = await ctx.pool.query<{ id: string; category: string }>(
      'SELECT id, category FROM documents WHERE id = ANY($1::ulid[]) ORDER BY id',
      [[first.id, second.id, third.id]],
    );
    const byId = new Map(rows.map((r) => [r.id, r.category]));
    expect(byId.get(first.id)).toBe('corporate_documents');
    expect(byId.get(second.id)).toBe('uploads');
    expect(byId.get(third.id)).toBe('corporate_documents');

    // And the batch is on the admin trail with the true tally, which a throw
    // past `recordAdminEvent` left off it entirely.
    const events = await ctx.pool.query<{
      payload: { requested: number; succeeded: number; failed: number };
    }>(
      `SELECT payload FROM admin_events
        WHERE type = 'documents_refiled' ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    );
    expect(events.rows[0]!.payload).toMatchObject({ requested: 3, succeeded: 2, failed: 1 });
  });

  it('is operations-only', async () => {
    expect((await queue(client.token)).statusCode).toBe(403);
    const doc = await upload('client-cannot-file.pdf');
    const res = await file([{ document_id: doc.id, category: 'corporate_documents' }], client.token);
    expect(res.statusCode).toBe(403);
  });

  it('refuses an empty or oversized batch rather than reporting nothing done', async () => {
    expect((await file([])).statusCode).toBe(422);
    const many = Array.from({ length: 101 }, () => ({
      document_id: '01N409DOC0000000000000001A',
      category: 'corporate_documents',
    }));
    expect((await file(many)).statusCode).toBe(422);
  });

  /**
   * Deleting one document is one deletion, however many times the button is
   * pressed.
   *
   * The route reads the row through `findDocumentById`, which filters
   * tombstones — but on a different connection, one statement before the write.
   * Two DELETEs off that one read is a double-click, and both committed: a
   * second `document_deleted` on an append-only trail for a file removed once,
   * and `deleted_at` moved to the later press. That date is what the personal
   * data export gives the uploader for their own file.
   *
   * Driven concurrently rather than in sequence, because a sequential second
   * call is refused by the read and would pass against the unguarded write too.
   */
  it('records one deletion for a double-clicked delete', async () => {
    const doc = await upload('double-clicked.pdf');
    const del = () =>
      ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${valuationId}/documents/${doc.id}`,
        headers: authHeader(admin.token),
      });
    const [a, b] = await Promise.all([del(), del()]);
    expect([a.statusCode, b.statusCode]).toEqual([204, 204]);

    const { rows } = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM valuation_events
        WHERE valuation_id = $1 AND type = 'document_deleted'
          AND payload->>'document_id' = $2`,
      [valuationId, doc.id],
    );
    expect(rows[0]!.n).toBe(1);
  });
});
