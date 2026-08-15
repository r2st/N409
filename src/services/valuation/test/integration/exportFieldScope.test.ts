import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * What the valuations export puts in the file, per reader.
 *
 * Row scope is covered elsewhere (`valuationScopeAuthorization`, `export`): the
 * export runs `valuationScope(principal)` and a client sees only their own
 * engagements. This file is about the other axis, which nothing covered — the
 * *columns*. Scope decides which rows; the projection is a fixed list, and it
 * was the same list for everybody.
 *
 * `reviewer_email` is the case that matters. The assigned reviewer is internal
 * firm information: the workspace renders it behind `{ops && …}`, only ops can
 * set it, and `editableFields` lists it under the ops arm. The export handed
 * every client and every partner member the reviewer's *email address* — a
 * column the UI will not show them — on a URL the UI never links.
 *
 * The fix is not to drop the column: ops export it deliberately, it is how a
 * firm reconciles reviewer workload outside the app. It is to project per
 * reader, so the file carries what its reader is allowed to see.
 */
describe.skipIf(!dbUp)('valuation export column scope', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let reviewer: Awaited<ReturnType<typeof seedUser>>;

  /** The export as `token` sees it, parsed into a header row and its columns. */
  const exportCsv = async (token: string): Promise<{ headers: string[]; body: string }> => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/valuations/export?format=csv',
      headers: authHeader(token),
    });
    expect(res.statusCode, res.body).toBe(200);
    const [header = ''] = res.body.split('\n');
    return { headers: header.trim().split(','), body: res.body };
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    reviewer = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Exported Co' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().valuation.id as string;

    // Assigning the reviewer is ops-only, which is the whole premise: the
    // client cannot set this field and cannot see it in the workspace.
    const assigned = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}`,
      headers: authHeader(ops.token),
      payload: { assigned_reviewer_id: reviewer.id },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
  });
  afterAll(async () => ctx?.teardown());

  it('gives ops the reviewer column they export for', async () => {
    const { headers, body } = await exportCsv(ops.token);
    expect(headers).toContain('reviewer_email');
    expect(body).toContain(reviewer.email);
  });

  /**
   * The leak. A client's own engagement, exported by the client, carried the
   * internal reviewer's address — a value the same client is refused in the
   * workspace and cannot set.
   */
  it('does not put the internal reviewer in a client’s export', async () => {
    const { headers, body } = await exportCsv(client.token);
    expect(headers).not.toContain('reviewer_email');
    expect(body).not.toContain(reviewer.email);
  });

  /**
   * The client still gets a usable file: withholding a column is not the same
   * as breaking the export, and a test that only asserted the absence would
   * pass on an endpoint that returned nothing at all.
   */
  it('still exports the client’s own engagements in full', async () => {
    const { headers, body } = await exportCsv(client.token);
    expect(headers).toContain('number');
    expect(headers).toContain('company_name');
    expect(headers).toContain('state');
    expect(body).toContain('Exported Co');
  });

  /**
   * The same column set, whichever format asked for it. The projection is
   * chosen once and all three renderers read it — otherwise the CSV is fixed
   * and the XLSX still leaks.
   */
  it('withholds the reviewer from the client’s XLSX too', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/valuations/export?format=xlsx',
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(200);
    // The sheet is a ZIP of XML; the shared-string table holds every cell
    // value, so a raw scan of the archive is enough to prove the address is
    // not in the file, without inflating it.
    expect(res.rawPayload.includes(Buffer.from(reviewer.email))).toBe(false);
  });
});
