import { describe, expect, it } from 'vitest';
import {
  REQUIRED_RETURN_BANDS,
  requiredReturnBands,
  requiredReturnRows,
} from '../../src/domain/requiredReturns.js';
import { requiredReturnExhibit } from '../../src/domain/reportExhibits.js';
import { sanitizeHtml } from '../../src/domain/report.js';
import { ParamsPatchBody } from '../../src/routes/params.js';

const CTX = { currency: 'USD', companyName: 'Northwind Robotics, Inc.' };

describe('the required-return ladder', () => {
  it('covers all six AICPA stages exactly once', () => {
    expect(REQUIRED_RETURN_BANDS.map((b) => b.stage)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('falls monotonically with stage — risk retired is return no longer required', () => {
    for (let i = 1; i < REQUIRED_RETURN_BANDS.length; i += 1) {
      const prev = REQUIRED_RETURN_BANDS[i - 1]!;
      const cur = REQUIRED_RETURN_BANDS[i]!;
      expect(cur.low).toBeLessThanOrEqual(prev.low);
      expect(cur.high).toBeLessThanOrEqual(prev.high);
    }
  });

  it('states every band low-end first', () => {
    for (const b of REQUIRED_RETURN_BANDS) expect(b.low).toBeLessThanOrEqual(b.high);
  });

  it('marks the concluded stage and only that stage', () => {
    const rows = requiredReturnRows(3);
    expect(rows.filter((r) => r.matched).map((r) => r.stage)).toEqual([3]);
    expect(rows.find((r) => r.matched)!.label).toContain('Stage 3');
  });

  it('marks nothing when no stage has been concluded', () => {
    expect(requiredReturnRows(null).some((r) => r.matched)).toBe(false);
    expect(requiredReturnRows(undefined).some((r) => r.matched)).toBe(false);
  });
});

describe('a firm’s own ladder', () => {
  const OWN = [
    { stage: 2, category: 'Our early band', low: 0.45, high: 0.55 },
    { stage: 1, category: 'Our seed band', low: 0.6, high: 0.8 },
  ];

  it('replaces the built-ins entirely, in stage order', () => {
    const rows = requiredReturnRows(1, OWN);
    expect(rows.map((r) => r.stage)).toEqual([1, 2]);
    expect(rows[0]!.category).toBe('Our seed band');
    expect(rows[0]!.matched).toBe(true);
  });

  it('falls back to the built-ins for null and undefined', () => {
    expect(requiredReturnBands(null)).toEqual(REQUIRED_RETURN_BANDS);
    expect(requiredReturnBands(undefined)).toEqual(REQUIRED_RETURN_BANDS);
  });

  it('refuses a malformed override rather than silently printing the built-ins', () => {
    // The failure mode this guards: a firm meant to supply its own figures,
    // mistyped them, and got a report that looked right and cited a table it
    // had not chosen.
    expect(() => requiredReturnBands([])).toThrow(/non-empty/);
    expect(() => requiredReturnBands([{ stage: 9, category: 'x', low: 0.1, high: 0.2 }])).toThrow(/stage/);
    expect(() => requiredReturnBands([{ stage: 1, category: '', low: 0.1, high: 0.2 }])).toThrow(/category/);
    expect(() => requiredReturnBands([{ stage: 1, category: 'x', low: 0.3, high: 0.2 }])).toThrow(/exceed/);
    expect(() => requiredReturnBands([{ stage: 1, category: 'x', low: 0, high: 0.2 }])).toThrow(/low/);
  });
});

describe('Appendix III', () => {
  it('renders against the concluded stage, with that row in bold', () => {
    const out = requiredReturnExhibit({ ...CTX, developmentStage: 4 })!;
    expect(out.heading).toBe('Appendix III — Required Rates of Return by Stage of Development');
    expect(out.html).toContain('<strong>Stage 4 — Product revenue, operating at a loss</strong>');
    expect(out.html).toContain('30% – 40%');
  });

  it('is absent until somebody has concluded a stage', () => {
    expect(requiredReturnExhibit({ ...CTX, developmentStage: null })).toBeNull();
    expect(requiredReturnExhibit(CTX)).toBeNull();
  });

  it('is absent when the concluded stage has no band in the firm’s own ladder', () => {
    // The ladder is the firm's; a stage it does not band is one this appendix
    // has nothing to say about, and an unmarked table is general reference in a
    // company-specific document.
    const out = requiredReturnExhibit({
      ...CTX,
      developmentStage: 6,
      requiredReturnTable: [{ stage: 1, category: 'Seed', low: 0.5, high: 0.7 }],
    });
    expect(out).toBeNull();
  });

  it('drops rather than throwing on an unreadable stored ladder', () => {
    const out = requiredReturnExhibit({
      ...CTX,
      developmentStage: 1,
      requiredReturnTable: [{ nonsense: true }],
    });
    expect(out).toBeNull();
  });

  it('says so when it drops for a failure rather than for a fact (R344)', () => {
    /*
     * The two absences above and this one were the same `return null` into a
     * list that keeps no record of what it did not build. "No stage concluded"
     * and "the stored ladder will not read" are a fact and a failure, and a
     * deliverable that ships an appendix short for the second reason had
     * nothing anywhere saying so — not the renderer, not the QA route, not the
     * exhibit index, all of which read the sections that *were* built.
     */
    const issues: { schedule: string; reason: string }[] = [];
    const out = requiredReturnExhibit({
      ...CTX,
      developmentStage: 1,
      requiredReturnTable: [{ stage: 1, category: 'Seed', low: 0.9, high: 0.5 }],
      onIssue: (i) => issues.push(i),
    });
    expect(out).toBeNull();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.schedule).toBe('III');
    // The stored row's own complaint, so the operator reading the line knows
    // which band to fix rather than only that one is wrong.
    expect(issues[0]!.reason).toContain('required_return_table[0].low');
  });

  it('says a category rather than quoting a message nobody vouched for (R345)', () => {
    /*
     * The reason is published now, not merely logged: it reaches the QA review
     * a reviewer reads. `errorBodyDisclosure`'s rule is that an error's own
     * wording is publishable only when something vouched for it, and
     * `RequiredReturnTableError` is that vouching — every sentence it carries
     * is written in `requiredReturns.ts` and names a field and a rule.
     *
     * A throw of any other shape is one nobody wrote a sentence for, so its
     * words do not go on the review. Provoked with a row that throws on being
     * read, which is the honest way to reach the branch.
     */
    const hostile = [
      {
        get stage(): number {
          throw new TypeError('a message from somewhere nobody vouched for');
        },
      },
    ];
    const issues: { schedule: string; reason: string }[] = [];
    const out = requiredReturnExhibit({
      ...CTX,
      developmentStage: 1,
      requiredReturnTable: hostile,
      onIssue: (i) => issues.push(i),
    });
    expect(out).toBeNull();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.reason).toBe('the stored required-return table could not be read');
    expect(issues[0]!.reason).not.toContain('nobody vouched for');
  });

  it('stays quiet when the appendix is merely not applicable', () => {
    // The discriminator: without it the assertion above passes for a reporter
    // that fires on every absence, which would make the line noise.
    const issues: unknown[] = [];
    expect(
      requiredReturnExhibit({ ...CTX, developmentStage: null, onIssue: () => issues.push(1) }),
    ).toBeNull();
    expect(
      requiredReturnExhibit({
        ...CTX,
        developmentStage: 6,
        requiredReturnTable: [{ stage: 1, category: 'Seed', low: 0.5, high: 0.7 }],
        onIssue: () => issues.push(1),
      }),
    ).toBeNull();
    expect(issues).toEqual([]);
  });

  it('says it corroborates rather than derives', () => {
    const out = requiredReturnExhibit({ ...CTX, developmentStage: 2 })!;
    expect(out.html).toContain('not the source of the concluded rate');
  });

  it('renders only tags the report whitelist allows', () => {
    const out = requiredReturnExhibit({ ...CTX, developmentStage: 2 })!;
    expect(sanitizeHtml(out.html)).toBe(out.html);
  });

  it('escapes a firm’s own category text', () => {
    const out = requiredReturnExhibit({
      ...CTX,
      developmentStage: 1,
      requiredReturnTable: [{ stage: 1, category: 'Seed <b>& angel</b>', low: 0.5, high: 0.7 }],
    })!;
    expect(out.html).toContain('Seed &lt;b&gt;&amp; angel&lt;/b&gt;');
  });
});

/**
 * The schema on PATCH /params, which is where a firm's own ladder is refused
 * while somebody is still looking at the form. `requiredReturnBands` validates
 * again at render time because a stored row can be older than this schema, but
 * a save is the only point at which the analyst can be told what was wrong.
 */
describe('required_return_table on PATCH /params', () => {
  const ok = (patch: Record<string, unknown>) => ParamsPatchBody.safeParse(patch);
  const row = { stage: 1, category: 'Seed / start-up', low: 0.5, high: 0.7 };

  it('accepts a well-formed ladder', () => {
    expect(ok({ required_return_table: [row] }).success).toBe(true);
  });

  it('accepts null — the firm is back on the built-in ranges', () => {
    expect(ok({ required_return_table: null }).success).toBe(true);
  });

  it('accepts a band whose ends are equal — a point estimate is a range', () => {
    expect(ok({ required_return_table: [{ ...row, low: 0.5, high: 0.5 }] }).success).toBe(true);
  });

  it('rejects a band stated high-end first', () => {
    // Otherwise Appendix III prints "70% – 50%", a range nobody can satisfy.
    expect(ok({ required_return_table: [{ ...row, low: 0.7, high: 0.5 }] }).success).toBe(false);
  });

  it('rejects a stage off the AICPA 1–6 scale', () => {
    expect(ok({ required_return_table: [{ ...row, stage: 0 }] }).success).toBe(false);
    expect(ok({ required_return_table: [{ ...row, stage: 7 }] }).success).toBe(false);
    expect(ok({ required_return_table: [{ ...row, stage: 1.5 }] }).success).toBe(false);
  });

  it('rejects a non-positive or implausibly large return', () => {
    expect(ok({ required_return_table: [{ ...row, low: 0 }] }).success).toBe(false);
    expect(ok({ required_return_table: [{ ...row, high: 5 }] }).success).toBe(false);
  });

  it('rejects an empty category', () => {
    expect(ok({ required_return_table: [{ ...row, category: '' }] }).success).toBe(false);
  });

  it('rejects an unrecognised field rather than dropping it', () => {
    // .strict(), for the same reason dlom_study_table is: a typo'd key is a
    // silently ignored input otherwise.
    expect(ok({ required_return_table: [{ ...row, hihg: 0.9 }] }).success).toBe(false);
  });

  it('rejects an empty table — that is what null is for', () => {
    expect(ok({ required_return_table: [] }).success).toBe(false);
  });

  it('accepts anything the render path will then accept', () => {
    // The two validators must not disagree: a ladder that saves and then fails
    // to render is an appendix that vanishes with nothing said about why.
    const ladder = [
      { stage: 1, category: 'Angel', low: 0.55, high: 0.85 },
      { stage: 4, category: 'Growth', low: 0.25, high: 0.4 },
    ];
    expect(ok({ required_return_table: ladder }).success).toBe(true);
    expect(() => requiredReturnBands(ladder)).not.toThrow();
  });
});
