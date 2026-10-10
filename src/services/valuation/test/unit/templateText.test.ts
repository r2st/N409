import { describe, expect, it } from 'vitest';
import { templateText } from '../../src/domain/templateText.js';

describe('templateText', () => {
  const schema = templateText(500);

  it('accepts normal text', () => {
    expect(schema.parse('Your 409A is ready')).toBe('Your 409A is ready');
  });

  it('accepts text with leading whitespace (formatting may be intentional)', () => {
    expect(schema.parse('  indented body')).toBe('  indented body');
  });

  it('rejects a string that is only whitespace', () => {
    expect(() => schema.parse('   ')).toThrow(/whitespace/);
  });

  it('rejects a string that is only tabs and newlines', () => {
    expect(() => schema.parse('\t\n  \n\t')).toThrow(/whitespace/);
  });

  it('rejects an empty string', () => {
    expect(() => schema.parse('')).toThrow();
  });

  it('rejects text exceeding the max length', () => {
    expect(() => schema.parse('x'.repeat(501))).toThrow();
  });

  it('accepts text at the max boundary', () => {
    expect(schema.parse('x'.repeat(500))).toHaveLength(500);
  });
});
