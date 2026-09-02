import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildZip, crc32 } from '../../src/export/zip.js';
import { readZip } from '../../src/domain/zipReader.js';

/** Reads the archive back with a tiny independent parser (appnote layout). */
function parseZip(buf: Buffer) {
  // End-of-central-directory record is the last 22 bytes (no comment).
  const eocd = buf.subarray(buf.length - 22);
  expect(eocd.readUInt32LE(0)).toBe(0x06054b50);
  const count = eocd.readUInt16LE(10);
  const cdOffset = eocd.readUInt32LE(16);

  const entries: Array<{
    name: string;
    crc: number;
    method: number;
    compressedSize: number;
    size: number;
    offset: number;
  }> = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      name: buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
      crc: buf.readUInt32LE(p + 16),
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries.map((e) => {
    // Local header → data bytes.
    expect(buf.readUInt32LE(e.offset)).toBe(0x04034b50);
    const nameLen = buf.readUInt16LE(e.offset + 26);
    const extraLen = buf.readUInt16LE(e.offset + 28);
    // Both headers agree about the method and both sizes; slicing by the
    // compressed one is what makes a deflated entry readable at all.
    expect(buf.readUInt16LE(e.offset + 8)).toBe(e.method);
    expect(buf.readUInt32LE(e.offset + 18)).toBe(e.compressedSize);
    expect(buf.readUInt32LE(e.offset + 22)).toBe(e.size);
    const start = e.offset + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + e.compressedSize);
    return { ...e, data: e.method === 8 ? inflateRawSync(raw) : raw };
  });
}

describe('crc32', () => {
  it('matches the known IEEE test vector', () => {
    // Standard check value for "123456789".
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('empty input is 0', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  /*
   * R367 (M8). The byte loop this replaced was 16.6 ms over a 7.6 MB entry
   * against zlib's 0.22 ms, on the event loop of the process serving every
   * other request — so the checksum now comes from `node:zlib` rather than
   * from a table in this repository.
   *
   * The two vectors above are necessary and not sufficient. CRC-32 comes in
   * variants that agree on `123456789` and on the empty input and disagree
   * elsewhere — reflected or not, complemented or not — and a checksum that is
   * wrong for *some* inputs is the worst version of this defect: the archive
   * still opens for the reader that does not verify, and fails for the auditor
   * who does. So the reference implementation stays, here, where it is the
   * test's model of the appnote rather than the code under test.
   */
  it('agrees with the table-driven reference on arbitrary bytes', () => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    const reference = (buf: Buffer): number => {
      let crc = 0xffffffff;
      for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
      return (crc ^ 0xffffffff) >>> 0;
    };

    // Deterministic rather than random: a checksum test that fails one run in
    // fifty is a test nobody trusts. Lengths either side of a word boundary,
    // all-zero and all-ones runs, and the high bytes a signed reading would
    // mangle.
    const cases: Buffer[] = [
      Buffer.alloc(0),
      Buffer.alloc(1, 0x00),
      Buffer.alloc(1, 0xff),
      Buffer.from('n409-evidence-bundle/1', 'utf8'),
      Buffer.alloc(4096, 0x00),
      Buffer.alloc(4096, 0xff),
    ];
    for (const length of [3, 4, 5, 7, 8, 9, 255, 256, 257, 65_537]) {
      const buf = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1) buf[i] = (i * 31 + (i >> 3)) & 0xff;
      cases.push(buf);
    }
    for (const buf of cases) expect(crc32(buf)).toBe(reference(buf));
  });
});

describe('buildZip', () => {
  it('produces a parseable archive with intact contents and checksums', () => {
    const zip = buildZip([
      { name: 'manifest.json', data: '{"format":"n409-evidence-bundle/1"}' },
      { name: 'report-v3.pdf', data: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]) },
    ]);
    const entries = parseZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['manifest.json', 'report-v3.pdf']);
    expect(entries[0]!.data.toString('utf8')).toBe('{"format":"n409-evidence-bundle/1"}');
    expect(Buffer.compare(entries[1]!.data, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]))).toBe(0);
    for (const e of entries) expect(crc32(Buffer.from(e.data))).toBe(e.crc);
  });

  /*
   * R330 (M8). The bundle was shipped stored, on the grounds that it is "mostly
   * JSON + already compressed PDFs" — which is the argument for deflating it.
   * These pin the two halves of the per-entry decision so a later change cannot
   * quietly go back to storing everything or start inflating the PDF.
   */
  it('deflates a compressible entry and stores an incompressible one', () => {
    const json = JSON.stringify(
      Array.from({ length: 400 }, (_, i) => ({ id: i, class: `class_${i % 12}`, shares: 1000 + i })),
      null,
      2,
    );
    // Incompressible bytes — a deflated PDF stream is what this stands in for.
    // Deterministic xorshift so the assertion below is not a coin flip.
    let x = 0x9e3779b9;
    const noise = Buffer.from(
      Array.from({ length: 4096 }, () => {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        return (x >>> 0) & 0xff;
      }),
    );
    const zip = buildZip([
      { name: 'calculations.json', data: json },
      { name: 'report-v3.pdf', data: noise },
    ]);
    const entries = parseZip(zip);

    expect(entries[0]!.method).toBe(8);
    expect(entries[0]!.compressedSize).toBeLessThan(entries[0]!.size / 4);
    expect(entries[0]!.data.toString('utf8')).toBe(json);

    expect(entries[1]!.method).toBe(0);
    expect(entries[1]!.compressedSize).toBe(noise.length);
    expect(Buffer.compare(entries[1]!.data, noise)).toBe(0);

    // The archive is smaller than the bytes that went into it, which is the
    // whole point, and every checksum still describes the original.
    expect(zip.length).toBeLessThan(Buffer.byteLength(json) + noise.length);
    for (const e of entries) expect(crc32(Buffer.from(e.data))).toBe(e.crc);
  });

  it('round-trips through the platform’s own zip reader', () => {
    const xml = `<?xml version="1.0"?><sheetData>${'<row><c><v>12345</v></c></row>'.repeat(300)}</sheetData>`;
    const read = readZip(buildZip([{ name: 'xl/worksheets/sheet1.xml', data: xml }]));
    expect(read.get('xl/worksheets/sheet1.xml')?.toString('utf8')).toBe(xml);
  });

  it('handles an empty archive', () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(22);
    expect(parseZip(zip)).toEqual([]);
  });

  it('preserves utf-8 names and binary content byte-for-byte', () => {
    const payload = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
    const entries = parseZip(buildZip([{ name: 'π/evidence—файл.bin', data: payload }]));
    expect(entries[0]!.name).toBe('π/evidence—файл.bin');
    expect(Buffer.compare(entries[0]!.data, payload)).toBe(0);
  });
});
