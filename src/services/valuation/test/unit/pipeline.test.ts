import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateWeights } from '../../src/routes/params.js';
import { deepMerge } from '../../src/routes/calculations.js';
import { safeFilename, contentDisposition } from '../../src/routes/documents.js';

describe('validateWeights', () => {
  const empty = { weight_asset: null, weight_opm: null, weight_income: null, weight_market: null };

  it('accepts an all-null weight set', () => {
    expect(validateWeights(empty, {}).ok).toBe(true);
  });

  it('accepts a complete set summing to exactly 1', () => {
    expect(
      validateWeights(empty, { weight_asset: 0, weight_opm: 0.6, weight_income: 0.15, weight_market: 0.25 })
        .ok,
    ).toBe(true);
  });

  it('accepts float-noisy sums that are exact in basis points', () => {
    // 0.1 + 0.2 + 0.3 + 0.4 !== 1 in IEEE754 addition order dependent cases
    expect(
      validateWeights(empty, { weight_asset: 0.1, weight_opm: 0.2, weight_income: 0.3, weight_market: 0.4 })
        .ok,
    ).toBe(true);
  });

  it('rejects a partial set', () => {
    const res = validateWeights(empty, { weight_opm: 1 });
    expect(res.ok).toBe(false);
  });

  it('rejects sums off by one basis point', () => {
    const res = validateWeights(empty, {
      weight_asset: 0.2501,
      weight_opm: 0.25,
      weight_income: 0.25,
      weight_market: 0.25,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toContain('1.0001');
  });

  it('merges against current DB values (numeric strings)', () => {
    const current = {
      weight_asset: '0.25',
      weight_opm: '0.25',
      weight_income: '0.25',
      weight_market: '0.25',
    };
    expect(validateWeights(current, { weight_market: 0.3 }).ok).toBe(false);
    expect(validateWeights(current, { weight_market: 0.25 }).ok).toBe(true);
  });

  it('allows clearing all four', () => {
    const current = {
      weight_asset: '0.25',
      weight_opm: '0.25',
      weight_income: '0.25',
      weight_market: '0.25',
    };
    expect(
      validateWeights(current, {
        weight_asset: null,
        weight_opm: null,
        weight_income: null,
        weight_market: null,
      }).ok,
    ).toBe(true);
  });
});

describe('deepMerge', () => {
  it('merges nested objects, later wins', () => {
    expect(deepMerge({ a: 1, m: { x: 1, y: 2 } }, { m: { y: 3, z: 4 }, b: 2 })).toEqual({
      a: 1,
      b: 2,
      m: { x: 1, y: 3, z: 4 },
    });
  });

  it('replaces arrays and scalars wholesale', () => {
    expect(deepMerge({ arr: [1, 2] }, { arr: [3] })).toEqual({ arr: [3] });
    expect(deepMerge({ v: { nested: true } }, { v: 5 })).toEqual({ v: 5 });
  });
});

describe('safeFilename', () => {
  it('keeps ordinary names', () => {
    expect(safeFilename('cap-table.v2.csv')).toBe('cap-table.v2.csv');
  });

  it('strips directories and separators', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('a\\b:c.pdf')).toBe('a_b_c.pdf');
  });

  it('never returns an empty name', () => {
    expect(safeFilename('///')).toBe('upload');
  });

  /**
   * The property that actually matters is the composed one.
   *
   * `storeDocument` writes to `path.join(documentsDir, valuationId, sha__name)`,
   * and `path.join` normalizes — so a `..` surviving into the last segment does
   * not stay in it, it climbs. Two separate things keep that from happening
   * (`path.basename`, and the `<16 hex>__` prefix that makes the segment
   * unequal to `..` even when the name is exactly that), and a test on
   * `safeFilename` alone pins neither of them to the write it protects. This
   * asserts the containment directly, on the same expression the route builds.
   */
  it('cannot escape the documents directory, whatever the upload is called', () => {
    const documentsDir = '/srv/n409/documents';
    const valuationId = '01JQZZZZZZZZZZZZZZZZZZZZZZ';
    const sha = 'a'.repeat(64);
    const hostile = [
      '../../etc/passwd',
      '../../../../../../etc/shadow',
      '..',
      '.',
      '../',
      '....//....//etc/hosts',
      '/etc/passwd',
      'C:\\Windows\\System32\\config\\SAM',
      '..\\..\\..\\windows\\win.ini',
      'a/../../../b.txt',
      '\u0000../../etc/passwd',
      'normal.pdf',
    ];
    for (const name of hostile) {
      const rel = path.join(valuationId, `${sha.slice(0, 16)}__${safeFilename(name)}`);
      const abs = path.resolve(documentsDir, rel);
      expect(abs.startsWith(`${path.resolve(documentsDir)}${path.sep}`)).toBe(true);
      // Stronger than "inside the root": it must land in this engagement's own
      // folder, so one client's upload cannot be written over another's.
      expect(path.dirname(abs)).toBe(path.resolve(documentsDir, valuationId));
    }
  });
});

describe('contentDisposition', () => {
  it('produces ASCII-safe filename and RFC 5987 filename*', () => {
    const val = contentDisposition('report.pdf');
    expect(val).toContain('filename="report.pdf"');
    expect(val).toContain("filename*=UTF-8''report.pdf");
    expect(val).toMatch(/^attachment;/);
  });

  it('percent-encodes non-ASCII characters in filename*', () => {
    const val = contentDisposition('\u00fc\u00e9port.pdf');
    // ASCII fallback replaces non-ASCII with _
    expect(val).toContain('filename="_');
    // UTF-8 version encodes the multi-byte chars
    expect(val).toContain("filename*=UTF-8''%C3%BC%C3%A9port.pdf");
  });

  it('strips quotes from the ASCII fallback', () => {
    const val = contentDisposition('file"name.pdf');
    expect(val).toContain('filename="filename.pdf"');
  });

  it('respects the disposition parameter', () => {
    expect(contentDisposition('x.pdf', 'inline')).toMatch(/^inline;/);
  });
});
