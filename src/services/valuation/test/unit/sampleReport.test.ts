import { describe, expect, it } from 'vitest';
import { sampleReportOutline, SAMPLE_EXHIBITS } from '../../src/domain/sampleReport.js';
import { templateForKind } from '../../src/domain/report.js';
import { VALUATION_KINDS } from '../../src/domain/valuation.js';

describe('sampleReportOutline', () => {
  it('is derived from the real template, not a second copy of it', () => {
    const template = templateForKind('409a');
    const outline = sampleReportOutline('409a');

    expect(outline.version).toBe(template.version);
    expect(outline.name).toBe(template.name);
    // Headings and their order come from the skeleton the renderer uses, so a
    // chapter added, renamed or moved cannot leave the public page behind.
    expect(outline.sections.map((s) => s.key)).toEqual(template.sections.map((s) => s.key));
    expect(outline.sections.map((s) => s.heading)).toEqual(template.sections.map((s) => s.heading));
  });

  it('explains every chapter of the 409A — the copy is complete and stays closed', () => {
    const outline = sampleReportOutline('409a');
    // This is the assertion that fails when a chapter is added to the template
    // without a word of explanation for the prospect reading the page.
    expect(outline.missingBlurbs).toEqual([]);
    for (const s of outline.sections) {
      expect(s.blurb, `${s.key} has no blurb`).toBeTruthy();
      expect(s.blurb!.length).toBeGreaterThan(30);
    }
  });

  it('covers the chapters a 409A is judged on', () => {
    const keys = sampleReportOutline('409a').sections.map((s) => s.key);
    for (const required of [
      'capital_structure',
      'allocation',
      'dlom',
      'conclusion',
      'safe_harbor',
      'certification',
      'limiting_conditions',
    ]) {
      expect(keys).toContain(required);
    }
  });

  it('defaults to the 409A', () => {
    expect(sampleReportOutline().kind).toBe('409a');
    expect(sampleReportOutline().version).toBe(templateForKind('409a').version);
  });

  it('serves an outline for every valuation kind the platform renders', () => {
    for (const kind of VALUATION_KINDS) {
      const outline = sampleReportOutline(kind);
      expect(outline.sections.length, `${kind} has no sections`).toBeGreaterThan(0);
      expect(outline.version).toBe(templateForKind(kind).version);
    }
  });

  it('lists exhibits for the 409A only — the specialty kinds render their own', () => {
    expect(sampleReportOutline('409a').exhibits.length).toBeGreaterThan(0);
    for (const kind of VALUATION_KINDS.filter((k) => k !== '409a')) {
      expect(sampleReportOutline(kind).exhibits, `${kind} claims 409A exhibits`).toEqual([]);
    }
  });

  it('marks the exhibits that only appear when the engagement needs them', () => {
    const ids = SAMPLE_EXHIBITS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids

    const always = SAMPLE_EXHIBITS.filter((e) => e.always).map((e) => e.id);
    // Every 409A has a cap table, a reconciliation, an allocation and a
    // conclusion. Nothing else is guaranteed.
    expect(always).toEqual(['A', 'B', 'F', 'H']);

    // A company with no DCF receives no Exhibit C, so the page must not promise one.
    const conditional = SAMPLE_EXHIBITS.filter((e) => !e.always).map((e) => e.id);
    expect(conditional).toContain('C');
    expect(conditional).toContain('D-1');
    expect(conditional).toContain('G');
  });

  it('describes every exhibit it lists', () => {
    for (const e of SAMPLE_EXHIBITS) {
      expect(e.title.length).toBeGreaterThan(3);
      expect(e.description.length).toBeGreaterThan(20);
    }
  });
});
