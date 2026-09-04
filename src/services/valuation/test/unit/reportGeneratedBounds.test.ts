import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  contentFromManagedTemplate,
  instantiateTemplate,
  REPORT_TITLE_MAX,
  templateForKind,
} from '../../src/domain/report.js';
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
