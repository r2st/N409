import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { buildZip } from '../../src/export/zip.js';
import { buildXlsx } from '../../src/export/xlsx.js';
import { readZip } from '../../src/domain/zipReader.js';

/**
 * Compression does not hold the event loop (R375, methodology M8).
 *
 * `buildZip` writes every .xlsx this platform exports as well as the auditor's
 * evidence bundle, and it used `deflateRawSync` — so the API process stopped
 * answering for the length of the compression. At the list-export cap (10 000
 * rows, six columns) that is 27 ms of a 40 ms `buildXlsx`, two thirds of
 * building a workbook; the bundle's `calculations.json` is 40 ms on its own.
 *
 * These assert the *shape of the work*, because the archive is byte-identical
 * either way and no assertion on the output can tell the two apart. Run them
 * against the synchronous form and the first two fail: nothing else on the
 * loop gets a turn while a synchronous deflate is running, by definition.
 */

/** An entry large enough that compressing it is measurable work. */
function bigEntry(): Buffer {
  const rows = Array.from({ length: 40_000 }, (_, i) => ({
    id: `01JZZ${String(i).padStart(6, '0')}`,
    klass: `class_${i % 9}`,
    shares: 1000 + i,
    note: 'observed, per the engagement file',
  }));
  return Buffer.from(JSON.stringify(rows, null, 2), 'utf8');
}

/** How many turns the loop got while `work` was in flight. */
async function turnsDuring<T>(work: () => Promise<T>): Promise<{ turns: number; value: T }> {
  let turns = 0;
  let running = true;
  const tick = (): void => {
    if (!running) return;
    turns += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  const value = await work();
  running = false;
  return { turns, value };
}

describe('zip compression and the event loop', () => {
  it('lets other work run while an entry is being compressed', async () => {
    const data = bigEntry();
    const { turns, value } = await turnsDuring(() => buildZip([{ name: 'calculations.json', data }]));

    // The synchronous form scores exactly one — the tick scheduled before the
    // call, which is also the tick the whole compression ran inside.
    expect(turns).toBeGreaterThan(1);
    expect(readZip(value).get('calculations.json')?.toString('utf8')).toBe(data.toString('utf8'));
  });

  it('lets other work run while a workbook is being written', async () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => [
      `Company ${i}`,
      i * 1000,
      `holder${i}@example.com`,
    ]);
    const { turns } = await turnsDuring(() =>
      buildXlsx([
        {
          name: 'Valuations',
          columns: [{ header: 'Company' }, { header: 'Value' }, { header: 'Email' }],
          rows,
        },
      ]),
    );

    expect(turns).toBeGreaterThan(1);
  });

  it('writes the bytes the synchronous form wrote', async () => {
    // The move is to `zlib`'s callback API at the same level over the same
    // input, so the compressed member is the same bytes — which is what makes
    // this a performance change and not a format one.
    const data = bigEntry();
    const zip = await buildZip([{ name: 'calculations.json', data, mtime: new Date(0) }]);

    expect(zip.readUInt16LE(8)).toBe(8); // method: deflate
    const compressed = deflateRawSync(data, { level: 6 });
    expect(zip.readUInt32LE(18)).toBe(compressed.length);
    expect(zip.subarray(30 + 'calculations.json'.length).subarray(0, compressed.length)).toEqual(
      compressed,
    );
  });
});
