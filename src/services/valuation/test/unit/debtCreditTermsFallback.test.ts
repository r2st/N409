import { describe, expect, it } from 'vitest';
import { applyCreditTerms } from '../../src/routes/debt.js';

/**
 * R376: the credit-spread → rating fallback in debt instrument valuation.
 *
 * R367 added a `Number.isFinite` guard on `terms.spread`, but the `else if`
 * for the rating fallback bound to the outer null-check rather than the
 * finiteness check. When spread was non-null but non-finite (e.g. "N/A"),
 * the instrument received neither spread nor rating — the engine got
 * incomplete parameters with no warning.
 */
describe('applyCreditTerms', () => {
  it('applies a finite spread and ignores the rating', () => {
    const params: Record<string, unknown> = {};
    applyCreditTerms(params, { benchmark_yield: '0.045', spread: '0.02', rating: 'BBB' });
    expect(params).toEqual({ benchmark_yield: 0.045, spread: 0.02 });
    expect(params.rating).toBeUndefined();
  });

  it('falls back to rating when spread is null', () => {
    const params: Record<string, unknown> = {};
    applyCreditTerms(params, { benchmark_yield: '0.05', spread: null, rating: 'AA' });
    expect(params).toEqual({ benchmark_yield: 0.05, rating: 'AA' });
    expect(params.spread).toBeUndefined();
  });

  it('falls back to rating when spread is non-finite (the R367 regression)', () => {
    const params: Record<string, unknown> = {};
    applyCreditTerms(params, { benchmark_yield: '0.03', spread: 'N/A', rating: 'BB+' });
    expect(params).toEqual({ benchmark_yield: 0.03, rating: 'BB+' });
    expect(params.spread).toBeUndefined();
  });

  it('falls back to rating when spread is "NaN"', () => {
    const params: Record<string, unknown> = {};
    applyCreditTerms(params, { benchmark_yield: null, spread: 'NaN', rating: 'A-' });
    expect(params).toEqual({ rating: 'A-' });
  });

  it('falls back to rating when spread is "Infinity"', () => {
    const params: Record<string, unknown> = {};
    applyCreditTerms(params, { benchmark_yield: null, spread: 'Infinity', rating: 'BBB-' });
    expect(params).toEqual({ rating: 'BBB-' });
  });

  it('sets neither when spread is non-finite and rating is absent', () => {
    const params: Record<string, unknown> = {};
    applyCreditTerms(params, { benchmark_yield: null, spread: 'bad', rating: null });
    expect(params.spread).toBeUndefined();
    expect(params.rating).toBeUndefined();
  });

  it('is a no-op when terms are null', () => {
    const params: Record<string, unknown> = { existing: 1 };
    applyCreditTerms(params, null);
    expect(params).toEqual({ existing: 1 });
  });

  it('ignores a non-finite benchmark_yield', () => {
    const params: Record<string, unknown> = {};
    applyCreditTerms(params, { benchmark_yield: 'bad', spread: '0.01', rating: null });
    expect(params).toEqual({ spread: 0.01 });
    expect(params.benchmark_yield).toBeUndefined();
  });
});
