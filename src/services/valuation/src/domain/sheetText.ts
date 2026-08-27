/**
 * Turn the bytes of an uploaded non-workbook file into the text the CSV parser
 * reads.
 *
 * The upload endpoint used to do this with `buffer.toString('utf8')`, which is
 * three separate assumptions in one call: that the file is text, that the text
 * is UTF-8, and that anything else is close enough. None of them holds for the
 * files a cap-table importer actually receives, and every failure was silent —
 * `toString` does not throw, it substitutes U+FFFD — so each one arrived as
 * "No cap-table rows were found", which is a statement about the *sheet* made
 * about a file that was never read.
 *
 * What comes in that is not a UTF-8 CSV:
 *
 *  - **A password-protected `.xlsx`.** Encrypted OOXML is not a ZIP at all; it
 *    is an OLE2 compound file, so `looksLikeXlsx` says no, and the extension is
 *    `.xlsx`, so the legacy-format branch — which lists `.xls`, not `.xlsx` —
 *    says no too. It fell through to being read as delimited text. A real
 *    `.xls`, or a `.doc`, renamed to `.csv` lands in the same place.
 *  - **UTF-16.** "Save as → Unicode Text" and several administrators' exports
 *    write UTF-16LE with a BOM. Decoded as UTF-8 every character comes back
 *    with a NUL beside it, so the header row is `c·l·a·s·s·` — column names
 *    that match no mapping, for a file that is perfectly well-formed.
 *  - **Latin-1 / Windows-1252.** Excel on Windows writes the ANSI code page
 *    unless "CSV UTF-8" is picked, and a French or German cap table is full of
 *    accented holder names. Each one became U+FFFD, so a security class named
 *    `Série A` imported as `S<?>rie A` — a class name that will not match the
 *    same class on any later import or reconciliation.
 *
 * So: refuse what is not text, with a message that says what the file is; read
 * the encodings a spreadsheet writes; and fall back to Windows-1252 only for
 * bytes that are not valid UTF-8, which leaves every UTF-8 file decoded exactly
 * as it was before.
 */

export class SheetTextError extends Error {}

/** Leading bytes that identify a container this is not going to read as text. */
const BINARY_SIGNATURES: Array<{ magic: number[]; message: string }> = [
  {
    // OLE2 / Compound File Binary — a password-protected .xlsx, or a legacy
    // .xls/.doc whatever it has been renamed to.
    magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
    message:
      'This file is a password-protected or legacy Excel workbook, which cannot be read. ' +
      'Remove the password, or re-save it as .xlsx or CSV, and upload it again',
  },
  { magic: [0x25, 0x50, 0x44, 0x46], message: 'This file is a PDF — upload the cap table as .xlsx or CSV' },
  {
    magic: [0x7b, 0x5c, 0x72, 0x74, 0x66],
    message: 'This file is RTF, not a spreadsheet — re-save it as .xlsx or CSV',
  },
];

function startsWith(buf: Buffer, magic: readonly number[]): boolean {
  return buf.length >= magic.length && magic.every((byte, i) => buf[i] === byte);
}

/**
 * Two bytes per character with a zero high byte is UTF-16LE even without a BOM,
 * and the mirror of it is UTF-16BE. Sampled over the head of the file rather
 * than the whole of it — a cap table's first kilobyte is its header row and
 * first holdings, which is as representative as the file gets.
 *
 * The threshold is a majority rather than all: a UTF-16 file with an astral
 * character in it has surrogate pairs whose halves are not ASCII, and one emoji
 * in a company name should not decide the encoding.
 */
function looksLikeUtf16(buf: Buffer, offset: 0 | 1): boolean {
  const end = Math.min(buf.length, 1024);
  let zeros = 0;
  let pairs = 0;
  for (let i = offset; i + 1 < end; i += 2) {
    pairs += 1;
    if (buf[i] === 0) zeros += 1;
  }
  return pairs >= 8 && zeros > pairs / 2;
}

/** UTF-16BE read through the LE decoder by swapping each pair. */
function swap16(buf: Buffer): Buffer {
  const out = Buffer.from(buf);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const hi = out[i]!;
    out[i] = out[i + 1]!;
    out[i + 1] = hi;
  }
  return out;
}

/** Is every byte a valid UTF-8 sequence? `fatal` is what makes the decoder say so. */
function isUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode an uploaded delimited-text file, or refuse it with a message naming
 * what it is.
 *
 * The leading BOM is left in the returned string: `parseCsvSheet` strips
 * U+FEFF itself, on every path into it, and stripping it in two places is how
 * the two would come to disagree.
 */
export function decodeSheetText(buf: Buffer): string {
  for (const { magic, message } of BINARY_SIGNATURES) {
    if (startsWith(buf, magic)) throw new SheetTextError(message);
  }

  // UTF-32 writes a UTF-16 BOM followed by two more zero bytes; nothing a
  // spreadsheet saves is UTF-32, so it is named rather than mis-decoded.
  if (startsWith(buf, [0xff, 0xfe, 0x00, 0x00]) || startsWith(buf, [0x00, 0x00, 0xfe, 0xff])) {
    throw new SheetTextError('This file is UTF-32 text — re-save it as UTF-8 CSV and upload it again');
  }
  if (startsWith(buf, [0xff, 0xfe])) return buf.subarray(2).toString('utf16le');
  if (startsWith(buf, [0xfe, 0xff])) return swap16(buf.subarray(2)).toString('utf16le');
  if (!startsWith(buf, [0xef, 0xbb, 0xbf])) {
    if (looksLikeUtf16(buf, 1)) return buf.toString('utf16le');
    if (looksLikeUtf16(buf, 0)) return swap16(buf).toString('utf16le');
  }

  const text = isUtf8(buf) ? buf.toString('utf8') : new TextDecoder('windows-1252').decode(buf);
  // Whatever encoding it was read as, a NUL is not something a spreadsheet
  // writes into a cell — the file is some container this does not recognise,
  // and reading it as a sheet would report its bytes as column names.
  if (text.includes('\u0000')) {
    throw new SheetTextError(
      'This file is not a spreadsheet or a text file — upload the cap table as .xlsx or CSV',
    );
  }
  return text;
}
