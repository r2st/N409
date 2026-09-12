import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The review mark as a transition (R448, methodology M3).
 *
 * `POST /documents/:documentId/review` is a two-state toggle — pending ⇄
 * reviewed — with an actor and a timestamp on the row and, until now, nothing
 * on the spine. 0121 kept `reviewed_by` on the row "even though
 * `valuation_events` also records the actor", and no event was ever written.
 * Two consequences, one per direction:
 *
 *   * `reviewed: true` over a file already reviewed re-stamped `reviewed_at`
 *     and `reviewed_by` with the second press. The console's control is a
 *     toggle computed from each analyst's own copy of the list, so two people
 *     working the same queue was all it took to re-attribute a clear.
 *   * `reviewed: false` erased both columns, and they were the only copy.
 *
 * Now the state is read under the lock the write takes, an unchanged state is
 * answered with the standing row and no event, and a real move writes
 * `document_reviewed` or `document_review_cleared` — the clear carrying the
 * mark it removed as the `from` half of its change list.
 */
describe.skipIf(!dbUp)('the document review mark on the spine', () => {
  let ctx: TestApp;
  let first: Awaited<ReturnType<typeof seedUser>>;
  let second: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    first = await seedUser(ctx, { roles: ['admin'] });
    second = await seedUser(ctx, { roles: ['reviewer'] });
    const owner = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Reviewed Files Co' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  const upload = async (filename: string): Promise<string> => {
    const boundary = '----n409reviewtrail';
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: text/plain\r\n\r\ncontents\r\n--${boundary}--\r\n`;
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/documents`,
      headers: { ...authHeader(first.token), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(body),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().document.id as string;
  };

  const review = async (documentId: string, reviewed: boolean, token: string) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/documents/${documentId}/review`,
      headers: authHeader(token),
      payload: { reviewed },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().document as { reviewed_at: string | null; reviewed_by: string | null };
  };

  const events = async (documentId: string) => {
    const { rows } = await ctx.pool.query<{
      type: string;
      actor_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT type, actor_id, payload FROM valuation_events
        WHERE valuation_id = $1 AND type IN ('document_reviewed', 'document_review_cleared')
          AND payload->>'document_id' = $2
        ORDER BY seq`,
      [valuationId, documentId],
    );
    return rows;
  };

  it('records who cleared the file, once, however many times it is pressed', async () => {
    const docId = await upload('cap-table.txt');

    const marked = await review(docId, true, first.token);
    expect(marked.reviewed_by).toBe(first.id);
    expect(marked.reviewed_at).not.toBeNull();

    // A second analyst, holding a list that still shows the file pending,
    // presses the same control. The mark stays the first analyst's.
    const again = await review(docId, true, second.token);
    expect(again.reviewed_by).toBe(first.id);
    expect(again.reviewed_at).toBe(marked.reviewed_at);

    const trail = await events(docId);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      type: 'document_reviewed',
      actor_id: first.id,
      payload: {
        document_id: docId,
        filename: 'cap-table.txt',
        changes: {
          reviewed_by: { from: null, to: first.id },
          reviewed_at: { from: null, to: marked.reviewed_at },
        },
      },
    });
  });

  it('keeps the mark it is clearing on the spine, and clears it once', async () => {
    const docId = await upload('reopen-me.txt');
    const marked = await review(docId, true, first.token);

    const reopened = await review(docId, false, second.token);
    expect(reopened.reviewed_at).toBeNull();
    expect(reopened.reviewed_by).toBeNull();

    // The row can no longer answer; the event must.
    const trail = await events(docId);
    expect(trail.map((e) => e.type)).toEqual(['document_reviewed', 'document_review_cleared']);
    expect(trail[1]).toMatchObject({
      actor_id: second.id,
      payload: {
        document_id: docId,
        filename: 'reopen-me.txt',
        changes: {
          reviewed_by: { from: first.id, to: null },
          reviewed_at: { from: marked.reviewed_at, to: null },
        },
      },
    });

    // Reopening a file that is already open is not a second reopening.
    await review(docId, false, first.token);
    expect(await events(docId)).toHaveLength(2);
  });

  it('writes nothing for a file that was never marked', async () => {
    const docId = await upload('untouched.txt');
    const row = await review(docId, false, first.token);
    expect(row.reviewed_at).toBeNull();
    expect(await events(docId)).toEqual([]);
  });

  it('is internal to the trail, like the working state it records', async () => {
    const docId = await upload('internal.txt');
    await review(docId, true, first.token);
    const { rows } = await ctx.pool.query<{ visibility: string }>(
      `SELECT 1 FROM valuation_events WHERE valuation_id = $1 AND type = 'document_reviewed' LIMIT 1`,
      [valuationId],
    );
    expect(rows).toHaveLength(1);
    // The catalog is the type: an internal descriptor is what keeps the client's
    // events feed from listing an analyst's own queue-keeping.
    const { EVENT_CATALOG } = await import('../../src/domain/auditTrail.js');
    expect(EVENT_CATALOG.document_reviewed.visibility).toBe('internal');
    expect(EVENT_CATALOG.document_review_cleared.visibility).toBe('internal');
  });
});
