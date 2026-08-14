import { sanitizeHtml, type ReportContent } from './report.js';
import { findReportPlaceholders, type ResolvableFigures } from './reportReadiness.js';
import type { ValuationKind } from './valuation.js';

/**
 * Putting the AI-drafted narrative into the report.
 *
 * Everything needed to write a 409A's prose already existed and none of it
 * reached the deliverable. `report_narrative` drafts the sections from the
 * finished calculation; `company_overview`, `industry_overview`,
 * `industry_outlook`, `competitor_analysis` and the regional `market_research`
 * topics retrieve and synthesise the public record, and the narrative agent is
 * handed the grounded ones to write from. All of it landed in `ai_jobs.result`,
 * and the only writes to `report_versions.content` were the editor's PUT and a
 * revert. So an analyst read the draft in one tab and retyped it into another —
 * and when nobody did, the report shipped with the skeleton's instructional
 * placeholder text where its Company Overview should have been.
 *
 * Two things make this safe enough to be automatic.
 *
 * **It never overwrites written prose.** A chapter is replaced only where
 * nobody has written it — decided against the report's own version 1, which is
 * the pristine skeleton (see `unwrittenSections`). `overwrite` exists for the
 * analyst who wants the draft regenerated over their own text, and it is a
 * deliberate act rather than the default. Anything else would mean a re-run
 * silently discarding an afternoon's editing, in a document whose whole value
 * is that a named appraiser stands behind it.
 *
 * **What it writes is sanitized.** The bodies come from a language model, land
 * in stored report HTML, and are rendered directly by the auditor portal — the
 * same path that made a company named `<img onerror=…>` script execution in an
 * external reviewer's browser. `sanitizeHtml` is the platform's existing answer
 * and it is applied here rather than trusted upstream.
 */

/**
 * Agent section key → template section key, for a 409A.
 *
 * The two vocabularies were designed independently and mostly agree. Where they
 * do not, the mapping is a judgement about which chapter the drafted prose
 * belongs in, and it is written out rather than inferred from string similarity
 * so that a wrong pairing is a visible line someone can argue with.
 *
 * `null` means the deliverable has no chapter for that section *by design*, as
 * against having one this map failed to name. The difference is the whole point
 * of the distinction: `unmatched` is a bug report and `suppressed` is a
 * decision, and while they were the same value nobody could see which was
 * which.
 *
 * `executive_summary` is the first of them. The PDF builds its own summary page
 * from the calculation — headline FMV, the figures grid, the approach chart,
 * the value bridge — and a drafted prose summary would sit beside it saying the
 * same things in a voice nothing verified. The narrative agent still drafts it;
 * it simply is not what the deliverable's summary page is made of.
 */
export const NARRATIVE_SECTION_MAP: Readonly<Record<string, string | null>> = {
  executive_summary: null,
  company_overview: 'company_overview',
  valuation_methodology: 'methodology',
  market_approach: 'market_approach',
  income_approach: 'income_approach',
  asset_approach: 'asset_approach',
  allocation_methodology: 'allocation',
  dlom_analysis: 'dlom',
  dloc_analysis: 'dloc',
  dloc: 'dloc',
  industry_analysis: 'industry_market',
  industry_overview: 'industry_market',
  industry_outlook: 'economic_outlook',
  economic_outlook: 'economic_outlook',
  financial_analysis: 'financial_analysis',
  capital_structure: 'capital_structure',
  reconciliation: 'reconciliation',
  conclusion: 'conclusion',
};

/**
 * The same, per report kind, where that kind's skeleton disagrees.
 *
 * The map above is the 409A's vocabulary, and until now it was the only one.
 * The prompt library (migration 0114) has drafted per-kind sections since it
 * was seeded — a §1202 entity test, an ASC 820 hierarchy, an IFRS 2 measurement
 * basis — and the skeletons in `domain/report.ts` have carried per-kind
 * chapters for just as long. Nothing connected the two. The agent drafted
 * `fair_value_hierarchy`, the 820 skeleton calls that chapter `hierarchy`,
 * `applyNarrative` found no section of either name, recorded `unmatched`, and
 * threw the prose away. The route reported success; the analyst opened a report
 * with the skeleton's instructions still in it and no reason to think anything
 * had failed. Fourteen of the fifteen deliverables lost narrative this way, and
 * only the 409A — whose keys this map was written from — did not.
 *
 * Two kinds of entry, and both are judgements about the deliverable rather than
 * about the strings:
 *
 *   * a rename — the chapter exists under another name. `measurement_basis` is
 *     the IFRS 2 skeleton's `measurement_principles`; a 409A's "Valuation
 *     Methodology" is an ESOP's "Valuation Approaches" and an SMB's "Valuation
 *     Methods".
 *   * a suppression — the chapter genuinely does not exist. A purchase price
 *     allocation has no marketability discount to discuss and a QSBS
 *     attestation weights no approaches, so drafted prose about either is not
 *     misrouted, it is inapplicable.
 *
 * Where two drafted sections belong in one chapter — a gift report argues both
 * discounts under "Interest-Level Discounts" — the second is appended rather
 * than dropped or written over the first. See `applyNarrative`.
 *
 * A kind absent from this table takes the base map unchanged, which is right
 * for the 409A and for nothing else; every other kind is listed.
 */
const NARRATIVE_SECTION_MAP_BY_KIND: Partial<
  Record<ValuationKind, Readonly<Record<string, string | null>>>
> = {
  // A §1202 memorandum attests to qualification. There is no equity value to
  // allocate, no approach to weight and no discount to take; the four statutory
  // tests it does have are keyed the same on both sides.
  qsbs: {
    company_overview: null,
    valuation_methodology: null,
    market_approach: null,
    income_approach: null,
    allocation_methodology: null,
    dlom_analysis: null,
  },
  // ASC 805 allocates a purchase price across identified assets. The transaction
  // overview stands where a company overview would, and each intangible's method
  // is argued in the intangibles chapter rather than in approach chapters.
  ppa: {
    company_overview: null,
    valuation_methodology: null,
    market_approach: null,
    income_approach: null,
    allocation_methodology: null,
    dlom_analysis: null,
  },
  // Goodwill impairment: the whole analysis is the quantitative test, and the
  // reporting units and qualitative screen have no counterpart in the library.
  goodwill: {
    company_overview: null,
    valuation_methodology: 'quantitative_tests',
    market_approach: null,
    income_approach: null,
    allocation_methodology: null,
    dlom_analysis: null,
  },
  // An ESOP report argues the approaches in one chapter and both discounts in
  // "Level of Value & Discounts", which is where the marketability discussion
  // belongs — the chain from the approaches to the per-share value runs through
  // it.
  esop: {
    valuation_methodology: 'valuation_approaches',
    market_approach: null,
    income_approach: null,
    allocation_methodology: null,
    dlom_analysis: 'level_of_value',
  },
  // An SMB fair-value opinion runs on normalized earnings and a small set of
  // methods; there is no allocation and no discount chapter.
  fmv: {
    valuation_methodology: 'valuation_methods',
    market_approach: null,
    income_approach: null,
    allocation_methodology: null,
    dlom_analysis: null,
  },
  // EMI: the restrictions that separate unrestricted from actual market value
  // are this deliverable's marketability discussion, and HMRC reads that
  // chapter for exactly that.
  emi: {
    valuation_methodology: 'valuation_analysis',
    market_approach: null,
    income_approach: null,
    allocation_methodology: null,
    dlom_analysis: 'umv_amv',
  },
  // CSOP is the EMI pack without the UMV/AMV split — the scheme values at
  // unrestricted market value, so there is no restriction chapter to write into.
  csop: {
    valuation_methodology: 'valuation_analysis',
    market_approach: null,
    income_approach: null,
    allocation_methodology: null,
    dlom_analysis: null,
  },
  // An IP valuation describes an asset, not a company, and concludes on the
  // asset; the subject-asset chapter is not a company overview and prose about
  // the business does not belong in it.
  ip: {
    company_overview: null,
    valuation_methodology: 'valuation_methods',
    market_approach: null,
    income_approach: null,
    allocation_methodology: null,
    dlom_analysis: null,
  },
  /*
   * ASC 718 measures an award. The concluded per-share value the library's
   * conclusion section is written about is precisely what "Fair Value of the
   * Underlying Share" states, so that is where it goes — the report has no
   * conclusion chapter of its own because the compensation-cost schedule is its
   * conclusion.
   */
  '718': {
    company_overview: null,
    valuation_methodology: 'model_and_assumptions',
    market_approach: null,
    income_approach: null,
    allocation_methodology: null,
    dlom_analysis: null,
    conclusion: 'underlying_value',
  },
  // ASC 820: the hierarchy classification is the point of the report and the
  // one the auditor tests first — and it was the section being discarded.
  '820': {
    company_overview: null,
    fair_value_hierarchy: 'hierarchy',
    market_approach: null,
    income_approach: null,
    allocation_methodology: null,
    dlom_analysis: null,
  },
  /*
   * Gift and estate. Two chapters take two drafted sections each: the Rev. Rul.
   * 59-60 factor walk sits with the valuation of the underlying entity, and
   * both discounts are argued together under "Interest-Level Discounts" —
   * which is how the deliverable is laid out and how it is examined.
   */
  gifts: {
    revenue_ruling_factors: 'valuation_analysis',
    valuation_methodology: 'valuation_analysis',
    market_approach: null,
    income_approach: null,
    allocation_methodology: null,
    dloc: 'discounts',
    dlom_analysis: 'discounts',
  },
  /*
   * IFRS 2. `measurement_basis` is the skeleton's `measurement_principles`, and
   * whether a vesting condition lands in the grant-date fair value or in the
   * attribution is the expense-recognition argument.
   *
   * `conclusion` is suppressed rather than routed: the library writes it about
   * a reconciliation across approaches and a fair market value per common
   * share, and an IFRS 2 report concludes on neither.
   */
  ifrs2: {
    company_overview: null,
    measurement_basis: 'measurement_principles',
    vesting_conditions: 'expense_recognition',
    valuation_methodology: 'model_and_assumptions',
    market_approach: null,
    income_approach: null,
    allocation_methodology: null,
    dlom_analysis: null,
    conclusion: null,
  },
  /*
   * Fund NAV. The techniques chapter is the methodology and the NAV chapter is
   * the conclusion. A marketability discount here is an input to one holding's
   * measurement, disclosed in the Level 3 table, not a chapter of the report.
   */
  fund: {
    company_overview: null,
    valuation_methodology: 'measurement_techniques',
    market_approach: null,
    income_approach: null,
    allocation_methodology: null,
    dlom_analysis: null,
    conclusion: 'nav_conclusion',
    // A fund report classifies and discloses the same two things an ASC 820
    // report does, so the library keys them the same way (0141) — but this
    // skeleton names the chapters `hierarchy` and `significant_inputs`. Keyed
    // to the 820 spelling rather than to this one so a firm editing "Fair
    // Value Hierarchy" for both is editing rows that look alike.
    fair_value_hierarchy: 'hierarchy',
    unobservable_inputs: 'significant_inputs',
  },
  /*
   * A debt instrument. The issuer discussion is a credit assessment, and the
   * library's income-approach guidance — projection assumptions and the
   * discount-rate build-up — is the discount-rate chapter almost word for word.
   */
  debt: {
    company_overview: 'credit_assessment',
    market_approach: null,
    income_approach: 'discount_rate',
    allocation_methodology: null,
    dlom_analysis: null,
  },
};

/**
 * The map one deliverable is applied through.
 *
 * No kind — a caller that does not know, which is only the tests and any older
 * call site — gets the 409A's, which is the behaviour that existed before the
 * table above and is right for the kind most reports are.
 */
export function narrativeSectionMap(
  kind?: ValuationKind | null,
): Readonly<Record<string, string | null>> {
  const overrides = kind ? NARRATIVE_SECTION_MAP_BY_KIND[kind] : undefined;
  return overrides ? { ...NARRATIVE_SECTION_MAP, ...overrides } : NARRATIVE_SECTION_MAP;
}

/** One section the agent drafted. */
export interface DraftedSection {
  key: string;
  title?: string;
  body: string;
}

export type ApplyOutcome =
  | 'written'
  /**
   * Written into a chapter an earlier drafted section had already filled, after
   * what was there rather than over it. Two sections legitimately share one
   * chapter on some deliverables (see `NARRATIVE_SECTION_MAP_BY_KIND`).
   */
  | 'appended'
  /** The section already holds prose somebody wrote. */
  | 'kept'
  /** The agent returned nothing usable for it. */
  | 'empty'
  /**
   * This deliverable has no chapter for that section, by design — the map says
   * so. Distinct from `unmatched`, which is this module failing to name a
   * chapter that does exist.
   */
  | 'suppressed'
  /** Nothing in this report answers to that key. */
  | 'unmatched';

export interface AppliedSection {
  /** The agent's key, which is what a caller asked for. */
  source_key: string;
  /** The report section it landed in, or null when nothing matched. */
  section_key: string | null;
  outcome: ApplyOutcome;
}

export interface NarrativeApplication {
  content: ReportContent;
  applied: AppliedSection[];
  /** True when `content` differs from what was passed in. */
  changed: boolean;
}

/**
 * Whether a chapter is one nobody has written yet.
 *
 * The first attempt asked whether the section still held a fill-me marker, and
 * a test against the real skeleton showed why that is wrong: the chapters that
 * most need drafting do not have one. "Describe the business of Northwind
 * Robotics, Inc.: products, customers, stage, headcount, and capital raised to
 * date." is instructional prose with no ellipsis in it, and so are the
 * methodology, income and market chapters. The marker rule would have written
 * into the DLOM and allocation chapters and skipped every chapter a 409A is
 * actually argued in.
 *
 * The precise question is not "does this look unfinished" but "has anybody
 * touched it", and the report answers that itself: version 1 is the template as
 * instantiated for this engagement, and `saveVersion` appends rather than
 * rewrites, so v1 is still the pristine skeleton however many edits followed. A
 * chapter identical to its v1 text is one nobody has written.
 *
 * The placeholder rule stays as the fallback for when no baseline is available.
 */
function unwrittenSections(
  content: ReportContent,
  baseline: ReportContent | null,
  figures: ResolvableFigures,
): Set<string> {
  if (baseline) {
    const skeleton = new Map(baseline.sections.map((s) => [s.key, s.html]));
    return new Set(content.sections.filter((s) => skeleton.get(s.key) === s.html).map((s) => s.key));
  }
  return new Set(findReportPlaceholders(content, figures).map((p) => p.key));
}

/**
 * Minimum length before a drafted body counts as prose.
 *
 * A model that has nothing to say about an approach the valuation did not use
 * returns a sentence fragment, or the word "N/A". Writing that into a chapter
 * of a 409A is worse than leaving the instruction that tells an analyst what
 * belongs there, because the instruction is visibly unfinished and "N/A." reads
 * as a considered position.
 */
export const MIN_DRAFT_LENGTH = 80;

/** Wraps the agent's plain-text paragraphs in the markup the report stores. */
export function paragraphsToHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${escapeText(para).replace(/\n/g, ' ')}</p>`)
    .join('');
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Applies a drafted narrative to `content`, returning a new document.
 *
 * `baseline` is the report's version 1 — the template as instantiated for this
 * engagement — and is how "nobody has written this chapter" is decided. See
 * `unwrittenSections`.
 *
 * `figures` matters only on the fallback path, where a section whose only
 * marker is a `{{fmv_per_share}}` the calculation *can* resolve must not count
 * as unwritten: that marker is supposed to be there, and treating it as a hole
 * would have the narrative overwrite the conclusion sentence the report
 * assembles from the run.
 */
export function applyNarrative(
  content: ReportContent,
  drafted: readonly DraftedSection[],
  opts: {
    overwrite?: boolean;
    figures?: ResolvableFigures;
    baseline?: ReportContent | null;
    /**
     * Which deliverable this is, and so which chapter each drafted section
     * belongs in. Omitted means the 409A's vocabulary — see
     * {@link narrativeSectionMap}.
     */
    kind?: ValuationKind | null;
  } = {},
): NarrativeApplication {
  const unwritten = unwrittenSections(content, opts.baseline ?? null, opts.figures ?? {});
  const sectionMap = narrativeSectionMap(opts.kind ?? null);
  const bySectionKey = new Map(content.sections.map((s, i) => [s.key, i]));
  const next = content.sections.map((s) => ({ ...s }));
  const applied: AppliedSection[] = [];
  /** Chapters this run has already drafted into, for the two-into-one case. */
  const filledHere = new Set<string>();
  let changed = false;

  for (const draft of drafted) {
    const mapped = Object.hasOwn(sectionMap, draft.key) ? sectionMap[draft.key]! : draft.key;
    if (mapped === null) {
      applied.push({ source_key: draft.key, section_key: null, outcome: 'suppressed' });
      continue;
    }
    const targetKey = mapped;
    const index = bySectionKey.get(targetKey);
    if (index === undefined) {
      applied.push({ source_key: draft.key, section_key: null, outcome: 'unmatched' });
      continue;
    }
    const body = (draft.body ?? '').trim();
    if (body.length < MIN_DRAFT_LENGTH) {
      applied.push({ source_key: draft.key, section_key: targetKey, outcome: 'empty' });
      continue;
    }
    /*
     * A chapter that took a drafted section a moment ago is not "prose somebody
     * wrote" and must not be treated as either — writing over it would discard
     * the first section, and keeping it would discard the second. Both are the
     * defect this change exists to remove, so the second is appended. Nothing
     * an analyst typed is at risk: the only text being added to is text this
     * same call wrote.
     */
    const alreadyFilled = filledHere.has(targetKey);
    if (!alreadyFilled && !opts.overwrite && !unwritten.has(targetKey)) {
      applied.push({ source_key: draft.key, section_key: targetKey, outcome: 'kept' });
      continue;
    }
    const html = sanitizeHtml(paragraphsToHtml(body));
    if (!html) {
      applied.push({ source_key: draft.key, section_key: targetKey, outcome: 'empty' });
      continue;
    }
    next[index] = { ...next[index]!, html: alreadyFilled ? `${next[index]!.html}${html}` : html };
    filledHere.add(targetKey);
    changed = true;
    applied.push({
      source_key: draft.key,
      section_key: targetKey,
      outcome: alreadyFilled ? 'appended' : 'written',
    });
  }

  return { content: { ...content, sections: next }, applied, changed };
}

/** Reads the agent's `{ sections: [{key, title, body}] }` result defensively. */
export function draftedSectionsFrom(result: unknown): DraftedSection[] {
  const sections = (result as { sections?: unknown } | null)?.sections;
  if (!Array.isArray(sections)) return [];
  const out: DraftedSection[] = [];
  for (const raw of sections) {
    if (!raw || typeof raw !== 'object') continue;
    const { key, title, body } = raw as Record<string, unknown>;
    if (typeof key !== 'string' || !key) continue;
    out.push({
      key,
      title: typeof title === 'string' ? title : undefined,
      body: typeof body === 'string' ? body : '',
    });
  }
  return out;
}
