/**
 * The working papers leaving, recorded.
 *
 * `reportDownloadAudit.test.ts` holds the deliverable's doors: "the export
 * itself is an auditable act" is what the evidence bundle has said since it
 * was written, and R215 held the two report doors to it. Two more exports of
 * client material still said nothing:
 *
 *   - `workbook.xlsx`, the auditor workbook — the assumption register, the
 *     model sheets, the cap table and grant schedules, the flattened engine
 *     results, and every value an analyst overrode with the reason they
 *     typed. More of the engagement in one file than the deliverable is, on a
 *     URL the UI never shows.
 *   - `documents/:id/download`, the client's own source materials. Arriving,
 *     being re-filed and being removed each wrote a row; the bytes being
 *     handed out did not.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listEvents } from '../../src/events/record.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const CAP_TABLE = 'holder,shares\nFounders,8000000\nSeries A,2000000';

describe.skipIf(!dbUp)('working-paper exports reach the audit spine', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let docsDir: string;
  let valuationId: string;
  let documentId: string;

  beforeAll(async () => {
    docsDir = mkdtempSync(path.join(tmpdir(), 'n409-wp-audit-'));
    ctx = await setupTestApp({ DOCUMENTS_DIR: docsDir, AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Working Paper Co' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id;

    const boundary = '----n409wpaudit';
    const payload =
      `--${boundary}\r\ncontent-disposition: form-data; name="kind"\r\n\r\ncap_table\r\n` +
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="cap-table.csv"\r\n` +
      `content-type: text/csv\r\n\r\n${CAP_TABLE}\r\n--${boundary}--\r\n`;
    const up = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/documents`,
      headers: {
        ...authHeader(client.token),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(up.statusCode).toBe(201);
    documentId = up.json().document.id;
  });

  afterAll(async () => {
    await ctx?.teardown();
    rmSync(docsDir, { recursive: true, force: true });
  });

  const eventsOfType = async (type: string) =>
    (await listEvents(ctx.pool, valuationId, { limit: 500 })).filter((e) => e.type === type);

  it('records each pull of the auditor workbook, which nothing did', async () => {
    for (let i = 0; i < 2; i += 1) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/workbook.xlsx`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      // The file really is a workbook, not an error body a 200 would hide.
      expect(res.rawPayload.subarray(0, 2).toString()).toBe('PK');
    }

    const rows = await eventsOfType('workbook_exported');
    expect(rows).toHaveLength(2);
    const row = rows.at(-1)!;
    expect(row.actor_id).toBe(ops.id);
    expect(row.actor_type).toBe('human');
    // What the file carried, not just that one was built: sheet names are the
    // difference between the whole working model and a degraded subset.
    expect(Array.isArray(row.payload.sheets)).toBe(true);
    expect((row.payload.sheets as string[]).length).toBeGreaterThan(0);
    expect(Number(row.payload.size_bytes)).toBeGreaterThan(0);
    expect(row.payload.overrides).toBe(0);
  });

  it('writes nothing when the workbook is refused', async () => {
    const before = (await eventsOfType('workbook_exported')).length;
    // Working data is operations-only; the owning client is refused this file.
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/workbook.xlsx`,
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(403);
    expect(await eventsOfType('workbook_exported')).toHaveLength(before);
  });

  it('records each download of a client document, which nothing did', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/documents/${documentId}/download`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(CAP_TABLE);

    const rows = await eventsOfType('document_downloaded');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe(ops.id);
    expect(rows[0]!.payload).toMatchObject({
      document_id: documentId,
      filename: 'cap-table.csv',
      size_bytes: CAP_TABLE.length,
    });
  });

  it('records the download once per read, not once per document', async () => {
    const before = (await eventsOfType('document_downloaded')).length;
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/documents/${documentId}/download`,
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(200);
    const rows = await eventsOfType('document_downloaded');
    expect(rows).toHaveLength(before + 1);
    // Attributed to whoever pulled it — the point of the row is who read the
    // client's material, and the second reader here is the client.
    expect(rows.at(-1)!.actor_id).toBe(client.id);
  });

  it('writes nothing when the stored file cannot be read', async () => {
    const before = (await eventsOfType('document_downloaded')).length;
    rmSync(path.join(docsDir, valuationId), { recursive: true, force: true });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/documents/${documentId}/download`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(404);
    // A download that handed over nothing must not read as one that did.
    expect(await eventsOfType('document_downloaded')).toHaveLength(before);
  });
});
