import { describe, expect, it } from 'vitest';
import { nonBlankText } from '../../src/domain/nonBlankText.js';

describe('nonBlankText', () => {
  const schema = nonBlankText(2, 100);

  it('accepts normal text', () => {
    expect(schema.parse('John Doe')).toBe('John Doe');
  });

  it('accepts text with leading/trailing whitespace if it has visible content', () => {
    expect(schema.parse('  Jane  ')).toBe('  Jane  ');
  });

  it('rejects all-whitespace strings', () => {
    expect(() => schema.parse('   ')).toThrow(/whitespace/);
    expect(() => schema.parse('\t\n')).toThrow(/whitespace/);
  });

  it('enforces min length on the raw string (not trimmed)', () => {
    expect(() => schema.parse('A')).toThrow();
    expect(schema.parse('AB')).toBe('AB');
  });

  it('enforces max length', () => {
    expect(() => schema.parse('x'.repeat(101))).toThrow();
    expect(schema.parse('x'.repeat(100))).toHaveLength(100);
  });

  it('rejects an empty string via both min and whitespace checks', () => {
    expect(() => schema.parse('')).toThrow();
  });

  it('rejects a string of exactly min length that is only spaces', () => {
    expect(() => nonBlankText(3, 50).parse('   ')).toThrow(/whitespace/);
  });
});
