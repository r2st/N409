import type { ReportPdfSection } from '@n409/report/pdf';

/**
 * The HTML primitives every render-time exhibit is built from, in one place.
 *
 * reportExhibits.ts (the 409A schedules) and specialtyExhibits.ts (the
 * specialty-engine schedules) each grew their own byte-identical copy of these
 * four; navExhibits.ts would have been the third. They are shared here instead
 * because `esc` in particular is a correctness boundary, not a convenience —
 * an exhibit that escapes cell text in two of three modules is an exhibit that
 * can be broken by a company called `Series A & B <old>`.
 *
 * Deliberately not a general HTML builder: these fragments go to the PDF
 * renderer's own small tag subset, and anything richer belongs in the renderer.
 */

/**
 * Company names, class names and free text from the engagement reach these
 * table cells; `sanitizeHtml` is not in this path because these fragments are
 * built rather than saved. A class named `Series A & B <old>` has to read as
 * itself and must not be able to close a cell.
 */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface Table {
  head: string[];
  rows: string[][];
  /** Rendered bold, as a total or a conclusion line. */
  foot?: string[];
}

export function table({ head, rows, foot }: Table): string {
  const cells = (row: string[], tag: 'th' | 'td', bold = false) =>
    row.map((c) => `<${tag}>${bold ? `<strong>${c}</strong>` : c}</${tag}>`).join('');
  const body = rows.map((r) => `<tr>${cells(r, 'td')}</tr>`).join('');
  const footer = foot ? `<tr>${cells(foot, 'td', true)}</tr>` : '';
  return `<table><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${body}${footer}</tbody></table>`;
}

export const P = (text: string): string => `<p>${text}</p>`;

/**
 * An exhibit, or nothing. The degradation rule the whole exhibit layer shares:
 * a schedule with no content is dropped rather than printed as an empty table
 * under a heading that promises figures.
 */
export function section(heading: string, parts: Array<string | null>): ReportPdfSection | null {
  const html = parts.filter((p): p is string => p !== null && p !== '').join('');
  return html ? { heading, html } : null;
}
