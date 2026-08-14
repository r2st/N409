import { visibleSections, type ReportContent } from './report.js';

/**
 * The index of exhibits, and the body's pointers into them, resolved against
 * the schedules this calculation actually produced.
 *
 * ## What was wrong
 *
 * The exhibits are conditional and always have been — `buildExhibits` returns
 * `null` for a schedule whose analysis was not applied, and filters it out, so
 * a valuation that gave the asset approach no weight prints no Exhibit E and one
 * whose sigma was chosen by judgement prints no Exhibit F-1. That is right: a
 * deliverable should not carry an empty schedule for an approach nobody ran.
 *
 * The *body*, though, is a prose skeleton instantiated once and stored, so it
 * cannot know any of that. It named its exhibits statically:
 *
 *   * the Index of Exhibits listed all fifteen, unconditionally, under a
 *     sentence promising that "an exhibit is included only where the
 *     corresponding analysis was applied" — an index that lists what is not
 *     there, apologising for it in advance;
 *   * the Asset Approach chapter closed with "The computation, where applied, is
 *     set out in Exhibit E", on a report with no Exhibit E;
 *   * Selected Volatility opened by sending the reader to Exhibit F-1, likewise.
 *
 * None of it is a wrong *number*, which is why every arithmetic check passed it.
 * It is the reviewer's first impression of how carefully the file was kept, and
 * the product's own coherence check (`domain/reportReview.ts`) grades a dangling
 * exhibit reference as a failure — correctly. Seeding the three sample
 * engagements failed the publish gate on exactly these six references.
 *
 * ## The fix
 *
 * The same architecture the summary, the exhibits and `fillFigures` already use:
 * computed content is resolved at render time and never written back. The stored
 * body keeps its markers, so a re-render after a recalculation that drops an
 * approach restates the index and the pointers instead of leaving yesterday's in
 * place. Two forms:
 *
 *   * `{{exhibit_index}}` — replaced by a list of the schedules that follow, in
 *     the order they are printed. A legacy body with no marker but a static
 *     list is handled too (see `withExhibitIndex`), so nothing has to be
 *     re-drafted to stop lying.
 *   * `{{#exhibit:E}}…{{/exhibit:E}}` — kept when Exhibit E is printed, dropped
 *     whole when it is not. This is what lets a chapter point precisely at a
 *     schedule in the case where there is one, and say nothing in the case where
 *     there is not, which no single piece of static prose can do.
 *
 * Applied by the renderer and by the QA route, from the one `buildExhibits` call
 * each already makes, so the document that is graded is the document that is
 * delivered.
 */

/** `Exhibit C`, `Exhibit D-1`, `Appendix II` — as the builders title them. */
const SCHEDULE_TITLE = /^(?:Exhibit|Appendix)\s+([A-Z]+(?:-\d+)?)\s/;

/**
 * `{{#exhibit:F-1}} … {{/exhibit:F-1}}`, non-greedy, across newlines.
 *
 * The id accepts more than a schedule identifier because a pointer can be
 * conditional on something finer than "the exhibit printed" — see
 * `renderedScheduleIds` and `ReportPdfSection.schedules`.
 */
const CONDITIONAL = /\{\{#exhibit:([A-Za-z0-9-]+)\}\}([\s\S]*?)\{\{\/exhibit:\1\}\}/g;

const INDEX_MARKER = '{{exhibit_index}}';

/** The section that holds the index, in every skeleton that has one. */
const INDEX_SECTION_KEY = 'exhibit_index';

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * A schedule as this module needs to see it: the heading it prints under, plus
 * any finer-grained pointer ids it answers.
 *
 * A bare string is the heading, which is what a caller with nothing finer to
 * say passes — most tests, and any list already reduced to headings.
 */
export type ScheduleSource = string | { readonly heading: string; readonly schedules?: readonly string[] };

const headingOf = (s: ScheduleSource): string => (typeof s === 'string' ? s : s.heading);

/**
 * The identifiers of the schedules that will print, e.g. `A`, `D-1`, `II`.
 *
 * Exported for the coherence check, which needs the same reading of the same
 * headings — a check that parsed them differently could pass a body the render
 * would contradict.
 *
 * A heading identifies one schedule, and for nearly every exhibit that is the
 * whole story. It is not for an exhibit assembled from blocks that appear
 * independently: Exhibit H-1 prints a DLOM derivation, a class-volatility
 * schedule, or both, so "H-1 printed" does not answer "are the class
 * volatilities in it". A run with no cap table produces no waterfall and
 * therefore no class volatilities, and the body still told the reader twice —
 * in Selected Volatility and again under the DLOM chapter — that they were set
 * out in Exhibit H-1, an exhibit which existed and did not contain them. Such
 * a builder declares the extra ids on the section (`schedules`), and a pointer
 * conditional on one is resolved against what actually printed.
 */
export function renderedScheduleIds(exhibits: readonly ScheduleSource[]): Set<string> {
  const out = new Set<string>();
  for (const exhibit of exhibits) {
    const m = SCHEDULE_TITLE.exec(headingOf(exhibit));
    if (m) out.add(m[1]!);
    if (typeof exhibit !== 'string') for (const id of exhibit.schedules ?? []) out.add(id.toUpperCase());
  }
  return out;
}

/** `<ul><li>Exhibit A — Capitalization Table</li>…</ul>`, in printed order. */
function indexListHtml(exhibitHeadings: readonly string[]): string {
  const items = exhibitHeadings.filter((h) => SCHEDULE_TITLE.test(h));
  if (items.length === 0) {
    /*
     * A report drafted before the engine has run has no schedules to index.
     * Saying so beats printing an empty `<ul>`, which renders as a heading
     * followed by nothing and reads as a rendering fault rather than a draft.
     */
    return '<p>No exhibits have been produced for this valuation yet; they are generated from the valuation model once a calculation has been run.</p>';
  }
  return `<ul>${items.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`;
}

/**
 * Put the real list into the index chapter.
 *
 * Three cases, in order, so that no stored body has to be re-drafted:
 *   1. the marker is present — substitute there, which is where the skeleton
 *      asked for it;
 *   2. no marker but a static `<ul>` — a body drafted from a skeleton older than
 *      this module. Its list is the stale one, so it is replaced;
 *   3. neither — append, so an analyst who rewrote the chapter entirely still
 *      gets an accurate list rather than none.
 */
function withExhibitIndex(html: string, exhibitHeadings: readonly string[]): string {
  const list = indexListHtml(exhibitHeadings);
  if (html.includes(INDEX_MARKER)) return html.split(INDEX_MARKER).join(list);
  if (/<ul[\s>][\s\S]*?<\/ul>/i.test(html)) return html.replace(/<ul[\s>][\s\S]*?<\/ul>/i, list);
  return html + list;
}

/** Keep the block if its schedule prints; drop it whole if it does not. */
function resolveConditionals(html: string, rendered: ReadonlySet<string>): string {
  return html.replace(CONDITIONAL, (_all, id: string, inner: string) =>
    rendered.has(id.toUpperCase()) ? inner : '',
  );
}

/**
 * Resolve the index and the conditional pointers against the printed schedules.
 *
 * Never written back — the caller passes the stored content and renders the
 * result, exactly as `fillFigures` is applied.
 */
export function resolveExhibitReferences(
  content: ReportContent,
  exhibits: readonly ScheduleSource[],
): ReportContent {
  const rendered = renderedScheduleIds(exhibits);
  const headings = exhibits.map(headingOf);
  return {
    title: content.title,
    sections: content.sections.map((s) => {
      let html = resolveConditionals(s.html, rendered);
      if (s.key === INDEX_SECTION_KEY) html = withExhibitIndex(html, headings);
      return html === s.html ? s : { ...s, html };
    }),
  };
}

/**
 * The index chapter is generated, so it cannot dangle — but only once it has
 * been resolved. Used by tests to assert the resolved body holds no reference
 * the exhibits do not answer.
 */
export function danglingReferences(
  content: ReportContent,
  exhibits: readonly ScheduleSource[],
): { heading: string; id: string }[] {
  const rendered = renderedScheduleIds(exhibits);
  const out: { heading: string; id: string }[] = [];
  for (const section of visibleSections(content)) {
    const text = section.html.replace(/<[^>]*>/g, ' ');
    const seen = new Set<string>();
    for (const m of text.matchAll(/\bExhibit\s+([A-Z](?:-\d+)?)\b/g)) {
      const id = m[1]!;
      if (rendered.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({ heading: section.heading, id });
    }
  }
  return out;
}
