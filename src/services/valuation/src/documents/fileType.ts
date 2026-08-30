/**
 * Magic-byte upload validation (audit B-1 P2). Size + extension were checked, but
 * the file's *actual* type wasn't confirmed against what it claims to be, and
 * extractable uploads feed the AI pipeline directly. This sniffs the leading
 * bytes and rejects a file whose real content contradicts its extension — e.g. a
 * `text/html` payload uploaded as `report.pdf`, or an executable renamed `.csv`.
 * It is not antivirus; it closes the "declared type is a lie" gap cheaply.
 */

export type SniffedCategory =
  'pdf' | 'png' | 'jpeg' | 'gif' | 'zip' | 'html' | 'executable' | 'text' | 'unknown';

const startsWith = (buf: Buffer, sig: number[], offset = 0): boolean =>
  buf.length >= offset + sig.length && sig.every((b, i) => buf[offset + i] === b);

/** Best-effort content category from the leading bytes. */
export function sniffCategory(buffer: Buffer): SniffedCategory {
  if (buffer.length === 0) return 'unknown';

  // Binary signatures.
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) return 'pdf'; // %PDF
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return 'gif'; // GIF8
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buffer, [0x50, 0x4b, 0x05, 0x06]))
    return 'zip'; // also xlsx/docx (zip containers)
  // Executables / dangerous binaries.
  if (startsWith(buffer, [0x7f, 0x45, 0x4c, 0x46])) return 'executable'; // ELF
  if (startsWith(buffer, [0x4d, 0x5a])) return 'executable'; // MZ (PE)
  if (
    startsWith(buffer, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWith(buffer, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWith(buffer, [0xcf, 0xfa, 0xed, 0xfe])
  )
    return 'executable'; // Mach-O

  // Text-ish: look for a markup marker or reject on NUL bytes (binary).
  const head = buffer.subarray(0, 512);
  if (head.includes(0x00)) return 'unknown'; // NUL → not text
  const text = head.toString('utf8').trimStart().toLowerCase();
  if (text.startsWith('#!')) return 'executable'; // shebang script
  if (isMarkup(text)) return 'html';
  return 'text';
}

/**
 * The prologue a markup document may carry before its first real element, and
 * which the marker test used to be defeated by (round 182).
 *
 * The test was `text.startsWith('<html')` on the trimmed head, which asks
 * whether the file *begins* with markup rather than whether it *is* markup.
 * Everything HTML and XML allow in front of the root element evaded it:
 *
 *   <!-- anything --><html><script>…       → sniffed as plain text
 *   <?xml version="1.0"?><svg …>           → sniffed as plain text
 *
 * so a script-carrying document uploaded as `.csv` passed the very check whose
 * job is "HTML content uploaded as a .csv file" — the one place a text
 * extension's content is examined at all, because a `.csv` has no signature to
 * check it against. Skipping the prologue costs one loop and the evasion goes
 * with it.
 *
 * A leading UTF-8 BOM needs nothing here: `U+FEFF` is `<ZWNBSP>` in the
 * WhiteSpace production, so `trimStart` has already removed it.
 */
const PROLOGUES = [
  { open: '<!--', close: '-->' },
  // XML declaration or processing instruction: `<?xml version="1.0"?>`.
  { open: '<?', close: '?>' },
] as const;

/** Markers that make the element after the prologue markup a browser executes. */
const MARKUP_MARKERS = ['<!doctype html', '<html', '<script', '<svg'] as const;

/**
 * Whether the head reads as markup.
 *
 * The `unterminated` case is markup rather than text, and that is the whole
 * point of doing this in a loop. Bounding the skip to the 512-byte head is what
 * makes the check cheap, and a bound is a thing an upload can be padded past:
 * `<!--` followed by six hundred bytes of filler and then `<html><script>` has
 * no `-->` inside the window, so a reader that gave up and called it text would
 * have swapped one evasion for another with more steps. A file whose very first
 * characters open an HTML comment or an XML declaration is not a cap table
 * under any reading, terminated within the window or not.
 */
function isMarkup(text: string): boolean {
  let rest = text;
  for (;;) {
    const before = rest;
    for (const { open, close } of PROLOGUES) {
      if (!rest.startsWith(open)) continue;
      const end = rest.indexOf(close, open.length);
      if (end < 0) return true; // unterminated inside the head — see above
      rest = rest.slice(end + close.length);
      break;
    }
    // A non-HTML doctype (`<!DOCTYPE svg …>`) is prologue; the HTML one is a
    // marker in its own right and must not be skipped past.
    if (rest.startsWith('<!doctype ') && !rest.startsWith('<!doctype html')) {
      const end = rest.indexOf('>');
      if (end < 0) return true;
      rest = rest.slice(end + 1);
    }
    rest = rest.trimStart();
    if (rest === before) break;
  }
  return MARKUP_MARKERS.some((marker) => rest.startsWith(marker));
}

/**
 * Extension → the content categories that are legitimate for it.
 *
 * An extension that is *missing* here is not neutral: `checkUploadType` treats
 * an unknown extension as "anything that is not an executable or HTML", which
 * is the weakest answer this function gives. `.xlsm` was missing, and `.xlsm`
 * is one of the eight extensions `EXTRACTABLE_EXTENSIONS` ships to the AI
 * service — so the one class of upload whose bytes are read by a model was also
 * the one whose bytes were never checked against what the file claimed to be,
 * while the `.xlsx` beside it had to be a ZIP. `extractableFileTypes.test.ts`
 * holds the two lists together so the next format added to one is added to both.
 */
export const EXTENSION_CATEGORIES: Record<string, SniffedCategory[]> = {
  pdf: ['pdf'],
  png: ['png'],
  jpg: ['jpeg'],
  jpeg: ['jpeg'],
  gif: ['gif'],
  xlsx: ['zip'],
  // Macro-enabled, and an OOXML package like any other: still a ZIP.
  xlsm: ['zip'],
  docx: ['zip'],
  zip: ['zip'],
  // Text/extractable formats have no signature; they must sniff as plain text.
  csv: ['text'],
  tsv: ['text'],
  txt: ['text'],
  md: ['text'],
  json: ['text'],
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

export interface UploadTypeCheck {
  ok: boolean;
  sniffed: SniffedCategory;
  reason?: string;
}

/**
 * What the sniffed content actually looked like, for a reader who did not
 * choose the word.
 *
 * `sniffed` is an internal category and three of the five are jargon at the
 * point of use: a client told their file "is zip" has to work out that this is
 * what a modern spreadsheet is made of. The reason strings quote these instead.
 */
const SNIFFED_DESCRIPTION: Record<SniffedCategory, string> = {
  zip: 'a zip archive (which is also what .xlsx and .docx files are made of)',
  pdf: 'a PDF',
  png: 'a PNG image',
  jpeg: 'a JPEG image',
  gif: 'a GIF image',
  html: 'a web page',
  executable: 'a program',
  text: 'plain text',
  unknown: 'binary data of no recognised type',
};

/**
 * Validates that `buffer`'s sniffed type is consistent with the file extension.
 * Always rejects executables and HTML masquerading as a document; for known
 * extensions requires the sniffed category to match; unknown extensions pass
 * unless the content is executable.
 *
 * Each `reason` states what to do as well as what was wrong (round 222). They
 * used to stop at the finding — `.csv must be text but the content is zip` —
 * which names the mismatch accurately and leaves the reader holding a file they
 * cannot see inside and a sentence about a format they did not know they had
 * sent. There is a real, specific remedy behind every one of these, and it is
 * usually thirty seconds of work: this is nearly always somebody who renamed a
 * spreadsheet rather than exporting it, or saved a page from a browser.
 */
export function checkUploadType(filename: string, buffer: Buffer): UploadTypeCheck {
  const sniffed = sniffCategory(buffer);

  if (sniffed === 'executable') {
    return {
      ok: false,
      sniffed,
      reason:
        'the content is a program or script rather than a document. If this is a spreadsheet or ' +
        'a report, re-export it from the application it came from and upload that file',
    };
  }

  const ext = extensionOf(filename);
  const expected = EXTENSION_CATEGORIES[ext];

  if (!expected) {
    // Unknown/absent extension: allow anything that isn't executable, but block
    // HTML which is only ever dangerous here.
    if (sniffed === 'html') {
      return {
        ok: false,
        sniffed,
        reason:
          'the content is a web page. Saving a page from a browser stores the page rather than ' +
          'the document on it — use the site’s own download or print-to-PDF option instead',
      };
    }
    return { ok: true, sniffed };
  }

  if (sniffed === 'html' && !expected.includes('html')) {
    return {
      ok: false,
      sniffed,
      reason:
        `it is named .${ext} but the content is a web page. Saving a page from a browser stores ` +
        'the page rather than the document on it — use the site’s own download or print-to-PDF ' +
        'option instead',
    };
  }

  // Text/extractable formats feed the AI pipeline directly, so their content
  // must actually be text — a binary (pdf/png/zip signature, or NUL bytes)
  // hiding behind a .csv/.txt/.json is rejected. Benign binary-vs-binary
  // extension mismatches (e.g. a PNG named .gif) are tolerated: low risk, and
  // over-strict sniffing rejects legitimate but oddly-named files.
  if (expected.includes('text') && sniffed !== 'text') {
    // The overwhelmingly common case is a spreadsheet renamed to .csv rather
    // than exported as one, so that is the remedy given first and by name.
    const remedy =
      sniffed === 'zip'
        ? `Renaming a spreadsheet to .${ext} does not convert it — open it and use ` +
          '“Save as” or “Export” to write a real CSV, or upload the .xlsx as it is'
        : `Upload it under its own extension, or export the contents as ${ext.toUpperCase()} first`;
    return {
      ok: false,
      sniffed,
      reason: `it is named .${ext}, which must contain text, but the content is ${SNIFFED_DESCRIPTION[sniffed]}. ${remedy}`,
    };
  }

  return { ok: true, sniffed };
}
