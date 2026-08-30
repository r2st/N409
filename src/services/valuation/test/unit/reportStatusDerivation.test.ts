import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORT_STATUSES, reportStatusFor } from '../../src/domain/report.js';
import { VALUATION_STATES } from '../../src/domain/valuation.js';
import { WORKFLOW_TRANSITIONS } from '../../src/domain/workflow.js';

/**
 * What a report is *at*, and the column that could never say so.
 *
 * `reports.status` (migration 0010) is a four-member enum defaulted to
 * `'draft'`, and no statement in this service has ever written it: `saveVersion`
 * updates `current_version`, `template_version` and `updated_at`, and nothing
 * else updates the row at all. Three of the four members were therefore
 * unreachable and the fourth was a constant, while four surfaces printed the
 * column as a status somebody maintained — the report tab's badge, the package
 * explorer, the partner API's `report_downloaded` event, and the auditor
 * portal, which headed the document `Report — draft`.
 *
 * The portal is the one that mattered. It shares the report from `drafted`
 * onward, `published` included, so an auditor holding the issued deliverable of
 * a published engagement — no DRAFT watermark on it, because the watermark is
 * keyed on the engagement's state — was told in the heading that it was a
 * draft.
 *
 * So the status is derived from the engagement's own state, which is the
 * editorial round trip and is the thing `WORKFLOW_TRANSITIONS` already guards.
 * These assertions are about that derivation being total, being onto, and
 * agreeing with the lifecycle it reads from; the census at the bottom is what
 * keeps the stale column from coming back.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '../../src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('the report status derivation', () => {
  it('answers for every state a valuation can hold', () => {
    for (const state of VALUATION_STATES) {
      expect(REPORT_STATUSES).toContain(reportStatusFor(state));
    }
  });

  it('reaches all four members of the enum, which the stored column never did', () => {
    const reached = new Set(VALUATION_STATES.map((s) => reportStatusFor(s)));
    expect([...reached].sort()).toEqual([...REPORT_STATUSES].sort());
  });

  it('names the deliverable final only where the engagement is published', () => {
    const published = VALUATION_STATES.filter((s) => reportStatusFor(s) === 'published');
    expect(published).toEqual(['published']);
  });

  it('reads accepted and changes off the two states that mean them', () => {
    expect(reportStatusFor('draft_accepted')).toBe('accepted');
    expect(reportStatusFor('draft_changes')).toBe('changes');
    // The state the analyst writes the body in is a draft, not an acceptance —
    // `drafted → draft_accepted` is a separate edge somebody has to take.
    expect(reportStatusFor('drafted')).toBe('draft');
    expect(WORKFLOW_TRANSITIONS.drafted).toContain('draft_accepted');
  });

  it('calls an abandoned engagement a draft rather than carrying its last word', () => {
    // A restart lands on `started`, and every terminal-ish state is a place a
    // file stopped rather than a statement about the document.
    for (const state of ['cancelled', 'ignored', 'timeout', 'pending'] as const) {
      expect(reportStatusFor(state)).toBe('draft');
    }
  });

  /**
   * The stored column stays in the database — migrations here are additive —
   * and `SELECT *` still returns it, so the only thing standing between it and
   * a reader is that `ReportRow` does not declare it. This says so out loud:
   * a route that reaches for `report.status` again is reading `'draft'` off
   * every row in the estate.
   */
  it('is the only reading of a report status in the service', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        if (/\breport(Row)?\.status\b/.test(line)) {
          offenders.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
