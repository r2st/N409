import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildZip, crc32 } from '../../src/export/zip.js';
import { inflatedBudgetFor, readZip, ZipReadError } from '../../src/domain/zipReader.js';

interface DeflatedEntry {
  name: string;
  data: string | Buffer;
  /**
   * Uncompressed size to write into the headers instead of the true one, so a
   * fixture can understate what it is about to expand to.
   */
  declaredSize?: number;
}

/**
 * Builds a ZIP whose entries are deflated (method 8). `buildZip` only emits
 * stored entries, but every real `.xlsx` is deflated, so that path needs its
 * own fixture.
 */
function buildDeflatedZip(entries: DeflatedEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const deflated = deflateRawSync(raw);
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(raw);
    const declaredSize = entry.declaredSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(declaredSize, 22);
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
    central.writeUInt32LE(declaredSize, 24);
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

  /*
   * R277, methodology M19. Naming the entry is the point of these messages —
   * "this part of the workbook" beats "this workbook" — but the name is read
   * out of the uploaded archive, and the message does not stay here: `readXlsx`
   * wraps it and the cap-table upload answers a 422 whose `detail` is this
   * string, drawn by the SPA and printed by a terminal.
   *
   * A ZIP entry name is a uint16 of length, so all three of these are what the
   * caller says they are: 65,535 bytes long, a quote that closes the quoting
   * around it, and a right-to-left override that reverses the sentence after it.
   */
  it('bounds and scrubs the entry name it quotes back', () => {
    const hostile = (name: string) => {
      const zip = Buffer.from(buildZip([{ name, data: 'x' }]));
      const centralOffset = zip.readUInt32LE(zip.length - 22 + 16);
      zip.writeUInt16LE(0x0001, centralOffset + 8);
      try {
        readZip(zip);
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error('expected a refusal');
    };

    expect(hostile(`${'n'.repeat(4_000)}.xml`).length).toBeLessThan(200);
    expect(hostile('sheet\u202Elmx.exe')).not.toContain('\u202E');
    // The quote cannot end the quoting the message puts around the name.
    expect(hostile('a".xml')).toContain('a?.xml');
    expect(hostile('a\u0007b.xml')).toContain('a?b.xml');
  });
});

/**
 * A ZIP bomb is a small archive that expands enormously. Deflate reaches about
 * 1000:1 on a run of one repeated byte, so the route's upload cap bounds only
 * the bytes on the wire; without a budget here, 10 MB of upload asks this
 * reader for something near ten gigabytes of resident Buffer.
 *
 * These fixtures are runs of zeros, which is the cheapest way to build the
 * ratio, but nothing depends on the payload: what is asserted is that the
 * reader refuses before it allocates, however the expansion is achieved.
 */
describe('zipReader decompression budget', () => {
  const MIB = 1024 * 1024;
  /**
   * Past the 16 MB floor the budget never goes below, and no further: these
   * fixtures are deflated on every run, so the margin is chosen to prove the
   * point without spending seconds compressing zeros to do it.
   */
  const OVER_BUDGET = Buffer.alloc(24 * MIB);

  it('refuses an entry that declares an expansion past the budget', () => {
    expect(() =>
      readZip(buildDeflatedZip([{ name: 'xl/worksheets/sheet1.xml', data: OVER_BUDGET }])),
    ).toThrow(/expands past the \d+ MB decompression limit/);
  });

  it('refuses an entry that understates how far it expands', () => {
    // The declared size is a number the archive chose. Believing it is the
    // whole trap: this entry claims a kilobyte and ships 24 MB, so only a
    // limit enforced during inflation — not before it — catches this one.
    const lying = buildDeflatedZip([
      { name: 'xl/worksheets/sheet1.xml', data: OVER_BUDGET, declaredSize: 1024 },
    ]);
    expect(() => readZip(lying)).toThrow(ZipReadError);
    expect(() => readZip(lying)).toThrow(/expands past the \d+ MB decompression limit/);
  });

  it('counts the budget across entries, not per entry', () => {
    // Each entry is comfortably inside the budget; together they are 32 MB.
    // A per-entry check would wave every one of them through.
    const drip = buildDeflatedZip(
      Array.from({ length: 8 }, (_, i) => ({
        name: `xl/worksheets/sheet${i}.xml`,
        data: Buffer.alloc(4 * MIB),
      })),
    );
    expect(() => readZip(drip)).toThrow(/expands past the \d+ MB decompression limit/);
  });

  it('applies the budget to stored entries too', () => {
    // Method 0 does not go through zlib, so it needs its own accounting or it
    // is a hole in the budget the deflate path enforces. A stored entry cannot
    // out-run the archive that carries it, so this one is shown an explicit
    // budget rather than the size-derived default.
    const stored = buildZip([{ name: 'a.txt', data: 'x'.repeat(2 * MIB) }]);
    expect(readZip(stored).get('a.txt')?.length).toBe(2 * MIB);
    expect(() => readZip(stored, { maxInflatedBytes: MIB })).toThrow(
      /expands past the 1 MB decompression limit/,
    );
  });

  it('still reads a workbook the size the cap-table route accepts', () => {
    // 2000 rows x 20 columns of inline-string cells — the row cap the upload
    // route enforces, so this is the largest sheet a caller can usefully send.
    // The guard has to leave this untouched or it has broken the feature.
    const rows = Array.from(
      { length: 2000 },
      (_, r) =>
        `<row r="${r + 1}">` +
        Array.from(
          { length: 20 },
          (_, c) =>
            `<c r="${String.fromCharCode(65 + (c % 26))}${r + 1}" t="inlineStr">` +
            `<is><t>Holder ${r + 1}-${c} common stock</t></is></c>`,
        ).join('') +
        '</row>',
    ).join('');
    const sheet = `<worksheet><sheetData>${rows}</sheetData></worksheet>`;

    const entries = readZip(buildDeflatedZip([{ name: 'xl/worksheets/sheet1.xml', data: sheet }]));
    expect(entries.get('xl/worksheets/sheet1.xml')?.toString('utf8')).toBe(sheet);
  });

  it('scales the budget with the archive, between a floor and a ceiling', () => {
    // The floor keeps a small legitimate workbook readable; the ceiling means
    // no archive at all, however large, can ask for unbounded memory.
    expect(inflatedBudgetFor(1024)).toBe(16 * MIB);
    expect(inflatedBudgetFor(4 * MIB)).toBe(80 * MIB); // 20x the input
    expect(inflatedBudgetFor(10 * MIB)).toBe(128 * MIB); // route's upload cap
    expect(inflatedBudgetFor(1024 * MIB)).toBe(128 * MIB);
  });

  it('bounds what the route-sized upload can cost by two orders of magnitude', () => {
    // The property, stated as a number: 10 MB in used to buy ~10 GB out.
    const uploadCap = 10 * MIB;
    expect(inflatedBudgetFor(uploadCap) / uploadCap).toBeLessThan(20);
  });
});
