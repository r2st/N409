/**
 * Minimal ZIP reader — the counterpart to the evidence-bundle writer in
 * `export/zip.ts`, used to open `.xlsx` uploads (an OOXML workbook is a ZIP of
 * XML parts). No external dependency: the central directory is walked by hand
 * and deflated entries go through node's built-in `zlib.inflateRawSync`.
 *
 * Scope is deliberately narrow — stored (method 0) and deflate (method 8) only,
 * no ZIP64, no encryption. Anything else raises so the caller can reject the
 * upload with a clear message rather than silently reading a truncated sheet.
 *
 * Every refusal that names the entry it refused names it through
 * `quoteForMessage`. The name is read out of the archive the caller uploaded —
 * a uint16 of length, so up to 65,535 bytes of anything at all — and these
 * messages do not stay here: `readXlsx` wraps them as "Could not read the
 * workbook: …" and the cap-table upload route answers a 422 whose `detail` is
 * that string, drawn by the SPA and printed by whatever terminal a curl caller
 * is looking at.
 */

import { inflateRawSync } from 'node:zlib';
import { quoteForMessage } from './displayText.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
/** A ZIP comment is a uint16 length, so the EOCD starts at most this far back. */
const MAX_COMMENT = 0xffff;
/** Sentinel the ZIP64 format writes into the 32-bit fields it overflows. */
const ZIP64_SENTINEL = 0xffffffff;

/**
 * Decompression budget. Deflate reaches roughly 1000:1 on the runs of a single
 * byte a bomb is built from, so the route's 10 MB upload cap bounds the bytes
 * on the wire and nothing at all about the bytes this reader materialises —
 * measured, 511 KiB of archive expands to 512 MiB, and a full-size upload to
 * something near ten gigabytes. Every entry is decompressed eagerly into a
 * Buffer, so that number is resident memory, and the request that asks for it
 * costs an attacker one upload.
 *
 * The budget is what the archive can expand *to*, not the ratio it expands
 * *by*: a ratio alone would let a large archive of highly compressible XML —
 * which is what every real `.xlsx` is — sail past a limit that a small one
 * trips. Scaling with the input keeps the amplification an attacker can buy
 * bounded (they must send a megabyte to cost us twenty), while the floor and
 * ceiling keep both ends sane: no legitimate small workbook is refused, and no
 * archive whatsoever can ask for more than the ceiling.
 */
const MAX_EXPANSION_RATIO = 20;
const MIN_INFLATED_BUDGET = 16 * 1024 * 1024;
const MAX_INFLATED_BUDGET = 128 * 1024 * 1024;

/** Total inflated bytes an archive of `archiveBytes` is allowed to produce. */
export function inflatedBudgetFor(archiveBytes: number): number {
  return Math.min(MAX_INFLATED_BUDGET, Math.max(MIN_INFLATED_BUDGET, archiveBytes * MAX_EXPANSION_RATIO));
}

export class ZipReadError extends Error {}

/** Locate the end-of-central-directory record by scanning back from the tail. */
function findEocd(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new ZipReadError('Not a ZIP archive (no end-of-central-directory record)');
}

/**
 * Read every entry into a name → bytes map. Directory entries are skipped;
 * `.xlsx` archives are small enough that eager decompression is simpler than
 * a lazy handle.
 *
 * Because that decompression is eager, the total it may produce is bounded —
 * see {@link inflatedBudgetFor}. `maxInflatedBytes` overrides the default for
 * a caller that knows its own workbooks are smaller.
 */
export function readZip(buf: Buffer, opts: { maxInflatedBytes?: number } = {}): Map<string, Buffer> {
  if (buf.length < EOCD_MIN_SIZE) throw new ZipReadError('File is too small to be a ZIP archive');

  const budget = opts.maxInflatedBytes ?? inflatedBudgetFor(buf.length);
  let remaining = budget;
  const overBudget = (name: string) =>
    new ZipReadError(
      `Entry "${quoteForMessage(name)}" expands past the ${Math.round(budget / (1024 * 1024))} MB decompression limit ` +
        'for an archive this size',
    );

  const eocd = findEocd(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (centralOffset === ZIP64_SENTINEL || entryCount === 0xffff) {
    throw new ZipReadError('ZIP64 archives are not supported');
  }
  if (centralOffset >= buf.length) throw new ZipReadError('Central directory offset is out of range');

  const entries = new Map<string, Buffer>();
  let cursor = centralOffset;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipReadError('Malformed central directory');
    }
    const method = buf.readUInt16LE(cursor + 10);
    const flags = buf.readUInt16LE(cursor + 8);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLen);
    cursor += 46 + nameLen + extraLen + commentLen;

    // Bit 0 is the "encrypted" flag; we cannot read those bytes at all.
    if (flags & 0x0001) throw new ZipReadError(`Entry "${quoteForMessage(name)}" is encrypted`);
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL) {
      throw new ZipReadError('ZIP64 archives are not supported');
    }
    if (name.endsWith('/')) continue; // directory marker

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new ZipReadError(`Malformed local header for "${quoteForMessage(name)}"`);
    }
    // The local header's extra field can differ in length from the central
    // one, so the data offset must be computed from the local record.
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const end = start + compressedSize;
    if (end > buf.length)
      throw new ZipReadError(`Entry "${quoteForMessage(name)}" runs past the end of the archive`);

    // The declared size is the cheap rejection — it costs no allocation — but
    // it is a number the archive chose, so it can lie in either direction. It
    // is a fast path, never the guard: what actually holds is maxOutputLength,
    // which stops zlib mid-stream rather than after the Buffer exists.
    if (uncompressedSize > remaining || remaining <= 0) throw overBudget(name);

    const raw = buf.subarray(start, end);
    if (method === 0) {
      if (raw.length > remaining) throw overBudget(name);
      entries.set(name, raw);
      remaining -= raw.length;
    } else if (method === 8) {
      let inflated: Buffer;
      try {
        inflated = inflateRawSync(raw, { maxOutputLength: remaining });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw overBudget(name);
        throw new ZipReadError(`Entry "${quoteForMessage(name)}" could not be decompressed`);
      }
      entries.set(name, inflated);
      remaining -= inflated.length;
    } else {
      throw new ZipReadError(
        `Entry "${quoteForMessage(name)}" uses unsupported compression method ${method}`,
      );
    }
  }

  return entries;
}
