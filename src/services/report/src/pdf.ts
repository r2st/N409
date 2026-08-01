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
  /** Vector charts appended after this section's prose. */
  charts?: ChartSpec[];
}

/** One plotted value. `display` overrides the default number formatting. */
export interface ChartPoint {
  label: string;
  value: number;
  display?: string;
}

/**
 * Charts are vector-drawn by pdfkit — no image pipeline, no headless browser,
 * and the output stays deterministic and text-searchable.
 *
 * `bar` compares magnitudes across categories (equity value by approach).
 * `waterfall` explains how a starting value becomes an ending one through
 * signed steps — the shape a 409A conclusion actually has: marketable common
 * value per share, less the discount for lack of control, less the discount
 * for lack of marketability, equals fair market value.
 */
export type ChartSpec =
  | {
      type: 'bar';
      title: string;
      points: ChartPoint[];
      /** Caption under the plot, e.g. what the weights were. */
      note?: string;
    }
  | {
      type: 'waterfall';
      title: string;
      start: ChartPoint;
      /** Signed contributions applied in order. */
      steps: ChartPoint[];
      end_label: string;
      /** Ending value; defaults to start + Σsteps. Pass it when rounding in
       *  the engine means the two differ by a cent. */
      end_value?: number;
      end_display?: string;
      note?: string;
    };

/** A headline figure on the executive summary page. */
export interface SummaryFigure {
  label: string;
  value: string;
  /** Small print under the value — the basis, method, or a caveat. */
  note?: string;
}

/**
 * The page a board member reads. One headline number, the facts that qualify
 * it, and the conclusion-of-value statement — before the methodology sections
 * that support it.
 */
export interface ReportPdfSummary {
  headline: SummaryFigure;
  figures?: SummaryFigure[];
  /** Conclusion of value, as plain sentences (no markup). */
  statement?: string;
  charts?: ChartSpec[];
}

export interface ReportPdfInput {
  title: string;
  company_name: string;
  /** cover-page facts, e.g. Valuation date / Reference / Template / Version */
  meta: Array<{ label: string; value: string }>;
  sections: ReportPdfSection[];
  /** Executive summary page, rendered after the contents and before §1. */
  summary?: ReportPdfSummary;
  /** White-label branding (improvement 8): partner logo + accent on the cover. */
  branding?: {
    partner_name: string;
    /** #rrggbb accent for the cover rule; falls back to the neutral grey. */
    brand_color?: string | null;
    /** PNG or JPEG bytes; anything unrenderable is skipped silently. */
    logo?: Buffer | null;
  };
  /**
   * Contents page with real page numbers. Defaults on once a report is long
   * enough to need one (see TOC_MIN_SECTIONS); pass false to force it off.
   */
  include_toc?: boolean;
  /**
   * Footer confidentiality marker. Defaults to 'Confidential' — a 409A report
   * is a private company's most sensitive document and every page should say
   * so. Pass null to omit it.
   */
  confidentiality?: string | null;
}

/** Reports shorter than this render without a contents page. */
export const TOC_MIN_SECTIONS = 4;

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
      // Links (gap 9) render as underlined text — the href itself is not
      // reproduced; a printed report can't follow it anyway.
      case 'a':
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

// ── charts ────────────────────────────────────────────────────────────────────

/** Default formatting when a point carries no `display`. */
export function formatChartValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}bn`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}m`;
  if (abs >= 10_000) return `${Math.round(value / 1000)}k`;
  if (abs >= 1) return value.toFixed(2);
  return value.toFixed(4);
}

export interface WaterfallColumn {
  label: string;
  display: string;
  kind: 'total' | 'increase' | 'decrease';
  /** Bar spans [bottom, top] in value space; equal for a zero-height step. */
  bottom: number;
  top: number;
}

/**
 * Turns a start value and signed steps into floating bars.
 *
 * Totals (first and last) sit on the axis; each step floats between the
 * running value before and after it. Rendering only needs [bottom, top] per
 * column, so the geometry is decided here — in a pure function the tests can
 * pin without reading a PDF.
 */
export function waterfallColumns(
  start: ChartPoint,
  steps: readonly ChartPoint[],
  endLabel: string,
  endValue?: number,
  endDisplay?: string,
): WaterfallColumn[] {
  const columns: WaterfallColumn[] = [
    {
      label: start.label,
      display: start.display ?? formatChartValue(start.value),
      kind: 'total',
      bottom: 0,
      top: start.value,
    },
  ];
  let running = start.value;
  for (const step of steps) {
    const next = running + step.value;
    columns.push({
      label: step.label,
      display: step.display ?? formatChartValue(step.value),
      kind: step.value < 0 ? 'decrease' : 'increase',
      bottom: Math.min(running, next),
      top: Math.max(running, next),
    });
    running = next;
  }
  const total = endValue ?? running;
  columns.push({
    label: endLabel,
    display: endDisplay ?? formatChartValue(total),
    kind: 'total',
    bottom: 0,
    top: total,
  });
  return columns;
}

/** Vertical space a chart needs, so pagination can decide before drawing. */
export function chartHeight(spec: ChartSpec): number {
  const title = 20;
  const note = spec.note ? 16 : 0;
  if (spec.type === 'bar') return title + Math.max(1, spec.points.length) * 20 + 10 + note;
  return title + WATERFALL_PLOT_HEIGHT + 34 + note;
}

const WATERFALL_PLOT_HEIGHT = 150;
const CHART_INK = '#222222';
const CHART_MUTED = '#8a8a8a';
const CHART_GRID = '#dddddd';

/** Bars are the accent colour; reductions are muted so a discount reads as one. */
function chartColor(kind: WaterfallColumn['kind'], accent: string): string {
  if (kind === 'decrease') return CHART_MUTED;
  if (kind === 'total') return CHART_INK;
  return accent;
}

function renderChart(doc: PDFKit.PDFDocument, spec: ChartSpec, usable: number, accent: string): void {
  ensureRoom(doc, chartHeight(spec));
  const left = doc.page.margins.left;
  doc.font(FONTS.bold).fontSize(10.5).fillColor(CHART_INK).text(spec.title, left, doc.y, { width: usable });
  doc.moveDown(0.4);

  if (spec.type === 'bar') renderBarChart(doc, spec, usable, accent);
  else renderWaterfallChart(doc, spec, usable, accent);

  if (spec.note) {
    doc.font(FONTS.italic).fontSize(8.5).fillColor('#777777').text(spec.note, left, doc.y + 4, {
      width: usable,
    });
  }
  doc.x = left;
  doc.moveDown(1);
}

function renderBarChart(
  doc: PDFKit.PDFDocument,
  spec: Extract<ChartSpec, { type: 'bar' }>,
  usable: number,
  accent: string,
): void {
  const left = doc.page.margins.left;
  const labelWidth = Math.min(150, usable * 0.32);
  const valueWidth = 78;
  const trackWidth = Math.max(40, usable - labelWidth - valueWidth - 16);
  // Scale off the largest magnitude; an all-zero series draws labels only.
  const max = Math.max(0, ...spec.points.map((p) => Math.abs(p.value)));
  const rowHeight = 20;
  const barHeight = 11;

  spec.points.forEach((point) => {
    const y = doc.y;
    doc
      .font(FONTS.regular)
      .fontSize(9.5)
      .fillColor(CHART_INK)
      .text(point.label, left, y + 1, { width: labelWidth - 8, lineBreak: false, ellipsis: true });

    const barX = left + labelWidth;
    if (max > 0 && point.value !== 0) {
      const width = Math.max(1, (Math.abs(point.value) / max) * trackWidth);
      doc
        .rect(barX, y, width, barHeight)
        .fillColor(point.value < 0 ? CHART_MUTED : accent)
        .fill();
    }
    doc
      .font(FONTS.regular)
      .fontSize(9.5)
      .fillColor(CHART_INK)
      .text(point.display ?? formatChartValue(point.value), left + labelWidth + trackWidth + 8, y + 1, {
        width: valueWidth,
        align: 'right',
        lineBreak: false,
      });
    doc.y = y + rowHeight;
    doc.x = left;
  });
}

function renderWaterfallChart(
  doc: PDFKit.PDFDocument,
  spec: Extract<ChartSpec, { type: 'waterfall' }>,
  usable: number,
  accent: string,
): void {
  const left = doc.page.margins.left;
  const top = doc.y;
  const baseline = top + WATERFALL_PLOT_HEIGHT;
  const columns = waterfallColumns(
    spec.start,
    spec.steps,
    spec.end_label,
    spec.end_value,
    spec.end_display,
  );

  const ceiling = Math.max(0, ...columns.map((c) => c.top));
  const slotWidth = usable / columns.length;
  const barWidth = Math.min(66, slotWidth * 0.6);
  // Headroom for the value label printed above each bar.
  const scale = ceiling > 0 ? (WATERFALL_PLOT_HEIGHT - 16) / ceiling : 0;

  doc
    .moveTo(left, baseline)
    .lineTo(left + usable, baseline)
    .lineWidth(0.6)
    .strokeColor(CHART_GRID)
    .stroke();

  columns.forEach((column, i) => {
    const centre = left + slotWidth * (i + 0.5);
    const x = centre - barWidth / 2;
    const yTop = baseline - column.top * scale;
    const height = Math.max(1, (column.top - column.bottom) * scale);

    doc.rect(x, yTop, barWidth, height).fillColor(chartColor(column.kind, accent)).fill();

    // Connector from this bar's settled value into the next column.
    const next = columns[i + 1];
    if (next && next.kind !== 'total') {
      const connectorY = baseline - Math.max(column.top, column.bottom) * scale;
      doc
        .moveTo(x + barWidth, connectorY)
        .lineTo(centre + slotWidth - barWidth / 2, connectorY)
        .lineWidth(0.5)
        .strokeColor(CHART_GRID)
        .stroke();
    }

    doc
      .font(FONTS.bold)
      .fontSize(8)
      .fillColor(CHART_INK)
      .text(column.display, centre - slotWidth / 2, yTop - 11, {
        width: slotWidth,
        align: 'center',
        lineBreak: false,
      });
    doc
      .font(FONTS.regular)
      .fontSize(8)
      .fillColor('#555555')
      .text(column.label, centre - slotWidth / 2 + 2, baseline + 5, {
        width: slotWidth - 4,
        align: 'center',
        height: 24,
      });
  });

  doc.x = left;
  doc.y = baseline + 30;
}

// ── executive summary ─────────────────────────────────────────────────────────

export const SUMMARY_HEADING = 'Executive Summary';

function renderSummaryPage(
  doc: PDFKit.PDFDocument,
  summary: ReportPdfSummary,
  usable: number,
  accent: string,
): void {
  const left = doc.page.margins.left;
  doc.font(FONTS.bold).fontSize(16).fillColor('#111111').text(SUMMARY_HEADING, left, doc.y);
  doc.moveDown(0.8);

  // Headline: the one number the engagement exists to produce.
  const boxTop = doc.y;
  const boxHeight = summary.headline.note ? 78 : 66;
  doc.rect(left, boxTop, usable, boxHeight).fillColor('#f6f5f2').fill();
  doc.rect(left, boxTop, 4, boxHeight).fillColor(accent).fill();
  doc
    .font(FONTS.regular)
    .fontSize(9.5)
    .fillColor('#666666')
    .text(summary.headline.label.toUpperCase(), left + 18, boxTop + 12, { width: usable - 36 });
  doc
    .font(FONTS.bold)
    .fontSize(26)
    .fillColor('#111111')
    .text(summary.headline.value, left + 18, boxTop + 26, { width: usable - 36 });
  if (summary.headline.note) {
    doc
      .font(FONTS.italic)
      .fontSize(8.5)
      .fillColor('#777777')
      .text(summary.headline.note, left + 18, boxTop + 60, { width: usable - 36, lineBreak: false });
  }
  doc.x = left;
  doc.y = boxTop + boxHeight + 18;

  // Supporting figures, three to a row.
  const figures = summary.figures ?? [];
  if (figures.length > 0) {
    const perRow = 3;
    const columnWidth = usable / perRow;
    for (let i = 0; i < figures.length; i += perRow) {
      const row = figures.slice(i, i + perRow);
      const rowTop = doc.y;
      let rowHeight = 0;
      row.forEach((figure, c) => {
        const x = left + c * columnWidth;
        doc
          .font(FONTS.regular)
          .fontSize(8)
          .fillColor('#888888')
          .text(figure.label.toUpperCase(), x, rowTop, { width: columnWidth - 12 });
        doc
          .font(FONTS.bold)
          .fontSize(12)
          .fillColor('#111111')
          .text(figure.value, x, rowTop + 11, { width: columnWidth - 12 });
        let bottom = rowTop + 27;
        if (figure.note) {
          doc
            .font(FONTS.regular)
            .fontSize(8)
            .fillColor('#777777')
            .text(figure.note, x, bottom, { width: columnWidth - 12 });
          bottom = doc.y;
        }
        rowHeight = Math.max(rowHeight, bottom - rowTop);
      });
      doc.x = left;
      doc.y = rowTop + rowHeight + 14;
    }
  }

  if (summary.statement) {
    doc.moveDown(0.2);
    doc
      .font(FONTS.regular)
      .fontSize(10.5)
      .fillColor('#222222')
      .text(summary.statement, left, doc.y, { width: usable, lineGap: 2, align: 'left' });
    doc.moveDown(1);
  }

  for (const chart of summary.charts ?? []) renderChart(doc, chart, usable, accent);
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

  // Contents. The page is reserved here and filled in at the end, once the
  // section start pages are known — pdfkit cannot insert a page after the fact.
  const wantsToc = input.include_toc ?? input.sections.length >= TOC_MIN_SECTIONS;
  let tocPageIndex: number | null = null;
  if (wantsToc && input.sections.length > 0) {
    doc.addPage();
    tocPageIndex = currentPageIndex(doc);
  }

  // Executive summary — after the contents, before §1.
  let summaryPage: number | null = null;
  if (input.summary) {
    doc.addPage();
    summaryPage = currentPageIndex(doc);
    renderSummaryPage(doc, input.summary, usable, brandColor);
  }

  // Sections
  const sectionStartPages: number[] = [];
  input.sections.forEach((section, idx) => {
    if (idx === 0) doc.addPage();
    else doc.moveDown(1.5);
    ensureRoom(doc, 80);
    sectionStartPages.push(currentPageIndex(doc));
    doc
      .font(FONTS.bold)
      .fontSize(16)
      .fillColor('#111111')
      .text(`${idx + 1}. ${section.heading}`);
    doc.moveDown(0.6);
    for (const block of htmlToBlocks(section.html)) {
      renderBlock(doc, block, usable);
    }
    for (const chart of section.charts ?? []) {
      renderChart(doc, chart, usable, brandColor);
    }
  });

  const range = doc.bufferedPageRange();

  if (tocPageIndex !== null) {
    const entries: TocEntry[] = input.sections.map((section, idx) => ({
      heading: section.heading,
      number: `${idx + 1}.`,
      page: sectionStartPages[idx]! - range.start + 1,
    }));
    // The summary is unnumbered — it precedes §1 rather than being part of it.
    if (summaryPage !== null) {
      entries.unshift({
        heading: SUMMARY_HEADING,
        number: null,
        page: summaryPage - range.start + 1,
      });
    }
    doc.switchToPage(tocPageIndex);
    doc.x = doc.page.margins.left;
    doc.y = doc.page.margins.top;
    renderTableOfContents(doc, entries, usable);
  }

  // Footer: identity, confidentiality marker and page numbers on every page.
  const confidentiality =
    input.confidentiality === null ? null : (input.confidentiality ?? 'Confidential');
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // allow writing inside the reserved margin
    const parts = [`${input.company_name} — ${input.title}`];
    if (confidentiality) parts.push(confidentiality);
    parts.push(`Page ${i - range.start + 1} of ${range.count}`);
    doc
      .font(FONTS.regular)
      .fontSize(8)
      .fillColor('#888888')
      .text(parts.join(' · '), doc.page.margins.left, doc.page.height - 46, {
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

/** Zero-based index of the page currently being written. */
function currentPageIndex(doc: PDFKit.PDFDocument): number {
  const range = doc.bufferedPageRange();
  return range.start + range.count - 1;
}

export interface TocEntry {
  heading: string;
  /** 1-based page number as stamped in the footer. */
  page: number;
  /** Prefix such as "3."; null for an unnumbered entry (the summary). */
  number?: string | null;
}

/**
 * Contents page: numbered headings with a dot leader out to the page number.
 * The leader is sized from the measured text so it lands flush against the
 * number instead of wrapping.
 */
function renderTableOfContents(
  doc: PDFKit.PDFDocument,
  entries: readonly TocEntry[],
  usable: number,
): void {
  doc.font(FONTS.bold).fontSize(16).fillColor('#111111').text('Table of Contents');
  doc.moveDown(1);

  const left = doc.page.margins.left;
  const numberWidth = 34;
  entries.forEach((entry, idx) => {
    ensureRoom(doc, 22);
    const prefix = entry.number === undefined ? `${idx + 1}.` : entry.number;
    const label = prefix ? `${prefix} ${entry.heading}` : entry.heading;
    const page = String(entry.page);
    const y = doc.y;

    doc.font(FONTS.regular).fontSize(11).fillColor('#222222');
    const labelWidth = doc.widthOfString(label);
    doc.text(label, left, y, { width: usable - numberWidth, lineBreak: false });

    const leaderStart = left + labelWidth + 4;
    const leaderEnd = left + usable - numberWidth - 4;
    if (leaderEnd > leaderStart) {
      const dotWidth = doc.widthOfString('.');
      const dots = '.'.repeat(Math.max(0, Math.floor((leaderEnd - leaderStart) / dotWidth)));
      doc.fillColor('#bbbbbb').text(dots, leaderStart, y, { lineBreak: false });
    }

    doc
      .fillColor('#222222')
      .text(page, left + usable - numberWidth, y, { width: numberWidth, align: 'right', lineBreak: false });
    doc.y = y + 18;
    doc.x = left;
  });
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
