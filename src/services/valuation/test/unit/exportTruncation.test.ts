import { describe, expect, it } from 'vitest';
import { truncationNotice, truncationOf } from '../../src/routes/exports.js';

const MAX = 10_000;
const rows = (n: number) => Array.from({ length: n }, (_, i) => i);

/**
 * The row cap has always been here; what was missing was any way for the reader
 * to know it applied. See the note on truncationOf for why a silently short
 * audit export is worse than one that refuses.
 */
describe('truncationOf', () => {
  it('reports an export well under the cap as complete', () => {
    expect(truncationOf(rows(5))).toEqual({ rows: rows(5), truncated: false });
  });

  /**
   * The boundary that matters. The query asks for MAX + 1, so exactly MAX rows
   * back means the last page fitted — the cap did *not* bite, and calling it
   * truncated would cry wolf on every export that happens to be exactly full.
   */
  it('treats exactly the cap as complete, not truncated', () => {
    const out = truncationOf(rows(MAX));
    expect(out.truncated).toBe(false);
    expect(out.rows).toHaveLength(MAX);
  });

  it('reports truncation as soon as one row beyond the cap exists', () => {
    const out = truncationOf(rows(MAX + 1));
    expect(out.truncated).toBe(true);
    // The probe row is dropped rather than emitted: the file still holds
    // exactly the cap, so no consumer sees an off-by-one extra row.
    expect(out.rows).toHaveLength(MAX);
  });

  it('emits no more than the cap however many rows came back', () => {
    expect(truncationOf(rows(MAX + 500)).rows).toHaveLength(MAX);
  });

  it('handles an empty result', () => {
    expect(truncationOf([])).toEqual({ rows: [], truncated: false });
  });
});

describe('truncationNotice', () => {
  it('says what happened and what to do about it', () => {
    const notice = truncationNotice(MAX);
    expect(notice).toContain('TRUNCATED');
    expect(notice).toContain('10,000');
    expect(notice).toMatch(/filter/i);
  });
});
