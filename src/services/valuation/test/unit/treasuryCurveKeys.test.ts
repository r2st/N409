import { describe, expect, it } from 'vitest';
import { ParamsPatchBody } from '../../src/routes/params.js';

/**
 * The maturities on a Treasury curve, checked at the door that stores them
 * (R410, methodology M19).
 *
 * `wacc_inputs.treasury_curve` is `{ maturity_years: yield }`. The yields were
 * range-checked and the point count was capped; the *keys* were checked by
 * nothing, on the strength of a comment saying "the engine reads the keys as
 * numbers whether they arrive as strings or not" — an assumption about them
 * rather than a check on them.
 *
 * `wacc._normalize_curve` is where they are actually read, and it refuses four
 * things this door stored under a 200. Each is the shape R406 closed for
 * `dlom`: the PATCH succeeds, the engagement looks configured, and the 422
 * arrives on whoever next presses Calculate — worse here, because the curve is
 * persisted and re-sent on every compute, so one bad tenor stops every
 * calculation on the engagement until somebody finds it.
 */
describe('treasury_curve maturities', () => {
  const curve = (c: Record<string, number>) =>
    ParamsPatchBody.safeParse({ wacc_inputs: { treasury_curve: c } });

  it('accepts a curve written the way Treasury publishes one', () => {
    expect(curve({ '0.25': 0.048, '2': 0.043, '5': 0.042, '10': 0.045, '30': 0.047 }).success).toBe(
      true,
    );
  });

  it('accepts a maturity float() would take, because that is what the engine calls', () => {
    // `_num` is `float(value)`, which takes surrounding space and exponent
    // notation. Agreeing with it is the point of the check.
    expect(curve({ ' 5 ': 0.042, '1e1': 0.045 }).success).toBe(true);
  });

  it('refuses a tenor written as a label', () => {
    // `{ "5y": … }`, `{ "30-year": … }`, `{ "5 years": … }` — the way a human
    // writes a maturity, and a bare TypeError-turned-422 from the engine.
    for (const key of ['5y', '2Y', '30-year', '5 years', '']) {
      expect(curve({ [key]: 0.042 }).success).toBe(false);
    }
  });

  it('refuses a maturity that is not positive', () => {
    // Overnight written as zero, and a sign slip. `_num(..., positive=True)`.
    expect(curve({ '0': 0.048 }).success).toBe(false);
    expect(curve({ '-1': 0.048 }).success).toBe(false);
  });

  it('refuses two spellings of one maturity', () => {
    // `_normalize_curve`'s own example: "interpolating strictly between them
    // divides by `m1 - m0` == 0".
    const res = curve({ '5': 0.04, '5.0': 0.05 });
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error?.issues)).toContain('same maturity');
  });

  it('refuses an empty curve rather than storing one nothing can interpolate', () => {
    // `risk_free_rate` keeps an explicitly empty curve distinct from an absent
    // one on purpose, so that clearing the last tenor is not silently answered
    // from the placeholder curve. Storing it means every compute answers
    // "treasury curve is empty".
    expect(curve({}).success).toBe(false);
  });

  it('still caps the point count, and still range-checks the yields', () => {
    const many = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [String(i + 1), 0.04] as const),
    );
    expect(curve(many).success).toBe(false);
    expect(curve({ '5': 4.2 }).success).toBe(false);
  });

  it('names the offending key, so the refusal says which tenor to fix', () => {
    const res = curve({ '5': 0.042, '10y': 0.045 });
    expect(res.success).toBe(false);
    expect(res.error?.issues.some((i) => i.path.includes('10y'))).toBe(true);
  });
});
