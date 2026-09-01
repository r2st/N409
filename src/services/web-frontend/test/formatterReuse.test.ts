import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatAmount, formatCents, formatNumber, moneyFormatter } from '../src/lib/format';

/**
 * The formatters are built once per (currency, options), not once per cell.
 *
 * R330 (M8). `Intl.NumberFormat` is expensive to construct and cheap to call —
 * 363 ms to build-and-format twenty thousand values against 6.9 ms through one
 * instance, a factor of fifty-three. Every function in `lib/format.ts` built a
 * fresh one per call, and these are per-cell functions: a two-hundred-class cap
 * table with half a dozen money columns is thousands of constructions per
 * render, repeated on every re-render.
 *
 * The risk a cache introduces is a key that is too coarse — one entry answering
 * two different questions — so the cases below are as much about the pairs that
 * must *not* share a formatter as about the ones that must.
 */

/** Counts constructions without changing what any of them produce. */
function countConstructions(): { calls: () => number } {
  const real = Intl.NumberFormat;
  let n = 0;
  const spy = vi.spyOn(Intl, 'NumberFormat').mockImplementation(((...args: unknown[]) => {
    n += 1;
    return new (real as unknown as new (...a: unknown[]) => unknown)(...args);
  }) as unknown as typeof Intl.NumberFormat);
  // `resolvedOptions` and the rest come off the real instance, so behaviour is
  // untouched; only the count is ours.
  void spy;
  return { calls: () => n };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatter reuse', () => {
  it('builds one formatter for a column of cells', () => {
    // Warm whatever the first call builds, so the count below is the steady
    // state a table row after the first one actually pays.
    formatAmount(1, 'USD');
    const { calls } = countConstructions();
    const rendered = Array.from({ length: 200 }, (_, i) => formatAmount(1000 + i, 'USD'));
    expect(calls()).toBe(0);
    expect(rendered[0]).toBe('$1,000.00');
    expect(rendered[199]).toBe('$1,199.00');
  });

  it('does not let two option sets share one formatter', () => {
    // `formatAmount` widens the fraction digits below one unit, so a $0.0001 par
    // value and a $1,000 preference go through different formatters. A key that
    // carried only the currency would round the par value to $0.00.
    expect(formatAmount(0.0001, 'USD')).toBe('$0.0001');
    expect(formatAmount(1000, 'USD')).toBe('$1,000.00');
    expect(formatAmount(0.0001, 'USD')).toBe('$0.0001');
  });

  it('does not let two currencies share one formatter', () => {
    expect(formatCents(250050, 'USD')).toBe('$2,500.50');
    expect(formatCents(250050, 'EUR')).not.toBe('$2,500.50');
    expect(formatCents(250050, 'USD')).toBe('$2,500.50');
  });

  it('reuses the scale lookup as well as the formatter', () => {
    // `formatCents` pays two constructions per cell, not one: the scale a
    // currency's minor unit is on is read off a second `Intl.NumberFormat`.
    formatCents(1, 'USD');
    const { calls } = countConstructions();
    for (let i = 0; i < 50; i += 1) expect(formatCents(250050 + i, 'USD')).toContain('$2,500.');
    expect(calls()).toBe(0);
  });

  it('caches the unparseable-currency fallback too, and it still prints the code', () => {
    // A row can carry `"$$$"`; `Intl` throws on it and the fallback prints the
    // code beside the amount. Caching a thrown construction would re-throw it.
    expect(moneyFormatter('$$$')(1000)).toBe('$$$ 1,000.00');
    const { calls } = countConstructions();
    expect(moneyFormatter('$$$')(2000)).toBe('$$$ 2,000.00');
    expect(calls()).toBe(0);
  });

  it('formats plain numbers through one instance', () => {
    formatNumber(1);
    const { calls } = countConstructions();
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(calls()).toBe(0);
  });
});
