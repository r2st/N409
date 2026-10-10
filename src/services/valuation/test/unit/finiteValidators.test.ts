import { describe, expect, it } from 'vitest';
import {
  finite,
  finiteNonNegative,
  finitePositive,
  boundedNonNegative,
  boundedPositive,
  boundedSigned,
  MAX_QUANTITY,
} from '../../src/domain/finite.js';

describe('finite()', () => {
  const schema = finite();

  it('accepts ordinary numbers', () => {
    expect(schema.parse(42)).toBe(42);
    expect(schema.parse(-100.5)).toBe(-100.5);
    expect(schema.parse(0)).toBe(0);
  });

  it('rejects Infinity', () => {
    expect(() => schema.parse(Infinity)).toThrow();
    expect(() => schema.parse(-Infinity)).toThrow();
  });

  it('rejects NaN', () => {
    expect(() => schema.parse(NaN)).toThrow();
  });
});

describe('finiteNonNegative()', () => {
  const schema = finiteNonNegative();

  it('accepts zero and positive', () => {
    expect(schema.parse(0)).toBe(0);
    expect(schema.parse(100)).toBe(100);
  });

  it('rejects negative numbers', () => {
    expect(() => schema.parse(-1)).toThrow();
    expect(() => schema.parse(-0.001)).toThrow();
  });

  it('rejects Infinity', () => {
    expect(() => schema.parse(Infinity)).toThrow();
  });
});

describe('finitePositive()', () => {
  const schema = finitePositive();

  it('accepts positive numbers', () => {
    expect(schema.parse(1)).toBe(1);
    expect(schema.parse(0.001)).toBe(0.001);
  });

  it('rejects zero', () => {
    expect(() => schema.parse(0)).toThrow();
  });

  it('rejects negative', () => {
    expect(() => schema.parse(-1)).toThrow();
  });

  it('rejects Infinity', () => {
    expect(() => schema.parse(Infinity)).toThrow();
  });
});

describe('MAX_QUANTITY', () => {
  it('is Number.MAX_SAFE_INTEGER', () => {
    expect(MAX_QUANTITY).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('is the threshold above which integer addition fails', () => {
    expect(MAX_QUANTITY + 1 === MAX_QUANTITY).toBe(false);
    expect(MAX_QUANTITY + 2 === MAX_QUANTITY + 1).toBe(true);
  });
});

describe('boundedNonNegative()', () => {
  const schema = boundedNonNegative();

  it('accepts zero', () => {
    expect(schema.parse(0)).toBe(0);
  });

  it('accepts MAX_QUANTITY', () => {
    expect(schema.parse(MAX_QUANTITY)).toBe(MAX_QUANTITY);
  });

  it('rejects above MAX_QUANTITY', () => {
    expect(() => schema.parse(MAX_QUANTITY + 1)).toThrow();
  });

  it('rejects negative', () => {
    expect(() => schema.parse(-1)).toThrow();
  });

  it('rejects Infinity (covered by finite + max)', () => {
    expect(() => schema.parse(Infinity)).toThrow();
  });
});

describe('boundedPositive()', () => {
  const schema = boundedPositive();

  it('accepts 1', () => {
    expect(schema.parse(1)).toBe(1);
  });

  it('rejects zero', () => {
    expect(() => schema.parse(0)).toThrow();
  });

  it('accepts MAX_QUANTITY', () => {
    expect(schema.parse(MAX_QUANTITY)).toBe(MAX_QUANTITY);
  });

  it('rejects above MAX_QUANTITY', () => {
    expect(() => schema.parse(MAX_QUANTITY + 1)).toThrow();
  });
});

describe('boundedSigned()', () => {
  const schema = boundedSigned();

  it('accepts negative values (EBITDA can be negative)', () => {
    expect(schema.parse(-1_000_000)).toBe(-1_000_000);
  });

  it('accepts zero', () => {
    expect(schema.parse(0)).toBe(0);
  });

  it('rejects below -MAX_QUANTITY', () => {
    expect(() => schema.parse(-MAX_QUANTITY - 1)).toThrow();
  });

  it('rejects above MAX_QUANTITY', () => {
    expect(() => schema.parse(MAX_QUANTITY + 1)).toThrow();
  });

  it('rejects both infinities', () => {
    expect(() => schema.parse(Infinity)).toThrow();
    expect(() => schema.parse(-Infinity)).toThrow();
  });
});
