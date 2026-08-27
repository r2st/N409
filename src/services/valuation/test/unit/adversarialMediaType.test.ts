import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEDIA_TYPE,
  MAX_MEDIA_TYPE_LENGTH,
  normalizeMediaType,
} from '../../src/documents/mediaType.js';
import { checkUploadType, sniffCategory } from '../../src/documents/fileType.js';

/**
 * Round 182 (adversarial input), the two upload-surface halves that are pure.
 *
 * The integration half — that the same inputs are answered with a 4xx by the
 * live routes rather than a 500, and that the stored type is what comes back on
 * the download — is in test/integration/adversarialUploads.test.ts.
 */
describe('normalizeMediaType', () => {
  it('keeps an ordinary media type, folding only type/subtype case', () => {
    expect(normalizeMediaType('text/csv')).toBe('text/csv');
    expect(normalizeMediaType('Application/PDF')).toBe('application/pdf');
    expect(normalizeMediaType('  image/png  ')).toBe('image/png');
    expect(normalizeMediaType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('keeps parameters, and their case, because some of them mean something', () => {
    expect(normalizeMediaType('text/csv; charset=UTF-8')).toBe('text/csv; charset=UTF-8');
    // A boundary is case-sensitive: folding it names a different boundary.
    expect(normalizeMediaType('Multipart/Related; boundary=AaBbCc')).toBe(
      'multipart/related; boundary=AaBbCc',
    );
    expect(normalizeMediaType('text/plain; name="my report.csv"')).toBe('text/plain; name="my report.csv"');
  });

  /**
   * The finding. `documents.content_type` is `text NOT NULL`, Postgres refuses
   * `U+0000` in one, and the estate's guard against that is a `preValidation`
   * hook over the *parsed body* — which is a stream on a multipart request. The
   * part headers are strings by the time the route reads them, so the one
   * character that cannot be stored arrived through the one door the hook does
   * not watch, and left as `500 urn:n409:problem:internal`.
   */
  it('replaces a type carrying a NUL byte, which no text column can store', () => {
    expect(normalizeMediaType('text/plain\x00evil')).toBe(DEFAULT_MEDIA_TYPE);
    expect(normalizeMediaType('\x00')).toBe(DEFAULT_MEDIA_TYPE);
    expect(normalizeMediaType('text/csv; charset=utf-8\x00')).toBe(DEFAULT_MEDIA_TYPE);
  });

  /**
   * The quieter half of the same finding: the value is echoed back as the
   * download response's own `Content-Type`, and nothing bounded it. 20 KB in a
   * part header became a 20 KB response header — past the 16 KB budget Node's
   * own HTTP client will parse.
   */
  it('replaces a type past the length ceiling rather than truncating it', () => {
    const long = `text/${'x'.repeat(20_000)}`;
    expect(normalizeMediaType(long)).toBe(DEFAULT_MEDIA_TYPE);
    expect(normalizeMediaType(long).length).toBeLessThan(MAX_MEDIA_TYPE_LENGTH);
    // A truncated media type is a different, wrong media type — so the answer is
    // "no claim" rather than the first 255 characters of one.
    expect(normalizeMediaType(long).startsWith('text/x')).toBe(false);
  });

  it('replaces anything that is not a media type at all', () => {
    for (const bad of [
      '',
      '   ',
      'not-a-media-type',
      'text/',
      '/csv',
      'text/csv\r\nX-Injected: 1',
      'text /csv',
      '<script>alert(1)</script>',
      'text/csv; charset',
    ]) {
      expect(normalizeMediaType(bad), JSON.stringify(bad)).toBe(DEFAULT_MEDIA_TYPE);
    }
  });

  it('is total — a missing or non-string claim is the default, not a throw', () => {
    expect(normalizeMediaType(null)).toBe(DEFAULT_MEDIA_TYPE);
    expect(normalizeMediaType(undefined)).toBe(DEFAULT_MEDIA_TYPE);
    expect(normalizeMediaType(42 as unknown as string)).toBe(DEFAULT_MEDIA_TYPE);
  });
});

/**
 * The marker test asked whether a file *begins* with markup, not whether it *is*
 * markup, so everything HTML and XML allow in front of the root element walked
 * past the one check a `.csv`'s content ever gets.
 */
describe('markup sniffing past a prologue', () => {
  const sniff = (s: string) => sniffCategory(Buffer.from(s, 'utf8'));

  it('still reads a bare markup document as markup', () => {
    expect(sniff('<!DOCTYPE html><html><body>hi</body></html>')).toBe('html');
    expect(sniff('<html><body>hi</body></html>')).toBe('html');
    expect(sniff('<script>alert(1)</script>')).toBe('html');
  });

  it('sees through a comment, an XML declaration and a non-HTML doctype', () => {
    expect(sniff('<!-- nothing to see --><html><script>alert(1)</script></html>')).toBe('html');
    expect(sniff('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')).toBe('html');
    expect(sniff('<!DOCTYPE svg PUBLIC "x" "y"><svg><script>alert(1)</script></svg>')).toBe('html');
    expect(sniff('<!-- a --> <!-- b --> <?xml version="1.0"?> <html>')).toBe('html');
  });

  /** SVG is markup a browser executes; nothing here has a legitimate use for one. */
  it('reads an SVG as markup', () => {
    expect(sniff('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')).toBe('html');
    expect(checkUploadType('logo.svg', Buffer.from('<svg onload="alert(1)"/>')).ok).toBe(false);
  });

  /**
   * The bound on the skip is a thing an upload can be padded past, so an opener
   * with no closer inside the 512-byte head is markup rather than text — else
   * the fix would have swapped one evasion for another with more steps.
   */
  it('reads an unterminated prologue as markup rather than as text', () => {
    expect(sniff(`<!--${'p'.repeat(900)}<html><script>alert(1)</script>`)).toBe('html');
    expect(sniff(`<?xml ${'p'.repeat(900)}<svg/>`)).toBe('html');
  });

  it('leaves ordinary text alone, including text that merely contains a tag', () => {
    expect(sniff('class,shares\ncommon,100')).toBe('text');
    expect(sniff('Revenue grew because x < y and y > z')).toBe('text');
    expect(sniff('notes,value\n"see <html> in the spec",1')).toBe('text');
    expect(sniff('{"a": 1}')).toBe('text');
    expect(checkUploadType('c.csv', Buffer.from('class,shares\ncommon,100')).ok).toBe(true);
  });

  it('refuses markup wearing a text extension', () => {
    const check = checkUploadType('c.csv', Buffer.from('<!-- x --><html><script>y</script></html>'));
    expect(check.ok).toBe(false);
    expect(check.sniffed).toBe('html');
    expect(check.reason).toContain('.csv');
  });
});
