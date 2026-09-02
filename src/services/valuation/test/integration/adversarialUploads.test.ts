import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeader,
  isDbAvailable,
  SEEDED_PASSWORD,
  seedPartner,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';
import { DEFAULT_MEDIA_TYPE } from '../../src/documents/mediaType.js';

const dbUp = await isDbAvailable();
const B = '----n409adversarial';

function part(name: string, value: string): string {
  return `--${B}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
}
function file(filename: string, contentType: string, data: string): string {
  return (
    `--${B}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n${data}\r\n`
  );
}
/** `binary` so a byte written as `\x00` in a test string stays one byte on the wire. */
const upload = (...parts: string[]): Buffer => Buffer.from(parts.join('') + `--${B}--\r\n`, 'binary');

const CSV = 'class,shares\ncommon,100';

/**
 * Round 182, methodology M6: the document upload route answered with something
 * other than a 500.
 *
 * Multipart is the estate's one input path that no body-level guard reaches.
 * @fastify/multipart registers its own content-type parser, so at
 * `preValidation` — where the global NUL-byte hook runs, and where Fastify's
 * schema validation would run — `req.body` is a stream and there is nothing to
 * inspect. R74 closed the size half of that (uploadLimits.ts). This is the
 * *content* half: the part headers, which busboy has already decoded into
 * strings by the time the handler asks for them, and which went into the
 * database and back out into a response header without anybody reading them.
 */
describe.skipIf(!dbUp)('adversarial document uploads', () => {
  let ctx: TestApp;
  let token: string;
  let url: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    const owner = await seedUser(ctx, { roles: ['valuation_user'] });
    token = owner.token;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { kind: '409a', company_name: 'Adversarial Co' },
    });
    const id = created.json().valuation.id as string;
    url = `/api/v1/valuations/${id}/documents`;
    headers = { ...authHeader(token), 'content-type': `multipart/form-data; boundary=${B}` };
  });
  afterAll(async () => ctx?.teardown());

  const send = (payload: Buffer) => ctx.app.inject({ method: 'POST', url, headers, payload });

  /**
   * The finding. `content_type` is `text NOT NULL`; Postgres refuses `U+0000`
   * in one with `22021`, which no repo looks for, so it reached the error
   * handler as an unrecognised database error and left as a 500 — from a
   * request an authenticated client can make with curl.
   */
  it('stores a NUL-carrying content type as the default rather than 500ing', async () => {
    const res = await send(
      upload(part('kind', 'income_statement'), file('a.csv', 'text/plain\x00evil', CSV)),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().document.content_type).toBe(DEFAULT_MEDIA_TYPE);
  });

  /**
   * And the value is echoed back as the download's own `Content-Type`, so an
   * unbounded part header was an unbounded response header — one Node's own
   * HTTP client would refuse to parse at 16 KB.
   */
  it('does not let a part header become an oversized response header', async () => {
    const res = await send(
      upload(part('kind', 'income_statement'), file('b.csv', `text/${'z'.repeat(20_000)}`, CSV)),
    );
    expect(res.statusCode).toBe(201);
    const documentId = res.json().document.id as string;

    const download = await ctx.app.inject({
      method: 'GET',
      url: `${url}/${documentId}/download`,
      headers: authHeader(token),
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe(DEFAULT_MEDIA_TYPE);
    // The header the client sent is 20 KB; whatever we answer with must not be.
    expect(String(download.headers['content-type']).length).toBeLessThan(256);
    expect(download.headers['x-content-type-options']).toBe('nosniff');
  });

  /**
   * The normalizer keeps parameters — the partner API's JSON `content_type`
   * reaches it whole — but busboy has already dropped them from a *part* header
   * by the time `file.mimetype` exists, so what a multipart upload can preserve
   * is the type and subtype. Asserted as it actually behaves rather than as the
   * normalizer alone would suggest.
   */
  it('keeps a well-formed declared type intact, folding only its case', async () => {
    const res = await send(
      upload(part('kind', 'income_statement'), file('c.csv', 'Text/CSV; charset=UTF-8', CSV)),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().document.content_type).toBe('text/csv');
  });

  /** Markup behind a text extension — see fileType.ts on the prologue evasion. */
  it('refuses markup wearing a .csv, prologue and all', async () => {
    for (const body of [
      '<html><script>alert(1)</script></html>',
      '<!-- x --><html><script>alert(1)</script></html>',
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    ]) {
      const res = await send(upload(part('kind', 'income_statement'), file('d.csv', 'text/csv', body)));
      expect(res.statusCode, body).toBe(422);
      expect(res.json().detail).toContain('Rejected upload');
    }
  });

  it('refuses an SVG, which no accepted extension maps to', async () => {
    const res = await send(
      upload(
        part('kind', 'income_statement'),
        file(
          'logo.svg',
          'image/svg+xml',
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        ),
      ),
    );
    expect(res.statusCode).toBe(422);
    // The refusal names the content for what it is and says what to send
    // instead. An SVG reaches this branch as markup, and the reader — who
    // picked a file called logo.svg — needs the second half more than the
    // first: "HTML content is not an accepted upload" left them with nothing
    // to try.
    expect(res.json().detail).toMatch(/content is a web page/i);
    expect(res.json().detail).toMatch(/print-to-PDF/i);
  });

  /**
   * The refusals that already worked, pinned here because this is the suite
   * that says what the upload surface answers — a regression in any of them
   * would otherwise only show as a 201.
   */
  it('keeps refusing the inputs that were already refused', async () => {
    const cases: Array<[string, Buffer, number]> = [
      ['empty file', upload(part('kind', 'income_statement'), file('e.csv', 'text/csv', '')), 422],
      [
        'executable behind a double extension',
        upload(part('kind', 'income_statement'), file('f.pdf.exe', 'application/pdf', 'MZ\x90\x00')),
        422,
      ],
      [
        'ELF behind a .csv',
        upload(part('kind', 'income_statement'), file('g.csv', 'text/csv', '\x7fELF\x02\x01')),
        422,
      ],
      ['no file part at all', upload(part('kind', 'income_statement')), 400],
      ['unknown kind', upload(part('kind', 'not_a_kind'), file('h.csv', 'text/csv', CSV)), 422],
    ];
    for (const [name, payload, status] of cases) {
      const res = await send(payload);
      expect(res.statusCode, `${name}: ${res.body.slice(0, 160)}`).toBe(status);
      expect(res.json().detail, name).toBeTruthy();
    }
  });

  /**
   * A path in the filename is stripped rather than refused (RFC 6266 §4.3 tells
   * a *recipient* to do exactly this), and the stored name must not carry one —
   * it is joined onto the documents directory to make the storage path.
   */
  it('strips a traversal filename instead of storing a path', async () => {
    const res = await send(
      upload(part('kind', 'income_statement'), file('../../../etc/passwd.csv', 'text/csv', CSV)),
    );
    expect(res.statusCode).toBe(201);
    const doc = res.json().document;
    expect(doc.filename).toBe('passwd.csv');
    expect(doc.storage_path).not.toContain('..');
  });

  it('bounds and scrubs a filename without losing its shape', async () => {
    const res = await send(
      upload(part('kind', 'income_statement'), file(`${'x'.repeat(5_000)}.csv`, 'text/csv', CSV)),
    );
    expect(res.statusCode).toBe(201);
    expect((res.json().document.filename as string).length).toBeLessThanOrEqual(200);

    const nul = await send(
      upload(part('kind', 'income_statement'), file('quarterly\x00.csv', 'text/csv', CSV)),
    );
    expect(nul.statusCode).toBe(201);
    expect(nul.json().document.filename).toBe('quarterly_.csv');
  });

  /**
   * R277, methodology M19. Every refusal on this route names the file through
   * `safeFilename` — except the earliest one, which quoted the raw part header
   * back into a sentence a person reads. The upload never reaches storage, so
   * the scrub that every *stored* name goes through never ran, and the refusal
   * body was the one place the name survived exactly as sent.
   *
   * A right-to-left override in it reorders the whole sentence around it, which
   * on a refusal is the same extension-spoof `filenameDisplay.test.ts` guards on
   * the stored name; the length is worse here, because a name has no bound on
   * the wire and the refusal repeats it.
   */
  it('names a refused empty upload by its scrubbed name, not the one that arrived', async () => {
    const res = await send(
      // The override written as its UTF-8 bytes: the body is assembled as
      // `binary`, so a `\u202E` in the source would be truncated to '.' rather
      // than reaching busboy as the control it is testing.
      upload(part('kind', 'income_statement'), file('memo\xe2\x80\xaegnp.exe', 'text/csv', '')),
    );
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.detail).toMatch(/zero bytes/i);
    // Drawn as it is written: no override left to reverse what follows it.
    expect(body.detail).not.toContain('\u202E');
    expect(body.filename).toBe('memognp.exe');

    const long = await send(
      upload(part('kind', 'income_statement'), file(`${'x'.repeat(5_000)}.csv`, 'text/csv', '')),
    );
    expect(long.statusCode).toBe(422);
    expect((long.json().filename as string).length).toBeLessThanOrEqual(200);
    expect((long.json().detail as string).length).toBeLessThan(500);
  });

  /**
   * Two uploads of the same bytes under the same name land on one storage path
   * by construction (`<sha-prefix>__<filename>`), so the concurrent case must be
   * two rows over one blob rather than a write racing itself to a truncated
   * file. Asserted on what comes back out, which is the thing that would break.
   */
  it('survives the same file uploaded twice at once', async () => {
    const payload = () => upload(part('kind', 'income_statement'), file('same.csv', 'text/csv', CSV));
    const [a, b] = await Promise.all([send(payload()), send(payload())]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().document.id).not.toBe(b.json().document.id);
    expect(a.json().document.storage_path).toBe(b.json().document.storage_path);

    for (const res of [a, b]) {
      const dl = await ctx.app.inject({
        method: 'GET',
        url: `${url}/${res.json().document.id}/download`,
        headers: authHeader(token),
      });
      expect(dl.statusCode).toBe(200);
      expect(dl.body).toBe(CSV);
    }
  });
});

/**
 * R274. The parameter half of the same field, which only the partner API can
 * reach: busboy drops a part header's parameters before the session route ever
 * sees them, so `content_type` arrives whole only when a JSON body carries it.
 *
 * `normalizeMediaType` spelled its *token* characters as an allow-list — which
 * is what kept the NUL out above — and its *quoted-string* characters as
 * `[^"\\]`, a negated class admitting every control character there is. So the
 * one shape that reaches the column intact was the one shape that was not
 * checked, and the failure it produces is worse than the 500 the token half
 * gave: the upload is accepted, the value is stored, and the 500 lands on
 * *every later download* of that document — for the analyst as much as for the
 * client who uploaded it.
 */
describe.skipIf(!dbUp)('adversarial partner-API declared media types', () => {
  let ctx: TestApp;
  let apiKey: string;
  let adminToken: string;
  let valuationId: string;
  let uploadUrl: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    const partnerId = await seedPartner(ctx, 'Media Type Advisors');
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId });
    adminToken = admin.token;
    const minted = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/partners/${partnerId}/tokens`,
      headers: authHeader(adminToken),
      payload: { current_password: SEEDED_PASSWORD, name: 'adversarial media types' },
    });
    expect(minted.statusCode).toBe(201);
    apiKey = minted.json().secret as string;

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/partner/v1/valuations',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { kind: '409a', company_name: 'Media Type Co' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;
    uploadUrl = `/api/partner/v1/valuations/${valuationId}/documents`;
  });
  afterAll(async () => ctx?.teardown());

  const put = (filename: string, contentType: string) =>
    ctx.app.inject({
      method: 'POST',
      url: uploadUrl,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        filename,
        content_type: contentType,
        content_base64: Buffer.from(CSV).toString('base64'),
      },
    });

  const download = (documentId: string) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/documents/${documentId}/download`,
      headers: authHeader(adminToken),
    });

  it.each([
    ['a bell inside a quoted parameter', 'text/plain; charset="\u0007"'],
    ['a CRLF written to split the response', 'text/plain; charset="\r\nX-Evil: 1"'],
    ['a control character behind a quoted-pair', 'text/plain; charset="\\\u0007"'],
    ['a line break standing in for the parameter separator', 'text/plain;\rcharset=utf-8'],
    ['a code point a header value has no room for', 'text/plain; name="\u20ac.csv"'],
  ])('stores %s as the default, and the document stays downloadable', async (_what, declared) => {
    const res = await put('poisoned.csv', declared);
    expect(res.statusCode).toBe(201);
    expect(res.json().document.content_type).toBe(DEFAULT_MEDIA_TYPE);

    const dl = await download(res.json().document.id as string);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe(DEFAULT_MEDIA_TYPE);
    expect(dl.body).toBe(CSV);
  });

  /**
   * The other half of the fix: a quoted parameter is ordinary and must survive.
   * `obs-text` is kept because a header value may carry it and Node will set it.
   */
  it('keeps a well-formed quoted parameter, obs-text included', async () => {
    const res = await put('kept.csv', 'text/csv; name="caf\u00e9 report.csv"');
    expect(res.statusCode).toBe(201);
    expect(res.json().document.content_type).toBe('text/csv; name="caf\u00e9 report.csv"');

    const dl = await download(res.json().document.id as string);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('text/csv; name="caf\u00e9 report.csv"');
  });
});
