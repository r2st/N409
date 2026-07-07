import { describe, expect, it } from 'vitest';
import { parseSort } from '../../src/repos/valuations.js';

describe('rich sort parsing (M4 #30)', () => {
  it('parses multi-column sort with directions', () => {
    expect(parseSort('company_name:asc,created_at:desc')).toEqual([
      { column: 'company_name', dir: 'asc' },
      { column: 'created_at', dir: 'desc' },
    ]);
  });

  it('defaults direction to asc', () => {
    expect(parseSort('due_date')).toEqual([{ column: 'due_date', dir: 'asc' }]);
  });

  it('returns empty for absent sort', () => {
    expect(parseSort(undefined)).toEqual([]);
    expect(parseSort('')).toEqual([]);
  });

  it('rejects unknown columns (SQL injection guard) and bad directions', () => {
    expect(parseSort('company_name; DROP TABLE valuations')).toBeNull();
    expect(parseSort('password_digest:asc')).toBeNull();
    expect(parseSort('created_at:sideways')).toBeNull();
    expect(parseSort('company_name:asc,nope:desc')).toBeNull();
  });
});
