import { describe, expect, it } from 'vitest';
import { escapeLike } from '../../src/repos/search.js';

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
