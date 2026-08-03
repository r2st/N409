import { describe, expect, it } from 'vitest';
import { escapeLike, valuationNumberQuery } from '../../src/repos/search.js';

describe('escapeLike', () => {
  it('passes plain strings through', () => {
    expect(escapeLike('Acme Corp')).toBe('Acme Corp');
    expect(escapeLike('hello')).toBe('hello');
  });

  it('escapes percent wildcards', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('%drop%')).toBe('\\%drop\\%');
  });

  it('escapes underscore wildcards', () => {
    expect(escapeLike('a_b')).toBe('a\\_b');
  });

  it('escapes backslashes', () => {
    expect(escapeLike('a\\b')).toBe('a\\\\b');
  });

  it('handles combined special characters', () => {
    expect(escapeLike('100%_test')).toBe('100\\%\\_test');
  });
});

describe('valuationNumberQuery', () => {
  it('accepts a digit run that fits the bigint column', () => {
    expect(valuationNumberQuery('42')).toBe('42');
    expect(valuationNumberQuery('9223372036854775807')).toBe('9223372036854775807');
  });

  it('rejects a digit run past the bigint ceiling', () => {
    // Casting these would be a range *error*, not a miss, taking the whole
    // search statement — company-name matches included — down with it.
    expect(valuationNumberQuery('9223372036854775808')).toBeNull();
    expect(valuationNumberQuery('99999999999999999999999')).toBeNull();
    expect(valuationNumberQuery('1'.repeat(200))).toBeNull();
  });

  it('reads a padded digit run at its value, not its length', () => {
    expect(valuationNumberQuery('00000000000000000000001')).toBe('00000000000000000000001');
  });

  it('rejects anything that is not all digits', () => {
    expect(valuationNumberQuery('acme')).toBeNull();
    expect(valuationNumberQuery('12a')).toBeNull();
    expect(valuationNumberQuery('#12')).toBeNull();
    expect(valuationNumberQuery('-1')).toBeNull();
    expect(valuationNumberQuery('1.5')).toBeNull();
    expect(valuationNumberQuery(' 12 ')).toBeNull();
  });
});
