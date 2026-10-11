import { describe, expect, it } from 'vitest';
import {
  boundedJson,
  MAX_DEPTH,
  MAX_ITEMS,
  MAX_STRING,
  CLIENT_BODY_KEYS,
} from '../../src/domain/boundedJson.js';

describe('boundedJson boundary inputs', () => {
  it('passes null through as null', () => {
    expect(boundedJson(null)).toBeNull();
  });

  it('passes undefined through as null', () => {
    expect(boundedJson(undefined)).toBeNull();
  });

  it('passes booleans through unchanged', () => {
    expect(boundedJson(true)).toBe(true);
    expect(boundedJson(false)).toBe(false);
  });

  it('passes finite numbers through unchanged', () => {
    expect(boundedJson(42)).toBe(42);
    expect(boundedJson(-3.14)).toBe(-3.14);
    expect(boundedJson(0)).toBe(0);
  });

  it('replaces NaN with null', () => {
    expect(boundedJson(NaN)).toBeNull();
  });

  it('replaces Infinity with null', () => {
    expect(boundedJson(Infinity)).toBeNull();
    expect(boundedJson(-Infinity)).toBeNull();
  });

  it('truncates strings longer than MAX_STRING', () => {
    const long = 'x'.repeat(MAX_STRING + 100);
    const result = boundedJson(long) as string;
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain('more characters');
  });

  it('keeps strings at exactly MAX_STRING', () => {
    const exact = 'x'.repeat(MAX_STRING);
    expect(boundedJson(exact)).toBe(exact);
  });

  it('converts bigint to string', () => {
    expect(boundedJson(BigInt(42))).toBe('42');
    expect(boundedJson(BigInt('99999999999999999999'))).toBe('99999999999999999999');
  });

  it('replaces functions with a truncation marker', () => {
    const result = boundedJson(() => {}) as { __truncated__: string };
    expect(result.__truncated__).toBe('function');
  });

  it('replaces symbols with a truncation marker', () => {
    const result = boundedJson(Symbol('test')) as { __truncated__: string };
    expect(result.__truncated__).toBe('symbol');
  });

  it('converts Dates to ISO strings', () => {
    const d = new Date('2026-06-15T12:00:00Z');
    expect(boundedJson(d)).toBe('2026-06-15T12:00:00.000Z');
  });

  it('detects circular references without throwing', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const result = boundedJson(a) as { self: { __truncated__: string } };
    expect(result.self.__truncated__).toBe('circular reference');
  });

  it('allows repeated references across sibling branches (not cycles)', () => {
    const shared = { value: 42 };
    const result = boundedJson({ a: shared, b: shared }) as {
      a: { value: number };
      b: { value: number };
    };
    expect(result.a.value).toBe(42);
    expect(result.b.value).toBe(42);
  });

  it('truncates arrays longer than MAX_ITEMS', () => {
    const big = Array.from({ length: MAX_ITEMS + 10 }, (_, i) => i);
    const result = boundedJson(big) as unknown[];
    expect(result).toHaveLength(MAX_ITEMS + 1);
    const marker = result[MAX_ITEMS] as { __truncated__: string };
    expect(marker.__truncated__).toBe('10 more items');
  });

  it('keeps arrays at exactly MAX_ITEMS', () => {
    const exact = Array.from({ length: MAX_ITEMS }, (_, i) => i);
    const result = boundedJson(exact) as number[];
    expect(result).toHaveLength(MAX_ITEMS);
    expect(result[MAX_ITEMS - 1]).toBe(MAX_ITEMS - 1);
  });

  it('truncates objects with more than MAX_ITEMS keys', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < MAX_ITEMS + 5; i++) big[`key${i}`] = i;
    const result = boundedJson(big) as Record<string, unknown>;
    expect(result.__truncated__).toBe('5 more keys');
  });

  it('summarises arrays at MAX_DEPTH', () => {
    let nested: unknown = [1, 2, 3];
    for (let i = 0; i < MAX_DEPTH; i++) nested = [nested];
    const result = boundedJson(nested);
    const leaf = JSON.stringify(result);
    expect(leaf).toContain('__truncated__');
    expect(leaf).toContain('items');
  });

  it('summarises objects at MAX_DEPTH', () => {
    let nested: unknown = { x: 1 };
    for (let i = 0; i < MAX_DEPTH; i++) nested = { child: nested };
    const result = boundedJson(nested);
    const leaf = JSON.stringify(result);
    expect(leaf).toContain('__truncated__');
    expect(leaf).toContain('keys');
  });

  it('replaces CLIENT_BODY_KEYS values with a size marker', () => {
    for (const key of CLIENT_BODY_KEYS) {
      const obj = { [key]: 'a'.repeat(1000) };
      const result = boundedJson(obj) as Record<string, { __truncated__: string }>;
      expect(result[key]!.__truncated__).toContain('1000 characters');
    }
  });

  it('handles empty object', () => {
    expect(boundedJson({})).toEqual({});
  });

  it('handles empty array', () => {
    expect(boundedJson([])).toEqual([]);
  });

  it('handles empty string', () => {
    expect(boundedJson('')).toBe('');
  });

  it('replaces NUL bytes in strings with replacement character', () => {
    const result = boundedJson('hello\u0000world') as string;
    expect(result).not.toContain('\u0000');
    expect(result).toContain('�');
  });

  it('replaces unpaired surrogates with replacement character', () => {
    const result = boundedJson('hello\uD800world') as string;
    expect(result).not.toContain('\uD800');
    expect(result).toContain('�');
  });

  it('preserves paired surrogates (emoji)', () => {
    const result = boundedJson('hello 🎉 world') as string;
    expect(result).toBe('hello 🎉 world');
  });

  it('replaces NUL in object keys', () => {
    const obj = { ['key\u0000name']: 'value' };
    const result = boundedJson(obj) as Record<string, string>;
    const keys = Object.keys(result);
    expect(keys[0]).toContain('�');
    expect(keys[0]).not.toContain('\u0000');
  });

  it('does not cut emoji in half when truncating a string', () => {
    const emoji = '🎉';
    const str = 'x'.repeat(MAX_STRING - 1) + emoji;
    const result = boundedJson(str) as string;
    expect(result).not.toMatch(/[\uD800-\uDFFF](?![\uDC00-\uDFFF])/);
  });
});
