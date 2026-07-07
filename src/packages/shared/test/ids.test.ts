import { describe, expect, it } from 'vitest';
import { isUlid, newUlid } from '../src/ids.js';

describe('ULID ids', () => {
  it('generates valid, unique, sortable ids', () => {
    const a = newUlid();
    const b = newUlid();
    expect(isUlid(a)).toBe(true);
    expect(isUlid(b)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBe(26);
  });

  it('rejects non-ulids', () => {
    expect(isUlid('not-a-ulid')).toBe(false);
    expect(isUlid('')).toBe(false);
    expect(isUlid('01ILO0000000000000000000OO')).toBe(false); // I, L, O excluded
  });
});
