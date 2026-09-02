/**
 * Minimal ZIP writer for the evidence bundle (no external dependency beyond
 * node's own `zlib`). UTF-8 filenames (general-purpose flag bit 11), CRC-32 per
 * the ZIP appnote, and per-entry deflate — see {@link deflateWins}.
 */
import { crc32 as zlibCrc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer | string;
  /** Modification time stamped into the archive (defaults to now). */
  mtime?: Date;
}

/**
 * The ZIP appnote's checksum: CRC-32, the IEEE polynomial, over every byte of
 * every entry.
 *
 * `node:zlib` computes it natively. This was a table-driven byte loop in
 * JavaScript, which R330 had already taken from 21.8 ms to 6.2 ms over a 2.7 MB
 * `calculations.json` by indexing rather than iterating — and the loop is the
 * wrong shape of work to hand V8 at all. Over a 7.6 MB entry (twenty runs of a
 * 200-class cap table, which is what `calculations.json` is at this platform's
 * own ceiling) it is **16.6 ms against 0.22 ms**, on the event loop of the
 * process that is also serving every other request.
 *
 * Same polynomial and the same seeding convention, which is not something to
 * take on faith for a checksum: verified equal on 200 random buffers, on the
 * empty buffer, and on the appnote's own `123456789` -> `cbf43926` vector,
 * which `zip.test.ts` pins from the other side.
 *
 * `zlib.crc32` has been in Node since 20.15 and this package requires 22, so
 * there is no version to fall back for.
 */
export function crc32(buf: Buffer): number {
  return zlibCrc32(buf);
}

/** MS-DOS date/time pair as used by the ZIP format (2-second resolution). */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(d.getFullYear(), 1980);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const UTF8_NAMES_FLAG = 0x0800;

/** Stored (method 0) and deflate (method 8), the two `zipReader` accepts. */
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/**
 * Below this, deflating is not worth attempting.
 *
 * A deflate stream carries its own header and a final block, so on a very short
 * entry the compressed form is routinely larger than the input. The check below
 * would catch that and fall back to stored anyway; this just skips the work.
 */
const MIN_DEFLATE_BYTES = 256;

/**
 * Deflate level. Six is zlib's default and the knee of the curve here.
 *
 * Measured on a real `calculations.json` (21 engine runs, 2.67 MB of
 * pretty-printed JSON): level 6 gives 74.6 kB in 10.6 ms, level 1 gives 142.6 kB
 * in 4.2 ms. Both are cheaper than the CRC-32 pass this file already makes over
 * the same bytes, so the faster level buys milliseconds and costs the reader
 * twice the download.
 */
const DEFLATE_LEVEL = 6;

/** Somewhere to say that an entry could not be compressed. */
export interface ZipIssueLog {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

let zipLog: ZipIssueLog | null = null;

/**
 * Install the logger this module reports a failed compression through.
 *
 * A module-level sink for the reason `configureReportPdfLogging` gives about
 * the renderer beside it: `buildZip` is reached from the evidence bundle route
 * and from `export/xlsx.ts`, which is itself called from every workbook
 * download on the platform, and widening all of those signatures to carry a
 * logger would be a lot of plumbing for a line that is written when zlib
 * refuses. Null until a host installs one, which is what a test gets.
 */
export function configureZipLogging(log: ZipIssueLog | null): void {
  zipLog = log;
}

/**
 * Whether this entry ships deflated, decided per entry by trying it.
 *
 * WHY THIS CHANGED (round 330, methodology M8). This writer stored every entry
 * uncompressed, on the stated grounds that "the bundle is mostly JSON + already
 * compressed PDFs". The second half is true of exactly one entry — the rendered
 * report — and the first half is the argument for compressing rather than
 * against it. A bundle is twenty-odd pretty-printed JSON documents, and
 * pretty-printed JSON of repeated record shapes is about as compressible as
 * anything gets: the `calculations.json` measured above is 2.8% of its original
 * size, a 36× reduction, for 10.6 ms of CPU. `calculation-traces.json` is the
 * engine's whole working state per run and compresses harder still.
 *
 * The same writer builds every .xlsx this platform exports (`export/xlsx.ts` —
 * an .xlsx *is* a ZIP of XML parts), so the workbook download was shipping raw
 * XML too. That is the more frequent of the two by a wide margin.
 *
 * Fidelity is not what was being traded away: deflate is lossless, and the CRC
 * and the uncompressed size in both headers are of the *original* bytes, so a
 * reader that inflates and checks gets exactly what the auditor was promised.
 *
 * Per entry rather than by filename, because the question is not what the file
 * is called. The PDF is already deflate-compressed internally and comes back
 * from `deflateRawSync` a shade *larger*; so does a small entry that is mostly
 * its own header. Comparing the two lengths answers that without a list of
 * extensions to keep up to date, and the archive is never larger than it was.
 */
function deflateWins(data: Buffer): Buffer | null {
  if (data.length < MIN_DEFLATE_BYTES) return null;
  try {
    const deflated = deflateRawSync(data, { level: DEFLATE_LEVEL });
    return deflated.length < data.length ? deflated : null;
  } catch (err) {
    /*
     * CONTAINED (round 332, methodology M5). Until R330 this writer never
     * called zlib at all, so `buildZip` could not fail: it read bytes, wrote
     * headers, and concatenated. Compression made an optional step that *can*
     * fail load-bearing for every archive the platform produces — the evidence
     * bundle an auditor is downloading and, far more often, every .xlsx export
     * on the platform, because an .xlsx is a ZIP of XML parts built here.
     *
     * `deflateRawSync` allocates a second copy of the entry and can throw for
     * reasons that have nothing to do with the caller: a buffer over
     * `buffer.kMaxLength`, or `ENOMEM` on a box already under pressure — and a
     * 2.7 MB `calculations.json` on a 3.8 GB host is exactly when the bundle
     * matters. Letting that out turns a download that would have worked into a
     * 500, to save bytes nobody asked to save.
     *
     * The fallback is this function's own contract and needs no new path:
     * `null` is "ship it stored", which is what every entry did before R330.
     * The archive is bigger and completely correct.
     */
    zipLog?.warn(
      { err, bytes: data.length },
      'could not deflate a zip entry; shipping it stored — the archive is larger but complete',
    );
    return null;
  }
}

/**
 * Builds a complete ZIP archive.
 *
 * Entries are deflated where that makes them smaller and stored where it does
 * not; see {@link deflateWins}. Both methods are ones `domain/zipReader.ts`
 * already reads, which is what makes an .xlsx this writes still parseable by
 * the importer on the other side of the platform.
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const name = Buffer.from(entry.name, 'utf8');
    // The checksum and the uncompressed size in both headers describe the
    // original bytes, whichever method carries them — that is the appnote's
    // rule and it is what lets a reader verify what it inflated.
    const crc = crc32(data);
    const deflated = deflateWins(data);
    const stored = deflated ?? data;
    const method = deflated ? METHOD_DEFLATE : METHOD_STORED;
    const { time, date } = dosDateTime(entry.mtime ?? new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8_NAMES_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(UTF8_NAMES_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra/comment/disk/attrs all zero
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(central, name);

    offset += local.length + name.length + stored.length;
  }

  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, ...centrals, eocd]);
}
