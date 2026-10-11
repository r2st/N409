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
import { fitsInt4, INT4_MAX, int4Positive, int4Version } from '../../src/domain/int4.js';

describe('finite() schema boundary inputs', () => {
  it('accepts zero', () => {
    expect(finite().safeParse(0).success).toBe(true);
  });

  it('accepts negative numbers', () => {
    expect(finite().safeParse(-42).success).toBe(true);
  });

  it('rejects NaN', () => {
    expect(finite().safeParse(NaN).success).toBe(false);
  });

  it('rejects Infinity', () => {
    expect(finite().safeParse(Infinity).success).toBe(false);
  });

  it('rejects -Infinity', () => {
    expect(finite().safeParse(-Infinity).success).toBe(false);
  });

  it('accepts MAX_SAFE_INTEGER', () => {
    expect(finite().safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
  });

  it('accepts MIN_SAFE_INTEGER', () => {
    expect(finite().safeParse(Number.MIN_SAFE_INTEGER).success).toBe(true);
  });
});

describe('finiteNonNegative() schema boundary inputs', () => {
  it('accepts zero', () => {
    expect(finiteNonNegative().safeParse(0).success).toBe(true);
  });

  it('rejects negative', () => {
    expect(finiteNonNegative().safeParse(-0.001).success).toBe(false);
  });

  it('rejects Infinity', () => {
    expect(finiteNonNegative().safeParse(Infinity).success).toBe(false);
  });
});

describe('finitePositive() schema boundary inputs', () => {
  it('rejects zero', () => {
    expect(finitePositive().safeParse(0).success).toBe(false);
  });

  it('accepts smallest positive', () => {
    expect(finitePositive().safeParse(Number.MIN_VALUE).success).toBe(true);
  });

  it('rejects negative', () => {
    expect(finitePositive().safeParse(-1).success).toBe(false);
  });
});

describe('boundedNonNegative() schema boundary inputs', () => {
  it('accepts zero', () => {
    expect(boundedNonNegative().safeParse(0).success).toBe(true);
  });

  it('accepts MAX_QUANTITY', () => {
    expect(boundedNonNegative().safeParse(MAX_QUANTITY).success).toBe(true);
  });

  it('rejects MAX_QUANTITY + 1', () => {
    expect(boundedNonNegative().safeParse(MAX_QUANTITY + 1).success).toBe(false);
  });

  it('rejects negative', () => {
    expect(boundedNonNegative().safeParse(-1).success).toBe(false);
  });

  it('rejects Infinity', () => {
    expect(boundedNonNegative().safeParse(Infinity).success).toBe(false);
  });
});

describe('boundedPositive() schema boundary inputs', () => {
  it('rejects zero', () => {
    expect(boundedPositive().safeParse(0).success).toBe(false);
  });

  it('accepts 1', () => {
    expect(boundedPositive().safeParse(1).success).toBe(true);
  });

  it('accepts MAX_QUANTITY', () => {
    expect(boundedPositive().safeParse(MAX_QUANTITY).success).toBe(true);
  });

  it('rejects above MAX_QUANTITY', () => {
    expect(boundedPositive().safeParse(MAX_QUANTITY + 1).success).toBe(false);
  });
});

describe('boundedSigned() schema boundary inputs', () => {
  it('accepts zero', () => {
    expect(boundedSigned().safeParse(0).success).toBe(true);
  });

  it('accepts -MAX_QUANTITY', () => {
    expect(boundedSigned().safeParse(-MAX_QUANTITY).success).toBe(true);
  });

  it('accepts +MAX_QUANTITY', () => {
    expect(boundedSigned().safeParse(MAX_QUANTITY).success).toBe(true);
  });

  it('rejects below -MAX_QUANTITY', () => {
    expect(boundedSigned().safeParse(-MAX_QUANTITY - 1).success).toBe(false);
  });

  it('rejects above +MAX_QUANTITY', () => {
    expect(boundedSigned().safeParse(MAX_QUANTITY + 1).success).toBe(false);
  });

  it('rejects NaN', () => {
    expect(boundedSigned().safeParse(NaN).success).toBe(false);
  });
});

describe('MAX_QUANTITY is Number.MAX_SAFE_INTEGER', () => {
  it('matches the JS safe integer ceiling', () => {
    expect(MAX_QUANTITY).toBe(Number.MAX_SAFE_INTEGER);
    expect(MAX_QUANTITY).toBe(2 ** 53 - 1);
  });

  it('demonstrates the addition failure above the ceiling', () => {
    expect(MAX_QUANTITY + 1 === MAX_QUANTITY + 2).toBe(true);
  });
});

describe('fitsInt4 boundary inputs', () => {
  it('accepts INT4_MAX', () => {
    expect(fitsInt4(INT4_MAX)).toBe(true);
  });

  it('rejects INT4_MAX + 1', () => {
    expect(fitsInt4(INT4_MAX + 1)).toBe(false);
  });

  it('accepts INT4 minimum (-2147483648)', () => {
    expect(fitsInt4(-2_147_483_648)).toBe(true);
  });

  it('rejects below INT4 minimum', () => {
    expect(fitsInt4(-2_147_483_649)).toBe(false);
  });

  it('accepts zero', () => {
    expect(fitsInt4(0)).toBe(true);
  });

  it('rejects non-integers', () => {
    expect(fitsInt4(3.14)).toBe(false);
    expect(fitsInt4(0.5)).toBe(false);
  });

  it('rejects NaN', () => {
    expect(fitsInt4(NaN)).toBe(false);
  });

  it('rejects Infinity', () => {
    expect(fitsInt4(Infinity)).toBe(false);
  });
});

describe('int4Positive() schema boundary inputs', () => {
  it('rejects zero', () => {
    expect(int4Positive().safeParse(0).success).toBe(false);
  });

  it('accepts 1', () => {
    expect(int4Positive().safeParse(1).success).toBe(true);
  });

  it('accepts INT4_MAX', () => {
    expect(int4Positive().safeParse(INT4_MAX).success).toBe(true);
  });

  it('rejects INT4_MAX + 1', () => {
    expect(int4Positive().safeParse(INT4_MAX + 1).success).toBe(false);
  });

  it('rejects non-integer', () => {
    expect(int4Positive().safeParse(1.5).success).toBe(false);
  });

  it('rejects negative', () => {
    expect(int4Positive().safeParse(-1).success).toBe(false);
  });
});

describe('int4Version() schema boundary inputs', () => {
  it('rejects 0', () => {
    expect(int4Version().safeParse(0).success).toBe(false);
  });

  it('accepts 1', () => {
    expect(int4Version().safeParse(1).success).toBe(true);
  });

  it('accepts INT4_MAX', () => {
    expect(int4Version().safeParse(INT4_MAX).success).toBe(true);
  });

  it('rejects INT4_MAX + 1', () => {
    expect(int4Version().safeParse(INT4_MAX + 1).success).toBe(false);
  });
});
