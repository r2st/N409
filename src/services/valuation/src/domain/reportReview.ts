import { TEMPLATE_VAR_NAMES, visibleSections, type ReportContent, type ReportTemplate } from './report.js';
import type { QaStatus } from './qaChecks.js';

/**
 * Review of the drafted report as a *document*, rather than of the arithmetic
 * behind it.
 *
 * Three things already grade a valuation before it publishes, and none of them
 * reads the deliverable as a reader would:
 *
 *   * `qaChecks.ts` grades the calculation — discounts in band, weights summing,
 *     a discount rate above terminal growth. Every check there is about a
 *     number, and none of them opens the report.
 *   * `reportReadiness.ts` opens the report, but looks only for the skeleton's
 *     own fill-me markers: an ellipsis nobody replaced, a `{{placeholder}}`
 *     nothing resolves. A chapter can be entirely free of markers and still be
 *     wrong.
 *   * the `qa` AI pipeline reads the outputs, and is optional, non-deterministic
 *     and off by default.
 *
 * What sits between them is the class of defect that is invisible in the
 * numbers and invisible to a marker search, because every sentence is complete
 * and every figure is plausible — the document simply does not hold together:
 *
 *   * A chapter that sends the reader to **Exhibit E** when no Exhibit E will
 *     be printed, because the asset approach carried no weight and its schedule
 *     was never built. The prose is fine. The reference is a dead end, and it
 *     is the reviewer's first impression of how carefully the file was kept.
 *   * An approach the calculation gave real weight to, with no chapter
 *     explaining it — the reconciliation table shows 30% on the market approach
 *     and the body never mentions one.
 *   * A chapter that used to restate itself from the calculation and no longer
 *     does, because somebody replaced `{{fmv_per_share}}` with the figure it
 *     resolved to that afternoon. It is correct on the day it is typed and
 *     silently stale from the next recalculation — which is exactly how a
 *     report comes to state two different conclusions in two places.
 *
 * Deterministic on purpose. An LLM reviewer is the obvious way to read a
 * document for coherence and it is already available here behind `ai: true`,
 * but it cannot be the only thing that looks: it is off by default, it needs a
 * provider that is routinely rate-limited, and a gate that silently stops
 * gating when a quota runs out is worse than one that never existed. These
 * checks run on every review, cost nothing and always answer the same way.
 */

export interface ReportReviewFinding {
  /** Stable check id, so findings group and a test names one. */
  check: string;
  /**
   * `fail` blocks the publish gate; `warn` surfaces for the analyst.
   *
   * Two findings fail, and both for the same reason: they are defects on the
   * page under every reading. There is no version of "see Exhibit E" that is
   * correct when no Exhibit E exists, and no version of "Summarize the industry
   * landscape" that is correct in a document a named appraiser has signed. The
   * others describe a report that may well be right and is at risk of not
   * staying right, which is a thing to tell somebody, not a thing to refuse.
   */
  severity: 'fail' | 'warn';
  /** The chapter the finding is about; null where it is about the document. */
  section_key: string | null;
  heading: string | null;
  summary: string;
}

export interface ReportReviewResult {
  status: QaStatus;
  findings: ReportReviewFinding[];
  detail: string;
}

/**
 * An exhibit reference as the body writes it: `Exhibit C`, `Exhibit D-1`.
 *
 * Matched on the rendered text rather than the markup because the skeletons
 * bold them (`<strong>Exhibit C</strong>`) and an analyst editing the body may
 * not — a check that only saw the bold ones would pass a report by being
 * differently formatted.
 */
const EXHIBIT_REF = /\b([Nn]o\s+)?Exhibit\s+([A-Z](?:-\d+)?)\b/g;

/** The same, as the exhibit builder titles its schedules. */
const EXHIBIT_TITLE = /^Exhibit\s+([A-Z](?:-\d+)?)\s/;

/** Every `{{marker}}`, of either kind. */
const MARKER = /\{\{(\w+)\}\}/g;

/**
 * The markers that make a chapter restate itself from the calculation.
 *
 * Instantiation-time variables are excluded, because they are *supposed* to be
 * absent from a stored body — `instantiateTemplate` fills them at draft time.
 * Counting them would report every correctly-drafted chapter that happened to
 * name the company as one that had lost its figures.
 */
function computedMarkers(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(MARKER)) {
    if (TEMPLATE_VAR_NAMES.has(m[1]!)) continue;
    /*
     * Not a figure either. `{{exhibit_index}}` is resolved from the exhibit list
     * rather than from the calculation (domain/reportExhibitIndex.ts), and this
     * check reads the *resolved* body — so counting it would report the Index of
     * Exhibits, whose whole content is generated, as a chapter that had stopped
     * restating itself.
     */
    if (m[1] === 'exhibit_index') continue;
    out.add(m[1]!);
  }
  return out;
}

/**
 * Which chapter explains which approach.
 *
 * Keyed by the engine's own approach names (`results.approaches`), so an
 * approach the engine grows later fails this lookup and is passed over rather
 * than reported against a chapter that does not exist. `opm_backsolve` is
 * deliberately absent — the backsolve is an allocation mechanism explained in
 * the allocation chapter, not an approach with a chapter of its own.
 */
const APPROACH_SECTIONS: Record<string, { key: string; label: string }> = {
  income: { key: 'income_approach', label: 'income approach' },
  market: { key: 'market_approach', label: 'market approach' },
  asset: { key: 'asset_approach', label: 'asset approach' },
};

/** Strips tags and collapses whitespace — every check below reads prose. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export interface ReportReviewInput {
  /** The drafted body as stored. Null — no draft — is reviewed as a pass. */
  content: ReportContent | null;
  /**
   * The headings the exhibit builder produced for this calculation, exactly as
   * the render will print them. Passed in rather than rebuilt here so the check
   * can never disagree with what the PDF contains: it is grading the real
   * output, not a second opinion about what the output should have been.
   */
  exhibitHeadings: readonly string[];
  /** `results.approaches` from the calculation, when there is one. */
  approaches?: unknown;
  /**
   * The skeleton this body was drafted from, for the two checks that compare
   * the stored chapter against the text it started as.
   *
   * Optional because a body drafted from a *managed* (DB-backed) template has
   * no code skeleton to compare against. Those checks are then skipped rather
   * than guessed at — the others do not depend on it.
   */
  template?: ReportTemplate | null;
  /**
   * What the current calculation resolves, exactly as `reportFigures` formats
   * it — the same map the render substitutes into the body.
   *
   * Formatted rather than numeric on purpose: the check asks whether a *string*
   * in the prose is one of these, and re-deriving the formatting here would let
   * it disagree with what the page actually says.
   */
  figures?: ResolvableFigures;
  /**
   * The same map for each superseded succeeded run of this engagement, newest
   * first. Absent or empty disables the staleness check — with no prior run
   * there is no evidence, and a figure check that guesses is worse than none.
   */
  supersededFigures?: readonly ResolvableFigures[];
}

/** A formatted figure map, keyed by placeholder name. `reportFigures` shape. */
export type ResolvableFigures = Readonly<Record<string, string>>;

export function reviewReport(input: ReportReviewInput): ReportReviewResult {
  if (!input.content) {
    return { status: 'pass', findings: [], detail: 'No report drafted yet.' };
  }

  const findings: ReportReviewFinding[] = [];
  const sections = visibleSections(input.content);
  const shown = new Map(sections.map((s) => [s.key, s]));

  checkExhibitReferences(sections, input.exhibitHeadings, findings);
  checkApproachChapters(input.approaches, shown, findings);
  checkFrozenFigures(sections, input.template ?? null, findings);
  checkUneditedGuidance(sections, input.template ?? null, findings);
  checkStaleFigures(sections, input.figures ?? {}, input.supersededFigures ?? [], findings);

  if (findings.length === 0) {
    return {
      status: 'pass',
      findings,
      detail: 'Report body is consistent with the schedules and the calculation.',
    };
  }

  const failures = findings.filter((f) => f.severity === 'fail');
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (failures.length > 0) {
    return {
      status: 'fail',
      findings,
      // Deliberately not phrased around one check any more: a dead exhibit
      // reference and an unedited instruction both land here, and a detail line
      // that named only the first described the wrong defect half the time.
      detail: `${plural(failures.length, 'finding blocks', 'findings block')} this report: ${failures
        .map((f) => f.summary)
        .join('; ')}`,
    };
  }
  return {
    status: 'warn',
    findings,
    detail: `${plural(findings.length, 'finding', 'findings')} on the drafted body: ${findings
      .map((f) => f.summary)
      .join('; ')}`,
  };
}

/**
 * References that go nowhere, and schedules nobody sends the reader to.
 *
 * The asymmetry between the two is deliberate. A body citing an exhibit that
 * will not print is a defect on the page and fails. An exhibit that prints with
 * nothing pointing at it is untidy rather than wrong — it is still a correct
 * schedule of real figures — so it warns.
 *
 * Only *primary* exhibits are checked for being unreferenced. A sub-exhibit
 * (C-1, D-1, F-1, H-1) is supporting detail hung off its parent and is reached
 * from the parent's own text, so requiring the body to name each one would fire
 * on every well-formed report — which is the definition of a check nobody
 * reads. Dangling references are still checked at full precision: a body citing
 * `Exhibit F-1` when no F-1 renders is as dead an end as any other.
 */
function checkExhibitReferences(
  sections: readonly { key: string; heading: string; html: string }[],
  exhibitHeadings: readonly string[],
  findings: ReportReviewFinding[],
): void {
  const rendered = new Set<string>();
  for (const heading of exhibitHeadings) {
    const m = EXHIBIT_TITLE.exec(heading);
    if (m) rendered.add(m[1]!);
  }

  const referenced = new Set<string>();
  for (const section of sections) {
    const text = textOf(section.html);
    const seen = new Set<string>();
    for (const m of text.matchAll(EXHIBIT_REF)) {
      const negated = m[1] !== undefined;
      const letter = m[2]!;
      /*
       * "No Exhibit E is included, because the approach was not applied" is not
       * a pointer at all — it is the report telling the reader an exhibit is
       * absent, which is the correct thing to write in a chapter explaining an
       * approach that was considered and given no weight. Reading it as a dead
       * end punished the best-written chapter in the sample engagements.
       *
       * The claim is still checked, in the other direction: the same sentence on
       * a report that *does* print Exhibit E has the document contradicting
       * itself on the page, which is the same class of defect.
       */
      if (negated) {
        if (!rendered.has(letter) || seen.has(letter)) continue;
        seen.add(letter);
        findings.push({
          check: 'contradicted_exhibit_reference',
          severity: 'fail',
          section_key: section.key,
          heading: section.heading,
          summary: `“${section.heading}” states that no Exhibit ${letter} is included, but this report contains one`,
        });
        continue;
      }
      referenced.add(letter);
      if (rendered.has(letter) || seen.has(letter)) continue;
      seen.add(letter);
      findings.push({
        check: 'dangling_exhibit_reference',
        severity: 'fail',
        section_key: section.key,
        heading: section.heading,
        summary: `“${section.heading}” sends the reader to Exhibit ${letter}, which this report does not contain`,
      });
    }
  }

  for (const letter of [...rendered].sort()) {
    if (letter.includes('-') || referenced.has(letter)) continue;
    findings.push({
      check: 'unreferenced_exhibit',
      severity: 'warn',
      section_key: null,
      heading: null,
      summary: `Exhibit ${letter} is printed and no chapter refers to it`,
    });
  }
}

/**
 * An approach the conclusion rests on, with no chapter explaining it.
 *
 * The reconciliation prints every weighted approach in Exhibit B, so a reader
 * can see that 30% of the concluded value came from the market approach. If no
 * chapter says which comparables, on what multiple, screened how, then the
 * weight is asserted and not supported — and that is the first thing an auditor
 * asks about.
 *
 * The converse is not a finding. A chapter that explains why an approach was
 * *considered and given no weight* is good practice and the skeletons ask for
 * exactly that, so a visible asset-approach chapter against a zero weight is
 * the report working as intended.
 */
function checkApproachChapters(
  approaches: unknown,
  shown: ReadonlyMap<string, { heading: string }>,
  findings: ReportReviewFinding[],
): void {
  const byKey = record(approaches);
  if (!byKey) return;

  for (const [approach, raw] of Object.entries(byKey)) {
    const mapping = APPROACH_SECTIONS[approach];
    if (!mapping) continue;
    const weight = num(record(raw)?.weight) ?? 0;
    if (weight <= 0 || shown.has(mapping.key)) continue;
    findings.push({
      check: 'weighted_approach_without_chapter',
      severity: 'warn',
      section_key: mapping.key,
      heading: null,
      summary:
        `The ${mapping.label} carries ${(weight * 100).toFixed(0)}% of the concluded value and no ` +
        'chapter explains it',
    });
  }
}

/**
 * Chapters that have stopped restating themselves from the calculation.
 *
 * The skeletons write their figures as `{{fmv_per_share}}`, `{{dlom}}`,
 * `{{equity_value}}`, and the render resolves them against the calculation the
 * report is being produced from. That is what lets a recalculation restate the
 * prose instead of leaving the old number in it.
 *
 * Replacing one with the figure it happened to resolve to breaks that, and does
 * so invisibly: the sentence is complete, the number is right, nothing is
 * missing, and `reportReadiness` — which looks for markers that *should not*
 * still be there — cannot see a marker that is gone. The next recalculation
 * moves the conclusion and the chapter keeps the old figure, which is the
 * two-conclusions-in-one-document failure spelled a different way.
 *
 * A warning, never a failure. An analyst may have deliberately fixed a figure —
 * quoting the prior year's conclusion, say — and the point is to make the
 * consequence visible, not to insist the template's phrasing is the only
 * correct one.
 */
function checkFrozenFigures(
  sections: readonly { key: string; heading: string; html: string }[],
  template: ReportTemplate | null,
  findings: ReportReviewFinding[],
): void {
  if (!template) return;
  const skeleton = new Map(template.sections.map((s) => [s.key, s.html]));

  for (const section of sections) {
    const original = skeleton.get(section.key);
    // Only chapters the skeleton wrote as self-restating can stop being so.
    if (original === undefined || computedMarkers(original).size === 0) continue;
    /*
     * Fires only when the chapter has lost *every* computed figure, not when it
     * has lost one of several. An analyst rewriting a paragraph and dropping a
     * marker along the way is common and usually deliberate; a chapter with
     * nothing left to resolve is the case where a recalculation provably
     * changes nothing on the page, which is the claim this finding makes.
     */
    if (computedMarkers(section.html).size > 0) continue;
    findings.push({
      check: 'frozen_figure',
      severity: 'warn',
      section_key: section.key,
      heading: section.heading,
      summary:
        `“${section.heading}” no longer restates its figures from the calculation — a recalculation ` +
        'will leave the numbers in it unchanged',
    });
  }
}

/**
 * A figure the prose froze, and the calculation has since moved past.
 *
 * `checkFrozenFigures` above is about a chapter that *will* go stale: it fires
 * when nothing is left to resolve, and its claim is about the next
 * recalculation. This one is about the recalculation that already happened. The
 * two are not the same finding and the second was invisible to everything:
 *
 *   * the marker is gone, so `reportReadiness`' marker search has nothing to
 *     find;
 *   * the conclusion chapter states its headline figure in one paragraph and
 *     its derivation in the next, so freezing the one that matters leaves
 *     `{{equity_value}}` and `{{dlom}}` behind and `frozen_figure` passes the
 *     chapter over;
 *   * the summary page and the exhibits render from the live calculation and
 *     are right, so no figure check is looking at the wrong number.
 *
 * What is left is a signed opinion stating $1.4947 per share in its Conclusion
 * of Value and $1.6120 on the summary page three pages earlier.
 *
 * The evidence is what makes this decidable rather than a heuristic about
 * numbers that look like conclusions. The literal in the prose is not merely a
 * plausible figure — it is, character for character, the value *this
 * engagement's own superseded run* concluded, in the formatting the render
 * would have produced. Nothing but a freeze puts that string on the page, so
 * the check needs no view about which numbers a chapter is allowed to contain.
 *
 * A warning rather than a failure, for the reason `checkFrozenFigures` gives: an
 * analyst may be quoting the prior conclusion deliberately, and the useful act
 * is to make the divergence visible rather than to refuse the document. The
 * guard below covers the common form of that — a chapter comparing the two
 * states both, and stating the current figure is what separates a comparison
 * from a freeze.
 */
function checkStaleFigures(
  sections: readonly { key: string; heading: string; html: string }[],
  figures: ResolvableFigures,
  superseded: readonly ResolvableFigures[],
  findings: ReportReviewFinding[],
): void {
  if (superseded.length === 0) return;
  for (const section of sections) {
    const text = textOf(section.html);
    for (const [key, current] of Object.entries(figures)) {
      /*
       * The chapter restating the current value is the whole point of the
       * placeholder mechanism, and a chapter that does it — whether from a
       * marker or by having been retyped correctly — is not stating a stale
       * conclusion whatever else it mentions. Checked before the superseded
       * scan so "revised from $1.4947 to $1.6120" is read as the comparison it
       * is.
       */
      if (statesFigure(text, current)) continue;
      const stale = superseded.find((f) => {
        const prior = f[key];
        return prior !== undefined && prior !== current && statesFigure(text, prior);
      });
      if (!stale) continue;
      findings.push({
        check: 'stale_figure',
        severity: 'warn',
        section_key: section.key,
        heading: section.heading,
        summary:
          `“${section.heading}” states ${stale[key]!}, which this engagement concluded on an ` +
          `earlier run — the calculation behind the schedules now concludes ${current}`,
      });
      // One per chapter. A frozen conclusion paragraph usually froze its
      // derivation too, and four findings about one edit is a wall, not a review.
      break;
    }
  }
}

/**
 * Does the prose state this exact figure, as a figure?
 *
 * Bounded on both ends against the characters a number is made of, because a
 * bare substring test reads `$1.49` out of `$1.4947` — which would report the
 * current conclusion as its own superseded one on any run that merely added a
 * decimal place, the single most likely way for two of these strings to be
 * prefixes of each other.
 */
function statesFigure(text: string, figure: string): boolean {
  const escaped = figure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.,])${escaped}(?![\\d.,%])`).test(text);
}

/**
 * The shortest run of skeleton text worth matching on.
 *
 * The comparison below splits the skeleton on its `{{markers}}` and asks
 * whether the literal text between them survives in the stored chapter. Short
 * fragments — "  — ", ", and ", the tail of a sentence a marker ended — appear
 * in any prose at all, so matching on them would report a fully rewritten
 * chapter as untouched. Long enough to be a clause, short enough that a
 * skeleton sentence with two markers in it still contributes one.
 */
const GUIDANCE_FRAGMENT = 24;

/**
 * Whether the skeleton's own words are still on the page.
 *
 * Not string equality, for two reasons. The stored body has had its
 * instantiation variables filled — "Describe the business of {{company_name}}"
 * is "Describe the business of Northwind Robotics, Inc." by the time it is
 * saved — so the skeleton never equals what it produced. And the case that
 * matters most is not the untouched chapter but the half-touched one: an
 * analyst who writes two paragraphs of company description above the
 * instruction and leaves the instruction under it has a report that still
 * delivers the instruction, and an equality test would call it edited.
 *
 * So the skeleton is split on its markers and each literal run between them
 * must still be found in the stored text. All of them, not any: a chapter that
 * has lost part of the guidance is one somebody is working through, and firing
 * on it would make the finding something analysts learn to ignore.
 */
function stillCarriesGuidance(skeletonHtml: string, storedHtml: string): boolean {
  const fragments = textOf(skeletonHtml)
    .split(/\{\{[^}]*\}\}/)
    .map((f) => f.trim())
    .filter((f) => f.length >= GUIDANCE_FRAGMENT);
  if (fragments.length === 0) return false;
  const stored = textOf(storedHtml);
  return fragments.every((f) => stored.includes(f));
}

/**
 * Chapters that ship the skeleton's instructions to the analyst as if they were
 * the report.
 *
 * Most of a skeleton is prose that is *supposed* to be delivered verbatim — the
 * standard of value, the safe-harbor statement, the certification. A handful of
 * chapters are the opposite: their text tells whoever writes the report what
 * belongs there. "Summarize the industry landscape, market size and growth, and
 * competitive positioning." is a to-do item, and a signed 409A containing it is
 * a document that tells its reader the analyst did not do that work.
 *
 * Nothing caught this. `reportReadiness` searches for the skeleton's fill-me
 * markers and these chapters have none — every sentence is complete, correctly
 * punctuated English. Six chapters of the 409A went out this way.
 *
 * `fail`, not `warn`. The distinction the rest of this module draws is between
 * a report that may be right and one that is wrong on the page, and there is no
 * reading under which an instruction to the analyst is the report. An
 * engagement that genuinely has nothing to say under a chapter has the answer
 * the editor already provides: hide it, and it leaves the deliverable and this
 * check together (`visibleSections`).
 *
 * Which chapters are guidance is declared by the skeleton (`authored`) rather
 * than guessed at here. Detecting an imperative sentence would have caught
 * these six and also every chapter that carries a substantive paragraph and one
 * "State the basis for the concluded discount" beside it — which is most of
 * them, and a gate that refuses every report is one somebody turns off.
 */
function checkUneditedGuidance(
  sections: readonly { key: string; heading: string; html: string }[],
  template: ReportTemplate | null,
  findings: ReportReviewFinding[],
): void {
  if (!template) return;
  const guidance = new Map(template.sections.filter((s) => s.authored === true).map((s) => [s.key, s.html]));

  for (const section of sections) {
    const original = guidance.get(section.key);
    if (original === undefined) continue;
    if (!stillCarriesGuidance(original, section.html)) continue;
    findings.push({
      check: 'unedited_template_guidance',
      severity: 'fail',
      section_key: section.key,
      heading: section.heading,
      summary:
        `“${section.heading}” still carries the template's instructions to the analyst rather than ` +
        'prose about this engagement',
    });
  }
}
