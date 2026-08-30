import { RENDER_RESOLVED_MARKERS, type ReportContent } from './report.js';
import { ellipsize } from './textSlice.js';

/**
 * Does the drafted report still contain the template's fill-me markers?
 *
 * Every skeleton in `domain/report.ts` ships instructional prose with an
 * ellipsis standing where a figure or a name belongs — `is $ … per share`,
 * `Expected term … years`, `$…`. That is the right way to write a skeleton: the
 * analyst is told what to supply and where. What was missing is anything that
 * notices when they did not.
 *
 * The 409A this was found on rendered a Conclusion of Value chapter reading
 * "the fair market value of one share of common stock of Northwind Robotics,
 * Inc. as of 2026-06-30 is $ … per share" — three pages after an executive
 * summary stating $1.2242, and one page before an exhibit deriving it. Nothing
 * refused to publish that, and nothing said it was there.
 *
 * The rule is deliberately about the *marker*, not about the section. An
 * ellipsis is not something analyst prose reaches for — a valuation report
 * states figures or omits them, it does not trail off — so its presence is a
 * reliable signal that a skeleton sentence was never completed. Being
 * marker-based also means a template section added later is covered the day it
 * is added, with no list here to keep in step.
 *
 * `blocking` is the judgement, and it is narrow on purpose: an unfilled
 * *Conclusion of Value* is a deliverable that contradicts itself, while an
 * unfilled *Qualifications* section is an incomplete report somebody may still
 * have reason to publish. So one fails the gate and the other warns.
 *
 * There are now two marker classes, and the difference between them matters:
 *
 *   * the ellipsis — "an analyst fills this in". Its presence in the stored
 *     body is the finding, because nothing else will ever fill it.
 *   * `{{fmv_per_share}}` and friends — "the calculation fills this in", at
 *     render time (domain/reportFigures.ts). Its presence in the stored body is
 *     *correct* and is what lets a re-render restate the prose after a
 *     recalculation. It is a finding only when nothing resolves it, which is
 *     exactly the case where it would reach the page as literal braces.
 *
 * So the computed markers are checked against the figures the current
 * calculation actually supplies, rather than being flagged on sight. Checking
 * them at all is the point: moving the conclusion from an ellipsis to a
 * placeholder would otherwise have moved it out from under the gate that was
 * built to catch it.
 */

/** The markers a skeleton uses to say "an analyst fills this in". */
const PLACEHOLDER = /[…]|\.\.\./;

/** The markers the calculation fills in at render time. */
const COMPUTED = /\{\{(\w+)\}\}/g;

/**
 * Sections whose placeholders block a publish rather than warn.
 *
 * These are the sections that state the answer. A report is allowed to go out
 * with an unwritten industry discussion; it is not allowed to go out without
 * saying what the shares are worth, or with an ASC 718 table of empty cells
 * that a client's auditor will read as the measured expense.
 */
const BLOCKING_SECTIONS: ReadonlySet<string> = new Set(['conclusion', 'asc718']);

/**
 * Headings are matched too, because a report drafted from a *managed* template
 * (the DB-backed ones) has no `key` this module can rely on — the key is a
 * property of the code-authored skeletons. The heading is what both kinds
 * share, and the conclusion chapter is called the same thing in each.
 */
const BLOCKING_HEADINGS = /conclusion of value|asc\s*718/i;

export interface ReportPlaceholder {
  key: string;
  heading: string;
  /** The sentence the marker sits in, so the analyst is not sent hunting. */
  excerpt: string;
  blocking: boolean;
}

/** Strips tags and collapses whitespace — the marker search runs on prose. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The clause around the first marker, bounded so a finding is one line in a UI.
 *
 * Sentence-bounded rather than a fixed character window: "…is $ … per share"
 * tells an analyst what to do, and 60 characters either side of an ellipsis
 * usually does not.
 */
function excerptAround(text: string, at: number): string {
  const start = Math.max(0, text.lastIndexOf('.', at - 1) + 1);
  const dot = text.indexOf('.', at);
  const end = dot === -1 ? text.length : dot + 1;
  const clause = text.slice(start, end).trim();
  return ellipsize(clause, 200);
}

/**
 * The names the current calculation can fill in, as `reportFigures` produces
 * them. Absent (or empty) means nothing will resolve, so every computed marker
 * in the body is a finding — which is the honest verdict on a report drafted
 * before the engine has run.
 */
export type ResolvableFigures = Readonly<Record<string, string>>;

export function findReportPlaceholders(
  content: ReportContent,
  figures: ResolvableFigures = {},
): ReportPlaceholder[] {
  const found: ReportPlaceholder[] = [];
  for (const section of content.sections) {
    /*
     * A hidden chapter is not in the deliverable, so an unfilled marker in one
     * is not an unfinished report. Scanning it anyway would make the toggle
     * useless exactly where it is most wanted: the skeleton's own instructions
     * are the thing an analyst hides when a chapter does not apply, and those
     * instructions are written with markers in them. The gate would then refuse
     * to publish over text no reader will ever see.
     *
     * Filtered on the same predicate the renderer uses, so the gate's answer and
     * the PDF's contents cannot drift apart.
     */
    if (section.hidden === true) continue;
    const text = textOf(section.html);
    const blocking = BLOCKING_SECTIONS.has(section.key) || BLOCKING_HEADINGS.test(section.heading);

    const manual = PLACEHOLDER.exec(text);
    if (manual) {
      found.push({
        key: section.key,
        heading: section.heading,
        excerpt: excerptAround(text, manual.index),
        blocking,
      });
      // One finding per section: the excerpt sends the analyst to the section,
      // and listing every marker in it turns a review into a wall.
      continue;
    }

    COMPUTED.lastIndex = 0;
    let computed: RegExpExecArray | null;
    while ((computed = COMPUTED.exec(text)) !== null) {
      if (Object.hasOwn(figures, computed[1]!)) continue;
      /*
       * Resolved at render from the exhibit list and the signatures on file
       * rather than from the calculation, so `figures` will never carry them and
       * their presence in a body is correct rather than unfinished. The QA route
       * resolves both before calling this, so on that path they are already
       * gone; the callers that pass a *stored* body are the ones this protects,
       * and it is what stops a marker's exclusion depending on which caller
       * asked. See `RENDER_RESOLVED_MARKERS`.
       */
      if (RENDER_RESOLVED_MARKERS.has(computed[1]!)) continue;
      found.push({
        key: section.key,
        heading: section.heading,
        excerpt: excerptAround(text, computed.index),
        blocking,
      });
      break;
    }
  }
  return found;
}

export interface ReportReadiness {
  status: 'pass' | 'warn' | 'fail';
  placeholders: ReportPlaceholder[];
  detail: string;
}

/**
 * One QA-shaped verdict on whether the drafted body is finished.
 *
 * `null` content — no draft yet — is a pass rather than a failure: a valuation
 * with no report is not a report with holes in it, and the publish path has its
 * own reasons to refuse that case.
 */
export function reportReadiness(
  content: ReportContent | null,
  figures: ResolvableFigures = {},
): ReportReadiness {
  if (!content) {
    return { status: 'pass', placeholders: [], detail: 'No report drafted yet.' };
  }
  const placeholders = findReportPlaceholders(content, figures);
  if (placeholders.length === 0) {
    return { status: 'pass', placeholders, detail: 'No unfilled template placeholders remain.' };
  }
  const blocking = placeholders.filter((p) => p.blocking);
  const list = (rows: ReportPlaceholder[]) => rows.map((p) => p.heading).join(', ');
  if (blocking.length > 0) {
    return {
      status: 'fail',
      placeholders,
      detail:
        `${blocking.length} section${blocking.length > 1 ? 's' : ''} that state${blocking.length > 1 ? '' : 's'} the answer ` +
        `still hold${blocking.length > 1 ? '' : 's'} a template placeholder: ${list(blocking)}`,
    };
  }
  return {
    status: 'warn',
    placeholders,
    detail: `${placeholders.length} section${placeholders.length > 1 ? 's' : ''} still hold a template placeholder: ${list(placeholders)}`,
  };
}
