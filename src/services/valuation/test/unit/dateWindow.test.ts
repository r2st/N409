import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkWindowOrder, dateWindowFields } from '../../src/domain/dateWindow.js';

/**
 * An inverted date window is the one bad query that comes back looking like a
 * good answer.
 *
 * Both audit surfaces push `from`/`to` into SQL as an inclusive range, so
 * `from > to` matches nothing and returns an empty page with a 200. On a list of
 * search results that is a shrug; on "what changed in this period, and who
 * changed it" it is indistinguishable from "nothing changed", which is a finding
 * an auditor files.
 */

const Query = z.object({ ...dateWindowFields }).superRefine(checkWindowOrder);

const parse = (q: Record<string, string>) => Query.safeParse(q);

describe('a date window the caller inverted', () => {
  it('is rejected rather than answered with an empty page', () => {
    const result = parse({ from: '2026-06-30', to: '2026-01-01' });
    expect(result.success).toBe(false);
    if (result.success) return;
    // Named against `to`, so a field-level form error lands on the second input.
    expect(result.error.issues[0]!.path).toEqual(['to']);
    expect(result.error.issues[0]!.message).toMatch(/earlier than/);
  });

  it('accepts a window the right way round', () => {
    const result = parse({ from: '2026-01-01', to: '2026-06-30' });
    expect(result.success).toBe(true);
  });

  /**
   * The bounds are inclusive, so a single instant is a legitimate window and
   * not the mistake this check is for.
   */
  it('accepts a window whose bounds are equal', () => {
    expect(parse({ from: '2026-01-01', to: '2026-01-01' }).success).toBe(true);
  });

  it('accepts a half-open window, and one with no bounds at all', () => {
    expect(parse({ from: '2026-06-30' }).success).toBe(true);
    expect(parse({ to: '2026-01-01' }).success).toBe(true);
    expect(parse({}).success).toBe(true);
  });

  /**
   * Ordering is compared on the instant, not on the string: `from` a minute
   * later on the same day is still inverted, and lexical comparison of the two
   * ISO strings would have said otherwise for any pair of differing formats.
   */
  it('compares instants rather than the text they were written as', () => {
    expect(parse({ from: '2026-01-01T12:00:00Z', to: '2026-01-01T11:59:00Z' }).success).toBe(false);
    expect(parse({ from: '2026-01-01T00:00:00Z', to: '2026-01-01' }).success).toBe(true);
  });

  /** An unparseable bound is already a 400; the order check must not mask it. */
  it('leaves an unparseable bound reported as the bad date it is', () => {
    const result = parse({ from: 'nonsense', to: '2026-01-01' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.includes('from'))).toBe(true);
  });
});
