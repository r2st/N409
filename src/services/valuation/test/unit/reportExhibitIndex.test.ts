import { describe, expect, it } from 'vitest';
import {
  danglingReferences,
  renderedScheduleIds,
  resolveExhibitReferences,
} from '../../src/domain/reportExhibitIndex.js';
import { instantiateTemplate, templateForKind, type ReportContent } from '../../src/domain/report.js';
import { scheduleTitle, SCHEDULE_CATALOGUE } from '../../src/domain/reportExhibits.js';

/**
 * The defect these cover is not a wrong number, which is why every arithmetic
 * check in the suite passed while it shipped: a stored body names its exhibits
 * in prose, and the exhibits themselves are conditional on what the calculation
 * produced. So a 409A that gave the asset approach no weight printed no Exhibit
 * E, and told the reader on the previous page where to find it — and an Index of
 * Exhibits that listed all fifteen, under a sentence promising that only the
 * applicable ones were included.
 *
 * The rule under test throughout: the resolved body may name a schedule only if
 * that schedule is in the file.
 */

/**
 * Every schedule the renderer can print, from the catalogue the builders take
 * their headings from. This was a hand-copied list until it fell a schedule
 * behind — it never gained Appendix III — which is the same drift the
 * catalogue exists to make impossible. `reportExhibits.test.ts` pins the
 * catalogue against what `buildExhibits` actually emits.
 */
const ALL_EXHIBITS = SCHEDULE_CATALOGUE.map(scheduleTitle);

/** What a going concern with no asset approach and a judged sigma actually gets. */
const TYPICAL = ALL_EXHIBITS.filter((h) => !h.startsWith('Exhibit E ') && !h.startsWith('Exhibit F-1 '));

const content = (sections: { key: string; html: string }[]): ReportContent => ({
  title: 'Report',
  sections: sections.map((s) => ({ key: s.key, heading: s.key, html: s.html })),
});

const html = (body: ReportContent, key: string): string => body.sections.find((s) => s.key === key)!.html;

describe('renderedScheduleIds', () => {
  it('reads the identifier out of each builder heading', () => {
    expect(renderedScheduleIds(ALL_EXHIBITS)).toEqual(
      new Set(['A', 'B', 'C', 'C-1', 'D', 'D-1', 'E', 'F', 'F-1', 'G', 'H', 'H-1', 'I', 'II', 'III']),
    );
  });

  it('ignores a heading that is not a schedule title', () => {
    // The exhibit list is built from section headings, and not every section a
    // builder emits is an exhibit.
    expect(renderedScheduleIds(['Summary of Findings', 'Exhibit A — Capitalization Table'])).toEqual(
      new Set(['A']),
    );
  });

  it('is empty for a report drafted before the engine has run', () => {
    expect(renderedScheduleIds([])).toEqual(new Set());
  });
});

describe('resolveExhibitReferences — conditional pointers', () => {
  it('keeps the block whose schedule is printed', () => {
    const body = resolveExhibitReferences(
      content([
        {
          key: 'income',
          html: '<p>DCF.{{#exhibit:C-1}} See <strong>Exhibit C-1</strong>.{{/exhibit:C-1}}</p>',
        },
      ]),
      ALL_EXHIBITS,
    );
    expect(html(body, 'income')).toBe('<p>DCF. See <strong>Exhibit C-1</strong>.</p>');
  });

  it('drops the block whose schedule is not, leaving the chapter behind', () => {
    // The chapter itself is the point: an approach considered and given no
    // weight is worth saying so. Only the pointer goes.
    const body = resolveExhibitReferences(
      content([
        {
          key: 'asset',
          html: '<p>Not applied.{{#exhibit:E}} See <strong>Exhibit E</strong>.{{/exhibit:E}}</p>',
        },
      ]),
      TYPICAL,
    );
    expect(html(body, 'asset')).toBe('<p>Not applied.</p>');
  });

  it('resolves every occurrence of a schedule named in more than one chapter', () => {
    // H-1 is named by Selected Volatility and again by the DLOM chapter. A
    // single-shot replace would leave the second one printing its own braces.
    const one = '{{#exhibit:H-1}}see H-1{{/exhibit:H-1}}';
    const body = resolveExhibitReferences(
      content([
        { key: 'vol', html: `<p>a ${one} b ${one}</p>` },
        { key: 'dlom', html: `<p>c ${one}</p>` },
      ]),
      TYPICAL,
    );
    expect(html(body, 'vol')).toBe('<p>a see H-1 b see H-1</p>');
    expect(html(body, 'dlom')).toBe('<p>c see H-1</p>');
  });

  it('matches the identifier case-insensitively but does not cross schedules', () => {
    const body = resolveExhibitReferences(
      content([{ key: 's', html: '{{#exhibit:c-1}}kept{{/exhibit:c-1}}{{#exhibit:E}}gone{{/exhibit:E}}' }]),
      TYPICAL,
    );
    expect(html(body, 's')).toBe('kept');
  });

  it('leaves a section it did not change identical, not merely equal', () => {
    // The renderer maps over every section on every render; an untouched
    // chapter should not be reallocated.
    const original = content([{ key: 'plain', html: '<p>No pointers here.</p>' }]);
    const body = resolveExhibitReferences(original, ALL_EXHIBITS);
    expect(body.sections[0]).toBe(original.sections[0]);
  });
});

describe('resolveExhibitReferences — the index', () => {
  it('lists exactly the schedules built, in printed order', () => {
    const body = resolveExhibitReferences(
      content([{ key: 'exhibit_index', html: '<p>The exhibits follow.</p>{{exhibit_index}}' }]),
      TYPICAL,
    );
    const index = html(body, 'exhibit_index');
    expect(index).toContain('<li>Exhibit A — Capitalization Table</li>');
    expect(index).toContain('<li>Appendix II — Historical Financial Statements</li>');
    // The two that were not built are the whole point.
    expect(index).not.toContain('Exhibit E —');
    expect(index).not.toContain('Exhibit F-1 —');
    expect(index.indexOf('Exhibit A')).toBeLessThan(index.indexOf('Exhibit B'));
  });

  it('replaces the stale static list in a body drafted before the marker existed', () => {
    // Stored reports carry the enumerated list the old skeleton wrote. They
    // must not have to be re-drafted to stop naming exhibits they do not have.
    const legacy = content([
      {
        key: 'exhibit_index',
        html: '<p>The exhibits follow.</p><ul><li>Exhibit A — Capitalization Table</li><li>Exhibit E — Asset Approach</li></ul><p>Only where applied.</p>',
      },
    ]);
    const index = html(resolveExhibitReferences(legacy, TYPICAL), 'exhibit_index');
    expect(index).not.toContain('Exhibit E');
    expect(index).toContain('<li>Exhibit C-1 — Basis of the Cash-Flow Forecast</li>');
    expect(index).toContain('<p>Only where applied.</p>');
  });

  it('appends a list where an analyst rewrote the chapter entirely', () => {
    const index = html(
      resolveExhibitReferences(content([{ key: 'exhibit_index', html: '<p>Schedules.</p>' }]), TYPICAL),
      'exhibit_index',
    );
    expect(index).toContain('<p>Schedules.</p>');
    expect(index).toContain('<li>Exhibit A — Capitalization Table</li>');
  });

  it('says so, rather than printing an empty list, before the engine has run', () => {
    const index = html(
      resolveExhibitReferences(content([{ key: 'exhibit_index', html: '{{exhibit_index}}' }]), []),
      'exhibit_index',
    );
    expect(index).not.toContain('<ul>');
    expect(index).toContain('once a calculation has been run');
  });

  it('escapes a heading rather than letting it write markup into the index', () => {
    const index = html(
      resolveExhibitReferences(content([{ key: 'exhibit_index', html: '{{exhibit_index}}' }]), [
        'Exhibit A — Cap Table for <script>alert(1)</script> & Co',
      ]),
      'exhibit_index',
    );
    expect(index).not.toContain('<script>');
    expect(index).toContain('&lt;script&gt;');
    expect(index).toContain('&amp; Co');
  });

  it('builds the index only in the index chapter', () => {
    const body = resolveExhibitReferences(
      content([
        { key: 'conclusion', html: '<p>Value.</p>' },
        { key: 'exhibit_index', html: '{{exhibit_index}}' },
      ]),
      TYPICAL,
    );
    expect(html(body, 'conclusion')).toBe('<p>Value.</p>');
    expect(html(body, 'exhibit_index')).toContain('<li>');
  });
});

describe('the 409A skeleton, resolved', () => {
  const vars = {
    company_name: 'Northwind Robotics, Inc.',
    kind: '409a' as const,
    valuation_ref: '01J000000000000000000001',
    date: '2026-06-30',
    currency: 'USD',
  };
  const drafted = () => instantiateTemplate(templateForKind('409a'), vars);

  it('names no schedule the calculation did not produce', () => {
    // The check the seeded sample engagements failed: six dangling references
    // on a report whose every figure was right.
    expect(danglingReferences(resolveExhibitReferences(drafted(), TYPICAL), TYPICAL)).toEqual([]);
  });

  it('still names them all when the calculation produced them all', () => {
    const body = resolveExhibitReferences(drafted(), ALL_EXHIBITS);
    expect(danglingReferences(body, ALL_EXHIBITS)).toEqual([]);
    expect(html(body, 'asset_approach')).toContain('Exhibit E');
    expect(html(body, 'selected_volatility')).toContain('Exhibit F-1');
  });

  it('reports the reference an unresolved body would have dangled', () => {
    // Guards the guard: with no resolution step, the asset chapter does dangle,
    // so an empty result above means the pointers were dropped and not that
    // `danglingReferences` cannot see them.
    const found = danglingReferences(drafted(), TYPICAL);
    expect(found.map((f) => f.id)).toContain('E');
  });

  it('leaves the index chapter free of the marker it was resolved from', () => {
    expect(html(resolveExhibitReferences(drafted(), TYPICAL), 'exhibit_index')).not.toContain('{{');
  });
});
