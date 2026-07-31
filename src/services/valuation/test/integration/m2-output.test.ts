import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('M2 — output & delivery (overwrites, workbook, reports)', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let partnerUser: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string; // owned by `client`, 409a

  beforeAll(async () => {
    ctx = await setupTestApp();
    const partnerId = await seedPartner(ctx, 'Vestd');
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    partnerUser = await seedUser(ctx, { roles: ['partner'], partnerId });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Acme Robotics, Inc.' },
    });
    expect(res.statusCode).toBe(201);
    valuationId = res.json().valuation.id;
  });
  afterAll(async () => ctx?.teardown());

  const opsGet = (url: string) => ctx.app.inject({ method: 'GET', url, headers: authHeader(ops.token) });

  describe('overwrites', () => {
    it('serves the 68-field schema to ops and denies clients', async () => {
      const res = await opsGet('/api/v1/overwrites/schema');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(68);
      expect(body.fields).toHaveLength(68);
      expect(body.categories).toHaveLength(6);

      const denied = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/overwrites/schema',
        headers: authHeader(client.token),
      });
      expect(denied.statusCode).toBe(403);
    });

    it('applies an override, preserving the original value and reason', async () => {
      const res = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/overwrites/dlom`,
        headers: authHeader(ops.token),
        payload: { value: 0.31, reason: 'Finnerty output too low for stage', original_value: 0.24 },
      });
      expect(res.statusCode).toBe(200);
      const { overwrite } = res.json();
      expect(overwrite.value).toBe(0.31);
      expect(overwrite.original_value).toBe(0.24);
      expect(overwrite.category).toBe('valuation_params');
      expect(overwrite.class).toBe('numeric');
      expect(overwrite.created_by).toBe(ops.id);
    });

    it('keeps the first original_value across updates', async () => {
      const res = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/overwrites/dlom`,
        headers: authHeader(ops.token),
        payload: { value: 0.28, original_value: 0.99 },
      });
      expect(res.statusCode).toBe(200);
      const { overwrite } = res.json();
      expect(overwrite.value).toBe(0.28);
      expect(overwrite.original_value).toBe(0.24); // frozen from first write
    });

    it('validates by class and range', async () => {
      const outOfRange = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/overwrites/dlom`,
        headers: authHeader(ops.token),
        payload: { value: 1.5 },
      });
      expect(outOfRange.statusCode).toBe(422);

      const badDate = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/overwrites/valuation_date`,
        headers: authHeader(ops.token),
        payload: { value: 'not-a-date' },
      });
      expect(badDate.statusCode).toBe(422);

      const unknownField = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/overwrites/not_a_field`,
        headers: authHeader(ops.token),
        payload: { value: 1 },
      });
      expect(unknownField.statusCode).toBe(404);
    });

    it('lists overrides and records audit events', async () => {
      await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/overwrites/valuation_date`,
        headers: authHeader(ops.token),
        payload: { value: '2026-06-30' },
      });
      const list = await opsGet(`/api/v1/valuations/${valuationId}/overwrites`);
      expect(list.statusCode).toBe(200);
      expect(list.json().count).toBe(2);

      const events = await opsGet(`/api/v1/valuations/${valuationId}/events`);
      const types = (events.json().events as Array<{ type: string }>).map((e) => e.type);
      expect(types.filter((t) => t === 'overwrite_applied').length).toBeGreaterThanOrEqual(3);
    });

    it('reverts an override (DELETE) and records the event', async () => {
      const del = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${valuationId}/overwrites/valuation_date`,
        headers: authHeader(ops.token),
      });
      expect(del.statusCode).toBe(204);

      const again = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${valuationId}/overwrites/valuation_date`,
        headers: authHeader(ops.token),
      });
      expect(again.statusCode).toBe(404);

      const events = await opsGet(`/api/v1/valuations/${valuationId}/events`);
      const types = (events.json().events as Array<{ type: string }>).map((e) => e.type);
      expect(types).toContain('overwrite_reverted');
    });

    it('denies clients and partners access to overwrites', async () => {
      for (const token of [client.token, partnerUser.token]) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/valuations/${valuationId}/overwrites`,
          headers: authHeader(token),
        });
        expect(res.statusCode).toBe(403);
      }
    });
  });

  describe('workbook', () => {
    it('returns the empty template grid', async () => {
      const res = await opsGet(`/api/v1/valuations/${valuationId}/workbook`);
      expect(res.statusCode).toBe(200);
      const { sheets } = res.json();
      expect(sheets.map((s: { key: string }) => s.key)).toEqual([
        'income_statement',
        'balance_sheet',
        'assumptions',
      ]);
    });

    it('saves input cells and returns recomputed derived rows', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/workbook`,
        headers: authHeader(ops.token),
        payload: {
          cells: [
            { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_current', value: 5_100_000 },
            { sheet: 'income_statement', row_key: 'cogs', column_key: 'fy_current', value: 1_700_000 },
            { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_minus_1', value: 4_200_000 },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const sheet = res.json().sheets.find((s: { key: string }) => s.key === 'income_statement');
      const row = (key: string) => sheet.rows.find((r: { key: string }) => r.key === key);
      const cell = (key: string, col: string) =>
        row(key).cells.find((c: { column_key: string }) => c.column_key === col).value;
      expect(cell('gross_profit', 'fy_current')).toBe(3_400_000);
      expect(cell('gross_margin', 'fy_current')).toBeCloseTo(3_400_000 / 5_100_000);
      expect(cell('revenue_growth', 'fy_current')).toBeCloseTo(900_000 / 4_200_000);
    });

    it('clears a cell with null', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/workbook`,
        headers: authHeader(ops.token),
        payload: {
          cells: [{ sheet: 'income_statement', row_key: 'cogs', column_key: 'fy_current', value: null }],
        },
      });
      expect(res.statusCode).toBe(200);
      const sheet = res.json().sheets.find((s: { key: string }) => s.key === 'income_statement');
      const gross = sheet.rows
        .find((r: { key: string }) => r.key === 'gross_profit')
        .cells.find((c: { column_key: string }) => c.column_key === 'fy_current');
      expect(gross.value).toBeNull(); // cogs missing again
    });

    it('rejects writes to derived rows and unknown refs', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/workbook`,
        headers: authHeader(ops.token),
        payload: {
          cells: [{ sheet: 'income_statement', row_key: 'ebitda', column_key: 'fy_current', value: 1 }],
        },
      });
      expect(res.statusCode).toBe(422);
    });

    it('applies a large batch of writes and clears in one request', async () => {
      // Exercises the batched (unnest-based) INSERT/DELETE path in
      // patchWorkbookCells, not just a handful of cells at a time.
      const writeCells = ['fy_minus_2', 'fy_minus_1', 'fy_current'].map((col) => ({
        sheet: 'income_statement',
        row_key: 'operating_expenses',
        column_key: col,
        value: 111,
      }));
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/workbook`,
        headers: authHeader(ops.token),
        payload: { cells: writeCells },
      });
      expect(res.statusCode).toBe(200);
      const rows = await ctx.pool.query(
        `SELECT column_key, value FROM workbook_cells
         WHERE valuation_id = $1 AND sheet = 'income_statement' AND row_key = 'operating_expenses'
         ORDER BY column_key`,
        [valuationId],
      );
      expect(rows.rows.map((r: { value: string }) => Number(r.value))).toEqual([111, 111, 111]);

      const cleared = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/workbook`,
        headers: authHeader(ops.token),
        payload: { cells: writeCells.map((c) => ({ ...c, value: null })) },
      });
      expect(cleared.statusCode).toBe(200);
      const afterClear = await ctx.pool.query(
        `SELECT count(*)::int AS n FROM workbook_cells
         WHERE valuation_id = $1 AND sheet = 'income_statement' AND row_key = 'operating_expenses'`,
        [valuationId],
      );
      expect(afterClear.rows[0].n).toBe(0);
    });

    it('last write wins when the same cell ref repeats within one request', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/workbook`,
        headers: authHeader(ops.token),
        payload: {
          cells: [
            { sheet: 'income_statement', row_key: 'taxes', column_key: 'fy_current', value: 10 },
            { sheet: 'income_statement', row_key: 'taxes', column_key: 'fy_current', value: 20 },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const row = await ctx.pool.query(
        `SELECT value FROM workbook_cells
         WHERE valuation_id = $1 AND sheet = 'income_statement' AND row_key = 'taxes' AND column_key = 'fy_current'`,
        [valuationId],
      );
      expect(Number(row.rows[0].value)).toBe(20);

      const clearAfterWrite = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/workbook`,
        headers: authHeader(ops.token),
        payload: {
          cells: [
            { sheet: 'income_statement', row_key: 'taxes', column_key: 'fy_current', value: 30 },
            { sheet: 'income_statement', row_key: 'taxes', column_key: 'fy_current', value: null },
          ],
        },
      });
      expect(clearAfterWrite.statusCode).toBe(200);
      const afterClear = await ctx.pool.query(
        `SELECT count(*)::int AS n FROM workbook_cells
         WHERE valuation_id = $1 AND sheet = 'income_statement' AND row_key = 'taxes' AND column_key = 'fy_current'`,
        [valuationId],
      );
      expect(afterClear.rows[0].n).toBe(0);
    });

    it('records a workbook_updated audit event', async () => {
      const events = await opsGet(`/api/v1/valuations/${valuationId}/events`);
      const types = (events.json().events as Array<{ type: string }>).map((e) => e.type);
      expect(types).toContain('workbook_updated');
    });

    it('denies non-ops access', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/workbook`,
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('reports', () => {
    it('creates the report from the current 409a template on first ops access', async () => {
      const res = await opsGet(`/api/v1/valuations/${valuationId}/report`);
      expect(res.statusCode).toBe(200);
      const { report, version } = res.json();
      expect(report.template_version).toBe('409a.v54');
      expect(report.status).toBe('draft');
      expect(report.current_version).toBe(1);
      expect(version.version).toBe(1);
      expect(version.content.title).toContain('Acme Robotics, Inc.');
      expect(version.content.sections.length).toBeGreaterThanOrEqual(8);
    });

    it('saving sanitized content creates version 2', async () => {
      const current = (await opsGet(`/api/v1/valuations/${valuationId}/report`)).json();
      const content = current.version.content;
      content.sections[0].html = '<p>Edited <strong>intro</strong>.</p><script>alert(1)</script>';
      const res = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/report`,
        headers: authHeader(ops.token),
        payload: { content },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.report.current_version).toBe(2);
      expect(body.version.content.sections[0].html).toBe('<p>Edited <strong>intro</strong>.</p>');
    });

    it('lists version history newest-first', async () => {
      const res = await opsGet(`/api/v1/valuations/${valuationId}/report/versions`);
      expect(res.statusCode).toBe(200);
      const versions = res.json().versions;
      expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    });

    it('reverting to v1 creates v3 with v1 content', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/report/revert`,
        headers: authHeader(ops.token),
        payload: { version: 1 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.report.current_version).toBe(3);
      expect(body.version.content.sections[0].html).not.toContain('Edited');

      const conflict = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/report/revert`,
        headers: authHeader(ops.token),
        payload: { version: 3 },
      });
      expect(conflict.statusCode).toBe(409);
    });

    it('renders the current version to PDF and serves report.pdf', async () => {
      const render = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/report/render`,
        headers: authHeader(ops.token),
      });
      expect(render.statusCode).toBe(200);
      expect(render.json().version).toBe(3);
      expect(render.json().size_bytes).toBeGreaterThan(1000);

      const pdf = await opsGet(`/api/v1/valuations/${valuationId}/report.pdf`);
      expect(pdf.statusCode).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

      const events = await opsGet(`/api/v1/valuations/${valuationId}/events`);
      const types = (events.json().events as Array<{ type: string }>).map((e) => e.type);
      expect(types).toContain('report_saved');
      expect(types).toContain('report_reverted');
      expect(types).toContain('report_rendered');
    });

    it('hides the report from the owner until drafted, then shares read-only', async () => {
      const before = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/report`,
        headers: authHeader(client.token),
      });
      expect(before.statusCode).toBe(404);
      const pdfBefore = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/report.pdf`,
        headers: authHeader(client.token),
      });
      expect(pdfBefore.statusCode).toBe(404);

      // ops moves the valuation to drafted
      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}`,
        headers: authHeader(ops.token),
        payload: { state: 'drafted' },
      });
      expect(patch.statusCode).toBe(200);

      const after = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/report`,
        headers: authHeader(client.token),
      });
      expect(after.statusCode).toBe(200);
      expect(after.json().version.content.title).toContain('Acme');

      const pdfAfter = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/report.pdf`,
        headers: authHeader(client.token),
      });
      expect(pdfAfter.statusCode).toBe(200);

      // …but editing stays ops-only
      const putDenied = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/report`,
        headers: authHeader(client.token),
        payload: { content: { title: 'X', sections: [{ key: 'a', heading: 'A', html: '<p>x</p>' }] } },
      });
      expect(putDenied.statusCode).toBe(403);
    });

    it('keeps other clients locked out entirely (404, not 403)', async () => {
      const stranger = await seedUser(ctx, { roles: ['valuation_user'] });
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/report.pdf`,
        headers: authHeader(stranger.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
