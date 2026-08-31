/**
 * How big an image *claims* to be, read from its header, before anything
 * decodes it (round 265, methodology M6).
 *
 * A partner's white-label mark is attacker-influenceable byte content reaching
 * an image decoder inside the process that renders a client's 409A report, and
 * every bound in front of it was a bound on the *compressed* size:
 * `MAX_LOGO_BYTES` (1 MiB) on the fetch, `logo_base64` (4 MB of base64) on the
 * render contract, `sniffImageKind` on the first eight bytes. A PNG's declared
 * dimensions are in the header and its pixels are deflated, so none of those
 * says anything about what decoding it costs.
 *
 * Measured: a **995 KB** PNG — inside every cap above — declaring
 * 16000 × 16000 RGBA takes `doc.image` to over **1.2 GB** of resident memory in
 * a single call, in about 200 ms. It is allocated as buffers rather than on the
 * JS heap, so `--max-old-space-size` does not bound it either. On a 3.8 GB host
 * running five services that is an OOM kill of whichever process is rendering
 * — the report service, or the API itself when the offload falls back in
 * process — with no status code, no render issue and no line in the log,
 * because the process does not survive to write one. It is the same shape the
 * connector tier's `MAX_INTEGRATION_JSON_BYTES` exists for, arriving through a
 * decoder instead of a socket.
 *
 * And the pixels are wasted even when they are honest: the mark is drawn into a
 * 140 × 56 pt box on the cover, so nothing above a few hundred thousand pixels
 * can reach a reader's eye.
 *
 * Header-only, deliberately. Reading the declaration is what makes this cheap
 * and what makes it run *before* the allocation; a decoder that disagrees with
 * its own header is still caught by the render's existing catch.
 */

/** Pixels a partner mark may declare. Drawn into 140 × 56 pt, so this is ample. */
export const MAX_IMAGE_PIXELS = 40_000_000;

export interface ImageSize {
  width: number;
  height: number;
}

const PNG_MAGIC = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1');

/**
 * PNG: IHDR is required by the spec to be the first chunk, so width and height
 * are at fixed offsets 16 and 20.
 */
function pngSize(buf: Buffer): ImageSize | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * JPEG: the dimensions live in whichever SOF marker the encoder used, which is
 * somewhere after a run of other segments, so the marker chain is walked.
 *
 * The walk is bounded by the buffer and skips only segments that carry a
 * length; the standalone markers (RSTn, SOI, TEM) have none and are stepped
 * over by hand, which is what stops a crafted stream from walking backwards or
 * standing still.
 */
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(buf: Buffer): ImageSize | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    // Fill bytes: a run of 0xff before the marker proper is legal padding.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // Standalone markers carry no payload length to skip by.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // Start of scan: the entropy-coded data begins and there is no SOF ahead.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = buf.readUInt16BE(i + 2);
    // A length under 2 does not include its own field and would not advance.
    if (length < 2) return null;
    if (SOF_MARKERS.has(marker)) {
      if (i + 9 > buf.length) return null;
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + length;
  }
  return null;
}

/**
 * The dimensions an image declares, or `null` when it declares none this reader
 * understands.
 *
 * `null` is not "small": it is "unmeasured", and the two callers treat it as
 * the same refusal a malformed image gets. Passing an unreadable header through
 * would make the bound optional to anything that can produce one.
 */
export function declaredImageSize(buf: Buffer): ImageSize | null {
  return pngSize(buf) ?? jpegSize(buf);
}

/**
 * Whether these bytes are safe to hand to an image decoder, by the only
 * question that can be answered without decoding them.
 */
export function withinImagePixelBudget(buf: Buffer, maxPixels = MAX_IMAGE_PIXELS): boolean {
  const size = declaredImageSize(buf);
  if (!size) return false;
  if (size.width <= 0 || size.height <= 0) return false;
  return size.width * size.height <= maxPixels;
}
