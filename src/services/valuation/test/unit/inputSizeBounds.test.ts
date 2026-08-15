import { describe, expect, it } from 'vitest';
import {
  IntakeAnswers,
  MAX_INTAKE_ANSWER_CHARS,
  MAX_INTAKE_ANSWER_KEYS,
  narrowIntakeAnswers,
} from '../../src/domain/intake.js';
import { ParamsPatchBody } from '../../src/routes/params.js';
import { ROLE_KEYS, RoleSet } from '../../src/domain/roles.js';

/**
 * The inputs whose *size* nothing measured.
 *
 * Every one of these already validated the shape of what it accepted — an
 * intake answer had to be a scalar, a role had to be one of the known keys, a
 * treasury yield had to sit in [0, 1]. What none of them bounded was how many,
 * or how long, so the effective ceiling was Fastify's 1 MB body: about 60,000
 * repetitions of `"admin"`, or 50,000 points on a yield curve that has thirteen.
 *
 * Each of these lands somewhere it stays: `valuation_params` and
 * `asc718_settings` are `jsonb` columns re-read on every page load and re-sent
 * to the engine on every compute, and the roles array becomes one `text[]`
 * parameter against a table with one row per role key. None of them is a crash;
 * together they are a client-controlled multiplier on stored bytes and on work
 * per request, which is what "resource exhaustion" means when there is a body
 * limit in front of you.
 */

const bigString = (n: number) => 'x'.repeat(n);

describe('intake answers', () => {
  const answers = (v: Record<string, unknown>) => IntakeAnswers.safeParse(v);

  it('accepts the scalars a wizard produces', () => {
    expect(answers({ legal_name: 'Acme, Inc.', headcount: 42, has_debt: true, notes: null }).success).toBe(
      true,
    );
  });

  it('accepts an answer exactly at the character bound', () => {
    expect(answers({ notes: bigString(MAX_INTAKE_ANSWER_CHARS) }).success).toBe(true);
  });

  /**
   * The anonymous portal writes through this same schema — it authenticates on
   * a link token and nothing else — so a single answer could be the whole body.
   */
  it('refuses one character past it, and names the field', () => {
    const result = answers({ notes: bigString(MAX_INTAKE_ANSWER_CHARS + 1) });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['notes']);
  });

  it('refuses more answers than any questionnaire has fields', () => {
    const wide = Object.fromEntries(
      Array.from({ length: MAX_INTAKE_ANSWER_KEYS + 1 }, (_, i) => [`k${i}`, 'v']),
    );
    expect(answers(wide).success).toBe(false);
  });

  it('refuses an answer key long enough to be a payload of its own', () => {
    expect(answers({ [bigString(201)]: 'v' }).success).toBe(false);
  });

  /**
   * Caught by `finiteNumberSweep`, and worth pinning here too: `1e999` parses
   * to Infinity, and `JSON.stringify` writes Infinity to a jsonb column as
   * `null` — so the answer the client typed would have been silently discarded
   * with a 200 on the way back.
   */
  it('refuses a numeric answer that JSON overflowed to Infinity', () => {
    expect(answers({ headcount: JSON.parse('1e999') as number }).success).toBe(false);
  });

  /**
   * The bound must not annex the narrow step's decision. Writing the value side
   * of this record as a scalar union reads like a tightening, but it converts
   * every silent drop into a 422 — and the anonymous portal autosaves on a
   * timer, so one object on a legal key would start rejecting whole payloads
   * that the wizard has no way to have produced.
   */
  it('passes a non-scalar through to be dropped rather than refusing the payload', () => {
    const result = answers({ legal_name: { $ne: null }, business_description: ['a'], industry: 'Robotics' });
    expect(result.success).toBe(true);
    expect(narrowIntakeAnswers(result.data!)).toEqual({ industry: 'Robotics' });
  });

  it('bounds a long string without regard to whether its key is a real field', () => {
    // The drop happens after the schema, so an unknown key is no reason to skip
    // the measurement — the bytes arrived either way.
    expect(answers({ not_a_field: bigString(MAX_INTAKE_ANSWER_CHARS + 1) }).success).toBe(false);
  });

  it('leaves the narrow step doing its own job', () => {
    // Bounds are the schema's; dropping an unknown key and a non-scalar value
    // stays here, because those are shapes the wizard cannot produce and this
    // runs on every keystroke's autosave.
    expect(narrowIntakeAnswers({ legal_name: 'Acme', not_a_field: 'x', bad: { deep: 1 } })).toEqual({
      legal_name: 'Acme',
    });
  });
});

describe('admin role arrays', () => {
  // The elements were bounded by the enum and the array was not, so the same
  // keys could be repeated until the body limit stopped them. `RoleSet` is what
  // the create, patch and invite bodies in routes/adminUsers.ts all now use.
  const roles = (v: unknown) => RoleSet.safeParse(v);

  it('accepts the whole role set at once', () => {
    expect(roles([...ROLE_KEYS]).success).toBe(true);
  });

  it('refuses a list longer than there are distinct roles', () => {
    expect(roles(Array.from({ length: ROLE_KEYS.length + 1 }, () => 'admin')).success).toBe(false);
  });

  it('refuses the 60,000-element list the body limit used to allow', () => {
    expect(roles(Array.from({ length: 60_000 }, () => 'admin')).success).toBe(false);
  });
});

describe('valuation params jsonb maps', () => {
  const patch = (v: Record<string, unknown>) => ParamsPatchBody.safeParse(v);
  const curve = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), 0.04]));

  it('accepts a real treasury curve', () => {
    expect(patch({ wacc_inputs: { treasury_curve: curve(13) } }).success).toBe(true);
  });

  it('accepts one exactly at the bound', () => {
    expect(patch({ wacc_inputs: { treasury_curve: curve(100) } }).success).toBe(true);
  });

  it('refuses one point past it', () => {
    expect(patch({ wacc_inputs: { treasury_curve: curve(101) } }).success).toBe(false);
  });

  it('still range-checks every yield in an accepted curve', () => {
    expect(patch({ wacc_inputs: { treasury_curve: { '5': 1.5 } } }).success).toBe(false);
  });

  it('bounds the custom market ranges the same way', () => {
    const wide = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`r${i}`, 1]));
    expect(patch({ market_custom_ranges: wide }).success).toBe(false);
    expect(patch({ market_custom_ranges: { ev_revenue: [1, 5] } }).success).toBe(true);
  });
});
