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

/**
 * The characters a message wraps an untrusted fragment in, and which therefore
 * close that wrapping if the fragment contains one.
 *
 * `"` was the whole set, on the strength of the note below — "the `\"` that
 * closes the quoting the message puts around it" — and three sites do not put
 * that quote around it. `routes/engagements.ts` quotes an unknown stage with
 * the typographic pair, under a comment saying the value is caller-supplied
 * and defanged here; so does the treasury curve's tenor. A `to` of
 * `”, and the engagement has been approved` closed the sentence and wrote
 * the rest of it, which is exactly the failure R383 named and the one site
 * that claimed to be handling it.
 *
 * The typographic pair is struck rather than the sites rewritten, so that the
 * *next* message quoting with `“”` — a house typography this codebase
 * uses everywhere else — is safe by construction rather than by review.
 *
 * The apostrophe is deliberately not in the set. No TypeScript message wraps a
 * fragment in one, and it is a character legitimate names carry
 * (`O'Brien Holdings`); the Python twin does strike it, because the engine tier
 * quotes with `'` and its note says so.
 */
export const CLOSING_QUOTES = new Set(['"', '“', '”']);

/** How much of an untrusted fragment a message keeps. */
const MAX_QUOTED_CHARS = 80;

/**
 * What a refusal calls a name with nothing visible left in it.
 *
 * The Python twin's literal too — `test_display_text.py` reads this file, so
 * the two runtimes stay one policy.
 */
const UNNAMED = '(unnamed)';

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
 *
 * THE WALK STOPS WHERE THE ANSWER DOES (round 385, methodology M8). The bound
 * is on what the sentence keeps, and it used to be applied after every
 * character of the value had been examined and concatenated. The values here
 * are not all short: `field_key`, `pipeline`, the template key and the
 * engagement stage are read straight off a request body, which this service
 * caps at Fastify's 1 MiB default, and a ZIP entry name carries two bytes of
 * length of its own. One 1 MB field cost 40 ms of the event loop — the loop
 * every other request in flight is queued behind — to produce 81 characters.
 * This is the twin of the same defect in `app/engine/display_text.py`, where
 * the ceiling is 8 MB and the walk is on the success path.
 *
 * One code unit past the bound is proof the bound applies, so the loop stops
 * there. `sliceChars` reads nothing past `max`, and each input character adds
 * the same code units here as it would have to the whole string, so the prefix
 * reached cuts to exactly what the full clean would have.
 */
export function quoteForMessage(value: string, max: number = MAX_QUOTED_CHARS): string {
  let cleaned = '';
  for (const ch of value) {
    if (BIDI_CONTROLS.has(ch)) continue;
    cleaned += isActedOnControl(ch) || CLOSING_QUOTES.has(ch) ? '?' : ch;
    // Compared in code units because the threshold below it always was: the
    // cut is astral-safe and the length test is not, and making them agree
    // would move a boundary rather than move work off one.
    if (cleaned.length > max) {
      // Asked of the fragment the sentence keeps, before the ellipsis: eighty
      // spaces followed by `…` is the same unreadable quote with a mark on it.
      const head = sliceChars(cleaned, max);
      return head.trim() === '' ? UNNAMED : `${head}…`;
    }
  }
  /*
   * `trim()`, not `cleaned || …`. The marker was written for a name that
   * scrubs away entirely — an empty string, or one made only of reordering
   * controls — and a name of three spaces is truthy, so the refusal read
   * `class '   ' …`: quotes around nothing a reader can see, which is the
   * situation the marker exists for. An imported spreadsheet is where
   * blank-but-present cells come from. The Python twin holds the same rule.
   */
  return cleaned.trim() === '' ? UNNAMED : cleaned;
}
