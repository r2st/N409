import { describe, expect, it } from 'vitest';
import {
  OVERWRITE_CATEGORIES,
  OVERWRITE_FIELDS,
  OVERWRITE_FIELDS_BY_KEY,
  validateOverwriteValue,
} from '../../src/domain/overwrites.js';

describe('overwrites registry (features.md §3.6)', () => {
  it('defines exactly 68 fields', () => {
    expect(OVERWRITE_FIELDS).toHaveLength(68);
  });

  it('matches the documented per-category counts', () => {
    const counts = Object.fromEntries(
      OVERWRITE_CATEGORIES.map((c) => [c, OVERWRITE_FIELDS.filter((f) => f.category === c).length]),
    );
    expect(counts).toEqual({
      company_info: 7,
      financial_metrics: 17,
      forecasts: 12,
      valuation_params: 15,
      market_comparables: 16,
      reporting: 1,
    });
  });

  it('has unique keys and complete metadata', () => {
    const keys = OVERWRITE_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const field of OVERWRITE_FIELDS) {
      expect(field.label.length).toBeGreaterThan(0);
      expect(field.description.length).toBeGreaterThan(0);
      expect(field.example).toBeDefined();
      expect(['numeric', 'date', 'character']).toContain(field.class);
    }
  });

  it('includes the documented example fields', () => {
    for (const key of [
      'industry_id',
      'valuation_date',
      'exit_timeline',
      'currency',
      'service_countries',
      'yearend',
      'bootstrap_assets',
    ]) {
      expect(OVERWRITE_FIELDS_BY_KEY.has(key), key).toBe(true);
    }
  });

  it('every example value passes its own field validation', () => {
    for (const field of OVERWRITE_FIELDS) {
      expect(validateOverwriteValue(field, field.example), field.key).toBeNull();
    }
  });
});

describe('validateOverwriteValue', () => {
  const numeric = OVERWRITE_FIELDS_BY_KEY.get('dlom')!; // min 0, max MAX_STATED_DISCOUNT
  const date = OVERWRITE_FIELDS_BY_KEY.get('valuation_date')!;
  const character = OVERWRITE_FIELDS_BY_KEY.get('company_legal_name')!;

  it('accepts valid values per class', () => {
    expect(validateOverwriteValue(numeric, 0.25)).toBeNull();
    expect(validateOverwriteValue(date, '2026-02-28')).toBeNull();
    expect(validateOverwriteValue(character, 'Acme, Inc.')).toBeNull();
  });

  it('rejects wrong types', () => {
    expect(validateOverwriteValue(numeric, '0.25')).toMatch(/number/);
    expect(validateOverwriteValue(numeric, Number.NaN)).toMatch(/number/);
    expect(validateOverwriteValue(date, 20260228)).toMatch(/ISO date/);
    expect(validateOverwriteValue(character, 42)).toMatch(/string/);
  });

  it('enforces numeric ranges', () => {
    expect(validateOverwriteValue(numeric, -0.1)).toMatch(/≥/);
    // 0.95 was the ceiling case until R413 widened this cell to the band the
    // params screen has always accepted; 1.0 is where the engine refuses.
    expect(validateOverwriteValue(numeric, 0.95)).toBeNull();
    expect(validateOverwriteValue(numeric, 1)).toMatch(/≤/);
  });

  it('rejects malformed and impossible dates', () => {
    expect(validateOverwriteValue(date, '2026-6-30')).toMatch(/ISO date/);
    expect(validateOverwriteValue(date, '2026-02-30')).toMatch(/calendar date/);
    expect(validateOverwriteValue(date, '2026-13-01')).toMatch(/calendar date/);
  });

  it('rejects empty and oversized strings', () => {
    expect(validateOverwriteValue(character, '')).toMatch(/empty/);
    expect(validateOverwriteValue(character, 'x'.repeat(2001))).toMatch(/2000/);
  });
});
