import { describe, expect, it } from 'vitest';
import { VALUATION_KINDS } from '../../src/domain/valuation.js';
import { templateForKind } from '../../src/domain/report.js';

/**
 * The skeleton cannot introduce the duplicate the door now refuses.
 *
 * `PUT /valuations/:id/report` refuses a body carrying the same section key
 * twice (R419, methodology M19) — three downstream maps are keyed by it, and
 * the pair "the pristine copy says unwritten, the index resolves to the copy
 * somebody wrote" is how a narrative re-run overwrote an analyst's chapter.
 *
 * A report body starts life as `instantiateTemplate(templateForKind(kind))`,
 * so the refusal is only as good as the skeletons it is stated over: a
 * template declaring a key twice would hand every engagement of that kind a
 * body its own editor could no longer save, and would carry the same broken
 * index in the meantime. `withClosingSections` already dedupes the closing
 * block against what a template declares — this is the other half, over the
 * declarations themselves.
 */
describe('every report skeleton declares each section key once', () => {
  it('covers every kind the product ships', () => {
    expect(VALUATION_KINDS.length).toBeGreaterThan(5);
  });

  for (const kind of VALUATION_KINDS) {
    it(`${kind}`, () => {
      const keys = templateForKind(kind).sections.map((s) => s.key);
      expect(keys.length).toBeGreaterThan(0);
      const repeated = keys.filter((key, i) => keys.indexOf(key) !== i);
      expect(repeated, `${kind} repeats: ${repeated.join(', ')}`).toEqual([]);
    });
  }
});
