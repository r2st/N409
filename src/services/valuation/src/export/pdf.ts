/**
 * Dependency-free tabular PDF writer (M4, CSV/PDF export). Produces a small
 * PDF 1.4 document: landscape A4 pages, Helvetica, a title line, a header
 * row, and fixed-width columns. Deliberately minimal — report-grade PDFs are
 * the report service's job (M2); this is for list exports.
 */

export interface PdfColumn {
  header: string;
  /** Column width in points. */
  width: number;
}

const PAGE_W = 842; // A4 landscape
const PAGE_H = 595;
const MARGIN = 40;
const FONT_SIZE = 8;
const HEADER_SIZE = 9;
const TITLE_SIZE = 14;
const ROW_H = 14;

/**
 * Anything the escape leaves behind is one Latin-1 byte, which is what makes
 * `.length` a byte count everywhere below. Nothing else in the file is
 * non-ASCII, so a code unit is a byte for the whole document.
 */
// eslint-disable-next-line no-control-regex
const ESCAPE_OR_WIDE = /[\\()]|[^\u0000-\u00FF]/gu;

function escapePdfText(s: string): string {
  // Helvetica/WinAnsi only — replace anything outside Latin-1 to keep the
  // content stream valid without embedding fonts, and escape the three
  // characters a PDF literal string reserves.
  //
  // One pass, replacing only what matches: this used to spread the string into
  // a per-code-point array, map, join, and then walk the result three more
  // times with `replaceAll`. It is called once per *cell* — 70,000 of them on a
  // 10,000-row export — and the overwhelming majority of cells contain none of
  // these characters, so the four passes were building garbage to discover
  // there was nothing to change. `u` keeps an astral character one match, so a
  // surrogate pair still collapses to a single '?' the way the spread did.
  return s.replace(ESCAPE_OR_WIDE, (ch) =>
    ch === '\\' ? '\\\\' : ch === '(' ? '\\(' : ch === ')' ? '\\)' : '?',
  );
}

/** Rough Helvetica width: ~0.5em average. Truncates with an ellipsis. */
function fit(text: string, widthPts: number, fontSize: number): string {
  const maxChars = Math.max(1, Math.floor(widthPts / (fontSize * 0.52)) - 1);
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…`.replace('…', '...') : text;
}

function pageContent(
  title: string,
  columns: PdfColumn[],
  rows: string[][],
  pageNo: number,
  pageCount: number,
): string {
  const ops: string[] = ['BT'];
  let y = PAGE_H - MARGIN;

  ops.push(`/F1 ${TITLE_SIZE} Tf 1 0 0 1 ${MARGIN} ${y} Tm (${escapePdfText(title)}) Tj`);
  y -= ROW_H * 2;

  let x = MARGIN;
  ops.push(`/F1 ${HEADER_SIZE} Tf`);
  for (const col of columns) {
    ops.push(`1 0 0 1 ${x} ${y} Tm (${escapePdfText(fit(col.header, col.width, HEADER_SIZE))}) Tj`);
    x += col.width;
  }
  y -= ROW_H;

  ops.push(`/F1 ${FONT_SIZE} Tf`);
  for (const row of rows) {
    x = MARGIN;
    for (let i = 0; i < columns.length; i++) {
      const cell = row[i] ?? '';
      if (cell !== '') {
        ops.push(`1 0 0 1 ${x} ${y} Tm (${escapePdfText(fit(cell, columns[i]!.width, FONT_SIZE))}) Tj`);
      }
      x += columns[i]!.width;
    }
    y -= ROW_H;
  }

  ops.push(
    `/F1 ${FONT_SIZE} Tf 1 0 0 1 ${MARGIN} ${MARGIN / 2} Tm (${escapePdfText(`Page ${pageNo} of ${pageCount}`)}) Tj`,
  );
  ops.push('ET');
  return ops.join('\n');
}

/** Renders a table as a multi-page PDF and returns the file bytes. */
export function tablePdf(title: string, columns: PdfColumn[], rows: string[][]): Buffer {
  const usable = PAGE_H - MARGIN * 2 - ROW_H * 3; // title + header + footer
  const rowsPerPage = Math.max(1, Math.floor(usable / ROW_H));
  const pages: string[][][] = [];
  for (let i = 0; i < Math.max(rows.length, 1); i += rowsPerPage) {
    pages.push(rows.slice(i, i + rowsPerPage));
  }

  // Object layout: 1 catalog, 2 pages, 3 font, then per page: page obj + stream obj.
  const objects: string[] = [];
  const pageObjIds = pages.map((_, i) => 4 + i * 2);
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  pages.forEach((pageRows, i) => {
    const streamId = 4 + i * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`,
    );
    const content = pageContent(title, columns, pageRows, i + 1, pages.length);
    // `.length`, not `Buffer.byteLength`: the stream is written as latin1. See below.
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  // The cross-reference table is a list of byte offsets into the file, so the
  // offsets have to be counted in the encoding the file is written in. They
  // were counted with `Buffer.byteLength`, which is UTF-8, over a document
  // emitted as `latin1` — so every character in U+0080..U+00FF was counted
  // twice and every offset after the first accented cell pointed past where it
  // meant to. `Société` in a company name is enough: the declared `/Length` of
  // that page's content stream overruns `endstream`, and `startxref` lands in
  // the middle of the `xref` keyword. Strict readers reject the file; forgiving
  // ones rebuild the table and open it, which is why this survived a test that
  // puts `Ünïcode` through the escape and reads the output back as latin1.
  //
  // Post-escape every character is a single Latin-1 byte (see `escapePdfText`)
  // and the rest of the file is ASCII, so `.length` is the byte count — and it
  // is O(1), which is the other half of this. `Buffer.byteLength(out)` inside
  // the loop re-encoded the whole document once per object: 611 objects on a
  // 10,000-row export, each flattening and scanning a rope that ends up 2.8 MB
  // long. Quadratic, on the event loop of the service every other request is
  // waiting on.
  const chunks: string[] = ['%PDF-1.4\n'];
  let length = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = `${i + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(chunk);
    length += chunk.length;
  });
  const xrefStart = length;
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) tail += `${String(off).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(tail);
  return Buffer.from(chunks.join(''), 'latin1');
}
