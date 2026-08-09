import { sanitizeHtml, type ReportContent } from './report.js';
import { findReportPlaceholders, type ResolvableFigures } from './reportReadiness.js';

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
 * Agent section key → template section key.
 *
 * The two vocabularies were designed independently and mostly agree. Where they
 * do not, the mapping is a judgement about which chapter the drafted prose
 * belongs in, and it is written out rather than inferred from string similarity
 * so that a wrong pairing is a visible line someone can argue with.
 *
 * `executive_summary` is deliberately absent. The PDF builds its own summary
 * page from the calculation — headline FMV, the figures grid, the approach
 * chart, the value bridge — and a drafted prose summary would sit beside it
 * saying the same things in a voice nothing verified. The narrative agent still
 * drafts it; it simply is not what the deliverable's summary page is made of.
 */
export const NARRATIVE_SECTION_MAP: Readonly<Record<string, string>> = {
  company_overview: 'company_overview',
  valuation_methodology: 'methodology',
  market_approach: 'market_approach',
  income_approach: 'income_approach',
  asset_approach: 'asset_approach',
  allocation_methodology: 'allocation',
  dlom_analysis: 'dlom',
  dloc_analysis: 'dloc',
  industry_analysis: 'industry_market',
  industry_overview: 'industry_market',
  industry_outlook: 'economic_outlook',
  economic_outlook: 'economic_outlook',
  financial_analysis: 'financial_analysis',
  capital_structure: 'capital_structure',
  reconciliation: 'reconciliation',
  conclusion: 'conclusion',
};

/** One section the agent drafted. */
export interface DraftedSection {
  key: string;
  title?: string;
  body: string;
}

export type ApplyOutcome =
  | 'written'
  /** The section already holds prose somebody wrote. */
  | 'kept'
  /** The agent returned nothing usable for it. */
  | 'empty'
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
    return new Set(
      content.sections.filter((s) => skeleton.get(s.key) === s.html).map((s) => s.key),
    );
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
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
  opts: { overwrite?: boolean; figures?: ResolvableFigures; baseline?: ReportContent | null } = {},
): NarrativeApplication {
  const unwritten = unwrittenSections(content, opts.baseline ?? null, opts.figures ?? {});
  const bySectionKey = new Map(content.sections.map((s, i) => [s.key, i]));
  const next = content.sections.map((s) => ({ ...s }));
  const applied: AppliedSection[] = [];
  let changed = false;

  for (const draft of drafted) {
    const targetKey = NARRATIVE_SECTION_MAP[draft.key] ?? draft.key;
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
    if (!opts.overwrite && !unwritten.has(targetKey)) {
      applied.push({ source_key: draft.key, section_key: targetKey, outcome: 'kept' });
      continue;
    }
    const html = sanitizeHtml(paragraphsToHtml(body));
    if (!html) {
      applied.push({ source_key: draft.key, section_key: targetKey, outcome: 'empty' });
      continue;
    }
    next[index] = { ...next[index]!, html };
    changed = true;
    applied.push({ source_key: draft.key, section_key: targetKey, outcome: 'written' });
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
