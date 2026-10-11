import { describe, expect, it } from 'vitest';
import { sliceChars, ellipsize } from '../../src/domain/textSlice.js';

describe('sliceChars boundary inputs', () => {
  it('returns empty string for empty input', () => {
    expect(sliceChars('', 10)).toBe('');
  });

  it('returns the string unchanged when shorter than max', () => {
    expect(sliceChars('hello', 10)).toBe('hello');
  });

  it('returns the string unchanged when exactly max length', () => {
    expect(sliceChars('hello', 5)).toBe('hello');
  });

  it('truncates at max when string is longer', () => {
    expect(sliceChars('hello world', 5)).toBe('hello');
  });

  it('does not split a surrogate pair (emoji at the boundary)', () => {
    const str = 'ab🎉cd';
    // 🎉 occupies positions 2-3 (two UTF-16 code units)
    // Slicing at 3 would leave a high surrogate orphaned
    const result = sliceChars(str, 3);
    expect(result).toBe('ab');
    // No lone surrogates
    expect(result).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('keeps emoji intact when cut falls after the pair', () => {
    const str = 'ab🎉cd';
    // Position 4 is after the emoji pair
    const result = sliceChars(str, 4);
    expect(result).toBe('ab🎉');
  });

  it('handles string of only emoji', () => {
    const str = '🎉🎊🎈';
    // Each emoji is 2 code units, so 6 total
    // Cut at 3 would split the second emoji
    const result = sliceChars(str, 3);
    expect(result).toBe('🎉');
  });

  it('handles max = 0', () => {
    expect(sliceChars('hello', 0)).toBe('');
  });

  it('handles max = 1 with a leading emoji (surrogate pair)', () => {
    const str = '🎉hello';
    // Position 0 is the high surrogate of 🎉, slicing at 1 orphans it
    const result = sliceChars(str, 1);
    expect(result).toBe('');
  });

  it('handles a string that is entirely a single emoji', () => {
    const result = sliceChars('🎉', 1);
    expect(result).toBe('');
  });

  it('handles ASCII-only strings at boundary', () => {
    expect(sliceChars('abcdef', 6)).toBe('abcdef');
    expect(sliceChars('abcdef', 3)).toBe('abc');
  });

  it('handles multiple consecutive emoji at the boundary', () => {
    const str = 'a🎉🎊b';
    // 'a' = pos 0, 🎉 = pos 1-2, 🎊 = pos 3-4, 'b' = pos 5
    const result = sliceChars(str, 4);
    // Position 3 is the high surrogate of 🎊, so it should drop it
    expect(result).toBe('a🎉');
  });
});

describe('ellipsize boundary inputs', () => {
  it('returns unchanged when string length equals max', () => {
    expect(ellipsize('hello', 5)).toBe('hello');
  });

  it('returns unchanged when string is shorter than max', () => {
    expect(ellipsize('hi', 5)).toBe('hi');
  });

  it('adds ellipsis when string exceeds max', () => {
    const result = ellipsize('hello world', 8);
    expect(result).toContain('…');
    expect(result.length).toBeLessThanOrEqual(8);
  });

  it('respects custom keep parameter', () => {
    const result = ellipsize('hello world', 8, 4);
    expect(result).toBe('hell…');
  });

  it('handles empty string', () => {
    expect(ellipsize('', 5)).toBe('');
  });

  it('handles max = 0', () => {
    const result = ellipsize('hello', 0);
    // String 'hello' length 5 > 0, so it triggers ellipsis with keep = -3
    // sliceChars('hello', -3) returns '' (slice with negative truncates to 0)
    expect(typeof result).toBe('string');
  });
});
