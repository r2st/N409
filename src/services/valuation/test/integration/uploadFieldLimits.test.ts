import { afterAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { UPLOAD_FIELD_LIMITS } from '../../src/routes/uploadLimits.js';

const dbUp = await isDbAvailable();

const BOUNDARY = '----n409fieldlimits';

/** A multipart body of `count` text fields, each `size` bytes, and no file. */
function fieldsOnly(count: number, size: number): Buffer {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="f${i}"\r\n\r\n${'a'.repeat(size)}\r\n`,
    );
  }
  parts.push(`--${BOUNDARY}--\r\n`);
  return Buffer.from(parts.join(''));
}

/** A normal one-file upload, optionally carrying the two fields the route reads. */
function fileUpload(fields: Record<string, string> = {}): Buffer {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  parts.push(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="financials.csv"\r\n` +
      `Content-Type: text/plain\r\n\r\na,b\r\n1,2\r\n--${BOUNDARY}--\r\n`,
  );
  return Buffer.from(parts.join(''));
}

/**
 * Non-file limits on the two multipart upload routes (round 74).
 *
 * `fileSize` was the only limit either route configured, and it applies to file
 * parts — so a multipart body made entirely of text fields was metered by
 * nothing the routes set, and not by Fastify's `bodyLimit` either, which does
 * not reach multipart. What remained was busboy's 1 MB-per-field default under
 * @fastify/multipart's 1000-part cap: on the order of a gigabyte, accepted and
 * buffered before either route noticed there was no file in it.
 *
 * See uploadLimits.ts for the measurement. The tests below are sized to run in
 * CI rather than to reproduce that number, which is why they assert on the
 * refusal rather than on memory: `fieldSize` and `fields` are what make the
 * large request unreachable, so pinning them is what stops the regression.
 */
describe.skipIf(!dbUp)('multipart upload field limits', () => {
  const contexts: TestApp[] = [];

  async function uploader() {
    const ctx = await setupTestApp();
    contexts.push(ctx);
    const owner = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Field Limits Co' },
    });
    const valuationId = created.json().valuation.id as string;

    const post = (path: string, payload: Buffer) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}${path}`,
        headers: {
          ...authHeader(owner.token),
          'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        },
        payload,
      });

    return { ctx, valuationId, post };
  }

  afterAll(async () => {
    for (const ctx of contexts) await ctx?.teardown();
  });

  it('refuses a documents upload that is all text fields and no file', async () => {
    const { post } = await uploader();
    const res = await post('/documents', fieldsOnly(UPLOAD_FIELD_LIMITS.fields + 40, 64));
    // 413 rather than the 400 "expected a file field" the route used to reach:
    // the request is turned away while it is being read, not after.
    expect(res.statusCode, res.body).toBe(413);
  });

  it('refuses the same request to the cap-table upload', async () => {
    // Two routes, one plugin registration — but each also passes its own
    // per-call limits, so each is asserted rather than assumed to inherit.
    const { post } = await uploader();
    const res = await post('/cap-table/upload', fieldsOnly(UPLOAD_FIELD_LIMITS.fields + 40, 64));
    expect(res.statusCode, res.body).toBe(413);
  });

  /**
   * The other half, and the one that carried the bytes: a count cap alone would
   * not have helped, because busboy's default allowed a megabyte in each field.
   *
   * `fieldSize` bounds it by *truncating* rather than erroring — which is the
   * behaviour worth having, since truncation is exactly "stop buffering", but it
   * means the limit is invisible from the status code. So it is asserted where
   * it is actually observable: the route echoes the field it could not
   * understand, and what comes back must be the capped length, not what was
   * sent.
   */
  it('truncates an oversized text field at the cap rather than buffering it', async () => {
    const { post } = await uploader();
    const oversized = 'x'.repeat(UPLOAD_FIELD_LIMITS.fieldSize * 4);
    const res = await post('/documents', fileUpload({ kind: oversized }));

    expect(res.statusCode, res.body).toBe(422);
    const detail = res.json().detail as string;
    const echoed = /"(x+)"/.exec(detail)?.[1] ?? '';
    expect(echoed.length).toBe(UPLOAD_FIELD_LIMITS.fieldSize);
    expect(echoed.length).toBeLessThan(oversized.length);
  });

  it('still accepts an ordinary upload carrying the fields the route reads', async () => {
    // The limits have to sit above real use or they are a bug of their own.
    // `kind` is exactly what the intake UI and the API clients send.
    const { post } = await uploader();
    const res = await post('/documents', fileUpload({ kind: 'income_statement' }));
    expect(res.statusCode, res.body).toBe(201);
  });

  it('still accepts an ordinary cap-table upload', async () => {
    const { post } = await uploader();
    const res = await post('/cap-table/upload', fileUpload());
    expect(res.statusCode, res.body).toBe(200);
  });

  it('leaves nothing stored when a body is refused', async () => {
    const { ctx, valuationId, post } = await uploader();
    await post('/documents', fieldsOnly(UPLOAD_FIELD_LIMITS.fields + 40, 64));
    const rows = await ctx.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM documents WHERE valuation_id = $1',
      [valuationId],
    );
    expect(rows.rows[0]!.n).toBe(0);
  });
});
