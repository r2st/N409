import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * zlib refusing to compress must not fail the download (R332, methodology M5).
 *
 * Until R330 this writer never called zlib, so `buildZip` could not fail — it
 * read bytes, wrote headers and concatenated. Compression made an *optional*
 * step load-bearing for every archive the platform produces: the auditor's
 * evidence bundle, and every .xlsx export, because an .xlsx is a ZIP of XML
 * parts built by this same writer.
 *
 * `deflateRawSync` allocates a second copy of the entry, so it throws for
 * reasons that have nothing to do with the caller — a buffer over
 * `buffer.kMaxLength`, `ENOMEM` on a box already under pressure. That is
 * exactly when the bundle matters, and the fallback was already sitting in
 * `deflateWins`' return type.
 */
const deflateRawSync = vi.hoisted(() => vi.fn());
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>();
  return { ...actual, deflateRawSync };
});

const { buildZip, configureZipLogging, crc32 } = await import('../../src/export/zip.js');
const { readZip } = await import('../../src/domain/zipReader.js');

afterEach(() => {
  deflateRawSync.mockReset();
  configureZipLogging(null);
});

/** A body well over MIN_DEFLATE_BYTES, so compression is attempted. */
const BODY = JSON.stringify(
  Array.from({ length: 300 }, (_, i) => ({ id: i, klass: `class_${i % 9}`, shares: 1000 + i })),
  null,
  2,
);

describe('a zip entry zlib will not compress', () => {
  it('ships stored rather than taking the whole archive down', () => {
    deflateRawSync.mockImplementation(() => {
      throw new Error('Cannot create a Buffer larger than 0x7fffffff bytes');
    });

    const zip = buildZip([{ name: 'calculations.json', data: BODY }]);

    // Method 0 in both headers, and the bytes are exactly what went in.
    expect(zip.readUInt16LE(8)).toBe(0);
    const read = readZip(zip);
    expect(read.get('calculations.json')?.toString('utf8')).toBe(BODY);
  });

  it('leaves the checksum describing the original bytes', () => {
    deflateRawSync.mockImplementation(() => {
      throw new Error('ENOMEM');
    });
    const zip = buildZip([{ name: 'calculations.json', data: BODY }]);
    expect(zip.readUInt32LE(14)).toBe(crc32(Buffer.from(BODY, 'utf8')));
  });

  it('does not stop the entries after it from being compressed', () => {
    let calls = 0;
    deflateRawSync.mockImplementation((data: Buffer) => {
      calls += 1;
      if (calls === 1) throw new Error('ENOMEM');
      return Buffer.from(data.subarray(0, 8)); // stands in for a smaller result
    });

    const zip = buildZip([
      { name: 'a.json', data: BODY },
      { name: 'b.json', data: BODY },
    ]);

    expect(calls).toBe(2);
    // First entry stored, second deflated — the failure was contained to its
    // own entry rather than switching the writer off for the rest of the pass.
    expect(zip.readUInt16LE(8)).toBe(0);
  });

  it('says so, because a swallowed compression failure is a silent one', () => {
    deflateRawSync.mockImplementation(() => {
      throw new Error('ENOMEM');
    });
    const warn = vi.fn();
    configureZipLogging({ warn });

    buildZip([{ name: 'calculations.json', data: BODY }]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ bytes: Buffer.byteLength(BODY) });
  });

  it('writes nothing at all when every entry compresses', () => {
    deflateRawSync.mockImplementation((data: Buffer) => Buffer.from(data.subarray(0, 8)));
    const warn = vi.fn();
    configureZipLogging({ warn });

    buildZip([{ name: 'calculations.json', data: BODY }]);

    expect(warn).not.toHaveBeenCalled();
  });
});
