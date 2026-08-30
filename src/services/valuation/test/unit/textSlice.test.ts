import { describe, expect, it } from 'vitest';
import { ellipsize, sliceChars } from '../../src/domain/textSlice.js';
import { safeFilename } from '../../src/routes/documents.js';
import { sanitizeSheetName } from '../../src/export/xlsx.js';

/**
 * R217, methodology M6: the bounds this service applies to text it did not
 * write, and the half-character a plain `slice` leaves behind.
 *
 * The input is not exotic. A phone names a photo with an emoji in it and a
 * client uploads it; a company calls itself something with one. What makes it
 * a bug is the *bound* — 200 characters for a filename, 31 for a sheet name —
 * landing between the two UTF-16 halves of one character.
 */
const GRIN = '\u{1F600}';

describe('sliceChars', () => {
  it('is `slice` for everything that fits, and for a clean cut', () => {
    expect(sliceChars('abc', 10)).toBe('abc');
    expect(sliceChars('abcdef', 3)).toBe('abc');
    expect(sliceChars('', 3)).toBe('');
  });

  it('drops the orphan rather than emitting half a character', () => {
    // 'a' + high + low; a bound of 2 lands between the halves.
    const s = `a${GRIN}`;
    expect(sliceChars(s, 2)).toBe('a');
    expect(sliceChars(s, 3)).toBe(s);
    expect([...sliceChars(s, 2)].every((c) => c.codePointAt(0)! < 0xd800)).toBe(true);
  });

  it('never returns a string with an unpaired surrogate, at any bound', () => {
    const run = `${'x'.repeat(5)}${GRIN}${'y'.repeat(5)}${GRIN}`;
    for (let n = 0; n <= run.length + 2; n++) {
      const out = sliceChars(run, n);
      expect(JSON.stringify(out).includes('\\ud'), `bound ${n}`).toBe(false);
    }
  });

  it('keeps a low surrogate whose high half survived the cut', () => {
    // The pair is whole at the boundary, so nothing is dropped.
    expect(sliceChars(`${GRIN}z`, 2)).toBe(GRIN);
  });
});

describe('ellipsize', () => {
  it('leaves short values alone and marks what it cut', () => {
    expect(ellipsize('short', 80)).toBe('short');
    const out = ellipsize('x'.repeat(200), 80);
    expect(out.length).toBe(78);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not cut through a character to make room for the ellipsis', () => {
    const long = `${'x'.repeat(76)}${GRIN}${'y'.repeat(40)}`;
    expect(JSON.stringify(ellipsize(long, 80)).includes('\\ud')).toBe(false);
  });
});

describe('the bounds that were cutting characters in half', () => {
  it('safeFilename: 199 characters and an emoji, which used to 500', () => {
    // The name is written into a `jsonb` event payload; Postgres refuses an
    // unpaired `\ud800` escape, so the upload came back a server error.
    for (const pad of [197, 198, 199, 200]) {
      const out = safeFilename(`${'a'.repeat(pad)}${GRIN}.pdf`);
      expect(out.length, `pad ${pad}`).toBeLessThanOrEqual(200);
      expect(JSON.stringify(out).includes('\\ud'), `pad ${pad}`).toBe(false);
    }
  });

  it('sanitizeSheetName: 30 characters and an emoji', () => {
    // XML has no production for a lone surrogate either; it reaches the
    // workbook as U+FFFD, in the one string a reader sees before any cell.
    for (let pad = 28; pad <= 32; pad++) {
      const out = sanitizeSheetName(`${'A'.repeat(pad)}${GRIN}`, new Set());
      expect(out.length, `pad ${pad}`).toBeLessThanOrEqual(31);
      expect(JSON.stringify(out).includes('\\ud'), `pad ${pad}`).toBe(false);
    }
  });

  it('sanitizeSheetName: the de-duplicating suffix has the same bound', () => {
    const taken = new Set<string>();
    const name = `${'A'.repeat(26)}${GRIN}`;
    for (let i = 0; i < 3; i++) {
      const out = sanitizeSheetName(name, taken);
      expect(JSON.stringify(out).includes('\\ud'), `attempt ${i}`).toBe(false);
      expect(out.length).toBeLessThanOrEqual(31);
    }
  });
});
