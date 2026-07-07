import { describe, expect, it } from 'vitest';
import { buildZip, crc32 } from '../../src/export/zip.js';

/** Reads the archive back with a tiny independent parser (appnote layout). */
function parseZip(buf: Buffer) {
  // End-of-central-directory record is the last 22 bytes (no comment).
  const eocd = buf.subarray(buf.length - 22);
  expect(eocd.readUInt32LE(0)).toBe(0x06054b50);
  const count = eocd.readUInt16LE(10);
  const cdOffset = eocd.readUInt32LE(16);

  const entries: Array<{ name: string; crc: number; size: number; offset: number }> = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      name: buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
      crc: buf.readUInt32LE(p + 16),
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
    const start = e.offset + 30 + nameLen + extraLen;
    return { ...e, data: buf.subarray(start, start + e.size) };
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
