import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildZip, crc32 } from '../../src/export/zip.js';
import { readZip, ZipReadError } from '../../src/domain/zipReader.js';

/**
 * Builds a ZIP whose entries are deflated (method 8). `buildZip` only emits
 * stored entries, but every real `.xlsx` is deflated, so that path needs its
 * own fixture.
 */
function buildDeflatedZip(entries: Array<{ name: string; data: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = Buffer.from(entry.data, 'utf8');
    const deflated = deflateRawSync(raw);
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + deflated.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

describe('zipReader', () => {
  it('reads stored entries', () => {
    const zip = buildZip([
      { name: 'a.txt', data: 'hello' },
      { name: 'nested/b.xml', data: '<x/>' },
    ]);
    const entries = readZip(zip);
    expect(entries.get('a.txt')?.toString('utf8')).toBe('hello');
    expect(entries.get('nested/b.xml')?.toString('utf8')).toBe('<x/>');
  });

  it('inflates deflated entries', () => {
    // Repetitive content so deflate actually compresses rather than storing.
    const body = 'row,'.repeat(500);
    const entries = readZip(buildDeflatedZip([{ name: 'big.csv', data: body }]));
    expect(entries.get('big.csv')?.toString('utf8')).toBe(body);
  });

  it('preserves UTF-8 entry names and content', () => {
    const entries = readZip(buildZip([{ name: 'ünïcode/€.txt', data: 'café — 日本' }]));
    expect(entries.get('ünïcode/€.txt')?.toString('utf8')).toBe('café — 日本');
  });

  it('finds the central directory past a trailing archive comment', () => {
    const zip = buildZip([{ name: 'a.txt', data: 'hi' }]);
    const withComment = Buffer.concat([zip, Buffer.from('trailing junk', 'utf8')]);
    withComment.writeUInt16LE(13, withComment.length - 13 - 2);
    expect(readZip(withComment).get('a.txt')?.toString('utf8')).toBe('hi');
  });

  it('rejects input that is not a ZIP archive', () => {
    expect(() => readZip(Buffer.from('just some text, not a zip at all'))).toThrow(ZipReadError);
    expect(() => readZip(Buffer.alloc(4))).toThrow(/too small/i);
  });

  it('rejects a truncated archive rather than returning partial entries', () => {
    const zip = buildZip([{ name: 'a.txt', data: 'hello world' }]);
    // Keep the EOCD but corrupt the central-directory offset it points at.
    const broken = Buffer.from(zip);
    broken.writeUInt32LE(zip.length - 10, broken.length - 22 + 16);
    expect(() => readZip(broken)).toThrow(ZipReadError);
  });

  it('reports encrypted entries instead of emitting ciphertext', () => {
    const zip = Buffer.from(buildZip([{ name: 'a.txt', data: 'secret' }]));
    const centralOffset = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt16LE(0x0001, centralOffset + 8); // general-purpose bit 0
    expect(() => readZip(zip)).toThrow(/encrypted/i);
  });

  it('reports an unsupported compression method by number', () => {
    const zip = Buffer.from(buildZip([{ name: 'a.txt', data: 'x' }]));
    const centralOffset = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt16LE(14, centralOffset + 10); // LZMA
    expect(() => readZip(zip)).toThrow(/unsupported compression method 14/i);
  });
});
