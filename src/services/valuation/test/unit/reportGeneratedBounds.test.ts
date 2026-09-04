import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  contentFromManagedTemplate,
  instantiateTemplate,
  managedTemplateOverruns,
  REPORT_HEADING_MAX,
  REPORT_MAX_SECTIONS,
  REPORT_SECTION_HTML_MAX,
  REPORT_TITLE_MAX,
  templateForKind,
} from '../../src/domain/report.js';
import { applyNarrative, draftedSectionsFrom } from '../../src/domain/narrativeApply.js';
import { VALUATION_KINDS } from '../../src/domain/valuation.js';

/**
 * Round 421, methodology M6: the report body has two doors, and only one of
 * them is a schema.
 *
 * `PUT /api/v1/valuations/:id/report` validates a body the editor sends. But
 * nobody types a report's first draft — a generator composes it, from a
 * built-in skeleton or from an ops-authored managed template — and that
 * generator answers to no schema at all. The editor then round-trips
 * `content` verbatim, title included, so anything a generator produces that
 * `PutBody` will not accept is a 400 on the analyst's first save of a report
 * they have not touched yet.
 *
 * The title is the one that bites: it is `${template.name} — ${company_name}`,
 * a sum of two other fields' ceilings (300 and 100), and the door bounded it
 * at 300 flat.
 */

/** The longest name `POST /api/v1/valuations` accepts (`.max(300)`). */
const LONGEST_COMPANY_NAME = 'Ω'.repeat(300);

const varsFor = (kind: string) =>
  ({
    company_name: LONGEST_COMPANY_NAME,
    kind,
    valuation_ref: '01JQ0000000000000000000000',
    date: '2026-01-01',
    currency: 'USD',
  }) as never;

describe('what a report generator produces fits the door that saves it', () => {
  /**
   * The finding. Every kind's built-in skeleton overran the old 300, so this
   * was not one exotic template — it was the default report for a company with
   * a long legal name.
   */
  it.each([...VALUATION_KINDS])('the built-in %s skeleton titles within the editor bound', (kind) => {
    const content = instantiateTemplate(templateForKind(kind), varsFor(kind));
    expect(content.title.length).toBeGreaterThan(300); // the bound it used to be held to
    expect(content.title.length).toBeLessThanOrEqual(REPORT_TITLE_MAX);
  });

  /** The managed-template composer spells the title the same way, from a name of up to 100. */
  it('a managed template at both ceilings titles within the editor bound', () => {
    const content = contentFromManagedTemplate(
      { name: 'x'.repeat(100), body: '<h1>Opinion</h1><p>Body.</p>' },
      varsFor('409a'),
    );
    expect(content.title.length).toBeLessThanOrEqual(REPORT_TITLE_MAX);
  });

  /**
   * And the door keeps deriving its bound from the constant rather than
   * restating it, so raising one without the other cannot happen quietly.
   */
  it('the save door bounds the title by the shared constant', () => {
    const source = readFileSync(new URL('../../src/routes/reports.ts', import.meta.url), 'utf8');
    expect(source).toContain('title: nonBlankText(1, REPORT_TITLE_MAX)');
  });
});

/**
 * The other half of the same gap: the section count, the heading and the
 * section HTML. A managed template body is an ops-authored megabyte with no
 * schema between it and the stored report, and `contentFromManagedTemplate`
 * splits it on every top-level `<h1>` it finds.
 */
describe('a managed template that composes an unsavable body is refused', () => {
  const chapters = (n: number) =>
    Array.from({ length: n }, (_, i) => `<h1>Chapter ${i + 1}</h1><p>Text.</p>`).join('');

  it('accepts a body that composes within every editor bound', () => {
    expect(managedTemplateOverruns({ name: 'ok', body: chapters(REPORT_MAX_SECTIONS) })).toEqual([]);
  });

  /** The finding: 80 headings in a body the create door accepts is 80 sections. */
  it('names the section count when the split runs past the report ceiling', () => {
    const [first, ...rest] = managedTemplateOverruns({ name: 'long', body: chapters(80) });
    expect(rest).toEqual([]);
    expect(first).toContain('80 sections');
    expect(first).toContain(String(REPORT_MAX_SECTIONS));
  });

  it('names an over-long heading', () => {
    const overruns = managedTemplateOverruns({
      name: 'wide',
      body: `<h1>${'H'.repeat(REPORT_HEADING_MAX + 1)}</h1><p>Text.</p>`,
    });
    expect(overruns).toHaveLength(1);
    expect(overruns[0]).toContain('heading 1');
    expect(overruns[0]).toContain(String(REPORT_HEADING_MAX));
  });

  it('names an over-long section body', () => {
    const overruns = managedTemplateOverruns({
      name: 'deep',
      body: `<h1>One</h1><p>${'B'.repeat(REPORT_SECTION_HTML_MAX)}</p>`,
    });
    expect(overruns).toHaveLength(1);
    expect(overruns[0]).toContain('section 1');
    expect(overruns[0]).toContain(String(REPORT_SECTION_HTML_MAX));
  });

  /**
   * Measured for the *widest* engagement, not the one in front of the author.
   * A heading whose `{{company_name}}` fits today would overrun months later,
   * on a valuation whose analyst has no idea a template is why they are stuck.
   */
  it('accounts for what a variable fills to, not what the marker costs', () => {
    const body = `<h1>Valuation of {{company_name}}</h1><p>Text.</p>`;
    expect(body.length).toBeLessThan(REPORT_HEADING_MAX);
    const overruns = managedTemplateOverruns({ name: 'filled', body });
    expect(overruns).toHaveLength(1);
    expect(overruns[0]).toContain('heading 1');
  });

  /** Each door that can put a body in front of a report runs the check. */
  it('is called on create, on patch and on activate', () => {
    const source = readFileSync(new URL('../../src/routes/templates.ts', import.meta.url), 'utf8');
    expect(source.match(/refuseUnsavableBody\(/g) ?? []).toHaveLength(4); // 1 definition + 3 doors
  });
});

/**
 * The two doors read one set of numbers, so the ceiling the generator is
 * measured against cannot drift from the one the editor enforces.
 */
describe('the save door bounds a section by the shared constants', () => {
  const source = readFileSync(new URL('../../src/routes/reports.ts', import.meta.url), 'utf8');

  it.each([
    ['heading', 'heading: nonBlankText(1, REPORT_HEADING_MAX)'],
    ['section html', 'html: z.string().max(REPORT_SECTION_HTML_MAX)'],
    ['section count', '.max(REPORT_MAX_SECTIONS)'],
  ])('%s', (_field, spelling) => {
    expect(source).toContain(spelling);
  });
});

/**
 * The third generator: the narrative agent's apply.
 *
 * `draftedSectionsFrom` reads free text out of `ai_jobs.result` with no length
 * in its contract, and `applyNarrative` *appends* when two drafted sections map
 * to one chapter — so a run that returned the same key a hundred times composed
 * a chapter several times the editor's ceiling, stored it, and locked the
 * analyst out of the report they had asked it to draft.
 */
describe('an AI narrative cannot compose a chapter past the editor ceiling', () => {
  const draftsInto = (key: string, count: number, chars: number) =>
    draftedSectionsFrom({
      sections: Array.from({ length: count }, (_, i) => ({ key, body: `${'X'.repeat(chars)} ${i}` })),
    });

  const applyTo409a = (drafts: ReturnType<typeof draftsInto>) =>
    applyNarrative(instantiateTemplate(templateForKind('409a'), varsFor('409a')), drafts, {
      kind: '409a',
      overwrite: true,
    });

  /** The finding: 200 drafts of 2,000 characters used to concatenate to ~400,000. */
  it('stops appending before the chapter crosses it, and says so', () => {
    const out = applyTo409a(draftsInto('market_approach', 200, 2_000));
    for (const section of out.content.sections) {
      expect(section.html.length).toBeLessThanOrEqual(REPORT_SECTION_HTML_MAX);
    }
    expect(out.applied.some((a) => a.outcome === 'too_long')).toBe(true);
    // What did fit is kept: the refusal is per draft, not per run.
    expect(out.changed).toBe(true);
    expect(out.applied.some((a) => a.outcome === 'written')).toBe(true);
  });

  /** A single draft over the ceiling leaves the chapter exactly as it was. */
  it('leaves the chapter untouched rather than storing a truncation of it', () => {
    const before = instantiateTemplate(templateForKind('409a'), varsFor('409a'));
    const out = applyNarrative(before, draftsInto('market_approach', 1, REPORT_SECTION_HTML_MAX + 1), {
      kind: '409a',
      overwrite: true,
    });
    expect(out.changed).toBe(false);
    expect(out.applied.map((a) => a.outcome)).toEqual(['too_long']);
    expect(out.content.sections).toEqual(before.sections);
  });

  /** An ordinary draft is unaffected — the bound is not a new refusal path. */
  it('writes a draft that fits', () => {
    const out = applyTo409a(draftsInto('market_approach', 1, 500));
    expect(out.applied.map((a) => a.outcome)).toEqual(['written']);
    expect(out.changed).toBe(true);
  });
});
