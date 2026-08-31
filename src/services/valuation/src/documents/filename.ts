import path from 'node:path';
import { sliceChars } from '../domain/textSlice.js';

/**
 * A character that reorders the text around it rather than being text.
 *
 * The bidirectional formatting controls: the embeddings and overrides
 * (U+202A–U+202E), the isolates (U+2066–U+2069), and the three marks
 * (U+200E, U+200F, U+061C). They have no width and no glyph — their entire
 * effect is on the order the characters *beside* them are drawn in.
 *
 * In a filename that is an extension spoof, and the oldest one there is:
 *
 *     "Q3 memo\u202Egnp.exe"   renders as   Q3 memoexe.png
 *
 * which is the name the document list shows an analyst, the name the
 * `filename*` parameter tells their browser to save it under, and the name
 * their file manager shows them afterwards. Every layer downstream is honest
 * about the bytes — the extension check, the media-type sniff, the virus scan
 * — and every layer a person reads is not. R217 taught this function that an
 * emoji is one character; this is the other thing a name can contain that is
 * not what it looks like.
 *
 * Dropped rather than replaced with '_'. These are zero-width, so a
 * substitution puts visible junk into a legitimate Arabic or Hebrew filename
 * that carries a mark for ordinary reasons, and the thing being removed has no
 * inert spelling to collapse to — unlike the `{{` in `defang()`, a control's
 * only effect *is* the one being taken away. The zero-width joiners
 * (U+200C/U+200D) are deliberately not in this set: they carry meaning inside
 * an emoji sequence and inside Persian and Indic words, and neither reorders
 * anything.
 */
const BIDI_CONTROLS = new Set([
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
]);

/**
 * The characters a filename may not contain, wherever the name came from:
 * path separators, the drive colon, the quote that delimits a header's
 * quoted-string, and the backslash that escapes it. Replaced with '_' and
 * collapsed, so a name stays recognizable rather than losing its shape.
 *
 * The control range replaced alongside them is C0 *and* the two above it that
 * a filename has as little use for: U+007F and the C1 block (U+0080–U+009F),
 * which a terminal or a log viewer may still act on, and U+2028/U+2029, which
 * are line breaks by another name. Everything the display *reorders* rather
 * than acts on is removed instead — see {@link BIDI_CONTROLS}.
 *
 * Written as a loop over a set rather than a regex to avoid a control-char
 * regex literal.
 */
export function scrubFilename(name: string): string {
  const bad = new Set(['\\', '/', ':', '"']);
  let cleaned = '';
  let prevReplaced = false;
  for (const ch of name) {
    if (BIDI_CONTROLS.has(ch)) continue;
    const code = ch.charCodeAt(0);
    const isBad =
      bad.has(ch) || code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    if (isBad) {
      if (!prevReplaced) cleaned += '_';
      prevReplaced = true;
    } else {
      cleaned += ch;
      prevReplaced = false;
    }
  }
  return cleaned.trim();
}

/** How much of a filename is kept. Well inside `documents.filename`'s column. */
const MAX_FILENAME_CHARS = 200;

/**
 * Strip directories and control characters; keep the name recognizable.
 *
 * `basename` first, because the name arrives from a browser that may send a
 * whole path — `C:\Users\me\cap table.xlsx` from an old Windows client — and
 * `cap table.xlsx` is a better answer than `C__Users_me_cap table.xlsx`.
 *
 * The length bound is `sliceChars` rather than `slice`, because this name is
 * written into a `jsonb` event payload and a cut that lands inside an emoji
 * leaves half a character there — which Postgres refuses, taking the upload to
 * a 500. See domain/textSlice.ts.
 *
 * It lives here rather than beside the upload route because `fileType.ts` has
 * to ask the same question: the extension it checks the bytes against must be
 * the extension of the name that ends up stored, not of the one that arrived.
 */
export function safeFilename(name: string): string {
  return sliceChars(scrubFilename(path.basename(name)) || 'upload', MAX_FILENAME_CHARS);
}
