import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Document search (global search, `type=documents`).
 *
 * Uploads were the one thing the search box could not reach: the only route to
 * a file was remembering which valuation it hung off. Filenames are what
 * people actually remember, so that is what this matches — but a filename
 * names a deal, so the scope rule matters as much as the matching does. These
 * tests pin both halves.
 */
describe.skipIf(!dbUp)('global search over documents', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let clientA: Awaited<ReturnType<typeof seedUser>>;
  let clientB: Awaited<ReturnType<typeof seedUser>>;
  let firmAdmin: Awaited<ReturnType<typeof seedUser>>;
  let partnerId: string;

  let valuationA: string;
  let valuationB: string;
  let capTableDocId: string;

  /** Documents are written directly — the upload route needs object storage. */
  const seedDocument = async (
    valuationId: string,
    filename: string,
    opts: { deleted?: boolean } = {},
  ): Promise<string> => {
    const id = newUlid();
    await ctx.pool.query(
      `INSERT INTO documents
         (id, valuation_id, kind, filename, content_type, size_bytes, sha256, storage_path, deleted_at)
       VALUES ($1, $2, 'other', $3, 'application/pdf', 1024, $4, $5, $6)`,
      [id, valuationId, filename, 'a'.repeat(64), `docs/${id}`, opts.deleted ? new Date() : null],
    );
    return id;
  };

  const seedValuation = async (company: string, userId: string, partner: string | null) => {
    const id = newUlid();
    await ctx.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id, partner_id, state)
       VALUES ($1, '409a', $2, $3, $4, 'review')`,
      [id, company, userId, partner],
    );
    return id;
  };

  const search = async (token: string, q: string, type = 'documents') => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/search?q=${encodeURIComponent(q)}&type=${type}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      documents: Array<{ id: string; filename: string; company_name: string; valuation_id: string }>;
      valuations: unknown[];
      users: unknown[];
    };
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    partnerId = await seedPartner(ctx, 'Docsearch Firm');
    firmAdmin = await seedUser(ctx, { roles: ['partner'], partnerId });
    clientA = await seedUser(ctx, { roles: ['valuation_user'] });
    clientB = await seedUser(ctx, { roles: ['valuation_user'] });

    valuationA = await seedValuation('Alpha Robotics', clientA.id, partnerId);
    valuationB = await seedValuation('Beta Biosciences', clientB.id, null);

    capTableDocId = await seedDocument(valuationA, 'Alpha-cap-table-2026.xlsx');
    await seedDocument(valuationA, 'board-consent-signed.pdf');
    await seedDocument(valuationB, 'Beta-cap-table-2026.xlsx');
  });

  afterAll(async () => ctx?.teardown());

  it('finds a document by a fragment of its filename', async () => {
    const body = await search(ops.token, 'cap-table');
    expect(body.documents.map((d) => d.filename).sort()).toEqual([
      'Alpha-cap-table-2026.xlsx',
      'Beta-cap-table-2026.xlsx',
    ]);
  });

  it('matches case-insensitively, the way the filename is remembered', async () => {
    const body = await search(ops.token, 'BOARD-CONSENT');
    expect(body.documents.map((d) => d.filename)).toEqual(['board-consent-signed.pdf']);
  });

  it('carries the owning valuation, so a hit is identifiable without a second call', async () => {
    const [hit] = (await search(ops.token, 'board-consent')).documents;
    expect(hit).toMatchObject({ valuation_id: valuationA, company_name: 'Alpha Robotics' });
    expect(hit!.id).toEqual(expect.any(String));
  });

  it('finds a document by its exact id', async () => {
    const body = await search(ops.token, capTableDocId);
    expect(body.documents.map((d) => d.id)).toEqual([capTableDocId]);
  });

  it('excludes soft-deleted uploads', async () => {
    const deletedId = await seedDocument(valuationA, 'withdrawn-cap-table-draft.xlsx', {
      deleted: true,
    });
    const body = await search(ops.token, 'withdrawn');
    expect(body.documents).toEqual([]);
    // And not by id either — deleted is deleted, however you ask for it.
    expect((await search(ops.token, deletedId)).documents).toEqual([]);
  });

  describe('scope is inherited from the owning valuation', () => {
    it('shows a client only their own valuations’ documents', async () => {
      const body = await search(clientA.token, 'cap-table');
      expect(body.documents.map((d) => d.filename)).toEqual(['Alpha-cap-table-2026.xlsx']);
    });

    it('does not leak another client’s filenames, which name their deal', async () => {
      const body = await search(clientB.token, 'Alpha');
      expect(body.documents).toEqual([]);
    });

    it('does not leak another client’s document by exact id', async () => {
      const body = await search(clientB.token, capTableDocId);
      expect(body.documents).toEqual([]);
    });

    it('scopes a partner to their own firm’s valuations', async () => {
      const body = await search(firmAdmin.token, 'cap-table');
      expect(body.documents.map((d) => d.filename)).toEqual(['Alpha-cap-table-2026.xlsx']);
    });
  });

  describe('type filter', () => {
    it('returns every collection when type is omitted', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/search?q=Alpha',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.documents.length).toBeGreaterThan(0);
      expect(body.valuations.length).toBeGreaterThan(0);
    });

    it('narrows to one collection so a caller does not pay for the others', async () => {
      const body = await search(ops.token, 'Alpha', 'documents');
      expect(body.documents.length).toBeGreaterThan(0);
      expect(body.valuations).toEqual([]);
      expect(body.users).toEqual([]);
    });

    it('rejects a type outside the known set', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/search?q=Alpha&type=secrets',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  it('treats LIKE wildcards in the query as characters, not pattern syntax', async () => {
    await seedDocument(valuationA, '100% ownership summary.pdf');
    // Escaped, `0%` is the literal pair — only the ownership summary has it.
    // Unescaped it would become `%0%%`, matching every filename containing a
    // "0", which is both 2026-dated cap tables as well.
    const wildcard = await search(ops.token, '0%');
    expect(wildcard.documents.map((d) => d.filename)).toEqual(['100% ownership summary.pdf']);
  });
});
