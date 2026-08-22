import { describe, expect, it } from 'vitest';
import { renderReportPdf } from '@n409/report/pdf';
import {
  instantiateTemplate,
  templateForKind,
  visibleSections,
  RENDER_RESOLVED_MARKERS,
  type ReportContent,
} from '../../src/domain/report.js';
import { resolveExhibitReferences } from '../../src/domain/reportExhibitIndex.js';
import { resolveSignatures } from '../../src/domain/reportSignatures.js';
import { fillFigures, reportFigures } from '../../src/domain/reportFigures.js';
import { VALUATION_KINDS, type ValuationKind } from '../../src/domain/valuation.js';
import type { CalculationRow } from '../../src/repos/calculations.js';
import { extractText as pdfText, pageCount } from '../../../report/test/support/pdfText.js';

/**
 * Every report type, through the real PDF pipeline.
 *
 * The platform renders fifteen kinds of deliverable — 409A, ASC 718, ASC 820,
 * gift and estate, QSBS, CSOP, EMI, IFRS 2, PPA, goodwill impairment, ESOP, IP,
 * fund, debt and a generic FMV — and until now exactly one of them had ever
 * been rendered to a PDF by a test. `sampleReportPdf.test.ts` renders the 409A,
 * because the 409A is the only kind with a *published* sample; the report
 * service's own suite renders synthetic inputs that exercise the layout engine.
 * Neither drives the other fourteen skeletons through `renderReportPdf`.
 *
 * That is a real hole rather than a tidiness one. These skeletons are authored
 * HTML: a chapter carrying a tag outside the renderer's whitelist, a heading
 * long enough to break the running head, an entity the font subset cannot
 * encode, or a placeholder nobody wired up produces a document that is wrong
 * for one report type and perfect for the other fourteen — and the failure
 * surfaces at a client, on the one kind nobody rendered.
 *
 * So: instantiate each skeleton the way `routes/reports.ts` does, render it,
 * and read the text back out of the PDF. No exhibits — those come from an
 * engine run, and `reportExhibits.test.ts` covers them for the 409A while
 * `specialtyExhibits.test.ts` covers the specialty schedules. What is under
 * test here is the body of every kind surviving the renderer intact.
 */

const VARS = {
  company_name: 'Northwind Robotics, Inc.',
  valuation_ref: 'ENG-2026-0042',
  date: '2026-06-30',
  currency: 'USD',
};

/** A succeeded calculation carrying every figure `reportFigures` reads. */
const FULLY_POPULATED = {
  status: 'succeeded',
  results: {
    fmv_per_share: 1.2345,
    equity_value: 42_000_000,
    common_equity_value: 19_500_000,
    fully_diluted_common: 8_000_000,
    marketable_value_per_share: 2.4375,
    discounts: { dloc: 0.1, dlom: 0.25 },
    assumptions: { volatility: 0.65, risk_free_rate: 0.042, time_to_exit_years: 3.5 },
    market_movement: { factor: 1.0412, index_return: 0.0824, index_name: 'S&P 500' },
  },
} as unknown as CalculationRow;

/** The body as the route assembles it, minus the schedules an engine produces. */
function body(kind: ValuationKind): ReportContent {
  // No exhibits, so `resolveExhibitReferences` drops every `{{#exhibit:X}}`
  // pointer and prints the "none produced yet" index — which is exactly the
  // state a report drafted before the first calculation is in, and therefore a
  // state that must render rather than throw.
  //
  // Unsigned for the same reason: a body drafted before anyone has signed is
  // the state every report passes through, and `resolveSignatures` has to print
  // the empty signature lines rather than leave `{{signatures}}` on the page.
  // Running it here is what puts the block through the renderer for all fifteen
  // kinds.
  return resolveSignatures(
    resolveExhibitReferences(instantiateTemplate(templateForKind(kind), { ...VARS, kind }), []),
    [],
  );
}

function input(kind: ValuationKind) {
  const content = body(kind);
  return {
    title: content.title,
    company_name: VARS.company_name,
    meta: [
      { label: 'Engagement', value: VARS.valuation_ref },
      { label: 'Kind', value: kind },
      { label: 'Valuation date', value: VARS.date },
      { label: 'Template', value: templateForKind(kind).version },
      { label: 'Currency', value: VARS.currency },
    ],
    sections: visibleSections(content).map((s) => ({ heading: s.heading, html: s.html })),
    generated_at: new Date('2026-07-01T00:00:00.000Z'),
    keywords: [VARS.company_name, kind, 'valuation'],
  };
}

describe('every report type renders', () => {
  // Rendering fifteen documents is slow enough to matter, so each kind is one
  // case that asserts everything about its document rather than fifteen cases
  // rendering it fifteen times.
  for (const kind of VALUATION_KINDS) {
    it(`${kind} — renders, and the text comes back out`, async () => {
      const pdf = await renderReportPdf(input(kind), { compress: false });

      // A PDF at all: the header, and a trailer the reader can find.
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pageCount(pdf)).toBeGreaterThan(0);

      const text = pdfText(pdf);
      expect(text).toContain(VARS.company_name);
      expect(text).toContain(templateForKind(kind).version);

      // Every chapter of the skeleton reached the document. A section the
      // renderer silently dropped — an empty body, an unsupported tag — is
      // invisible in a "did it render" check and is the failure this exists
      // to catch.
      for (const s of visibleSections(body(kind))) {
        expect(text, `${kind}: chapter "${s.heading}" is not in the PDF`).toContain(s.heading);
      }
    }, 120_000);
  }

  it('resolves every exhibit pointer, on every kind', () => {
    // `{{#exhibit:C}}` blocks are dropped whole when the schedule is absent, so
    // after resolution against an empty exhibit list none may survive. One that
    // does prints its markers literally in a delivered PDF.
    for (const kind of VALUATION_KINDS) {
      for (const s of visibleSections(body(kind))) {
        expect(s.html, `${kind}/${s.heading}`).not.toMatch(/\{\{[#/]exhibit:/);
      }
    }
  });

  /*
   * A figure placeholder nobody can fill.
   *
   * An unresolved `{{fmv_per_share}}` on a *draft* is deliberate: it reads as a
   * blank waiting on the engine, and `reportFigures` returns nothing at all
   * until a calculation has succeeded, so the whole set stays visible. That is
   * the design.
   *
   * What the design assumes is that each of those placeholders has a producer.
   * A skeleton author who writes `{{cost_of_equity}}` — plausible, adjacent to
   * a dozen keys that do exist — creates one that no calculation can ever
   * resolve, on any engagement: permanently literal, in a signed PDF, and
   * invisible to every test that renders a draft. `domain/templateVariables.ts`
   * closes exactly this hole for email templates, by declaring the variable set
   * and checking it at save time. Report bodies had no equivalent.
   *
   * The producible set is taken from `reportFigures` itself, run over a result
   * carrying every figure it reads, rather than from a second list that could
   * fall behind it the way the schedule lists did.
   */
  it('uses no figure placeholder the engine cannot produce', () => {
    const producible = new Set(Object.keys(reportFigures(FULLY_POPULATED, 'USD')));
    // Sanity: the probe result is the producer set, not an empty object from a
    // guard clause misfiring — which would make this test vacuous.
    expect(producible.size).toBeGreaterThan(10);

    for (const kind of VALUATION_KINDS) {
      for (const s of visibleSections(body(kind))) {
        for (const m of s.html.matchAll(/\{\{([a-z0-9_]+)\}\}/g)) {
          const name = m[1]!;
          // Resolved elsewhere than the figures layer — by `reportExhibitIndex`
          // and `reportSignatures`. Read from the shared set rather than named
          // here, so a marker added to one and not the other fails loudly
          // instead of being excused by a literal this file forgot to update.
          if (RENDER_RESOLVED_MARKERS.has(name)) continue;
          expect(
            producible.has(name),
            `${kind}/${s.heading}: {{${name}}} has no producer in reportFigures`,
          ).toBe(true);
        }
      }
    }
  });

  it('fills those placeholders once a calculation has succeeded', () => {
    // The other half: the keys exist *and* they land. A producer whose key is
    // spelled differently from the skeleton's passes the check above and still
    // leaves the placeholder on the page.
    const figures = reportFigures(FULLY_POPULATED, 'USD');
    for (const kind of VALUATION_KINDS) {
      const filled = fillFigures(body(kind), figures);
      for (const s of visibleSections(filled)) {
        const left = [...s.html.matchAll(/\{\{([a-z0-9_]+)\}\}/g)].map((m) => m[1]);
        expect(left, `${kind}/${s.heading}`).toEqual([]);
      }
    }
  });

  it('gives every kind a distinct template version', () => {
    // Two kinds sharing a version string makes the `Template` line on the cover
    // useless for saying which skeleton produced the document, and the four
    // tests that pin a version literal would pin the wrong one.
    const versions = VALUATION_KINDS.map((k) => templateForKind(k).version);
    const seen = new Map<string, ValuationKind[]>();
    for (const [i, v] of versions.entries()) {
      seen.set(v, [...(seen.get(v) ?? []), VALUATION_KINDS[i]!]);
    }
    const shared = [...seen.entries()].filter(([, ks]) => ks.length > 1);
    // `fmv` is the generic skeleton; anything else sharing a version is a bug.
    expect(shared.map(([v, ks]) => `${v}: ${ks.join(', ')}`)).toEqual([]);
  });

  it('titles every kind, and names the subject in the title', () => {
    for (const kind of VALUATION_KINDS) {
      const content = body(kind);
      expect(content.title.length, kind).toBeGreaterThan(10);
      expect(content.title, kind).toContain(VARS.company_name);
      expect(visibleSections(content).length, `${kind} has no chapters`).toBeGreaterThan(3);
    }
  });
});
