/**
 * Minimal ZIP reader — the counterpart to the evidence-bundle writer in
 * `export/zip.ts`, used to open `.xlsx` uploads (an OOXML workbook is a ZIP of
 * XML parts). No external dependency: the central directory is walked by hand
 * and deflated entries go through node's built-in `zlib.inflateRawSync`.
 *
 * Scope is deliberately narrow — stored (method 0) and deflate (method 8) only,
 * no ZIP64, no encryption. Anything else raises so the caller can reject the
 * upload with a clear message rather than silently reading a truncated sheet.
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
/** A ZIP comment is a uint16 length, so the EOCD starts at most this far back. */
const MAX_COMMENT = 0xffff;
/** Sentinel the ZIP64 format writes into the 32-bit fields it overflows. */
const ZIP64_SENTINEL = 0xffffffff;

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
 * a lazy handle, and the upload size is already capped by the route.
 */
export function readZip(buf: Buffer): Map<string, Buffer> {
  if (buf.length < EOCD_MIN_SIZE) throw new ZipReadError('File is too small to be a ZIP archive');

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
    if (flags & 0x0001) throw new ZipReadError(`Entry "${name}" is encrypted`);
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL) {
      throw new ZipReadError('ZIP64 archives are not supported');
    }
    if (name.endsWith('/')) continue; // directory marker

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new ZipReadError(`Malformed local header for "${name}"`);
    }
    // The local header's extra field can differ in length from the central
    // one, so the data offset must be computed from the local record.
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const end = start + compressedSize;
    if (end > buf.length) throw new ZipReadError(`Entry "${name}" runs past the end of the archive`);

    const raw = buf.subarray(start, end);
    if (method === 0) {
      entries.set(name, raw);
    } else if (method === 8) {
      try {
        entries.set(name, inflateRawSync(raw));
      } catch {
        throw new ZipReadError(`Entry "${name}" could not be decompressed`);
      }
    } else {
      throw new ZipReadError(`Entry "${name}" uses unsupported compression method ${method}`);
    }
  }

  return entries;
}
