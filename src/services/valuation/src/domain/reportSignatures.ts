import { SIGNATURE_MARKER, type ReportContent } from './report.js';
import { esc, P } from './exhibitHtml.js';

/**
 * The appraiser's signature, on the page.
 *
 * ## What was wrong
 *
 * The platform collects the signature and gates the deliverable on it. A
 * `valuation_signatures` row holds the signer's name, their title, the text
 * they typed to sign and the instant they did it; `domain/publishGate.ts`
 * refuses to publish an engagement with no `main` row — "A main signature is
 * required before publishing". Every 409A this platform has issued was signed.
 *
 * None of it reached the PDF. `summaryFor` loads eleven tables to build the
 * schedules and this was not one of them, so the certification chapter went out
 * reading "We certify that, to the best of our knowledge and belief: …" over
 * five bullets and then stopped — with a bullet referring to "the persons
 * signing this report" and no indication anywhere in the file of who they were.
 *
 * That is the one omission on the list of report deficiencies that is not a
 * matter of degree. An unsigned valuation is not a weaker valuation; USPAP
 * Standards Rule 10-3 requires a signed certification, and a report without one
 * is an analysis rather than an appraisal report. An auditor holding the file
 * cannot tell that the signature exists in a database they will never see, and
 * the safe harbour of Treasury Regulation §1.409A-1(b)(5)(iv)(B)(1) turns on the
 * valuation having been made by a qualified independent appraiser — a person
 * the document has to name.
 *
 * ## Resolved at render, like everything else computed
 *
 * The body is authored once and stored; the signature lands later, after QA
 * closes, and may be replaced (`upsertSignature` is insert-or-replace, so
 * re-signing after a change supersedes the previous row). A signature written
 * into the stored body at draft time would be a signature that could not be
 * corrected without editing prose.
 *
 * So this follows `reportFigures` and `reportExhibitIndex` exactly: the stored
 * body keeps `{{signatures}}`, the marker resolves against the rows on the way
 * to the PDF writer, and nothing is ever written back. A re-render after a
 * second reviewer signs picks that up with no edit to the chapter.
 *
 * ## The unsigned case prints too
 *
 * A draft renders with the signature lines present and unfilled rather than
 * with the block omitted. Omitting it would make an unsigned draft and a signed
 * final differ by the *absence* of a page element, which is the hardest kind of
 * difference for a reader to notice; leaving the ruled lines empty is how a
 * paper report says the same thing, and it agrees with the `Draft` watermark
 * the same render already carries.
 */

/**
 * Re-exported so a caller resolving the block imports the marker from the
 * module that resolves it, rather than having to know it is declared beside the
 * skeletons that write it.
 */
export { SIGNATURE_MARKER };

/** One signatory, as `valuation_signatures` holds them. */
export interface ReportSignatory {
  role: 'main' | 'second';
  signer_name: string;
  signer_title: string | null;
  signature_text: string;
  signed_at: Date;
}

/** The section that holds the certification, in every skeleton. */
const CERTIFICATION_SECTION_KEY = 'certification';

/**
 * What each role is called in the deliverable.
 *
 * The database and the ops UI call them `main` and `second`, which describe the
 * gate rather than the people — a reader of the report has no reason to know
 * which of two signatures the publish check looked for. `second` is a firm
 * quality-control review rather than a second opinion, and saying so is what
 * stops an auditor reading two signatures as two independent appraisals.
 */
const ROLE_LABELS: Record<ReportSignatory['role'], string> = {
  main: 'Valuation analyst',
  second: 'Concurring reviewer',
};

/** `main` first, whatever order the rows arrived in. */
const ROLE_ORDER: readonly ReportSignatory['role'][] = ['main', 'second'];

/**
 * The UTC day of a `timestamptz`.
 *
 * Deliberately not `calendarDate`, which exists for `date` columns and would be
 * wrong here — see its own note on the distinction. `signed_at` is a real
 * instant, and its UTC day is the reading already chosen for `published_at`,
 * `issued_at` and the cover's `Rendered` stamp, so the certification agrees with
 * the cover of the document it closes.
 */
function signedOn(at: Date): string {
  return Number.isNaN(at.getTime()) ? '—' : at.toISOString().slice(0, 10);
}

/**
 * The block, in the four columns a signature page carries.
 *
 * `signature_text` is what the signer typed, reproduced verbatim in the
 * conventional `/s/` form so that the document shows the act rather than
 * merely reporting that it happened. It is escaped like everything else here:
 * the value arrives from a request body, and the certification page is the last
 * place in the product that should be trusting one.
 */
function signatureTable(signatories: readonly ReportSignatory[]): string {
  const rows = signatories.map(
    (s) =>
      '<tr>' +
      `<td>${esc(ROLE_LABELS[s.role])}</td>` +
      `<td>/s/ ${esc(s.signature_text)}</td>` +
      `<td>${esc(s.signer_name)}${s.signer_title ? `, ${esc(s.signer_title)}` : ''}</td>` +
      `<td>${esc(signedOn(s.signed_at))}</td>` +
      '</tr>',
  );
  return (
    '<table><thead><tr><th>Capacity</th><th>Signature</th><th>Name and title</th><th>Date signed</th></tr></thead><tbody>' +
    rows.join('') +
    '</tbody></table>'
  );
}

/** The same table with the analyst's line ruled and empty. */
function unsignedTable(): string {
  return (
    '<table><thead><tr><th>Capacity</th><th>Signature</th><th>Name and title</th><th>Date signed</th></tr></thead><tbody>' +
    `<tr><td>${ROLE_LABELS.main}</td><td>—</td><td>—</td><td>—</td></tr>` +
    '</tbody></table>'
  );
}

function blockHtml(signatories: readonly ReportSignatory[]): string {
  if (signatories.length === 0) {
    return (
      unsignedTable() +
      P(
        'This report is <strong>not yet signed</strong>. It is a draft and may not be relied upon; the ' +
          'certification above takes effect only when signed by the valuation analyst responsible for it.',
      )
    );
  }
  const ordered = [...signatories].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  return signatureTable(ordered);
}

/**
 * Put the signature block into the certification chapter.
 *
 * Three cases, mirroring `withExhibitIndex`, and for the same reason — no
 * stored body may have to be re-drafted to gain this:
 *   1. the marker is present, and the block goes where the skeleton asked;
 *   2. no marker — a body drafted from a skeleton older than this module, or
 *      one an analyst rewrote entirely. The block is appended, so every report
 *      already in flight gains a signature page at its next render.
 *
 * There is deliberately no third "replace what is there" case. The index chapter
 * has one because its stale content is a list this module can recognise and
 * supersede; a certification chapter's prose is the analyst's, and a signature
 * block that overwrote it would be a render silently deleting authored text.
 */
function withSignatureBlock(html: string, signatories: readonly ReportSignatory[]): string {
  const block = blockHtml(signatories);
  if (html.includes(SIGNATURE_MARKER)) return html.split(SIGNATURE_MARKER).join(block);
  return html + block;
}

/**
 * Resolve `{{signatures}}` against the rows on file.
 *
 * Never written back — the caller passes the stored content and renders the
 * result, exactly as `fillFigures` and `resolveExhibitReferences` are applied.
 *
 * A hidden certification chapter is left alone. It is not in the deliverable,
 * so there is nothing for a signature to close, and building the block anyway
 * would put the signer's name into a section the reader never sees.
 */
export function resolveSignatures(
  content: ReportContent,
  signatories: readonly ReportSignatory[],
): ReportContent {
  return {
    title: content.title,
    sections: content.sections.map((s) => {
      if (s.key !== CERTIFICATION_SECTION_KEY || s.hidden === true) return s;
      const html = withSignatureBlock(s.html, signatories);
      return html === s.html ? s : { ...s, html };
    }),
  };
}
