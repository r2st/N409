import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { buildXlsx } from '../../src/export/xlsx.js';

/** Multipart POST with a binary body, for the spreadsheet upload endpoint. */
function uploadFile(
  app: FastifyInstance,
  url: string,
  token: string,
  file: { filename: string; content: Buffer | string; contentType: string },
) {
  const boundary = '----n409captable';
  const head = Buffer.from(
    `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
      `content-type: ${file.contentType}\r\n\r\n`,
    'utf8',
  );
  const body = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return app.inject({
    method: 'POST',
    url,
    headers: { ...authHeader(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([head, body, tail]),
  });
}

/** A workbook shaped like a real export: a title line above the header row. */
function capTableWorkbook(): Buffer {
  return buildXlsx([
    {
      name: 'Summary',
      columns: [{ header: 'note' }],
      rows: [['This tab is not the cap table']],
    },
    {
      name: 'Cap Table',
      titleLines: ['CapCo — capitalization as of 2024-03-01'],
      columns: [
        { header: 'class' },
        { header: 'shares', format: 'integer' },
        { header: 'price', format: 'currency' },
        { header: 'invested', format: 'currency' },
      ],
      rows: [
        ['Common Stock', 8_000_000, 0.1, null],
        ['Series A Preferred', 2_000_000, 1, 2_000_000],
        ['Option Pool', 1_000_000, null, null],
      ],
    },
  ]);
}

const dbUp = await isDbAvailable();

const CSV = [
  'class,shares,price,invested',
  'Common Stock,8000000,0.10,',
  '"Series A Preferred",2000000,1.00,2000000',
  'Option Pool,1000000,,',
].join('\n');

describe.skipIf(!dbUp)('feature 9 — cap-table integration', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let otherClient: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    app = ctx.app;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    otherClient = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'CapCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('exposes format presets', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/cap-table/formats',
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().formats.map((f: any) => f.key)).toEqual(['carta', 'pulley', 'generic']);
  });

  it('previews an import without persisting', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/cap-table/preview`,
      headers: authHeader(client.token),
      payload: { format: 'generic', csv: CSV },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toHaveLength(3);
    expect(res.json().validation.valid).toBe(true);
    expect(res.json().validation.summary.fully_diluted_shares).toBe(11_000_000);

    // Not persisted.
    const stored = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: authHeader(client.token),
    });
    expect(stored.json().cap_table).toBeNull();
  });

  it('imports and persists a valid cap table (client)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: authHeader(client.token),
      payload: { format: 'generic', csv: CSV },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cap_table.entries).toHaveLength(3);
    expect(res.json().cap_table.validation.valid).toBe(true);

    const stored = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: authHeader(ops.token),
    });
    expect(stored.json().cap_table.source_format).toBe('generic');
  });

  it('rejects an import with validation errors', async () => {
    const bad = 'class,shares\nCommon,-100\n';
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: authHeader(client.token),
      payload: { format: 'generic', csv: bad },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().validation.issues.some((i: any) => i.code === 'bad_shares')).toBe(true);
  });

  it('accepts pre-parsed rows with a custom column mapping', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/cap-table/preview`,
      headers: authHeader(client.token),
      payload: {
        format: 'generic',
        rows: [{ Name: 'Common', Qty: '5000' }],
        mapping: { security_class: 'Name', shares: 'Qty' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries[0]).toMatchObject({ security_class: 'Common', shares: 5000 });
  });

  it('projects waterfall inputs (ops only)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/cap-table/waterfall-inputs`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().inputs.common_shares).toBe(8_000_000);
    expect(res.json().inputs.option_pool_shares).toBe(1_000_000);
    expect(res.json().inputs.preferred).toHaveLength(1);

    // Clients can't reach the engine projection.
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/cap-table/waterfall-inputs`,
      headers: authHeader(client.token),
    });
    expect(denied.statusCode).toBe(403);
  });

  describe('spreadsheet upload', () => {
    const uploadUrl = () => `/api/v1/valuations/${valuationId}/cap-table/upload`;

    it('parses an uploaded .xlsx into sheets of rows', async () => {
      const res = await uploadFile(app, uploadUrl(), client.token, {
        filename: 'captable.xlsx',
        content: capTableWorkbook(),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.source).toBe('xlsx');
      expect(body.truncated).toBe(false);
      expect(body.sheets.map((s: any) => s.name)).toEqual(['Summary', 'Cap Table']);

      // The title line above the header must not be mistaken for the header.
      const capSheet = body.sheets[1];
      expect(capSheet.headers).toEqual(['class', 'shares', 'price', 'invested']);
      expect(capSheet.rows).toHaveLength(3);
      expect(capSheet.rows[0]).toMatchObject({ class: 'Common Stock', shares: '8000000' });
    });

    it('feeds uploaded rows straight into the existing import flow', async () => {
      const uploaded = await uploadFile(app, uploadUrl(), client.token, {
        filename: 'captable.xlsx',
        content: capTableWorkbook(),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const rows = uploaded.json().sheets[1].rows;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/cap-table/preview`,
        headers: authHeader(client.token),
        payload: { format: 'generic', rows },
      });
      expect(res.statusCode).toBe(200);
      // Same totals the equivalent CSV import produces earlier in this file.
      expect(res.json().validation.valid).toBe(true);
      expect(res.json().validation.summary.fully_diluted_shares).toBe(11_000_000);
      expect(res.json().entries.map((e: any) => e.class_type)).toEqual(['common', 'preferred', 'option']);
    });

    it('reports a rejected import against the row of the file it came from', async () => {
      // The end-to-end shape of the error-reporting change: a CSV with a blank
      // line and a bad cell, saved rather than previewed, so the 422 the
      // importer actually sees is the thing under test. Before this the reader
      // got a class name and was left to find it in the sheet.
      const csv = [
        'class,shares,price,invested',
        'Common Stock,8000000,0.10,',
        '',
        'Series A Preferred,2000000,1.00,(2000000)',
      ].join('\n');

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/cap-table`,
        headers: authHeader(client.token),
        payload: { format: 'generic', csv },
      });
      expect(res.statusCode).toBe(422);
      const issues = res.json().validation.issues as Array<{
        code: string;
        row?: number;
        message: string;
        security_class?: string;
      }>;
      const negative = issues.find((i) => i.code === 'negative_investment');
      // Series A is the fourth line of the file; it is the second surviving
      // entry, so an index-based number would have said 3 and sent the reader
      // to the blank line.
      expect(negative?.row).toBe(4);
      expect(negative?.message).toContain('Row 4');
      expect(negative?.security_class).toBe('Series A Preferred');
    });

    it('carries workbook row numbers through upload, echo and validation', async () => {
      // The .xlsx wizard path end to end: /upload reports the line each row
      // came from, the client sends them back with the rows, and the error
      // names the row of the workbook. Without the echo an .xlsx import gets no
      // row at all, because by then the preamble and header are gone.
      const uploaded = await uploadFile(app, uploadUrl(), client.token, {
        filename: 'captable.xlsx',
        content: capTableWorkbook(),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const sheet = uploaded.json().sheets[1];
      // The 'Cap Table' sheet carries a title line above the header, so the
      // first data row is line 3 of the worksheet, not line 1 of `rows`.
      expect(sheet.lines).toHaveLength(sheet.rows.length);
      expect(sheet.lines[0]).toBeGreaterThan(1);

      // Break one row so validation has something to point at.
      const rows = sheet.rows.map((r: Record<string, string>, i: number) =>
        i === 1 ? { ...r, shares: '0' } : r,
      );
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/cap-table/preview`,
        headers: authHeader(client.token),
        payload: { format: 'generic', rows, source_lines: sheet.lines, mapping: {} },
      });
      expect(res.statusCode).toBe(200);
      const zero = res.json().validation.issues.find((i: { code: string }) => i.code === 'zero_shares');
      expect(zero.row).toBe(sheet.lines[1]);
      expect(zero.message).toContain(`Row ${sheet.lines[1]}`);
    });

    it('drops the row numbers rather than mislabelling when they do not line up', async () => {
      // A client that builds the two arrays from different things would
      // otherwise put row 40's number on row 12's error, which is worse than
      // no number: it sends the reader to a line that is fine.
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/cap-table/preview`,
        headers: authHeader(client.token),
        payload: {
          format: 'generic',
          rows: [
            { class: 'Common Stock', shares: '8000000' },
            { class: 'Series A', shares: '0' },
          ],
          source_lines: [7],
          mapping: {},
        },
      });
      expect(res.statusCode).toBe(200);
      const zero = res.json().validation.issues.find((i: { code: string }) => i.code === 'zero_shares');
      expect(zero.row).toBeUndefined();
      expect(zero.message).not.toContain('Row');
    });

    it('accepts a CSV upload through the same endpoint', async () => {
      const res = await uploadFile(app, uploadUrl(), client.token, {
        filename: 'captable.csv',
        content: `\uFEFF${CSV}`, // a BOM, as Excel's "Save as CSV" writes
        contentType: 'text/csv',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().source).toBe('csv');
      // The BOM must not end up glued to the first header name.
      expect(res.json().sheets[0].headers).toEqual(['class', 'shares', 'price', 'invested']);
      expect(res.json().sheets[0].rows).toHaveLength(3);
    });

    it('rejects a corrupt workbook with a 422 rather than a 500', async () => {
      const res = await uploadFile(app, uploadUrl(), client.token, {
        filename: 'captable.xlsx',
        content: Buffer.from('PK\x03\x04 and then nothing valid at all'),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail ?? res.json().title).toMatch(/could not read the workbook/i);
    });

    it('rejects legacy spreadsheet formats with actionable guidance', async () => {
      const res = await uploadFile(app, uploadUrl(), client.token, {
        filename: 'captable.xls',
        content: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        contentType: 'application/vnd.ms-excel',
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail ?? res.json().title).toMatch(/re-save this file as \.xlsx or CSV/i);
    });

    it('rejects an empty file', async () => {
      const res = await uploadFile(app, uploadUrl(), client.token, {
        filename: 'empty.csv',
        content: '',
        contentType: 'text/csv',
      });
      expect(res.statusCode).toBe(422);
    });

    it('will not let an unrelated client upload', async () => {
      const res = await uploadFile(app, uploadUrl(), otherClient.token, {
        filename: 'captable.csv',
        content: CSV,
        contentType: 'text/csv',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  it('hides the cap table from an unrelated client', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: authHeader(otherClient.token),
    });
    expect(res.statusCode).toBe(404);
  });
});
