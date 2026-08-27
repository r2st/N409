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

/** Extension → the content categories that are legitimate for it. */
const EXTENSION_CATEGORIES: Record<string, SniffedCategory[]> = {
  pdf: ['pdf'],
  png: ['png'],
  jpg: ['jpeg'],
  jpeg: ['jpeg'],
  gif: ['gif'],
  xlsx: ['zip'],
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
 * Validates that `buffer`'s sniffed type is consistent with the file extension.
 * Always rejects executables and HTML masquerading as a document; for known
 * extensions requires the sniffed category to match; unknown extensions pass
 * unless the content is executable.
 */
export function checkUploadType(filename: string, buffer: Buffer): UploadTypeCheck {
  const sniffed = sniffCategory(buffer);

  if (sniffed === 'executable') {
    return { ok: false, sniffed, reason: 'file content is an executable/script' };
  }

  const ext = extensionOf(filename);
  const expected = EXTENSION_CATEGORIES[ext];

  if (!expected) {
    // Unknown/absent extension: allow anything that isn't executable, but block
    // HTML which is only ever dangerous here.
    if (sniffed === 'html') return { ok: false, sniffed, reason: 'HTML content is not an accepted upload' };
    return { ok: true, sniffed };
  }

  if (sniffed === 'html' && !expected.includes('html')) {
    return { ok: false, sniffed, reason: `HTML content uploaded as a .${ext} file` };
  }

  // Text/extractable formats feed the AI pipeline directly, so their content
  // must actually be text — a binary (pdf/png/zip signature, or NUL bytes)
  // hiding behind a .csv/.txt/.json is rejected. Benign binary-vs-binary
  // extension mismatches (e.g. a PNG named .gif) are tolerated: low risk, and
  // over-strict sniffing rejects legitimate but oddly-named files.
  if (expected.includes('text') && sniffed !== 'text') {
    return { ok: false, sniffed, reason: `.${ext} must be text but the content is ${sniffed}` };
  }

  return { ok: true, sniffed };
}
