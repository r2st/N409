import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as ZlibModule from 'node:zlib';

/**
 * zlib refusing to compress must not fail the download (R332, methodology M5).
 *
 * Until R330 this writer never called zlib, so `buildZip` could not fail — it
 * read bytes, wrote headers and concatenated. Compression made an *optional*
 * step load-bearing for every archive the platform produces: the auditor's
 * evidence bundle, and every .xlsx export, because an .xlsx is a ZIP of XML
 * parts built by this same writer.
 *
 * `deflateRaw` allocates a second copy of the entry, so it fails for reasons
 * that have nothing to do with the caller — a buffer over
 * `buffer.kMaxLength`, `ENOMEM` on a box already under pressure. That is
 * exactly when the bundle matters, and the fallback was already sitting in
 * `deflateWins`' return type.
 *
 * Stubbed in the callback form since R375, because that is the one the writer
 * calls: compression moved off the event loop onto libuv's threadpool, so the
 * refusal now arrives as a rejected promise rather than a throw. The fallback
 * has to hold either way, which is the whole point of this file.
 */
const deflateRaw = vi.hoisted(() =>
  vi.fn((_data: Buffer, _opts: unknown, cb: (err: Error | null, out?: Buffer) => void) =>
    cb(null, Buffer.alloc(0)),
  ),
);
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof ZlibModule>();
  return { ...actual, deflateRaw };
});

const { buildZip, configureZipLogging, crc32 } = await import('../../src/export/zip.js');
const { readZip } = await import('../../src/domain/zipReader.js');

afterEach(() => {
  deflateRaw.mockReset();
  configureZipLogging(null);
});

/** A body well over MIN_DEFLATE_BYTES, so compression is attempted. */
const BODY = JSON.stringify(
  Array.from({ length: 300 }, (_, i) => ({ id: i, klass: `class_${i % 9}`, shares: 1000 + i })),
  null,
  2,
);

describe('a zip entry zlib will not compress', () => {
  it('ships stored rather than taking the whole archive down', async () => {
    deflateRaw.mockImplementation((_data, _opts, cb) =>
      cb(new Error('Cannot create a Buffer larger than 0x7fffffff bytes')),
    );

    const zip = await buildZip([{ name: 'calculations.json', data: BODY }]);

    // Method 0 in both headers, and the bytes are exactly what went in.
    expect(zip.readUInt16LE(8)).toBe(0);
    const read = readZip(zip);
    expect(read.get('calculations.json')?.toString('utf8')).toBe(BODY);
  });

  it('leaves the checksum describing the original bytes', async () => {
    deflateRaw.mockImplementation((_data, _opts, cb) => cb(new Error('ENOMEM')));
    const zip = await buildZip([{ name: 'calculations.json', data: BODY }]);
    expect(zip.readUInt32LE(14)).toBe(crc32(Buffer.from(BODY, 'utf8')));
  });

  it('does not stop the entries after it from being compressed', async () => {
    let calls = 0;
    deflateRaw.mockImplementation((data: Buffer, _opts, cb) => {
      calls += 1;
      if (calls === 1) return cb(new Error('ENOMEM'));
      return cb(null, Buffer.from(data.subarray(0, 8))); // stands in for a smaller result
    });

    const zip = await buildZip([
      { name: 'a.json', data: BODY },
      { name: 'b.json', data: BODY },
    ]);

    expect(calls).toBe(2);
    // First entry stored, second deflated — the failure was contained to its
    // own entry rather than switching the writer off for the rest of the pass.
    expect(zip.readUInt16LE(8)).toBe(0);
  });

  it('says so, because a swallowed compression failure is a silent one', async () => {
    deflateRaw.mockImplementation((_data, _opts, cb) => cb(new Error('ENOMEM')));
    const warn = vi.fn();
    configureZipLogging({ warn });

    await buildZip([{ name: 'calculations.json', data: BODY }]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ bytes: Buffer.byteLength(BODY) });
  });

  it('writes nothing at all when every entry compresses', async () => {
    deflateRaw.mockImplementation((data: Buffer, _opts, cb) => cb(null, Buffer.from(data.subarray(0, 8))));
    const warn = vi.fn();
    configureZipLogging({ warn });

    await buildZip([{ name: 'calculations.json', data: BODY }]);

    expect(warn).not.toHaveBeenCalled();
  });
});
