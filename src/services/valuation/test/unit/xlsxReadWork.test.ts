/**
 * What the import parser stops doing per cell (R377, performance).
 *
 * Both fixes here are invisible to every existing xlsxRead test, because the
 * grid they produce is identical either way. `xlsxRead.test.ts` and
 * `capTableAdversarialImport.test.ts` pin the answers and passed unchanged. So
 * these assertions are about the work:
 *
 * - `attr` compiled a fresh `RegExp` on every call, and the cell reader asks
 *   for two or three attributes per `<c>`. A 20,000-row sheet of five columns
 *   is 100,000 cells, so ~250,000 compiles for ten distinct patterns; the grid
 *   budget allows two million cells.
 * - `decodeXmlText` ran its entity pattern over every attribute value and every
 *   `<v>`, and a spreadsheet's cells are numbers and names that contain no `&`
 *   at all.
 *
 * Measured together on that sheet: 105.3 -> 72.6 ms.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildXlsx } from '../../src/export/xlsx.js';
import { decodeXmlText, readXlsx } from '../../src/domain/xlsxRead.js';

const COLUMNS = ['class', 'shares', 'price', 'date', 'note'].map((key) => ({ key, header: key }));

async function sheetOf(rowCount: number): Promise<Buffer> {
  const rows = Array.from({ length: rowCount }, (_, i) => [
    `Holder ${i}`,
    i * 13,
    i / 7,
    `2024-03-0${(i % 9) + 1}`,
    `note ${i}`,
  ]);
  return buildXlsx([{ name: 'S', columns: COLUMNS as never, rows: rows as never }]);
}

/** Count `new RegExp(...)` while `work` runs. Literals compile at parse time and are not counted. */
function countRegExpConstructions(work: () => void): number {
  const real = globalThis.RegExp;
  let built = 0;
  const counting = function (this: unknown, ...args: unknown[]) {
    built += 1;
    return new (real as never as new (...a: unknown[]) => RegExp)(...args);
  } as unknown as RegExpConstructor;
  counting.prototype = real.prototype;
  globalThis.RegExp = counting;
  try {
    work();
  } finally {
    globalThis.RegExp = real;
  }
  return built;
}

describe('the attribute reader compiles a pattern per name, not per cell', () => {
  it('a second parse of the same workbook compiles nothing at all', async () => {
    const buf = await sheetOf(400);
    readXlsx(buf); // first parse fills the cache
    // 2,000 cells, two or three attributes each. Before the cache this was
    // ~5,000 compiles; the module holds ten patterns for ten literal names, so
    // once they exist there is nothing left to build.
    expect(countRegExpConstructions(() => void readXlsx(buf))).toBe(0);
  });

  it('the very first parse compiles once per distinct attribute name', async () => {
    // A fresh module registry, so the cache starts empty and this measures the
    // ceiling rather than the steady state. Ten names appear in the file.
    vi.resetModules();
    const fresh = await import('../../src/domain/xlsxRead.js');
    const buf = await sheetOf(400);
    const built = countRegExpConstructions(() => void fresh.readXlsx(buf));
    expect(built).toBeLessThanOrEqual(12);
    // Vacuity guard: a reader that compiled nothing would also pass the bound,
    // and so would a counter that never fires.
    expect(built).toBeGreaterThan(0);
  });

  it('the counter sees the shape this replaced', () => {
    // Without this the two assertions above would pass over a broken counter.
    expect(countRegExpConstructions(() => {
      for (let i = 0; i < 7; i += 1) new RegExp(`\\b${i}\\s*=`);
    })).toBe(7);
  });

  it('a cached pattern is stateless, which is what makes sharing it safe', async () => {
    // No `g` flag means no `lastIndex`, so the same object may be reused across
    // cells. Read twice: a stateful pattern would answer differently the second
    // time and the grids would not match.
    const buf = await sheetOf(50);
    expect(readXlsx(buf)).toEqual(readXlsx(buf));
  });
});

describe('the entity decoder does not scan text that carries no entity', () => {
  it('a value with no ampersand is answered without running the pattern', () => {
    const spy = vi.spyOn(String.prototype, 'replace');
    try {
      expect(decodeXmlText('Acme Robotics Holdings, Inc.')).toBe('Acme Robotics Holdings, Inc.');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('a value that carries one still runs it', () => {
    const spy = vi.spyOn(String.prototype, 'replace');
    try {
      expect(decodeXmlText('Series B &amp; C')).toBe('Series B & C');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('every decoding this parser does still gives the same answer', () => {
    // The fast path is a claim that nothing without an `&` decodes to anything
    // else. These are the forms the reader meets.
    for (const [input, expected] of [
      ['', ''],
      ['plain', 'plain'],
      ['A1', 'A1'],
      ['45352', '45352'],
      ['&amp;', '&'],
      ['&lt;c&gt;', '<c>'],
      ['&quot;q&quot;', '"q"'],
      ['&apos;', "'"],
      ['&#65;', 'A'],
      ['&#x41;', 'A'],
      // Unknown and out-of-range references are left as written.
      ['&nope;', '&nope;'],
      ['&#x110000;', '&#x110000;'],
      // A bare ampersand is not a reference and survives untouched — the same
      // answer the fast path would give if it ever reached it.
      ['R & D', 'R & D'],
    ] as const) {
      expect(decodeXmlText(input)).toBe(expected);
    }
  });
});
