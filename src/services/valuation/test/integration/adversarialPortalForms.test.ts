import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Round 217, methodology M6: the forms a client fills in themselves.
 *
 * Prior adversarial rounds worked the machine boundaries — uploads (R182),
 * webhooks and SCIM (R201, R207), the JSON body reader (R211). Those are the
 * surfaces a hostile caller reaches. This one is the opposite: the company
 * details, the cap table and the file picker that ordinary clients use, where
 * the interesting input is not an attack but a paste.
 *
 * Two of the three findings came from a character nobody typed on purpose:
 *
 *  - an unpaired surrogate — half of an emoji — in a company name. Every write
 *    records an event, `recordEvent` writes the payload as `jsonb`, and
 *    Postgres refuses an unpaired `\ud800` escape, so the request 500d.
 *  - the same character produced by this service's own 200-character bound on
 *    an uploaded filename, which `String.slice` cut through the middle of an
 *    emoji. That one no boundary guard could have caught, because the
 *    half-character was not in the request.
 *
 * The third is arithmetic: a share count and a conversion ratio that are each
 * acceptable and whose product is not a number.
 */
describe.skipIf(!dbUp)('adversarial portal forms', () => {
  let ctx: TestApp;
  let token: string;
  let valuationId: string;

  /** A high surrogate with no low half — what half a pasted emoji is. */
  const LONE = '\uD800';
  const GRIN = '\u{1F600}';
  const B = '----n409r217';
  const PDF = '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n';

  const uploadBody = (filename: string): Buffer =>
    Buffer.concat([
      Buffer.from(
        `--${B}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nother\r\n` +
          `--${B}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: application/pdf\r\n\r\n`,
        'utf8',
      ),
      Buffer.from(PDF, 'binary'),
      Buffer.from(`\r\n--${B}--\r\n`, 'utf8'),
    ]);

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    token = (await seedUser(ctx, { roles: ['valuation_user'] })).token;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { kind: '409a', company_name: 'Portal Forms Co' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;
  });
  afterAll(() => ctx.teardown());

  /* ------------------------------------------------- half a character --- */

  describe('an unpaired surrogate in a name', () => {
    /**
     * The half-character survives the whole way in: `JSON.stringify` is
     * required to emit it as the escape `\ud800`, and `JSON.parse` turns that
     * back into the lone code unit. Nothing between the browser and the driver
     * looks at it, which is why the guard is the same boundary hook the NUL
     * byte gets.
     */
    it('is refused on the new-valuation form, which used to 500', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(token),
        payload: { kind: '409a', company_name: `Acme${LONE} Ltd` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toMatch(/unpaired surrogate/);
      expect(res.json().detail).toContain('company_name');
    });

    it('is refused on the company profile editor, naming the field', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/company-profile`,
        headers: authHeader(token),
        payload: { legal_name: 'Fine', address_line1: `1 Main${LONE} St` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toContain('address_line1');
    });

    it('is refused in a query string, where it arrives already decoded', async () => {
      // `%ED%A0%80` is the surrogate written as UTF-8 would write it if it
      // could. Whatever the decoder makes of it, the answer is not a 500.
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations?q=%ED%A0%80abc',
        headers: authHeader(token),
      });
      expect(res.statusCode).toBeLessThan(500);
    });

    it('does not disturb the emoji and astral scripts that are legitimate', async () => {
      for (const name of [`Acme ${GRIN} Ltd`, '𠮷野家', '𝄞 Music Co', '🇬🇧 Holdings']) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/valuations',
          headers: authHeader(token),
          payload: { kind: '409a', company_name: name },
        });
        expect(res.statusCode, name).toBe(201);
        expect(res.json().valuation.company_name, name).toBe(name);
      }
    });
  });

  /* -------------------------------------- a bound this service applies --- */

  describe('a filename cut through an emoji', () => {
    /**
     * The boundary hook cannot help here twice over: a multipart body is a
     * stream at `preValidation`, and the half-character was not sent — the
     * 200-character bound in `safeFilename` made it. See domain/textSlice.ts.
     */
    it('uploads at every offset the cut can land on', async () => {
      const headers = {
        ...authHeader(token),
        'content-type': `multipart/form-data; boundary=${B}`,
      };
      for (const pad of [197, 198, 199, 200]) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${valuationId}/documents`,
          headers,
          payload: uploadBody(`${'a'.repeat(pad)}${GRIN}.pdf`),
        });
        expect(res.statusCode, `pad ${pad}`).toBe(201);
        const filename = res.json().document.filename as string;
        // The stored name is a string Postgres and UTF-8 can both hold.
        expect(JSON.stringify(filename).includes('\\ud'), `pad ${pad}`).toBe(false);
        expect(filename.length, `pad ${pad}`).toBeLessThanOrEqual(200);
      }
    });
  });

  /* ------------------------------------------ figures that stop being --- */

  describe('cap-table figures that overflow when multiplied', () => {
    const importRows = (rows: Array<Record<string, unknown>>) =>
      ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${valuationId}/cap-table`,
        headers: authHeader(token),
        payload: { format: 'generic', rows },
      });

    it('refuses a table whose fully-diluted count is no longer a number', async () => {
      const res = await importRows([
        { class: 'Common', type: 'common', shares: '1000000' },
        {
          class: 'Series A Preferred',
          type: 'preferred',
          shares: '1e300',
          conversion_ratio: '1e300',
        },
      ]);
      expect(res.statusCode).toBe(422);
      const codes = (res.json().validation.issues as Array<{ code: string }>).map((i) => i.code);
      expect(codes).toContain('figure_overflows');
    });

    it('stores nothing, so no reader inherits a null denominator', async () => {
      // `JSON.stringify(Infinity)` is `null`, so a persisted summary would come
      // back from JSONB with a null where its own type declares a number.
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/cap-table`,
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().cap_table).toBeNull();
    });

    it('still imports a large but computable table', async () => {
      const res = await importRows([
        { class: 'Common', type: 'common', shares: '1000000000000' },
        {
          class: 'Series A Preferred',
          type: 'preferred',
          shares: '1000000000000',
          price: '1',
          liquidation_multiple: '3',
          conversion_ratio: '2',
        },
        { class: 'Option Pool', type: 'option', shares: '100000' },
      ]);
      expect(res.statusCode).toBe(200);
      const summary = res.json().cap_table.validation.summary as Record<string, number>;
      expect(summary.fully_diluted_shares).toBe(3_000_000_100_000);
    });
  });
});
