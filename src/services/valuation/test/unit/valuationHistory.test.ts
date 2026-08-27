import { describe, expect, it } from 'vitest';
import { sameCompany, sameCompanyFilter } from '../../src/domain/valuationHistory.js';

/**
 * Which engagements count as "the same client".
 *
 * The report's trend chart and the analytics series each carried their own copy
 * of this predicate and both scoped it to `user_id`, while the firm console
 * groups its client roster by `(partner_id, company_name)`. So a firm whose
 * engagements for one company were opened by two different members had one
 * client on the console and two unrelated companies everywhere the history is
 * drawn — and a two-point trend chart is suppressed below two points, so the
 * deliverable silently lost the comparison a board asks for first.
 */
describe('sameCompanyFilter', () => {
  const firmValuation = {
    user_id: '01USER00000000000000000A',
    partner_id: '01FIRM00000000000000000A',
    company_name: '  Halcyon Bio, Inc. ',
  };
  const directValuation = {
    user_id: '01USER00000000000000000B',
    partner_id: null,
    company_name: 'Northwind Robotics',
  };

  it('scopes a firm engagement to the firm, not to the member who opened it', () => {
    const { clause, params } = sameCompanyFilter(firmValuation);
    expect(clause).toContain('v.partner_id = $1');
    expect(clause).not.toContain('v.user_id');
    expect(params).toEqual(['01FIRM00000000000000000A', '  Halcyon Bio, Inc. ']);
  });

  it('scopes a direct client to its owner — there is no firm to group under', () => {
    // Grouping these on name alone would join unrelated companies across every
    // account on the platform, which is a different bug and a worse one.
    const { clause, params } = sameCompanyFilter(directValuation);
    expect(clause).toContain('v.user_id = $1');
    expect(clause).not.toContain('v.partner_id');
    expect(params).toEqual(['01USER00000000000000000B', 'Northwind Robotics']);
  });

  it('always matches the company name case- and whitespace-insensitively', () => {
    for (const v of [firmValuation, directValuation]) {
      expect(sameCompanyFilter(v).clause).toContain('lower(trim(v.company_name)) = lower(trim($2))');
    }
  });

  it('leaves archived engagements out of every history it scopes', () => {
    /*
     * R176: all three callers scanned `valuations v` with no archived clause,
     * and none of them is a list the user is picking from. The trend chart
     * plots a retired valuation's FMV as a point on a signed PDF; the analytics
     * series can seat one as the newest row, which is what the benchmark block
     * is computed from; and the bridge offers one as a comparison candidate.
     *
     * Asserted on the builder rather than on the three call sites for the
     * reason `buildValuationWhere` gives for owning its own `archived_at IS
     * NULL`: a rule each caller has to remember is a rule a fourth caller will
     * forget.
     */
    for (const v of [firmValuation, directValuation]) {
      expect(sameCompanyFilter(v).clause).toContain('v.archived_at IS NULL');
    }
  });

  it('binds exactly $1 and $2, so a caller can append its own from $3', () => {
    for (const v of [firmValuation, directValuation]) {
      const { clause, params } = sameCompanyFilter(v);
      expect(params).toHaveLength(2);
      expect(clause).not.toMatch(/\$[3-9]/);
      expect(clause.match(/\$1/g)).toHaveLength(1);
      expect(clause.match(/\$2/g)).toHaveLength(1);
    }
  });
});

/**
 * The same question decided between two rows in hand — what the value bridge
 * needs, and the one caller that was left spelling the superseded rule itself.
 */
describe('sameCompany', () => {
  const firm = '01FIRM00000000000000000A';
  const alice = '01USER0000000000000000AL';
  const bob = '01USER0000000000000000BO';
  const ref = (over: Partial<{ user_id: string; partner_id: string | null; company_name: string }> = {}) => ({
    user_id: alice,
    partner_id: firm as string | null,
    company_name: 'Halcyon Bio, Inc.',
    ...over,
  });

  it('joins two engagements one firm opened under different members', () => {
    // The case the whole fix is about: client intake gives a converted
    // questionnaire to whoever pressed Convert, so this is the ordinary shape.
    expect(sameCompany(ref(), ref({ user_id: bob }))).toBe(true);
  });

  it('keeps two firms apart even under an identical company name', () => {
    expect(sameCompany(ref(), ref({ partner_id: '01FIRM00000000000000000B' }))).toBe(false);
  });

  it('scopes a direct client to its owner, since there is no firm to group under', () => {
    const direct = ref({ partner_id: null });
    expect(sameCompany(direct, ref({ partner_id: null }))).toBe(true);
    expect(sameCompany(direct, ref({ partner_id: null, user_id: bob }))).toBe(false);
  });

  it('never joins a firm engagement to a direct one', () => {
    // Neither side's `sameCompanyFilter` would return the other, so the
    // predicate must not either — a firm's client and a self-serve account are
    // not one company's history.
    expect(sameCompany(ref(), ref({ partner_id: null }))).toBe(false);
    expect(sameCompany(ref({ partner_id: null }), ref())).toBe(false);
  });

  it('folds the company name exactly as the SQL does', () => {
    expect(sameCompany(ref(), ref({ company_name: '  halcyon bio, inc. ' }))).toBe(true);
    expect(sameCompany(ref(), ref({ company_name: 'Halcyon Biosciences' }))).toBe(false);
  });

  it('is symmetric', () => {
    const pairs: Array<[ReturnType<typeof ref>, ReturnType<typeof ref>]> = [
      [ref(), ref({ user_id: bob })],
      [ref(), ref({ partner_id: null })],
      [ref({ partner_id: null }), ref({ partner_id: null, user_id: bob })],
      [ref(), ref({ company_name: 'Other Co' })],
    ];
    for (const [a, b] of pairs) expect(sameCompany(a, b)).toBe(sameCompany(b, a));
  });
});
