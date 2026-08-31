import { sliceChars } from './textSlice.js';

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
 *     "Q3 memo‮gnp.exe"   renders as   Q3 memoexe.png
 *
 * which is the name the document list shows an analyst, the name the
 * `filename*` parameter tells their browser to save it under, and the name
 * their file manager shows them afterwards. Every layer downstream is honest
 * about the bytes — the extension check, the media-type sniff, the virus scan
 * — and every layer a person reads is not. R217 taught `safeFilename` that an
 * emoji is one character; this is the other thing a name can contain that is
 * not what it looks like.
 *
 * It lives here rather than beside the filename scrub because a filename is
 * not the only string this platform quotes back from a file it was handed: a
 * ZIP entry name and a cell reference are read out of the uploaded bytes and
 * put into a sentence the same way (see {@link quoteForMessage}), and the set
 * of characters that reorder that sentence is the same set. Two copies of it
 * is how the two would come to disagree.
 *
 * Dropped rather than replaced with '_'. These are zero-width, so a
 * substitution puts visible junk into a legitimate Arabic or Hebrew string
 * that carries a mark for ordinary reasons, and the thing being removed has no
 * inert spelling to collapse to — unlike the `{{` in `defang()`, a control's
 * only effect *is* the one being taken away. The zero-width joiners
 * (U+200C/U+200D) are deliberately not in this set: they carry meaning inside
 * an emoji sequence and inside Persian and Indic words, and neither reorders
 * anything.
 */
export const BIDI_CONTROLS = new Set(['؜', '‎', '‏', '‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩']);

/**
 * A character a display *acts on* rather than draws: C0, U+007F, the C1 block
 * (U+0080–U+009F), and U+2028/U+2029, which are line breaks by another name.
 *
 * A terminal reading a problem body — which is what a `curl` or a partner's
 * integration log is — treats these as commands, so a value carrying them can
 * erase the line it was printed on or move the cursor off it. Distinct from
 * {@link BIDI_CONTROLS}, which are drawn as nothing and reorder their
 * neighbours; these are drawn as nothing and do something.
 */
export function isActedOnControl(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/** How much of an untrusted fragment a message keeps. */
const MAX_QUOTED_CHARS = 80;

/**
 * Prepare a string that came out of a file for a sentence a person reads.
 *
 * The uploaded-file readers name what they refused — the ZIP entry, the cell
 * reference — because naming it is the difference between "this workbook is
 * unreadable" and "this part of it is". But the name is read out of the bytes
 * the caller supplied: it is as long as they like (a ZIP entry name has two
 * bytes of length, so 65,535 of them), it can carry the controls above, and it
 * can carry the `"` that closes the quoting the message puts around it.
 *
 * That string ends up in an RFC 9457 `detail` — drawn by the SPA, printed by a
 * terminal, and written into a partner's own log. So: the reordering controls
 * dropped, the acted-on ones replaced by a visible `?` (unlike a filename,
 * nothing here is a name that must stay recognisable enough to look for), the
 * quote replaced with the same, and the whole thing bounded.
 *
 * `sliceChars` rather than `slice`, for the reason a filename uses it: the cut
 * is applied to text that is JSON-encoded on its way out, and a cut landing
 * between the halves of an astral character leaves a lone surrogate that UTF-8
 * cannot encode. See domain/textSlice.ts.
 */
export function quoteForMessage(value: string, max: number = MAX_QUOTED_CHARS): string {
  let cleaned = '';
  for (const ch of value) {
    if (BIDI_CONTROLS.has(ch)) continue;
    cleaned += isActedOnControl(ch) || ch === '"' ? '?' : ch;
  }
  if (cleaned.length <= max) return cleaned || '(unnamed)';
  return `${sliceChars(cleaned, max)}…`;
}
