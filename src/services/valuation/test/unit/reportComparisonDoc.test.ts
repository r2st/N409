import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCHEDULE_CATALOGUE, scheduleTitle } from '../../src/domain/reportExhibits.js';

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
   * The two schedules the document still reports as missing. If either is built,
   * this fails — which is the point: the round that ships one has to say so
   * here, rather than leaving the next round to plan against a closed gap.
   */
  it('is right that the OPM and time-series appendices do not exist yet', async () => {
    const text = await doc();
    expect(text).toContain('**GAP #11 — OPEN**');
    expect(text).toContain('**GAP #13 — OPEN**');
    const names = SCHEDULE_CATALOGUE.map((s) => s.name);
    // `\b` and not `includes('opm')`: "Stage of Development" contains it, which
    // is how the first draft of this case failed.
    expect(names.some((n) => /\bOPM\b/.test(n))).toBe(false);
    expect(names.some((n) => /time series/i.test(n))).toBe(false);
  });

  /** The open list and the headline count are one claim written twice. */
  it('counts its own open gaps correctly', async () => {
    const text = await doc();
    const open = new Set([...text.matchAll(/\*\*GAP #(\d+) — OPEN\*\*/g)].map((m) => m[1]));
    // §2 marks #23 open in a differently-shaped cell.
    const openInAiTable = new Set([...text.matchAll(/\*\*#(\d+) — OPEN\*\*/g)].map((m) => m[1]));
    const all = new Set([...open, ...openInAiTable]);
    expect([...all].sort()).toEqual(['11', '13', '23']);
    expect(text).toContain('31 identified, 28 closed, 3 open');
  });
});
