import { describe, expect, it } from 'vitest';
import {
  calendarDate,
  todayLocal,
  calendarDateOf,
  calendarDateOrNull,
  calendarDateRow,
} from '../../src/domain/calendarDate.js';

describe('calendarDate boundary inputs', () => {
  it('formats midnight correctly regardless of timezone', () => {
    const d = new Date(2026, 0, 1, 0, 0, 0);
    expect(calendarDate(d)).toBe('2026-01-01');
  });

  it('formats the last day of the year', () => {
    const d = new Date(2026, 11, 31, 23, 59, 59);
    expect(calendarDate(d)).toBe('2026-12-31');
  });

  it('pads single-digit month and day', () => {
    const d = new Date(2026, 0, 5);
    expect(calendarDate(d)).toBe('2026-01-05');
  });

  it('handles Feb 28 non-leap year', () => {
    const d = new Date(2025, 1, 28);
    expect(calendarDate(d)).toBe('2025-02-28');
  });

  it('handles Feb 29 leap year', () => {
    const d = new Date(2024, 1, 29);
    expect(calendarDate(d)).toBe('2024-02-29');
  });

  it('handles year 2000 (4-digit year)', () => {
    const d = new Date(2000, 0, 1);
    expect(calendarDate(d)).toBe('2000-01-01');
  });
});

describe('todayLocal', () => {
  it('returns a YYYY-MM-DD string', () => {
    const today = todayLocal();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('uses the provided date instead of the clock', () => {
    const d = new Date(2030, 5, 15);
    expect(todayLocal(d)).toBe('2030-06-15');
  });
});

describe('calendarDateOf', () => {
  it('handles a Date object', () => {
    const d = new Date(2026, 5, 15);
    expect(calendarDateOf(d)).toBe('2026-06-15');
  });

  it('handles an ISO date string', () => {
    expect(calendarDateOf('2026-06-15')).toBe('2026-06-15');
  });

  it('truncates a datetime string to just the date', () => {
    expect(calendarDateOf('2026-06-15T12:30:00Z')).toBe('2026-06-15');
  });

  it('handles a non-standard string by slicing first 10 chars', () => {
    expect(calendarDateOf('2026-06-15 some extra stuff')).toBe('2026-06-15');
  });
});

describe('calendarDateOrNull', () => {
  it('returns null for null', () => {
    expect(calendarDateOrNull(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(calendarDateOrNull(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(calendarDateOrNull('')).toBeNull();
  });

  it('returns the date for a valid Date', () => {
    const d = new Date(2026, 5, 15);
    expect(calendarDateOrNull(d)).toBe('2026-06-15');
  });

  it('returns the date for a valid string', () => {
    expect(calendarDateOrNull('2026-06-15')).toBe('2026-06-15');
  });
});

describe('calendarDateRow', () => {
  it('converts Date columns to strings', () => {
    const row = { id: 1, valuation_date: new Date(2026, 5, 15), name: 'test' };
    const result = calendarDateRow(row, 'valuation_date');
    expect(result.valuation_date).toBe('2026-06-15');
    expect(result.name).toBe('test');
  });

  it('leaves string columns unchanged', () => {
    const row = { id: 1, valuation_date: '2026-06-15' };
    const result = calendarDateRow(row, 'valuation_date');
    expect(result.valuation_date).toBe('2026-06-15');
  });

  it('leaves null columns unchanged', () => {
    const row = { id: 1, valuation_date: null as Date | null };
    const result = calendarDateRow(row, 'valuation_date');
    expect(result.valuation_date).toBeNull();
  });

  it('handles multiple date columns', () => {
    const row = {
      start_date: new Date(2025, 0, 1),
      end_date: new Date(2026, 11, 31),
      other: 'unchanged',
    };
    const result = calendarDateRow(row, 'start_date', 'end_date');
    expect(result.start_date).toBe('2025-01-01');
    expect(result.end_date).toBe('2026-12-31');
    expect(result.other).toBe('unchanged');
  });

  it('returns a shallow copy, not the original', () => {
    const row = { val: new Date(2026, 0, 1) };
    const result = calendarDateRow(row, 'val');
    expect(result).not.toBe(row);
  });
});
