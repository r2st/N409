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

function escapePdfText(s: string): string {
  // Helvetica/WinAnsi only — replace anything outside Latin-1 to keep the
  // content stream valid without embedding fonts.
  const latin = [...s].map((ch) => (ch.codePointAt(0)! > 255 ? '?' : ch)).join('');
  return latin.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

/** Rough Helvetica width: ~0.5em average. Truncates with an ellipsis. */
function fit(text: string, widthPts: number, fontSize: number): string {
  const maxChars = Math.max(1, Math.floor(widthPts / (fontSize * 0.52)) - 1);
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…`.replace('…', '...') : text;
}

function pageContent(title: string, columns: PdfColumn[], rows: string[][], pageNo: number, pageCount: number): string {
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
  objects.push(`<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  pages.forEach((pageRows, i) => {
    const streamId = 4 + i * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`,
    );
    const content = pageContent(title, columns, pageRows, i + 1, pages.length);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  });

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
