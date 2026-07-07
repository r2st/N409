import PDFDocument from 'pdfkit';

/**
 * Report PDF renderer (M2). Consumes the sanitized HTML subset produced by
 * the report editor (valuation service domain/report.ts whitelist) and lays
 * it out with pdfkit — pure JS, no headless browser, deterministic output.
 *
 * Exported as a library (`@n409/report/pdf`) for in-process rendering by the
 * valuation service, and served over HTTP via POST /render/v1/pdf.
 */

export interface ReportPdfSection {
  heading: string;
  html: string;
}

export interface ReportPdfInput {
  title: string;
  company_name: string;
  /** cover-page facts, e.g. Valuation date / Reference / Template / Version */
  meta: Array<{ label: string; value: string }>;
  sections: ReportPdfSection[];
  /** White-label branding (improvement 8): partner logo + accent on the cover. */
  branding?: {
    partner_name: string;
    /** #rrggbb accent for the cover rule; falls back to the neutral grey. */
    brand_color?: string | null;
    /** PNG or JPEG bytes; anything unrenderable is skipped silently. */
    logo?: Buffer | null;
  };
}

export interface RenderOptions {
  /** disable stream compression so tests can assert on embedded text */
  compress?: boolean;
}

// ── HTML subset → layout blocks ───────────────────────────────────────────────

export interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; runs: Run[] }
  | { type: 'paragraph'; runs: Run[]; quote?: boolean }
  | { type: 'list'; ordered: boolean; items: Run[][] }
  | { type: 'table'; rows: string[][]; headerRows: number };

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? m : String.fromCodePoint(code);
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? m : String.fromCodePoint(code);
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

interface Token {
  kind: 'tag' | 'text';
  value: string; // tag name (lowercase) or text
  closing?: boolean;
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const re = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let last = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m.index > last) tokens.push({ kind: 'text', value: html.slice(last, m.index) });
    tokens.push({ kind: 'tag', value: m[2]!.toLowerCase(), closing: m[1] === '/' });
    last = re.lastIndex;
  }
  if (last < html.length) tokens.push({ kind: 'text', value: html.slice(last) });
  return tokens;
}

/**
 * Parses the sanitized subset into render blocks. Defensive: unknown or
 * mis-nested tags never throw — text content always survives.
 */
export function htmlToBlocks(html: string): Block[] {
  const blocks: Block[] = [];
  let runs: Run[] = [];
  let paragraphOpen = false;
  let heading: 1 | 2 | 3 | null = null;
  let quote = false;
  let bold = 0;
  let italic = 0;
  let underline = 0;

  let list: { ordered: boolean; items: Run[][] } | null = null;
  let listItem: Run[] | null = null;

  let table: { rows: string[][]; headerRows: number; sawHeaderCell: boolean } | null = null;
  let tableRow: string[] | null = null;
  let tableCell: string | null = null;

  const flushParagraph = () => {
    const trimmed = trimRuns(runs);
    if (trimmed.length > 0) {
      if (heading) blocks.push({ type: 'heading', level: heading, runs: trimmed });
      else blocks.push({ type: 'paragraph', runs: trimmed, ...(quote ? { quote: true } : {}) });
    }
    runs = [];
    paragraphOpen = false;
    heading = null;
  };

  const pushRun = (text: string) => {
    if (text.length === 0) return;
    runs.push({ text, bold: bold > 0, italic: italic > 0, underline: underline > 0 });
  };

  for (const token of tokenize(html)) {
    if (token.kind === 'text') {
      const text = decodeEntities(token.value).replace(/\s+/g, ' ');
      if (text.trim().length === 0 && !paragraphOpen && !listItem && tableCell === null) continue;
      if (tableCell !== null) tableCell += text;
      else if (listItem) {
        if (text.length > 0) listItem.push({ text, bold: bold > 0, italic: italic > 0, underline: underline > 0 });
      } else pushRun(text);
      continue;
    }

    const tag = token.value;
    const closing = token.closing === true;

    switch (tag) {
      case 'p':
        if (closing) flushParagraph();
        else {
          flushParagraph();
          paragraphOpen = true;
        }
        break;
      case 'h1':
      case 'h2':
      case 'h3':
        if (closing) flushParagraph();
        else {
          flushParagraph();
          paragraphOpen = true;
          heading = Number(tag.slice(1)) as 1 | 2 | 3;
        }
        break;
      case 'blockquote':
        flushParagraph();
        quote = !closing;
        break;
      case 'br':
        if (tableCell !== null) tableCell += '\n';
        else if (listItem) listItem.push({ text: '\n', bold: false, italic: false, underline: false });
        else pushRun('\n');
        break;
      case 'strong':
      case 'b':
        bold = Math.max(0, bold + (closing ? -1 : 1));
        break;
      case 'em':
      case 'i':
        italic = Math.max(0, italic + (closing ? -1 : 1));
        break;
      case 'u':
        underline = Math.max(0, underline + (closing ? -1 : 1));
        break;
      case 'ul':
      case 'ol':
        if (closing) {
          if (listItem && list) list.items.push(trimRuns(listItem));
          listItem = null;
          if (list && list.items.length > 0) blocks.push({ type: 'list', ordered: list.ordered, items: list.items });
          list = null;
        } else {
          flushParagraph();
          list = { ordered: tag === 'ol', items: [] };
        }
        break;
      case 'li':
        if (!list) break;
        if (closing) {
          if (listItem) list.items.push(trimRuns(listItem));
          listItem = null;
        } else {
          if (listItem) list.items.push(trimRuns(listItem));
          listItem = [];
        }
        break;
      case 'table':
        if (closing) {
          if (tableRow && table && tableRow.some((c) => c.trim() !== '')) table.rows.push(tableRow);
          if (table && table.rows.length > 0) {
            blocks.push({ type: 'table', rows: table.rows, headerRows: table.headerRows });
          }
          table = null;
          tableRow = null;
          tableCell = null;
        } else {
          flushParagraph();
          table = { rows: [], headerRows: 0, sawHeaderCell: false };
        }
        break;
      case 'tr':
        if (!table) break;
        if (closing) {
          if (tableRow) {
            table.rows.push(tableRow);
            if (table.sawHeaderCell && table.headerRows === table.rows.length - 1) table.headerRows += 1;
          }
          tableRow = null;
        } else {
          tableRow = [];
          table.sawHeaderCell = false;
        }
        break;
      case 'th':
      case 'td':
        if (!tableRow) break;
        if (closing) {
          if (tableCell !== null) tableRow.push(tableCell.trim());
          tableCell = null;
        } else {
          tableCell = '';
          if (tag === 'th' && table) table.sawHeaderCell = true;
        }
        break;
      default:
        break; // thead/tbody and anything else: structural only
    }
  }
  flushParagraph();
  if (listItem && list) list.items.push(trimRuns(listItem));
  if (list && list.items.length > 0) blocks.push({ type: 'list', ordered: list.ordered, items: list.items });
  return blocks;
}

function trimRuns(runs: Run[]): Run[] {
  const result = runs.filter((r) => r.text.length > 0);
  if (result.length > 0) {
    result[0] = { ...result[0]!, text: result[0]!.text.replace(/^\s+/, '') };
    const last = result.length - 1;
    result[last] = { ...result[last]!, text: result[last]!.text.replace(/\s+$/, '') };
  }
  return result.filter((r) => r.text.length > 0);
}

// ── pdfkit layout ─────────────────────────────────────────────────────────────

const FONTS = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique',
  boldItalic: 'Helvetica-BoldOblique',
} as const;

function fontFor(run: Pick<Run, 'bold' | 'italic'>): string {
  if (run.bold && run.italic) return FONTS.boldItalic;
  if (run.bold) return FONTS.bold;
  if (run.italic) return FONTS.italic;
  return FONTS.regular;
}

export async function renderReportPdf(input: ReportPdfInput, opts: RenderOptions = {}): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 72, bottom: 72, left: 72, right: 72 },
    bufferPages: true,
    compress: opts.compress ?? true,
    info: { Title: input.title, Author: 'N409' },
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Cover
  const brandColor = /^#[0-9a-fA-F]{6}$/.test(input.branding?.brand_color ?? '')
    ? input.branding!.brand_color!
    : '#999999';
  if (input.branding?.logo) {
    try {
      // Centered partner logo above the title, capped to a 140×56pt box.
      doc.image(input.branding.logo, doc.page.width / 2 - 70, doc.y + 24, {
        fit: [140, 56],
        align: 'center',
        valign: 'center',
      });
      doc.y += 96;
    } catch {
      // Undecodable image bytes — render the cover without the logo.
      doc.moveDown(6);
    }
  } else {
    doc.moveDown(6);
  }
  doc.font(FONTS.bold).fontSize(24).fillColor('#111111').text(input.title, { align: 'center' });
  doc.moveDown(0.5);
  doc.font(FONTS.regular).fontSize(14).fillColor('#444444').text(input.company_name, { align: 'center' });
  if (input.branding) {
    doc.moveDown(0.4);
    doc
      .font(FONTS.italic)
      .fontSize(10.5)
      .fillColor('#666666')
      .text(`Prepared in partnership with ${input.branding.partner_name}`, { align: 'center' });
  }
  doc.moveDown(2);
  const ruleY = doc.y;
  doc
    .moveTo(doc.page.margins.left + usable / 4, ruleY)
    .lineTo(doc.page.margins.left + (3 * usable) / 4, ruleY)
    .lineWidth(input.branding ? 1.2 : 0.5)
    .strokeColor(brandColor)
    .stroke();
  doc.moveDown(2);
  for (const item of input.meta) {
    doc
      .font(FONTS.bold)
      .fontSize(10)
      .fillColor('#666666')
      .text(`${item.label}: `, { continued: true, align: 'center' })
      .font(FONTS.regular)
      .fillColor('#111111')
      .text(item.value, { align: 'center' });
    doc.moveDown(0.3);
  }

  // Sections
  input.sections.forEach((section, idx) => {
    if (idx === 0) doc.addPage();
    else doc.moveDown(1.5);
    ensureRoom(doc, 80);
    doc
      .font(FONTS.bold)
      .fontSize(16)
      .fillColor('#111111')
      .text(`${idx + 1}. ${section.heading}`);
    doc.moveDown(0.6);
    for (const block of htmlToBlocks(section.html)) {
      renderBlock(doc, block, usable);
    }
  });

  // Footer page numbers
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // allow writing inside the reserved margin
    doc
      .font(FONTS.regular)
      .fontSize(8)
      .fillColor('#888888')
      .text(`${input.company_name} — ${input.title} · Page ${i + 1} of ${range.count}`, doc.page.margins.left, doc.page.height - 46, {
        width: usable,
        align: 'center',
        lineBreak: false,
      });
    doc.page.margins.bottom = bottom;
  }

  doc.end();
  return done;
}

function ensureRoom(doc: PDFKit.PDFDocument, needed: number): void {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function renderRuns(doc: PDFKit.PDFDocument, runs: Run[], opts: { indent?: number; width: number }): void {
  const x = doc.page.margins.left + (opts.indent ?? 0);
  runs.forEach((run, idx) => {
    const last = idx === runs.length - 1;
    doc
      .font(fontFor(run))
      .fontSize(10.5)
      .fillColor('#222222')
      .text(run.text, x, doc.y, {
        width: opts.width - (opts.indent ?? 0),
        continued: !last,
        underline: run.underline,
        align: 'left',
        lineGap: 2,
      });
  });
}

function renderBlock(doc: PDFKit.PDFDocument, block: Block, usable: number): void {
  switch (block.type) {
    case 'heading': {
      ensureRoom(doc, 60);
      const size = block.level === 1 ? 14 : block.level === 2 ? 12.5 : 11.5;
      doc.moveDown(0.6);
      doc.font(FONTS.bold).fontSize(size).fillColor('#111111');
      doc.text(
        block.runs.map((r) => r.text).join(''),
        doc.page.margins.left,
        doc.y,
        { width: usable },
      );
      doc.moveDown(0.3);
      break;
    }
    case 'paragraph': {
      ensureRoom(doc, 40);
      renderRuns(doc, block.runs, { indent: block.quote ? 18 : 0, width: usable });
      doc.moveDown(0.7);
      break;
    }
    case 'list': {
      block.items.forEach((item, idx) => {
        ensureRoom(doc, 24);
        const marker = block.ordered ? `${idx + 1}. ` : '•  ';
        doc
          .font(FONTS.regular)
          .fontSize(10.5)
          .fillColor('#222222')
          .text(marker, doc.page.margins.left + 10, doc.y, { continued: true, width: usable - 10, lineGap: 2 });
        item.forEach((run, runIdx) => {
          const last = runIdx === item.length - 1;
          doc
            .font(fontFor(run))
            .text(run.text, { continued: !last, underline: run.underline, lineGap: 2 });
        });
        if (item.length === 0) doc.text('', { continued: false });
        doc.moveDown(0.2);
      });
      doc.moveDown(0.5);
      break;
    }
    case 'table': {
      const cols = Math.max(1, ...block.rows.map((r) => r.length));
      const colWidth = usable / cols;
      const padding = 4;
      block.rows.forEach((row, rowIdx) => {
        const isHeader = rowIdx < block.headerRows;
        const font = isHeader ? FONTS.bold : FONTS.regular;
        const heights = row.map((cell) =>
          doc
            .font(font)
            .fontSize(9.5)
            .heightOfString(cell || ' ', { width: colWidth - padding * 2 }),
        );
        const rowHeight = Math.max(14, ...heights) + padding * 2;
        ensureRoom(doc, rowHeight + 4);
        const y = doc.y;
        row.forEach((cell, c) => {
          doc
            .font(font)
            .fontSize(9.5)
            .fillColor('#222222')
            .text(cell, doc.page.margins.left + c * colWidth + padding, y + padding, {
              width: colWidth - padding * 2,
              lineGap: 1,
            });
        });
        doc
          .moveTo(doc.page.margins.left, y + rowHeight)
          .lineTo(doc.page.margins.left + usable, y + rowHeight)
          .lineWidth(isHeader ? 0.8 : 0.4)
          .strokeColor(isHeader ? '#555555' : '#cccccc')
          .stroke();
        doc.y = y + rowHeight + 2;
        doc.x = doc.page.margins.left;
      });
      doc.moveDown(0.7);
      break;
    }
  }
}
