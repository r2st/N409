import { describe, expect, it } from 'vitest';
import { parseSortParam, serializeSort, sortIndicator, toggleSort } from '../src/lib/sort';

describe('multi-column sort helpers (M4)', () => {
  it('round-trips the URL param', () => {
    const specs = parseSortParam('company_name:asc,created_at:desc');
    expect(specs).toEqual([
      { column: 'company_name', dir: 'asc' },
      { column: 'created_at', dir: 'desc' },
    ]);
    expect(serializeSort(specs)).toBe('company_name:asc,created_at:desc');
  });

  it('drops unknown columns instead of crashing', () => {
    expect(parseSortParam('hacker:asc,state:desc')).toEqual([{ column: 'state', dir: 'desc' }]);
    expect(parseSortParam(null)).toEqual([]);
  });

  it('toggles asc → desc → removed and promotes the clicked column to primary', () => {
    let specs = toggleSort([], 'company_name');
    expect(specs).toEqual([{ column: 'company_name', dir: 'asc' }]);
    specs = toggleSort(specs, 'due_date');
    expect(specs[0]).toEqual({ column: 'due_date', dir: 'asc' });
    expect(specs[1]).toEqual({ column: 'company_name', dir: 'asc' });
    specs = toggleSort(specs, 'due_date');
    expect(specs[0]).toEqual({ column: 'due_date', dir: 'desc' });
    specs = toggleSort(specs, 'due_date');
    expect(specs).toEqual([{ column: 'company_name', dir: 'asc' }]);
  });

  it('reports indicator direction and priority', () => {
    const specs = parseSortParam('state:desc,number:asc');
    expect(sortIndicator(specs, 'state')).toEqual({ dir: 'desc', position: 1 });
    expect(sortIndicator(specs, 'number')).toEqual({ dir: 'asc', position: 2 });
    expect(sortIndicator(specs, 'kind')).toBeNull();
  });
});
