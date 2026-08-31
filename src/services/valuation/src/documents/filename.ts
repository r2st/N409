import path from 'node:path';
import { sliceChars } from '../domain/textSlice.js';
import { BIDI_CONTROLS, isActedOnControl } from '../domain/displayText.js';

/**
 * The characters a filename may not contain, wherever the name came from:
 * path separators, the drive colon, the quote that delimits a header's
 * quoted-string, and the backslash that escapes it. Replaced with '_' and
 * collapsed, so a name stays recognizable rather than losing its shape.
 *
 * The control range replaced alongside them — C0, U+007F, the C1 block, and
 * U+2028/U+2029 — is {@link isActedOnControl}, and everything the display
 * *reorders* rather than acts on is dropped instead ({@link BIDI_CONTROLS}).
 * Both live in domain/displayText.ts, because the refusals that quote a name
 * read out of an uploaded file ask exactly the same question of it.
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
    if (bad.has(ch) || isActedOnControl(ch)) {
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
