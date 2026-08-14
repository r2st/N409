/**
 * Reading a delivered PDF back, for the routes in this service that serve one.
 *
 * Two suites here assert on what a document *says* — the 409A deliverable and
 * the payment receipt — and both had their own copy of a decoder that split the
 * file on `<...>` and read the bytes inside as Latin-1. That was right while the
 * renderer used the standard-14 faces, whose encoding is very nearly ASCII. It
 * stopped being right the day the renderer embedded a Unicode face: pdfkit
 * subsets what it embeds and writes it as Type0/Identity-H, so those bytes are
 * *glyph indices in the subset* — numbers assigned in the order the glyphs were
 * first used, different in every document. Both suites went on decoding them
 * into mojibake, and 21 assertions failed on text the document does say.
 *
 * Getting the letters back means doing what a reader does: following the face's
 * `/ToUnicode` CMap, which is also the only reason a finished report can be
 * searched or read aloud. `@n409/report`'s test support already does exactly
 * that, and now inflates as well, so this delegates rather than keeping a third
 * copy — a decoder that disagrees with the renderer's own is worse than none.
 */

// Reached across packages on purpose. The alternative is a fourth copy of a
// PDF parser, and a copy that drifts is how this file came to be needed; the
// renderer and the service that serves its output should read a document the
// same way. @n409/report is already a dependency of this service.
export { extractText, pageCount, pageTexts, readPdf } from '../../../../report/test/support/pdfText.js';

import { extractText } from '../../../../report/test/support/pdfText.js';

/** Everything a rendered document draws, in drawing order. */
export function readable(pdf: Buffer): string {
  return extractText(pdf);
}
