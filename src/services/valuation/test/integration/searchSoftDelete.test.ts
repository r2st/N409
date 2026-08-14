import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * A soft delete has to land on every read, and search is the read that is
 * easiest to forget.
 *
 * Retiring an engagement stamps `archived_at` (repos/valuationPurge.ts), and
 * `buildValuationWhere` filters it out of the list, the counts, the bucket
 * strip and the export. Search builds its own WHERE — that is deliberate, it
 * matches on different columns — and so inherited none of it. Deactivating a
 * user stamps `users.deleted_at`, which the admin directory, the firm roster
 * and the reviewer picker all filter; the user half of the same search box did
 * not.
 *
 * The result in both cases is the same shape of bug: a row removed from every
 * surface that lists it, still reachable from the one surface people type into.
 * That is worse than never having soft-deleted it, because the delete reports
 * success.
 *
 * Each case is asserted from both ends — the retired row is gone *and* the live
 * one beside it is still found. A filter that is too broad passes a
 * "cannot find the deleted thing" test perfectly while breaking search.
 */
describe.skipIf(!dbUp)('search does not return soft-deleted rows', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  /** Company names are distinctive so a hit can only have come from this test. */
  const RETIRED = 'Quillfeather Retired Holdings';
  const LIVE = 'Quillfeather Live Holdings';

  let retiredId: string;
  let liveId: string;

  const search = async (q: string, token: string, type?: string) => {
    const url = `/api/v1/search?q=${encodeURIComponent(q)}${type ? `&type=${type}` : ''}`;
    const res = await ctx.app.inject({ method: 'GET', url, headers: authHeader(token) });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      valuations: Array<{ id: string; company_name: string }>;
      documents: Array<{ id: string; valuation_id: string }>;
      users: Array<{ id: string; email: string }>;
    };
  };

  const createValuation = async (companyName: string, token: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  const addDocument = async (valuationId: string, filename: string): Promise<string> => {
    const id = newUlid();
    await ctx.pool.query(
      `INSERT INTO documents (id, valuation_id, kind, filename, content_type, size_bytes, sha256, storage_path)
       VALUES ($1, $2, 'other', $3, 'application/pdf', 100, 'deadbeef', $4)`,
      [id, valuationId, filename, `docs/${id}.bin`],
    );
    return id;
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });

    // Owned by the client, so the same rows exercise both the 'all' scope (ops)
    // and the 'own' scope — the archived filter has to hold under each.
    retiredId = await createValuation(RETIRED, client.token);
    liveId = await createValuation(LIVE, client.token);
  });

  afterAll(async () => ctx?.teardown());

  describe('an archived valuation', () => {
    let retiredDocId: string;
    let liveDocId: string;

    beforeAll(async () => {
      retiredDocId = await addDocument(retiredId, 'quillfeather-retired-captable.pdf');
      liveDocId = await addDocument(liveId, 'quillfeather-live-captable.pdf');
      // What `retireValuations` does, minus the rename — the rename would make
      // the company-name assertions pass for the wrong reason.
      await ctx.pool.query('UPDATE valuations SET archived_at = now() WHERE id = $1', [retiredId]);
    });

    it('is gone from search for ops, who can otherwise read everything', async () => {
      const hits = await search('Quillfeather', ops.token, 'valuations');
      expect(hits.valuations.map((v) => v.company_name)).toEqual([LIVE]);
    });

    it('is gone from search for the client who owns it', async () => {
      const hits = await search('Quillfeather', client.token, 'valuations');
      expect(hits.valuations.map((v) => v.company_name)).toEqual([LIVE]);
    });

    it('is not retrievable by pasting its id either', async () => {
      // The id branch is OR'd into the match group. If the archived filter had
      // been written into that group rather than beside it, an exact id would
      // walk straight past it.
      const hits = await search(retiredId, ops.token, 'valuations');
      expect(hits.valuations).toEqual([]);

      const live = await search(liveId, ops.token, 'valuations');
      expect(live.valuations.map((v) => v.id)).toEqual([liveId]);
    });

    it('takes its uploads out of document search with it', async () => {
      // The document is not itself deleted. It comes back with the engagement's
      // company name and number in its own payload, so a hit republishes
      // exactly what retiring the engagement was meant to withdraw.
      const hits = await search('quillfeather', ops.token, 'documents');
      expect(hits.documents.map((d) => d.id)).toEqual([liveDocId]);
      expect(hits.documents.map((d) => d.valuation_id)).not.toContain(retiredId);
      expect(retiredDocId).toBeTruthy();
    });

    it('still hides an upload whose own valuation is live but deleted', async () => {
      // The pre-existing `d.deleted_at` filter has to survive the new clause.
      const deletedDoc = await addDocument(liveId, 'quillfeather-live-superseded.pdf');
      await ctx.pool.query('UPDATE documents SET deleted_at = now() WHERE id = $1', [deletedDoc]);
      const hits = await search('quillfeather-live', ops.token, 'documents');
      expect(hits.documents.map((d) => d.id)).toEqual([liveDocId]);
    });
  });

  describe('a deactivated user', () => {
    let departed: Awaited<ReturnType<typeof seedUser>>;
    let present: Awaited<ReturnType<typeof seedUser>>;

    beforeAll(async () => {
      departed = await seedUser(ctx, { roles: ['analyst'], email: 'thackeray.departed@test.example.com' });
      present = await seedUser(ctx, { roles: ['analyst'], email: 'thackeray.present@test.example.com' });
      await ctx.pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [departed.id]);
    });

    it('is gone from the people half of the search box', async () => {
      const hits = await search('thackeray', ops.token, 'users');
      expect(hits.users.map((u) => u.email)).toEqual([present.email]);
    });

    it('is not retrievable by pasting their id either', async () => {
      // `WHERE <name match> OR id = $3` put the id branch outside the deleted
      // filter. One misplaced parenthesis makes every deactivated account
      // retrievable by id, which is the same leak in a quieter form.
      const hits = await search(departed.id, ops.token, 'users');
      expect(hits.users).toEqual([]);

      const stillHere = await search(present.id, ops.token, 'users');
      expect(stillHere.users.map((u) => u.id)).toEqual([present.id]);
    });

    it('was never visible to a client anyway', async () => {
      // People search is ops-only; asserted here so the filter above is not the
      // only thing standing between a client and the user directory.
      const hits = await search('thackeray', client.token, 'users');
      expect(hits.users).toEqual([]);
    });
  });
});
