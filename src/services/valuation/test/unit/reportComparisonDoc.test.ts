import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCHEDULE_CATALOGUE, scheduleTitle } from '../../src/domain/reportExhibits.js';
import { TAG_CATALOGUE, TAG_CATEGORIES } from '../../src/domain/valuationTags.js';

/**
 * `docs/N409-vs-409ai-Report-Comparison.md` against the code it describes.
 *
 * The document is a gap list, and a gap list is read as a work order. This one
 * was generated on 2026-08-09 and then sat still while the deliverable grew
 * three appendices, five exhibits and six AI pipelines — so by R32 it was
 * asserting that features which existed did not, and two rounds were planned
 * against premises the code had already refuted. ("AI comparables discovery —
 * comps are manual input only" was written while the `comp_selection` agent was
 * in the tree.)
 *
 * The fix for a document that goes stale silently is not to rewrite it more
 * often. It is to make the staleness loud. These cases fail when the schedule
 * catalogue and the document's §1.4 table come apart in either direction:
 * a schedule that ships without being recorded as closed, and a schedule the
 * document claims that the deliverable does not build.
 *
 * This is the same argument `SCHEDULE_CATALOGUE`'s own header makes about the
 * public sample page — a hand-maintained list beside a generated one drifts,
 * and the only arrangement in which they cannot is one that checks.
 */

const DOC = fileURLToPath(new URL('../../../../../docs/N409-vs-409ai-Report-Comparison.md', import.meta.url));

async function doc(): Promise<string> {
  return readFile(DOC, 'utf8');
}

describe('the 409.ai comparison document', () => {
  it('names every schedule the deliverable actually builds', async () => {
    const text = await doc();
    const missing = SCHEDULE_CATALOGUE.filter((s) => !text.includes(`${s.kind} ${s.id} — ${s.name}`));
    expect(
      missing.map(scheduleTitle),
      'These schedules ship but the comparison document does not list them — it is stale again. ' +
        'Add a row to §1.4 and mark the corresponding gap closed.',
    ).toEqual([]);
  });

  /**
   * The other direction. A row promising `Exhibit J` to a reader comparing this
   * platform against 409.ai is the failure the original document made in
   * reverse, and it is the more embarrassing one.
   */
  it('claims no schedule the deliverable does not build', async () => {
    const text = await doc();
    const built = new Set(SCHEDULE_CATALOGUE.map((s) => `${s.kind} ${s.id}`));
    const claimed = [...text.matchAll(/\*\*(Exhibit|Appendix) ([A-Z]+(?:-\d)?) — /g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(claimed.length).toBeGreaterThan(0);
    expect([...new Set(claimed)].filter((c) => !built.has(c))).toEqual([]);
  });

  /**
   * The two schedules the document reported as missing until this round.
   *
   * The case has flipped rather than been deleted, and it still does the same
   * job from the other side. It used to fail when either appendix was built
   * while the document still called it a gap; it now fails if either is removed
   * while the document still calls it closed. Both directions are the same
   * defect — a reader planning work against a claim the code has refuted.
   */
  it('is right that the OPM and time-series appendices now ship', async () => {
    const text = await doc();
    expect(text).toContain('**GAP #11 — CLOSED**');
    expect(text).toContain('**GAP #13 — CLOSED**');
    const names = SCHEDULE_CATALOGUE.map((s) => s.name);
    expect(names.some((n) => /Option Pricing Model/.test(n))).toBe(true);
    expect(names.some((n) => /Operating Metrics/.test(n))).toBe(true);
  });

  /** The open list and the headline count are one claim written twice. */
  it('counts its own open gaps correctly', async () => {
    const text = await doc();
    const open = new Set([...text.matchAll(/\*\*GAP #(\d+) — OPEN\*\*/g)].map((m) => m[1]));
    // §2 marks its gaps in a differently-shaped cell.
    const openInAiTable = new Set([...text.matchAll(/\*\*#(\d+) — OPEN\*\*/g)].map((m) => m[1]));
    const all = new Set([...open, ...openInAiTable]);
    expect([...all].sort()).toEqual([]);
    expect(text).toContain('31 identified, 31 closed, 0 open');
  });

  /**
   * #23, the last of the thirty-one, and the one the document was most likely
   * to go on being wrong about — it had been open long enough to read as
   * permanent.
   *
   * Flipped rather than deleted, the same way #11 and #13 were: it used to fail
   * if the tagging agent shipped while the document still called it a gap, and
   * it now fails if the agent is removed while the document still calls it
   * closed. The catalogue assertion is the one that matters, because the
   * document's claim is not "tagging exists" — it is that the vocabulary is
   * *closed*, which is the whole divergence from 409.ai's free-text prompt and
   * the only reason the tags are queryable.
   */
  it('is right that AI auto-tagging now ships against a closed vocabulary', async () => {
    const text = await doc();
    expect(text).toContain('**#23 — CLOSED**');
    expect(TAG_CATALOGUE.length).toBeGreaterThan(0);
    expect(text).toContain(`closed** 40-tag vocabulary`);
    // The count in the prose is a claim about the code, so it is checked
    // against the code rather than proof-read.
    expect(TAG_CATALOGUE.length).toBe(40);
    expect(TAG_CATEGORIES).toHaveLength(6);
  });
});
