/**
 * What the browser saves the file as.
 *
 * `apiDownload` reads the name out of `content-disposition` rather than using
 * the caller's guess, and the server writes that header twice over: an ASCII
 * `filename` for old clients and an RFC 5987 `filename*` carrying the real
 * UTF-8 bytes. The ASCII half is a lossy transliteration by construction — the
 * server replaces every character ASCII cannot spell with `_` — so reading it
 * in preference to the ext-value is how a correctly-named file arrives on disk
 * with its name destroyed.
 *
 * The tests are split in two. The `dispositionFilename` block is the parser,
 * where the malformed and adversarial headers live; the `apiDownload` block
 * proves the parser is actually the thing that decides `a.download`, since a
 * correct parser wired to nothing would pass the first block completely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiDownload, dispositionFilename } from '../src/lib/api';

/** What the valuation service's `contentDisposition()` emits for `name`. */
function serverHeader(name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_');
  const encoded = [...name]
    .map((ch) =>
      /[0-9A-Za-z\-._~]/.test(ch)
        ? ch
        : [...new TextEncoder().encode(ch)]
            .map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0'))
            .join(''),
    )
    .join('');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

describe('dispositionFilename', () => {
  it('prefers the UTF-8 ext-value over the lossy ASCII fallback', () => {
    // The regression: the ASCII half of this very header is
    // `_ngstr_m-cap-table.xlsx`, and it used to win.
    const header = serverHeader('Ångström-cap-table.xlsx');
    expect(header).toContain('filename="_ngstr_m-cap-table.xlsx"');
    expect(dispositionFilename(header, 'fallback.xlsx')).toBe('Ångström-cap-table.xlsx');
  });

  it('reads a name that ASCII cannot approximate at all', () => {
    expect(dispositionFilename(serverHeader('資本政策表.xlsx'), 'fallback.xlsx')).toBe('資本政策表.xlsx');
  });

  it('accepts an ext-value whose language subtag is present', () => {
    expect(dispositionFilename("attachment; filename*=UTF-8'de'M%C3%BCller.csv", 'f.csv')).toBe('Müller.csv');
  });

  it('decodes an iso-8859-1 ext-value by code point, not as UTF-8 bytes', () => {
    // %E9 is a lone continuation-free byte: valid Latin-1 'é', invalid UTF-8.
    expect(dispositionFilename("attachment; filename*=ISO-8859-1''caf%E9.csv", 'f.csv')).toBe('café.csv');
  });

  it('uses the ASCII form when there is no ext-value', () => {
    expect(dispositionFilename('attachment; filename="users.csv"', 'fallback.csv')).toBe('users.csv');
  });

  it('falls back to the ASCII form when the ext-value will not decode', () => {
    // A truncated percent sequence — `decodeURIComponent` throws on this.
    const header = `attachment; filename="plain.csv"; filename*=UTF-8''broken%E`;
    expect(dispositionFilename(header, 'caller.csv')).toBe('plain.csv');
  });

  it('falls back for a charset it does not know', () => {
    const header = `attachment; filename="plain.csv"; filename*=Shift_JIS''%82%A0.csv`;
    expect(dispositionFilename(header, 'caller.csv')).toBe('plain.csv');
  });

  it("falls back for an ext-value that isn't one — no apostrophes at all", () => {
    expect(dispositionFilename('attachment; filename="p.csv"; filename*=nonsense', 'c.csv')).toBe('p.csv');
  });

  it("uses the caller's name when the header names nothing", () => {
    expect(dispositionFilename('attachment', 'caller.csv')).toBe('caller.csv');
    expect(dispositionFilename('', 'caller.csv')).toBe('caller.csv');
  });

  it('does not let a decoded name turn into a path', () => {
    // The server strips separators before it encodes, so this cannot come from
    // our own service — it is the header being treated as data regardless.
    const header = "attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd";
    expect(dispositionFilename(header, 'safe.csv')).toBe('....etcpasswd');
  });

  it('rejects a name that is only separators rather than saving as empty', () => {
    expect(dispositionFilename("attachment; filename*=UTF-8''%2F%2F", 'safe.csv')).toBe('safe.csv');
    expect(dispositionFilename('attachment; filename=""', 'safe.csv')).toBe('safe.csv');
  });
});

describe('apiDownload names the anchor from the header', () => {
  let anchors: HTMLAnchorElement[];

  beforeEach(() => {
    anchors = [];
    // jsdom implements neither half of the object-URL API, so these are
    // assigned rather than spied — there is nothing there to spy on.
    Object.assign(URL, { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} });
    // The anchor is created, clicked and removed inside `apiDownload`, so the
    // only way to see its `download` is to catch it on the way past.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push(this);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function respondWith(header: string): void {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Blob(['x']), { status: 200, headers: { 'content-disposition': header } }),
    );
  }

  it('saves an uploaded document under the name it was uploaded with', async () => {
    respondWith(serverHeader('Ångström-cap-table.xlsx'));
    await apiDownload('/valuations/v1/documents/d1/download', 'Ångström-cap-table.xlsx');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.download).toBe('Ångström-cap-table.xlsx');
  });

  it("keeps the caller's name when the server sends no disposition at all", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob(['x']), { status: 200 }));
    await apiDownload('/valuations/export?format=csv', 'valuations.csv');
    expect(anchors[0]!.download).toBe('valuations.csv');
  });
});
