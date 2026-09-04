import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * One file per upload request, said out loud (R419, methodology M19).
 *
 * Both upload routes read the body with `req.file({ limits: { files: 1 } })`,
 * which reads as "at most one file" and is not what it does: `req.file` returns
 * at the first part that has a file and never asks for the rest, so busboy's
 * `filesLimit` never fires. A request carrying two documents stored the first,
 * discarded the second without a word, and answered `201 { document }`.
 *
 * `<input type="file" multiple>` and `curl -F file=@a -F file=@b` both produce
 * that body, and nothing downstream would have shown the gap: the response is a
 * document, so a client sees a success; the analyst sees an intake bucket one
 * file short of what the client sent.
 */
describe.skipIf(!dbUp)('an upload request carrying more than one file', () => {
  let ctx: TestApp;
  let token: string;
  let valuationId: string;

  const B = '----n409r419';
  const PDF = '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n';
  const CSV = 'holder,class,shares\nAda,common,100\n';

  const filePart = (name: string, type: string, content: string) =>
    `--${B}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
    `Content-Type: ${type}\r\n\r\n${content}\r\n`;

  const post = (url: string, parts: string) =>
    ctx.app.inject({
      method: 'POST',
      url,
      headers: { ...authHeader(token), 'content-type': `multipart/form-data; boundary=${B}` },
      payload: Buffer.from(`${parts}--${B}--\r\n`),
    });

  const documentCount = async (): Promise<number> => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/documents`,
      headers: authHeader(token),
    });
    return (res.json().documents as unknown[]).length;
  };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    token = (await seedUser(ctx, { roles: ['valuation_user'] })).token;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { kind: '409a', company_name: 'One At A Time, Inc.' },
    });
    valuationId = created.json().valuation.id as string;
  });
  afterAll(() => ctx.teardown());

  it('still takes a single document', async () => {
    const before = await documentCount();
    const res = await post(
      `/api/v1/valuations/${valuationId}/documents`,
      filePart('alone.pdf', 'application/pdf', PDF),
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(await documentCount()).toBe(before + 1);
  });

  it('is refused, naming the file that would have been kept', async () => {
    const res = await post(
      `/api/v1/valuations/${valuationId}/documents`,
      filePart('first.pdf', 'application/pdf', PDF) + filePart('second.pdf', 'application/pdf', PDF),
    );
    expect(res.statusCode, res.body).toBe(422);
    const body = res.json();
    expect(body.detail).toContain('more than one file');
    expect(body.detail).toContain('first.pdf');
    expect(body.filename).toBe('first.pdf');
  });

  /*
   * The half-store is the defect, so this is the assertion that matters: the
   * refusal has to come before anything reaches disk or the documents table.
   */
  it('stores neither of them', async () => {
    const before = await documentCount();
    await post(
      `/api/v1/valuations/${valuationId}/documents`,
      filePart('kept.pdf', 'application/pdf', PDF) + filePart('dropped.pdf', 'application/pdf', PDF),
    );
    expect(await documentCount()).toBe(before);
  });

  it('holds past the second file too', async () => {
    const res = await post(
      `/api/v1/valuations/${valuationId}/documents`,
      filePart('a.pdf', 'application/pdf', PDF) +
        filePart('b.pdf', 'application/pdf', PDF) +
        filePart('c.pdf', 'application/pdf', PDF),
    );
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().detail).toContain('a.pdf');
  });

  /*
   * The cap-table import stores nothing, so the loss there is not a document —
   * it is the client being handed the first spreadsheet's sheets and told
   * nothing about the second one they sent.
   */
  it('applies to the cap-table import as well', async () => {
    const ok = await post(
      `/api/v1/valuations/${valuationId}/cap-table/upload`,
      filePart('table.csv', 'text/csv', CSV),
    );
    expect(ok.statusCode, ok.body).toBe(200);

    const res = await post(
      `/api/v1/valuations/${valuationId}/cap-table/upload`,
      filePart('table.csv', 'text/csv', CSV) + filePart('other.csv', 'text/csv', CSV),
    );
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().detail).toContain('table.csv');
  });

  it('still says so when there is no file at all', async () => {
    const res = await post(
      `/api/v1/valuations/${valuationId}/documents`,
      `--${B}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nother\r\n`,
    );
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().detail).toContain('file');
  });
});
