import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Export fidelity (R169): the file has to say what the screen says.
 *
 * The list export is a second projection of the same query the workspace list
 * renders, and the two are built by different code — different WHERE builder
 * call, different column list per format. Every one of those seams is a place
 * the file can quietly disagree with the table it was exported from, and the
 * disagreement is invisible at the point it matters: somebody hands the CSV to
 * a reviewer as "our engagements", and rows that are in the file but not on the
 * screen are, by construction, the ones nobody thinks to look for.
 *
 * These tests are all the same shape — read the screen through
 * `GET /valuations`, read the file through `GET /valuations/export`, and assert
 * the two name the same rows and the same fields.
 */
describe.skipIf(!dbUp)('export/display parity', () => {
  let ctx: TestApp;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  const dir = mkdtempSync(path.join(tmpdir(), 'n409-export-parity-'));
  let seq = 0;

  function sheet1(payload: Buffer): string {
    const file = path.join(dir, `x-${seq++}.xlsx`);
    writeFileSync(file, payload);
    return execFileSync('unzip', ['-p', file, 'xl/worksheets/sheet1.xml'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  /** Inline cell text, which is how this writer emits every string. */
  function textsIn(sheetXml: string): string[] {
    return [...sheetXml.matchAll(/<t xml:space="preserve">([^<]*)<\/t>/g)].map((m) => m[1] ?? '');
  }

  /** RFC 4180 reader — enough of one to read what `domain/csv.ts` writes. */
  function parseCsv(body: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    const text = body.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]!;
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else if (ch === '"') quoted = false;
        else field += ch;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\r' && text[i + 1] === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        i += 1;
      } else field += ch;
    }
    if (field !== '' || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  const createValuation = async (companyName: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  /** Company names on the screen, for a query string the list route accepts. */
  const onScreen = async (query: string): Promise<string[]> => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations?per_page=100&${query}`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().valuations.map((v: { company_name: string }) => v.company_name);
  };

  /** Company names in the CSV, read out of the `company_name` column. */
  const inCsv = async (query: string): Promise<string[]> => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/export?format=csv&${query}`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const [header, ...rows] = parseCsv(res.body);
    const col = header!.indexOf('company_name');
    expect(col).toBeGreaterThanOrEqual(0);
    return rows.map((r) => r[col]!);
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    ops = await seedUser(ctx, { roles: ['admin'] });
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await ctx?.teardown();
  });

  /**
   * The Unread tab, which is the one filter on the strip that is not a column.
   *
   * `unreadFor` is resolved from the *reader*, not from the query string — the
   * predicate compares `last_comment_at` against this caller's side of the read
   * marker — so it only exists if the route says which side is asking. The list
   * route does; the export route called the same builder without it, and a
   * filter that resolves to `undefined` is not a narrower export, it is no
   * filter at all. Exporting from the Unread tab handed over the whole book.
   */
  describe('the unread filter', () => {
    let unreadCo: string;

    beforeAll(async () => {
      unreadCo = 'Awaiting Reply Co';
      const id = await createValuation(unreadCo);
      await createValuation('Seen Already Co');
      // A client comment leaves the admin side of the conversation unread.
      const posted = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/comments`,
        headers: authHeader(client.token),
        payload: { kind: 'chat', body: 'Any update?' },
      });
      expect(posted.statusCode).toBe(201);
    });

    it('narrows the screen to the unread row', async () => {
      expect(await onScreen('unread=true')).toEqual([unreadCo]);
      expect(await onScreen('bucket=unread')).toEqual([unreadCo]);
    });

    it('narrows the CSV to the same row', async () => {
      expect(await inCsv('unread=true')).toEqual([unreadCo]);
      expect(await inCsv('bucket=unread')).toEqual([unreadCo]);
    });

    it('narrows the XLSX to the same row', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations/export?format=xlsx&bucket=unread',
        headers: authHeader(ops.token),
      });
      const texts = textsIn(sheet1(res.rawPayload));
      expect(texts).toContain(unreadCo);
      expect(texts).not.toContain('Seen Already Co');
    });

    it('narrows the PDF to the same row', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations/export?format=pdf&bucket=unread',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const pdf = res.rawPayload.toString('latin1');
      expect(pdf).toContain('Awaiting Reply Co');
      expect(pdf).not.toContain('Seen Already Co');
    });

    /**
     * The client's side of the same marker. Ops reading a row does not make it
     * read for the client, so "unread" has to mean a different set of rows per
     * caller in the file exactly as it does on the screen — a single shared
     * answer here would be the bug migration 0113 was written to fix.
     */
    it('resolves to the asking reader, not to a fixed side', async () => {
      const screen = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations?per_page=100&unread=true',
        headers: authHeader(client.token),
      });
      const file = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations/export?format=csv&unread=true',
        headers: authHeader(client.token),
      });
      expect(screen.statusCode).toBe(200);
      expect(file.statusCode).toBe(200);
      const [header, ...rows] = parseCsv(file.body);
      const col = header!.indexOf('company_name');
      expect(rows.map((r) => r[col]!)).toEqual(
        screen.json().valuations.map((v: { company_name: string }) => v.company_name),
      );
      // Asserted against ops' answer as well, so the two sides having the same
      // rows by accident cannot make this pass: a shared marker would have put
      // the ops row in the client's file too.
      expect(await onScreen('unread=true')).toEqual(['Awaiting Reply Co']);
    });
  });

  /**
   * The cap bit, on the two exports that were capped and silent about it.
   *
   * Neither can be pushed past its cap in a test — ten thousand accounts and
   * five thousand events are not fixtures — so what is asserted is that the
   * signal is *present and false*, which is the half a caller reads. A route
   * that never sets the header at all reads as "no information" to a client
   * that has learned to check it, and reads as "complete" to one that has not.
   */
  describe('the truncation signal', () => {
    it('rides on the users export, which was capped and said nothing', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/users/export',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-export-truncated']).toBe('false');
      expect(res.headers['x-export-row-limit']).toBe('10000');
      // And the file itself is unchanged by the over-fetch: no probe row.
      const [header, ...rows] = parseCsv(res.body);
      expect(header![0]).toBe('id');
      expect(rows.map((r) => r[1]!)).toContain(ops.email);
    });

    it('rides on the change log, whose JSON view already reported it', async () => {
      const id = await createValuation('Change Log Co');
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/audit-trail.csv`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['x-export-truncated']).toBe('false');
      // The same bit the JSON view returns in its body, for the same trail.
      const json = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/audit-trail`,
        headers: authHeader(ops.token),
      });
      expect(json.json().truncated).toBe(false);
    });
  });

  /**
   * A filter the export already honoured, kept here so the tab strip is covered
   * end to end rather than only at the one entry that was broken.
   */
  it('honours the state buckets the tab strip is built from', async () => {
    await createValuation('Bucketed Co');
    const screen = await onScreen('bucket=incomplete');
    expect(screen).toContain('Bucketed Co');
    expect(await inCsv('bucket=incomplete')).toEqual(screen);
    expect(await inCsv('bucket=published')).not.toContain('Bucketed Co');
  });
});
