import { describe, expect, it } from 'vitest';
import { keyOf, MEASURED, scanExpressionSorts, SRC_DIR, UNMEASURED } from '../support/expressionSorts.js';

/**
 * Every `ORDER BY` whose leading term is an expression is either measured for
 * its plan or named as deliberately unmeasured, with a mechanism.
 *
 * See `test/support/expressionSorts.ts` for why this exists as a source scan
 * rather than a list: R202's plan guard asks the right question of a roster
 * somebody typed, and `listScimTokens` — `listAllApiTokens` character for
 * character on a second ledger — was never in it. R251 found it by planning
 * every statement in the service; this test is what would have found it by
 * reading, on a machine with no database.
 */
describe('every expression-ordered list is accounted for', () => {
  const found = scanExpressionSorts(SRC_DIR);

  it('is reading real SQL and not prose about it', () => {
    // The vacuity guard. Both halves are shapes this repo reformats — a query
    // wrapped onto another line, a comment rewritten — and a scanner that
    // stopped matching would report an empty set, which is what "no drift"
    // looks like from the outside.
    expect(found.length).toBeGreaterThanOrEqual(10);

    // It finds the statements that are the whole point of the file...
    const keys = found.map(keyOf);
    expect(keys).toContain('repos/ssoConfig.ts :: (revoked_at IS NULL) DESC');
    expect(keys).toContain('repos/apiTokens.ts :: (t.revoked_at IS NULL) DESC');

    // ...and not the plain column sorts, which are 0170's subject and are
    // everywhere. If one of these appears the term classifier has broken open
    // and the roster below will fill up with noise.
    expect(keys.some((k) => /:: created_at DESC$/.test(k))).toBe(false);
    expect(keys.some((k) => /:: [a-z_]+ ASC$/.test(k))).toBe(false);
  });

  it('leaves no expression-ordered list unaccounted for', () => {
    const accounted = new Set([...MEASURED, ...Object.keys(UNMEASURED)]);
    const unaccounted = found
      .filter((s) => !accounted.has(keyOf(s)))
      .map((s) => `${keyOf(s)}  (${s.file}:${s.line})`);
    expect([...new Set(unaccounted)]).toEqual([]);
  });

  it('names nothing the service no longer issues', () => {
    // The other direction, and the one a rewrite breaks: a roster entry whose
    // statement has been respelled is a plan assertion aimed at nothing, and
    // the integration suite can only say so where a database is up.
    const present = new Set(found.map(keyOf));
    const gone = [...MEASURED, ...Object.keys(UNMEASURED)].filter((k) => !present.has(k));
    expect(gone).toEqual([]);
  });

  it('states a mechanism, not a hope, for every exemption', () => {
    // Same bar as `listScalingCoverage`: "it is a small table" is the reason a
    // full sort survives to the day the table is not small.
    const vague = Object.entries(UNMEASURED).filter(
      ([, why]) =>
        why.trim().length < 80 ||
        /\b(small|short|few|low) (enough|in practice)\b|\bunlikely to\b|\brarely\b|\bfor now\b|\bnobody has\b|\bin practice\b/i.test(
          why,
        ),
    );
    expect(vague.map(([key]) => key)).toEqual([]);
  });

  it('measures and exempts disjoint sets', () => {
    expect(MEASURED.filter((k) => k in UNMEASURED)).toEqual([]);
    expect(new Set(MEASURED).size).toBe(MEASURED.length);
  });
});
