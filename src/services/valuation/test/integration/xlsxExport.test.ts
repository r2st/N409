import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createGrant } from '../../src/repos/grants.js';
import { createCalculation } from '../../src/repos/calculations.js';

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

  /**
   * The worksheet part for a named sheet. Sheet parts are numbered by position,
   * so addressing them by index hardcodes the sheet order into every assertion —
   * adding a tab then breaks tests that have nothing to do with it.
   */
  function sheetNamed(payload: Buffer, name: string): string {
    const workbook = unpack(payload, 'xl/workbook.xml');
    const names = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    const index = names.indexOf(name);
    if (index < 0) throw new Error(`no sheet named ${name}; got ${names.join(', ')}`);
    return unpack(payload, `xl/worksheets/sheet${index + 1}.xml`);
  }

  /** Cell text, which this writer emits inline rather than via sharedStrings. */
  function textsIn(sheetXml: string): string[] {
    return [...sheetXml.matchAll(/<t xml:space="preserve">([^<]*)<\/t>/g)].map((m) => m[1] ?? '');
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
      // The override register ships even with nothing in it — see the audit
      // sheets block below.
      expect(workbook).toContain('name="Overrides"');
      // Eight sheets means eight worksheet parts, not one reused eight times.
      expect(entries(res.rawPayload)).toContain('xl/worksheets/sheet8.xml');
    });

    it('delivers derived rows as live formulas, not frozen numbers', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/workbook.xlsx`,
        headers: authHeader(ops.token),
      });
      const sheet = sheetNamed(res.rawPayload, 'Income statement');
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

  /**
   * The auditor sheets: what was assumed, what a human changed it from, and what
   * the engine concluded. These are what a reviewer ties to, so the assertions
   * are about provenance surviving the round-trip into the file — the values
   * being present is not enough if the file cannot say where they came from.
   */
  describe('audit sheets', () => {
    let valuationId: string;

    beforeAll(async () => {
      valuationId = await createValuation('Audited Analytics');

      const put = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/overwrites/dlom`,
        headers: authHeader(ops.token),
        payload: {
          value: 0.185,
          reason: 'Longer expected hold following the delayed Series C.',
          original_value: 0.14,
        },
      });
      expect(put.statusCode).toBe(200);

      // Running the engine for real is a different subsystem; this test is about
      // the export, so the run goes in through the repo.
      await createCalculation(
        ctx.pool,
        {
          valuationId,
          engineVersion: '2.4.1',
          status: 'succeeded',
          inputs: { discount_rate: 0.22, valuation_params: { dlom: 0.185 } },
          results: { allocation: { method: 'opm', volatility: 0.62 } },
          equityValue: 41_000_000,
          fmvPerShare: 1.42,
          diagnostics: [
            {
              code: 'HIGH_DLOM',
              field: 'valuation_params.dlom',
              message: 'DLOM above the usual range for this stage.',
              severity: 'warning',
              hint: null,
            },
          ],
          createdBy: ops.id,
        },
        { actorType: 'human', actorId: ops.id },
      );
    });

    const fetchWorkbook = async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/workbook.xlsx`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      return res.rawPayload;
    };

    it('adds the assumption register, calculation record and override sheets', async () => {
      const workbook = unpack(await fetchWorkbook(), 'xl/workbook.xml');
      for (const name of ['Assumption register', 'Calculation', 'Overrides']) {
        expect(workbook).toContain(`name="${name}"`);
      }
      // Distinct from the model's own methodology tab, which keeps its name.
      expect(workbook).toContain('name="Assumptions"');
    });

    it('labels an overridden assumption as manually set, and the rest as engine', async () => {
      const texts = textsIn(sheetNamed(await fetchWorkbook(), 'Assumption register'));
      expect(texts).toContain('valuation_params.dlom');
      expect(texts).toContain('manual override');
      // The untouched assumption is on the same sheet, marked the other way.
      expect(texts).toContain('discount_rate');
      expect(texts).toContain('engine');
    });

    it('carries the replaced value and the stated reason into the file', async () => {
      const sheet = sheetNamed(await fetchWorkbook(), 'Overrides');
      const texts = textsIn(sheet);
      expect(texts).toContain('Longer expected hold following the delayed Series C.');
      // The registry label, not the raw key.
      expect(texts).toContain('DLOM');
      expect(texts).toContain('dlom');
      // The engine value it replaced, as a real number rather than text.
      expect(sheet).toContain('<v>0.14</v>');
      expect(sheet).toContain('<v>0.185</v>');
    });

    it('records engine provenance and the warning the run carried', async () => {
      const sheet = sheetNamed(await fetchWorkbook(), 'Calculation');
      const texts = textsIn(sheet);
      expect(texts).toContain('Engine version');
      expect(texts).toContain('2.4.1');
      // A successful run can still carry a warning; hiding it would defeat the
      // point of the sheet.
      expect(texts).toContain('warning: valuation_params.dlom');
      expect(texts).toContain('DLOM above the usual range for this stage.');
      expect(texts).toContain('allocation.method');
      // The concluded numbers are footable, not strings.
      expect(sheet).toContain('<v>41000000</v>');
      expect(sheet).toContain('<v>1.42</v>');
    });

    it('is readable by the owning client, like the rest of the workbook', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/workbook.xlsx`,
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(200);
    });

    it('does not leak the register to another client', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/workbook.xlsx`,
        headers: authHeader(otherClient.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
