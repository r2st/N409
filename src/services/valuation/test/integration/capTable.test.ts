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

  /**
   * The stored `validation` is a cache of `validateCapTable(entries)`, and a
   * cap table is only revalidated when somebody re-imports it — which for a
   * published engagement is never. Rows written before `conversion_ratio`
   * reached the denominator therefore still hold a 1:1 fully-diluted count,
   * and the tab, the monitoring baseline and the workbook's Summary sheet all
   * read it. Writing a stale summary straight into the column is the only way
   * to reproduce a row that predates a rule change.
   */
  it('re-derives a stale stored validation from the entries beside it', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: authHeader(client.token),
      payload: {
        format: 'generic',
        csv: [
          'class,shares,price,invested,conversion_ratio',
          'Common,8000000,0.10,,',
          'Series A,2000000,1.00,2000000,2',
        ].join('\n'),
      },
    });

    const fresh = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: authHeader(ops.token),
    });
    // 8M common + 2M converting 2:1 = 12M as-converted, not the 10M raw sum.
    expect(fresh.json().cap_table.validation.summary.fully_diluted_shares).toBe(12_000_000);

    // Age the row the way the schema change did: the entries stay, the cached
    // summary goes back to counting the Series A 1:1.
    await ctx.pool.query(
      `UPDATE cap_tables
          SET validation = jsonb_set(validation, '{summary,fully_diluted_shares}', '10000000')
        WHERE valuation_id = $1`,
      [valuationId],
    );

    const reread = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: authHeader(ops.token),
    });
    expect(reread.json().cap_table.validation.summary.fully_diluted_shares).toBe(12_000_000);

    // And the entries themselves are untouched — the correction is a
    // recomputation on read, not a rewrite of what was imported.
    expect(reread.json().cap_table.entries).toHaveLength(2);
    expect(reread.json().cap_table.entries[1].conversion_ratio).toBe(2);

    // Restore the fixture the later cases in this file read.
    await app.inject({
      method: 'PUT',
      url: `/api/v1/valuations/${valuationId}/cap-table`,
      headers: authHeader(client.token),
      payload: { format: 'generic', csv: CSV },
    });
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

  /**
   * The row cap, on every path into the import.
   *
   * `rows` is capped by zod and `/upload` truncates and reports it, but the
   * pasted-CSV path — the one the textarea uses — was bounded only by its two
   * megabytes of text, some 340,000 lines of `Class,1000`. The same cap table
   * refused as `rows` was accepted as `csv`, and on PUT it was persisted whole
   * into one JSON document that every later reader of the valuation loads.
   */
  describe('the row cap', () => {
    const overCapCsv = () =>
      [
        'class,shares,price,invested',
        ...Array.from({ length: 2500 }, (_, i) => `Class ${i},1000,1.00,1000`),
      ].join('\n');

    it('refuses a pasted CSV past the cap, naming the limit', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/cap-table/preview`,
        headers: authHeader(client.token),
        payload: { format: 'generic', csv: overCapCsv() },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain('2500');
      expect(res.json().detail).toContain('2000');
    });

    it('refuses it on the save path too, so nothing over the cap is persisted', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/cap-table`,
        headers: authHeader(client.token),
        payload: { format: 'generic', csv: overCapCsv() },
      });
      expect(res.statusCode).toBe(422);
    });

    it('answers the same way whichever shape the rows arrive in', async () => {
      // The `rows` half was already capped, by zod. The point is that the two
      // now agree: one import, one verdict, whatever the client sent.
      const viaRows = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/cap-table/preview`,
        headers: authHeader(client.token),
        payload: {
          format: 'generic',
          rows: Array.from({ length: 2500 }, (_, i) => ({ class: `Class ${i}`, shares: '1000' })),
        },
      });
      expect(viaRows.statusCode).toBe(422);
    });

    it('still accepts a paste right up to the cap', async () => {
      const csv = ['class,shares', ...Array.from({ length: 2000 }, (_, i) => `Class ${i},1000`)].join('\n');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/cap-table/preview`,
        headers: authHeader(client.token),
        payload: { format: 'generic', csv },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().entries).toHaveLength(2000);
    });
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

    /**
     * Files built to break the reader, at the endpoint that receives them.
     *
     * The unit half is `test/unit/capTableAdversarialImport.test.ts`; this is
     * the half that says the refusals reach the caller as a 422 with something
     * to act on, rather than as a 500 or — worse — as a 200 reporting an empty
     * cap table for a file that was never read.
     */
    describe('adversarial uploads', () => {
      it('names a password-protected workbook instead of reading it as text', async () => {
        // Encrypted OOXML is an OLE2 compound file, so the ZIP check says no,
        // and the extension is `.xlsx`, which the legacy-format branch does not
        // list — so it fell through to being parsed as delimited text and came
        // back 200 with no rows. Same bytes as the `.xls` case above; what
        // changed is that the extension no longer decides.
        const res = await uploadFile(app, uploadUrl(), client.token, {
          filename: 'captable.xlsx',
          content: Buffer.concat([
            Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
            Buffer.alloc(600),
          ]),
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        expect(res.statusCode).toBe(422);
        expect(res.json().detail ?? res.json().title).toMatch(/password-protected or legacy/i);
      });

      it('reads a UTF-16 CSV, which is what "Save as Unicode Text" writes', async () => {
        const res = await uploadFile(app, uploadUrl(), client.token, {
          filename: 'captable.csv',
          content: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(CSV, 'utf16le')]),
          contentType: 'text/csv',
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().sheets[0].headers).toEqual(['class', 'shares', 'price', 'invested']);
        expect(res.json().sheets[0].rows).toHaveLength(3);
      });

      it('reads a Windows-1252 CSV without corrupting the security class', async () => {
        const ansi = Buffer.from([
          ...Buffer.from('class,shares\nS'),
          0xe9,
          ...Buffer.from('rie A,1000\n'),
        ]);
        const res = await uploadFile(app, uploadUrl(), client.token, {
          filename: 'captable.csv',
          content: ansi,
          contentType: 'text/csv',
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().sheets[0].rows[0].class).toBe('Série A');
      });

      it('refuses a header row wider than a worksheet rather than laying it out', async () => {
        const res = await uploadFile(app, uploadUrl(), client.token, {
          filename: 'wide.csv',
          content: ','.repeat(20_000),
          contentType: 'text/csv',
        });
        expect(res.statusCode).toBe(422);
        expect(res.json().detail ?? res.json().title).toMatch(/more than 16,384 columns/);
      });

      it('says how many rows a truncated upload really had', async () => {
        const rows = Array.from({ length: 2500 }, (_, i) => `Class ${i},1000,0.10,`).join('\n');
        const res = await uploadFile(app, uploadUrl(), client.token, {
          filename: 'big.csv',
          content: `class,shares,price,invested\n${rows}`,
          contentType: 'text/csv',
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().truncated).toBe(true);
        // The reply carries 2,000 rows and the count of what it left behind —
        // the reader stops building at the cap, so `rows.length` can no longer
        // answer that question on its own.
        expect(res.json().sheets[0].rows).toHaveLength(2000);
        expect(res.json().sheets[0].total_rows).toBe(2500);
      });

      it('refuses a shifted row by naming the cell, on the save path', async () => {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/v1/valuations/${valuationId}/cap-table`,
          headers: authHeader(client.token),
          payload: {
            format: 'generic',
            csv: 'class,shares,price\nSeries A, Inc,1000,2.50\nCommon,5000,0.10\n',
          },
        });
        expect(res.statusCode).toBe(422);
        const issue = res
          .json()
          .validation.issues.find((i: { code: string }) => i.code === 'unreadable_number');
        expect(issue.row).toBe(2);
        expect(issue.message).toContain('the share count column reads "Inc"');
      });
    });
  });

  describe('importing the same file twice', () => {
    const twiceUrl = () => `/api/v1/valuations/${valuationId}/cap-table`;

    it('replaces the table rather than appending to it, and bumps the version', async () => {
      // The import is an upsert keyed by valuation, so re-importing a corrected
      // export is the ordinary workflow and must not double every holding. The
      // version moves because the row was written — that is what an If-Match
      // from another editor is checked against.
      const first = await app.inject({
        method: 'PUT',
        url: twiceUrl(),
        headers: authHeader(client.token),
        payload: { format: 'generic', csv: CSV },
      });
      expect(first.statusCode).toBe(200);
      const firstVersion = first.json().cap_table.version;

      const second = await app.inject({
        method: 'PUT',
        url: twiceUrl(),
        headers: authHeader(client.token),
        payload: { format: 'generic', csv: CSV },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().cap_table.entries).toHaveLength(first.json().cap_table.entries.length);
      expect(second.json().cap_table.version).toBe(firstVersion + 1);

      const stored = await app.inject({
        method: 'GET',
        url: twiceUrl(),
        headers: authHeader(client.token),
      });
      expect(stored.json().cap_table.entries).toHaveLength(3);
      expect(stored.json().cap_table.validation.summary.fully_diluted_shares).toBe(11_000_000);
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
