import { describe, expect, it } from 'vitest';
import { contentDisposition, safeFilename } from '../../src/routes/documents.js';

/**
 * A filename is the one string on this platform that a person is invited to
 * make a decision from without opening the thing it names.
 *
 * Everything downstream of the upload reads the bytes: `fileType.ts` checks the
 * extension against a list, `mediaType.ts` sniffs the declared type, the
 * scanner reads the content. The analyst reads the name, in the document list,
 * in the download dialog, and afterwards in their own file manager — and the
 * name is drawn by a bidi engine that the checks upstream of it do not have.
 *
 * Every character below is invisible. Each has a real use somewhere; none of
 * them has one in a filename.
 */

/** U+202E, the override that draws everything after it right-to-left. */
const RLO = '\u202E';

const BIDI = [
  '\u061C',
  '\u200E',
  '\u200F',
  '\u202A',
  '\u202B',
  '\u202C',
  '\u202D',
  '\u202E',
  '\u2066',
  '\u2067',
  '\u2068',
  '\u2069',
];

describe('a filename that is not what it is drawn as', () => {
  // The classic, and the reason this is worth a guard rather than a note: the
  // stored name ends `.exe`, the drawn name ends `.png`, and the person
  // deciding whether to open it reads the second one.
  it('drops the override that reverses the extension', () => {
    expect(safeFilename(`Q3 memo${RLO}gnp.exe`)).toBe('Q3 memognp.exe');
  });

  it.each(BIDI)('drops %j wherever it appears', (control) => {
    const name = safeFilename(`a${control}b${control}.pdf`);
    expect(name).toBe('ab.pdf');
    for (const other of BIDI) expect(name).not.toContain(other);
  });

  // Zero-width, so a substitution would put visible junk into a name that
  // carries one for ordinary reasons. Removal leaves the rest intact.
  it('leaves the rest of a right-to-left name alone', () => {
    expect(safeFilename(`\u200F\u062A\u0642\u0631\u064A\u0631.pdf`)).toBe(
      '\u062A\u0642\u0631\u064A\u0631.pdf',
    );
  });

  // The joiners are not in the set: they are how an emoji sequence and a
  // Persian word are spelled, and neither reorders anything. R217 taught this
  // function that an emoji is one character; it stays one here.
  it('keeps the joiners a name is genuinely made of', () => {
    expect(safeFilename('family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}.pdf')).toBe(
      'family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}.pdf',
    );
    expect(safeFilename('\u0645\u06CC\u200C\u062E\u0648\u0627\u0646\u0645.txt')).toBe(
      '\u0645\u06CC\u200C\u062E\u0648\u0627\u0646\u0645.txt',
    );
  });

  // Acted on rather than reordered, so these follow the path separators and
  // become a visible '_' instead of disappearing.
  it('replaces the controls above C0 that a terminal still acts on', () => {
    expect(safeFilename('a\u007Fb.pdf')).toBe('a_b.pdf');
    expect(safeFilename('a\u009Bb.pdf')).toBe('a_b.pdf');
    expect(safeFilename('a\u2028b.pdf')).toBe('a_b.pdf');
    expect(safeFilename('a\u2029b.pdf')).toBe('a_b.pdf');
  });

  it('still does everything it did before', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('C:\\Users\\me\\cap table.xlsx')).toBe('C_Users_me_cap table.xlsx');
    expect(safeFilename('')).toBe('upload');
    expect(safeFilename('\u{1F600} report.pdf')).toBe('\u{1F600} report.pdf');
  });

  // The header is built from the same scrub, so the spoof does not survive
  // into the name the browser saves the file under either.
  it('keeps the override out of both halves of the disposition header', () => {
    const header = contentDisposition(`Q3 memo${RLO}gnp.exe`);
    expect(header).not.toContain(RLO);
    expect(header).not.toContain('%E2%80%AE');
  });
});
