import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createGrant } from '../../src/repos/grants.js';

const dbUp = await isDbAvailable();

/**
 * XLSX export (feature-improvements §4). The assertions read the archive back
 * with `unzip` rather than checking the byte length: the failure that matters is
 * "Excel refuses to open it", and only unpacking the parts catches that.
 */
describe.skipIf(!dbUp)('XLSX export', () => {
  let ctx: TestApp;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let otherClient: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  const dir = mkdtempSync(path.join(tmpdir(), 'n409-xlsx-it-'));
  let seq = 0;

  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  function unpack(payload: Buffer, entry: string): string {
    const file = path.join(dir, `x-${seq++}.xlsx`);
    writeFileSync(file, payload);
    // unzip globs its arguments, so [Content_Types].xml needs escaping.
    return execFileSync('unzip', ['-p', file, entry.replace(/([[\]*?])/g, '\\$1')], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  function entries(payload: Buffer): string[] {
    const file = path.join(dir, `x-${seq++}.xlsx`);
    writeFileSync(file, payload);
    return execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n');
  }

  const createValuation = async (companyName: string, token = client.token): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    otherClient = await seedUser(ctx, { roles: ['valuation_user'] });
    ops = await seedUser(ctx, { roles: ['admin'] });
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await ctx?.teardown();
  });

  describe('list export', () => {
    let valuationId: string;

    beforeAll(async () => {
      valuationId = await createValuation('Spreadsheet Ventures');
    });

    it('serves a well-formed workbook with the xlsx content type', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations/export?format=xlsx',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain(XLSX_TYPE);
      expect(res.headers['content-disposition']).toContain('.xlsx');
      // A ZIP local file header — the first thing a reader checks.
      expect(res.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
      expect(entries(res.rawPayload)).toEqual(
        expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']),
      );
    });

    it('names the sheet and writes the header row', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations/export?format=xlsx',
        headers: authHeader(ops.token),
      });
      expect(unpack(res.rawPayload, 'xl/workbook.xml')).toContain('name="Valuations"');
      const sheet = unpack(res.rawPayload, 'xl/worksheets/sheet1.xml');
      expect(sheet).toContain('>Company<');
      expect(sheet).toContain('>Spreadsheet Ventures<');
    });

    it('writes dates as numeric serials rather than strings', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations/export?format=xlsx',
        headers: authHeader(ops.token),
      });
      const sheet = unpack(res.rawPayload, 'xl/worksheets/sheet1.xml');
      // Created is column M with the date style; a string date would carry
      // t="inlineStr" and sort lexically in the delivered sheet.
      expect(sheet).toMatch(/<c r="M2" s="8"><v>\d+(\.\d+)?<\/v><\/c>/);
    });

    it('scopes rows to the caller, like the CSV and PDF exports', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations/export?format=xlsx',
        headers: authHeader(otherClient.token),
      });
      expect(res.statusCode).toBe(200);
      expect(unpack(res.rawPayload, 'xl/worksheets/sheet1.xml')).not.toContain('Spreadsheet Ventures');
    });

    it('honours the id filter so a bulk selection exports exactly those rows', async () => {
      const otherId = await createValuation('Unselected Co');
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/export?format=xlsx&ids=${valuationId}`,
        headers: authHeader(ops.token),
      });
      const sheet = unpack(res.rawPayload, 'xl/worksheets/sheet1.xml');
      expect(sheet).toContain('Spreadsheet Ventures');
      expect(sheet).not.toContain('Unselected Co');
      expect(otherId).toBeTruthy();
    });

    it('still rejects an invalid format', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations/export?format=numbers',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('per-valuation workbook', () => {
    let valuationId: string;

    beforeAll(async () => {
      valuationId = await createValuation('Workbook Co');

      const cells = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/workbook`,
        headers: authHeader(ops.token),
        payload: {
          cells: [
            { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_current', value: 6_000_000 },
            { sheet: 'income_statement', row_key: 'cogs', column_key: 'fy_current', value: 2_000_000 },
          ],
        },
      });
      expect(cells.statusCode).toBe(200);

      // The import takes source-column rows plus a format preset; 'generic' maps
      // class/type/shares/price/invested onto the canonical fields.
      const capTable = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/cap-table`,
        headers: authHeader(ops.token),
        payload: {
          format: 'generic',
          rows: [
            { class: 'Common', type: 'common', shares: '8000000' },
            {
              class: 'Series A Preferred',
              type: 'preferred',
              shares: '2000000',
              price: '1.50',
              invested: '3000000',
              liquidation_multiple: '1',
              seniority: '1',
              conversion_ratio: '1',
            },
            { class: 'Option pool', type: 'option', shares: '1000000' },
          ],
        },
      });
      expect(capTable.statusCode).toBe(200);

      // Issuing a grant through the API needs an approved board resolution, which
      // is a whole other workflow; this test is about the export, so the row goes
      // in through the repo.
      await createGrant(
        ctx.pool,
        {
          valuationId,
          granteeName: 'Dana Lin',
          granteeEmail: 'dana@acme.test',
          grantDate: '2024-06-01',
          optionsCount: 120_000,
          exercisePrice: 0.85,
          currency: 'USD',
          vestingTemplate: 'standard_4yr_1yr_cliff',
          vestingStartDate: '2024-06-01',
          vestingMonths: 48,
          cliffMonths: 12,
          frequencyMonths: 1,
          createdBy: ops.id,
        },
        { actorType: 'human', actorId: ops.id },
      );
    });

    it('serves every sheet the valuation has data for', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/workbook.xlsx`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain(XLSX_TYPE);
      expect(res.headers['content-disposition']).toContain('workbook-');

      const workbook = unpack(res.rawPayload, 'xl/workbook.xml');
      for (const name of ['Summary', 'Income statement', 'Cap table', 'Waterfall', 'Grants']) {
        expect(workbook).toContain(`name="${name}"`);
      }
      // Seven sheets means seven worksheet parts, not one reused seven times.
      expect(entries(res.rawPayload)).toContain('xl/worksheets/sheet7.xml');
    });

    it('delivers derived rows as live formulas, not frozen numbers', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/workbook.xlsx`,
        headers: authHeader(ops.token),
      });
      // sheet2 is the income statement (sheet1 is the summary).
      const sheet = unpack(res.rawPayload, 'xl/worksheets/sheet2.xml');
      // Gross profit for FY (current): revenue on row 4, COGS on row 5.
      expect(sheet).toContain('<f>IF(COUNT(D4,D5)&lt;2,&quot;&quot;,D4-D5)</f>');
      // …with the computed value cached alongside it.
      expect(sheet).toContain('<f>IF(COUNT(D4,D5)&lt;2,&quot;&quot;,D4-D5)</f><v>4000000</v>');
    });

    it('is readable by the owning client, not just ops', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/workbook.xlsx`,
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(200);
    });

    it('hides another client’s valuation behind a 404', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/workbook.xlsx`,
        headers: authHeader(otherClient.token),
      });
      expect(res.statusCode).toBe(404);
    });

    it('requires authentication', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/workbook.xlsx`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('404s an unknown or malformed id without leaking the difference', async () => {
      for (const id of ['not-a-ulid', '01JQTESTTESTTESTTESTTESTXX']) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/valuations/${id}/workbook.xlsx`,
          headers: authHeader(ops.token),
        });
        expect(res.statusCode).toBe(404);
      }
    });

    it('exports a bare valuation as the model sheets alone', async () => {
      const bare = await createValuation('Bare Co');
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${bare}/workbook.xlsx`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const workbook = unpack(res.rawPayload, 'xl/workbook.xml');
      expect(workbook).toContain('name="Summary"');
      expect(workbook).toContain('name="Assumptions"');
      // Nothing to show means no sheet, rather than an empty tab that reads as a bug.
      expect(workbook).not.toContain('name="Cap table"');
      expect(workbook).not.toContain('name="Grants"');
    });
  });
});
