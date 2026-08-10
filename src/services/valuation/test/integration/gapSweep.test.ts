import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/** Final-status §4.3 gap sweep — end-to-end behaviours. */

describe.skipIf(!dbUp)('gap sweep', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, {
      email: 'jane.requester@client.example',
      roles: ['valuation_user'],
    });
    await pool.query(`UPDATE users SET first_name = 'Jane', last_name = 'Requester' WHERE id = $1`, [
      client.id,
    ]);
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  async function createValuation(company: string, asClient = true): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(asClient ? client.token : ops.token),
      payload: { kind: '409a', company_name: company },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  }

  it('read/unread markers: comments flip unread, opening clears it, filter scopes (gap 4)', async () => {
    const id = await createValuation('Unread Co');

    // client comments → unread for ops
    const posted = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/comments`,
      headers: authHeader(client.token),
      payload: { kind: 'chat', body: 'Any update?' },
    });
    expect(posted.statusCode).toBe(201);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/valuations?q=Unread Co',
      headers: authHeader(ops.token),
    });
    const row = list.json().valuations.find((v: { id: string }) => v.id === id);
    expect(row.unread).toBe(true);

    // unread filter keeps it; after opening, both drop it
    const unreadOnly = await app.inject({
      method: 'GET',
      url: '/api/v1/valuations?unread=true',
      headers: authHeader(ops.token),
    });
    expect(unreadOnly.json().valuations.some((v: { id: string }) => v.id === id)).toBe(true);

    await app.inject({ method: 'GET', url: `/api/v1/valuations/${id}`, headers: authHeader(ops.token) });

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/valuations?q=Unread Co',
      headers: authHeader(ops.token),
    });
    expect(after.json().valuations.find((v: { id: string }) => v.id === id).unread).toBe(false);
    const unreadAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/valuations?unread=true',
      headers: authHeader(ops.token),
    });
    expect(unreadAfter.json().valuations.some((v: { id: string }) => v.id === id)).toBe(false);
  });

  /**
   * The read marker is only ever compared against `last_comment_at`, so
   * re-stamping an already-read valuation cannot change any answer — and
   * `GET /api/v1/valuations/:id` is the most-hit route in the workspace, so an
   * unconditional stamp meant every open wrote a row on the busiest table and
   * evicted the read cache entry the same request had just filled.
   *
   * What must still hold: the marker moves when there is something new to
   * acknowledge, and only then.
   */
  it('opening an already-read valuation writes nothing, and a new comment makes it write again', async () => {
    const id = await createValuation('Idempotent Read Co');
    const marker = async (): Promise<string | null> => {
      const { rows } = await pool.query<{ admin_read_at: Date | null }>(
        'SELECT admin_read_at FROM valuations WHERE id = $1',
        [id],
      );
      return rows[0]!.admin_read_at?.toISOString() ?? null;
    };
    const open = async (): Promise<void> => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
    };

    // Nothing has been said yet, so there is nothing to mark read.
    await open();
    expect(await marker()).toBeNull();

    await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/comments`,
      headers: authHeader(client.token),
      payload: { kind: 'chat', body: 'First question' },
    });
    await open();
    const first = await marker();
    expect(first).not.toBeNull();

    // Second open: already read, so the marker must not move.
    await open();
    await open();
    expect(await marker()).toBe(first);

    // A new comment is new information, so the next open does write.
    await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/comments`,
      headers: authHeader(client.token),
      payload: { kind: 'chat', body: 'Second question' },
    });
    await open();
    const second = await marker();
    expect(second).not.toBe(first);
    expect(new Date(second!).getTime()).toBeGreaterThan(new Date(first!).getTime());
  });

  it('requester search matches name and email (gap 7)', async () => {
    const id = await createValuation('Searchable Co');
    for (const q of ['jane.requester@client.example', 'Jane Requester', 'jane']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations?q=${encodeURIComponent(q)}`,
        headers: authHeader(ops.token),
      });
      expect(
        res.json().valuations.some((v: { id: string }) => v.id === id),
        q,
      ).toBe(true);
    }
    // still matches company name
    const byCompany = await app.inject({
      method: 'GET',
      url: '/api/v1/valuations?q=Searchable',
      headers: authHeader(ops.token),
    });
    expect(byCompany.json().valuations.some((v: { id: string }) => v.id === id)).toBe(true);
  });

  it('clone carries documents, funding rounds, and workbook cells (gap 5)', async () => {
    const id = await createValuation('CloneDeep Co');
    await pool.query(
      `INSERT INTO documents (id, valuation_id, kind, filename, content_type, size_bytes, sha256, storage_path, uploaded_by)
       VALUES ($1, $2, 'cap_table', 'cap.xlsx', 'application/vnd.ms-excel', 10, 'abc123', $3, $4)`,
      [newUlid(), id, `${id}/abc__cap.xlsx`, client.id],
    );
    await pool.query(
      `INSERT INTO funding_rounds (id, valuation_id, name, amount_raised_cents)
       VALUES ($1, $2, 'Series A', 500000000)`,
      [newUlid(), id],
    );
    await pool.query(
      `INSERT INTO workbook_cells (valuation_id, sheet, row_key, column_key, value)
       VALUES ($1, 'income', 'revenue', 'fy1', 4200000)`,
      [id],
    );

    const cloned = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/clone`,
      headers: authHeader(ops.token),
      payload: { roll_forward: true },
    });
    expect(cloned.statusCode).toBe(201);
    const cloneId = cloned.json().valuation.id as string;

    const [docs, rounds, cells] = await Promise.all([
      pool.query('SELECT filename, sha256, storage_path FROM documents WHERE valuation_id = $1', [cloneId]),
      pool.query('SELECT name, amount_raised_cents FROM funding_rounds WHERE valuation_id = $1', [cloneId]),
      pool.query('SELECT sheet, row_key, value FROM workbook_cells WHERE valuation_id = $1', [cloneId]),
    ]);
    expect(docs.rows).toEqual([
      { filename: 'cap.xlsx', sha256: 'abc123', storage_path: `${id}/abc__cap.xlsx` },
    ]);
    expect(rounds.rows).toEqual([{ name: 'Series A', amount_raised_cents: '500000000' }]);
    expect(cells.rows).toEqual([{ sheet: 'income', row_key: 'revenue', value: '4200000' }]);
  });

  it('new reports merge the active managed template body (gap 6)', async () => {
    // author + activate a managed 409a template
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/report-templates',
      headers: authHeader(ops.token),
      payload: {
        name: 'custom-409a',
        kind: '409a',
        body: '<h1>Executive Summary</h1><p>{{company_name}} valued in {{currency}}.</p><h1>Conclusion</h1><p>Done.</p>',
      },
    });
    expect(created.statusCode).toBe(201);
    const templateId = created.json().template.id as string;
    const activated = await app.inject({
      method: 'POST',
      url: `/api/v1/report-templates/${templateId}/activate`,
      headers: authHeader(ops.token),
    });
    expect(activated.statusCode).toBe(200);

    const id = await createValuation('Templated Co');
    const report = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/report`,
      headers: authHeader(ops.token),
    });
    expect(report.statusCode).toBe(200);
    const body = report.json();
    expect(body.report.template_version).toBe('custom-409a.v1');
    expect(body.version.content.sections.map((s: { heading: string }) => s.heading)).toEqual([
      'Executive Summary',
      'Conclusion',
    ]);
    expect(body.version.content.sections[0].html).toContain('Templated Co valued in USD.');
  });
});
