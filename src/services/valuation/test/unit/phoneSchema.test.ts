import { describe, expect, it } from 'vitest';
import { NullablePhone, OptionalPhone } from '../../src/domain/phone.js';

describe('NullablePhone', () => {
  it('normalizes a valid US number to E.164', () => {
    const result = NullablePhone.parse('+15551234567');
    expect(result).toBe('+15551234567');
  });

  it('clears an empty string to null', () => {
    expect(NullablePhone.parse('')).toBeNull();
    expect(NullablePhone.parse('   ')).toBeNull();
  });

  it('passes through null as null', () => {
    expect(NullablePhone.parse(null)).toBeNull();
  });

  it('rejects a non-phone string', () => {
    expect(() => NullablePhone.parse('not-a-phone')).toThrow();
  });

  it('rejects a string exceeding 50 characters', () => {
    expect(() => NullablePhone.parse('+1' + '5'.repeat(50))).toThrow();
  });
});

describe('OptionalPhone', () => {
  it('normalizes a valid number', () => {
    const result = OptionalPhone.parse('+15551234567');
    expect(result).toBe('+15551234567');
  });

  it('collapses blank/null/undefined to undefined', () => {
    expect(OptionalPhone.parse('')).toBeUndefined();
    expect(OptionalPhone.parse('  ')).toBeUndefined();
    expect(OptionalPhone.parse(null)).toBeUndefined();
    expect(OptionalPhone.parse(undefined)).toBeUndefined();
  });

  it('rejects an invalid phone', () => {
    expect(() => OptionalPhone.parse('abc123')).toThrow();
  });
});
