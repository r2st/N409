import { describe, expect, it } from 'vitest';
import { sameCompanyFilter } from '../../src/domain/valuationHistory.js';

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
