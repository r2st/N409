import { fileURLToPath } from 'node:url';
import * as fontkit from 'fontkit';
import PDFDocument from 'pdfkit';
import { MAX_IMAGE_PIXELS, declaredImageSize } from '@n409/shared';

/**
 * Report PDF renderer (M2). Consumes the sanitized HTML subset produced by
 * the report editor (valuation service domain/report.ts whitelist) and lays
 * it out with pdfkit — pure JS, no headless browser, deterministic output.
 *
 * Served over HTTP via POST /render/v1/pdf, which is how the valuation service
 * renders since R98, and still exported as a library (`@n409/report/pdf`) —
 * which is that caller's fallback when the hop fails.
 */

export interface ReportPdfSection {
  heading: string;
  html: string;
  /** Vector charts appended after this section's prose. */
  charts?: ChartSpec[];
  /**
   * Conditional-pointer ids this section answers *beyond* the one in its
   * heading. Ignored by the renderer — it is read by the valuation service's
   * `resolveExhibitReferences`, which keeps or drops each `{{#exhibit:X}}`
   * pointer in the authored body according to what actually printed.
   *
   * An exhibit built from independently-conditional blocks needs it: Exhibit
   * H-1 prints a DLOM derivation, a class-volatility schedule, or both, and a
   * body pointer that could only see the heading sent the reader to a schedule
   * the exhibit did not contain.
   */
  schedules?: readonly string[];
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
 * Four shapes, one per question a reader actually asks:
 *
 * `bar` compares magnitudes across categories (equity value by approach).
 * `waterfall` explains how a starting value becomes an ending one through
 * signed steps — the shape a 409A conclusion actually has: marketable common
 * value per share, less the discount for lack of control, less the discount
 * for lack of marketability, equals fair market value.
 * `donut` shows composition, where the whole is the point and the parts are
 * shares of it — approach weighting is a weighting, and a reader should see
 * that the pieces sum to one rather than have to add four bars up.
 * `line` shows a value moving over time. A 409A is not read in isolation; the
 * board's first question about a new number is how it compares with the last
 * one, and a trend answers that in the space a sentence would take.
 */
/**
 * How many marks a series of each shape may carry.
 *
 * These are *legibility* limits, not storage limits, which is why they live
 * beside the drawing code rather than beside the wire schema that enforces
 * them. Each one is the point past which the renderer below stops producing a
 * chart and starts producing a smear: a bar chart draws one labelled row per
 * point down the page, a donut separates its slices on lightness alone from a
 * five-step grey ramp, a waterfall gives every step a column and a connector,
 * and a line chart plots a marker every `plotWidth / n` points across about
 * 450pt of usable width — at 40 that is 11pt between markers of radius 2.6.
 *
 * They are exported because three files have to agree on them and only one of
 * them can see why the numbers are what they are. `RenderBody` (app.ts) turns
 * them into the wire contract, and the valuation service's chart builders have
 * to respect the same numbers when they assemble a series — a producer that
 * does not is not caught by anything at build time and shows up as a 422 that
 * falls back to in-process rendering, which is a silent performance regression
 * rather than a visible failure. Before this existed the caps were four literals
 * in one Zod schema and `historyChart` had grown past one of them.
 */
export const CHART_SERIES_LIMITS = {
  bar: 20,
  waterfall: 10,
  donut: 12,
  line: 40,
} as const;

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
    }
  | {
      type: 'donut';
      title: string;
      /** Magnitudes; normalised to the total, so weights or raw values both work. */
      slices: ChartPoint[];
      /** Two short lines in the hole — typically the total and what it is. */
      center?: string;
      center_note?: string;
      note?: string;
    }
  | {
      type: 'line';
      title: string;
      /** Chronological. `label` is the period (a date), `value` the metric. */
      points: ChartPoint[];
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
  /**
   * Timestamp recorded as the document's CreationDate. Pass the report's own
   * generation time so the PDF's metadata agrees with the audit trail; pdfkit
   * otherwise stamps whenever the bytes happened to be produced, which for a
   * re-download is months after the valuation was signed.
   */
  generated_at?: Date;
  /** Document keywords. Defaults to the company, the title and 'valuation'. */
  keywords?: string[];
  /**
   * Draft marker. When set, every page carries a diagonal stamp of this word and
   * the cover carries a notice naming it.
   *
   * A report is readable by the client from `drafted` onward — before the QA
   * review closes, before the signature, before publication — and the bytes
   * that reader downloads were until now indistinguishable from the signed
   * deliverable. Those bytes do not stay with the person who downloaded them:
   * a 409A report is forwarded to an auditor, attached to a board pack and
   * filed in a data room, and each of those readers takes an unmarked document
   * as final. Marking the draft is the ordinary practice of the profession for
   * exactly that reason, and the cost of not doing it lands on whoever relied
   * on a number that later moved.
   *
   * Null or absent renders the deliverable unmarked, which is what publication
   * produces.
   */
  watermark?: string | null;
}

/** Reports shorter than this render without a contents page. */
export const TOC_MIN_SECTIONS = 4;

export interface RenderOptions {
  /** disable stream compression so tests can assert on embedded text */
  compress?: boolean;
}

/** Somewhere to say why a render came out missing something. */
export interface RenderIssueLog {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

let issueLog: RenderIssueLog | null = null;

/**
 * Install the logger this module reports a degraded render through.
 *
 * A module-level sink rather than a field on {@link RenderOptions}, for two
 * reasons. This file is a library with two hosts — the report service renders
 * through it over HTTP and the valuation service imports it directly as its
 * fallback — and threading a logger down through the twenty frames between a
 * route and a cover would touch every one of them. And `RenderOptions` is not
 * free: the valuation service's client treats *any* option as a reason to skip
 * the offload entirely (`render_options` in clients/reportRender.ts), so a
 * logger passed that way would silently move every render back in-process.
 *
 * Null until a host installs one, which is what a test gets.
 */
export function configureReportPdfLogging(log: RenderIssueLog | null): void {
  issueLog = log;
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

/**
 * The five predefined entities plus `&nbsp;`.
 *
 * Null-prototyped, and read through `Object.hasOwn` below, because the lookup
 * key is text out of a report narrative. `&constructor;` matches the
 * named-entity branch of the regex — it is letters and nothing else — and a
 * plain object literal answers that lookup from `Object.prototype` with a
 * function, which is not nullish, so the `?? m` fallback that exists for
 * `&unknown;` never ran and the deliverable printed
 * `function Object() { [native code] }` in the middle of a sentence.
 */
const ENTITIES: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
});

/** The highest code point Unicode defines — `String.fromCodePoint` throws past it. */
const MAX_CODE_POINT = 0x10ffff;

/**
 * A numeric character reference as a character, or `null` when it does not name
 * one.
 *
 * `String.fromCodePoint` throws RangeError for anything above U+10FFFF, and the
 * decoder's only guard was `Number.isNaN` — which a well-formed number like
 * `&#99999999;` passes. The throw escaped `decodeEntities`, then `htmlToBlocks`,
 * then `renderReportPdf`, so eight digits anywhere in any section of a report
 * returned a 500 instead of a PDF. The text reaching here is a report narrative:
 * partly LLM-written, partly copied out of a client's own documents, and neither
 * source is one that never emits a stray high number.
 *
 * An unresolvable reference is left as the literal text it was, which is what
 * the named-entity branch below already does for `&unknown;`.
 */
function codePointChar(digits: string, radix: number): string | null {
  const code = Number.parseInt(digits, radix);
  if (!Number.isFinite(code) || code < 0 || code > MAX_CODE_POINT) return null;
  return String.fromCodePoint(code);
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return codePointChar(body.slice(2), 16) ?? m;
    }
    if (body.startsWith('#')) {
      return codePointChar(body.slice(1), 10) ?? m;
    }
    const name = body.toLowerCase();
    return Object.hasOwn(ENTITIES, name) ? ENTITIES[name]! : m;
  });
}

interface Token {
  kind: 'tag' | 'text';
  value: string; // tag name (lowercase) or text
  closing?: boolean;
}

/**
 * Splits the sanitized subset into tags and text.
 *
 * Scans for the brackets explicitly rather than letting one regex do it. The
 * regex form — `/<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g` — is quadratic on
 * input with no `>` in it: at every `<` the `[^>]*` runs to the end of the
 * document looking for a closing bracket, fails, backtracks the whole way, and
 * the engine advances one character and does it again. Measured on `"<p"`
 * repeated: 7.5k copies took 49ms, 15k took 192ms, 30k 760ms and 60k 3.1s —
 * a clean 4× per doubling, inside the 200,000-character section limit the
 * schema already allows, on a service whose only job is rendering.
 *
 * Two things make the scan below linear:
 *
 *  - `gt` only ever moves forward. A `>` that is not there for this `<` is not
 *    there for any `<` after it either, so the search resumes past the last one
 *    found instead of restarting per candidate. This is the same argument
 *    `domain/report.ts` makes for its comment and raw-text strippers.
 *  - the tag pattern is sticky (`/y`) and anchored at the `<`, so it matches the
 *    name in place rather than slicing the document out to test it. Its own
 *    backtracking is bounded by the tag name.
 *
 * The tokens produced are identical to the regex's for every input; only the
 * cost of arriving at them changes.
 */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  // No `[^>]*>` tail: the attributes are skipped by the `gt` cursor instead.
  // A successful match cannot cross the `>`, since neither whitespace nor a
  // tag-name character is `>`.
  const tag = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b/y;
  const tokenText = (from: number, to: number) => {
    if (to > from) tokens.push({ kind: 'text', value: html.slice(from, to) });
  };
  let last = 0;
  let at = 0;
  let gt = -1;
  for (;;) {
    const lt = html.indexOf('<', at);
    if (lt === -1) break;
    if (gt < lt) gt = html.indexOf('>', lt + 1);
    if (gt === -1) break; // no `>` remains, for this `<` or any after it
    tag.lastIndex = lt;
    const m = tag.exec(html);
    if (m === null) {
      at = lt + 1; // a `<` that starts no tag is text; keep looking
      continue;
    }
    tokenText(last, lt);
    tokens.push({ kind: 'tag', value: m[2]!.toLowerCase(), closing: m[1] === '/' });
    last = at = gt + 1;
  }
  tokenText(last, html.length);
  return tokens;
}

/**
 * The longest run of non-whitespace handed to the line wrapper in one piece.
 *
 * pdfkit breaks a word that is wider than the line by fitting characters: it
 * measures a prefix, adjusts by one character, and measures again, and each of
 * those measurements walks the string. For one token that is O(n²) — rendering
 * a single 64,000-character "word" took 5.5s against 23ms for the same bytes
 * as ordinary words, and at the schema's 200,000-character section limit it is
 * 52 seconds of one pinned CPU. Since R98 that is the report service's loop
 * rather than the API's, which lowers the blast radius and does not change the
 * argument: the renders serialize on one thread there too, so a single
 * pathological document stalls every queued report behind it — and the caller's
 * 30s budget then expires, sending the work back to the API to be done there.
 *
 * Chunking is what removes the exponent, and the chunk size barely matters to
 * that: bounded at K, the fitting loop costs O(K²) per chunk over n/K chunks —
 * O(K·n), linear in the input, for any fixed K. So K is chosen for the other
 * constraint instead, which is that nothing real should ever reach it. 128 is
 * several times the longest word in any natural language and an order of
 * magnitude past the longest ticker, ULID or account reference this platform
 * puts in a report.
 */
const MAX_UNBROKEN_RUN = 128;
const SOFT_HYPHEN = '­';

/**
 * Inserts break opportunities into absurdly long unbroken runs.
 *
 * U+00AD rather than a space or a zero-width space: a soft hyphen is a break
 * opportunity that renders *nothing* unless the line actually breaks there, in
 * which case pdfkit draws the hyphen (it special-cases the character in
 * `canFit`). So a run short enough to fit is unchanged on the page, and one
 * that has to be broken is broken the way a typesetter would. The embedded face
 * carries a glyph for it, which is what makes the drawn form a hyphen.
 *
 * Whitespace-separated text — which is all real prose — comes back untouched.
 *
 * Chunked by character rather than by UTF-16 unit, which it was not. `slice`
 * counts units, so a run of astral characters — an emoji, a rarer Han ideograph,
 * anything from a supplementary plane — was cut through the middle of a
 * surrogate pair whenever the boundary fell between its halves, and a soft
 * hyphen was inserted into the character. `ellipsize` states the rule this
 * violated a hundred lines below: a lone half of a surrogate pair in the
 * content stream is a worse failure than the overflow being repaired, because
 * it is not text any more — `fontSafe` cannot decide coverage for half a
 * codepoint, so it replaces both halves with `?`, and one character the face
 * *does* draw becomes two question marks in a signed deliverable.
 *
 * Combining marks are kept with the character they modify for the same reason,
 * with the slack below bounding how far past the limit that is allowed to push
 * a chunk. Without a bound, a run that is nothing but marks would be one
 * unbroken chunk again and the quadratic fitting cost this function exists to
 * remove would come back with it; with it, a chunk is at most
 * `limit + MAX_CLUSTER_SLACK` and the cost stays linear.
 */
const MAX_CLUSTER_SLACK = 16;
const COMBINING_MARK = /\p{M}/u;

export function breakLongRuns(text: string, limit: number = MAX_UNBROKEN_RUN): string {
  // The common case is one pass over the string finding nothing to do.
  if (text.length <= limit) return text;
  return text.replace(/\S+/g, (run) => {
    if (run.length <= limit) return run;
    const parts: string[] = [];
    let chunk = '';
    for (const ch of run) {
      const full = chunk.length + ch.length > limit;
      // A mark with nothing to attach to is an ordinary character.
      const attaches = chunk !== '' && chunk.length < limit + MAX_CLUSTER_SLACK && COMBINING_MARK.test(ch);
      if (full && !attaches) {
        parts.push(chunk);
        chunk = '';
      }
      chunk += ch;
    }
    if (chunk !== '') parts.push(chunk);
    return parts.join(SOFT_HYPHEN);
  });
}

// ── typeface ──────────────────────────────────────────────────────────────────

/**
 * The document's typeface, embedded in the file rather than named in it.
 *
 * This renderer used pdfkit's standard-14 Helvetica, which is not really a font
 * — it is a name and a set of metrics, and the glyphs come from whatever the
 * viewer has. Its encoding is WinAnsi (CP1252): Latin-1 and a little
 * punctuation. Everything outside that had to be transliterated or replaced
 * with `?`, and two of those losses were on pages that decide money. `₹1,20,00,000`
 * set as `?1,20,00,000` on every report written for an Indian subsidiary, and a
 * company legally named 中国科技 appeared in the title of its own valuation as
 * `????`.
 *
 * DejaVu Sans covers Latin (including Extended-A and -B), Greek, Cyrillic,
 * Hebrew, Arabic, the currency block — ₹ ₩ ₪ ₫ ₽ ₺ ₴ ฿ — and the mathematical
 * operators this domain writes its models with. It does not cover CJK; see
 * `FALLBACK_GLYPHS` for what happens to a character no face can draw. It is
 * licensed under the Bitstream Vera and Arev licenses, both of which permit
 * redistribution, and the text of both ships beside the files in
 * `assets/fonts/LICENSE`.
 *
 * Embedding also removes the last thing standing between this document and
 * PDF/UA-1 — see the structure-tree section, which says why we would not claim
 * conformance while the faces were the standard 14.
 *
 * pdfkit subsets what it embeds, so a report that sets only Latin carries only
 * the Latin glyphs and the file does not grow.
 */
const FACES = {
  regular: { name: 'N409Sans', file: 'DejaVuSans.ttf' },
  bold: { name: 'N409Sans-Bold', file: 'DejaVuSans-Bold.ttf' },
  italic: { name: 'N409Sans-Italic', file: 'DejaVuSans-Oblique.ttf' },
  boldItalic: { name: 'N409Sans-BoldItalic', file: 'DejaVuSans-BoldOblique.ttf' },
} as const;

/** Which of the four faces a run is set in. */
export type FaceName = keyof typeof FACES;

const FONTS = {
  regular: FACES.regular.name,
  bold: FACES.bold.name,
  italic: FACES.italic.name,
  boldItalic: FACES.boldItalic.name,
} as const;

/**
 * Resolved against this module rather than the process's working directory.
 *
 * `src/` and `dist/` are siblings, so `../assets/fonts/` names the same
 * directory whether this is running from TypeScript under vitest or from the
 * compiled output under systemd. The Dockerfile copies `assets/` for the same
 * reason.
 */
const FONT_DIR = new URL('../assets/fonts/', import.meta.url);

const fontFile = (face: FaceName): string => fileURLToPath(new URL(FACES[face].file, FONT_DIR));

/**
 * Opened once per face, on first use, and kept.
 *
 * Two readers. This module asks one question of it — *can this face draw this
 * character* — before the text reaches pdfkit, because pdfkit's own answer to
 * a character it has no glyph for is to draw a blank box and say nothing.
 *
 * And pdfkit itself, since R358. `registerFont` takes a path, a buffer or an
 * already-open font, and it was being handed the path: pdfkit then did its own
 * `readFileSync` and its own fontkit parse, **four faces per document**, for
 * fonts this process had already read and parsed and was holding. Four
 * synchronous file reads on the event loop of a service whose whole job is
 * rendering, and the parse showed up in a profile of the sample report as the
 * `Struct`/`LazyArray` table decoding underneath every render.
 *
 * Sharing one open face across documents is what pdfkit's own signature
 * invites: `EmbeddedFont` reads metrics off the font and takes a *subset* of
 * its own (`font.createSubset()`), and its layout cache hangs off the embedded
 * instance rather than the face. Nothing it does writes to the shared object.
 */
const openFaces = new Map<FaceName, fontkit.Font>();

function faceMetrics(face: FaceName): fontkit.Font {
  const open = openFaces.get(face);
  if (open) return open;
  const font = fontkit.openSync(fontFile(face)) as fontkit.Font;
  openFaces.set(face, font);
  return font;
}

/** Whether `face` has a glyph for this codepoint. */
export function faceCovers(face: FaceName, code: number): boolean {
  return faceMetrics(face).hasGlyphForCodePoint(code);
}

/**
 * Opens all four faces, throwing if any of them cannot be read.
 *
 * Exists to be a readiness check. Every other dependency of a render is code in
 * this process; the fonts are four files on disk, resolved relative to this
 * module, and they are the one part of a render that a deploy can get wrong —
 * `assets/` is a sibling of `dist/` rather than something the build emits, so
 * an archive, image or volume mount that omits it leaves a service that starts
 * cleanly, answers /health, and then fails every render.
 *
 * Nothing notices that today: `openFaces` is lazy, so the first evidence is a
 * 500 on a report somebody asked for. Calling this at probe time moves the
 * discovery to /ready, where the deploy is still watching. It is cheap to
 * repeat — after the first call every face is memoised — and it deliberately
 * does not name the path in the error, since that string ends up in a readiness
 * body.
 */
export function verifyFontAssets(): void {
  for (const face of Object.keys(FACES) as FaceName[]) {
    try {
      faceMetrics(face);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`report font "${FACES[face].file}" is unreadable: ${reason}`);
    }
  }
}

/**
 * The face a registered font name belongs to, or null if we did not register it.
 *
 * Built once rather than scanned per call. This is asked on *every* `doc.font()`
 * — pdfkit reselects the face for each cell of a table and each run of a
 * paragraph — and the linear `Object.entries` scan it used to do allocated four
 * entry pairs each time, which measured at 1.7% of a large render.
 */
const FACE_BY_FONT_NAME: ReadonlyMap<string, FaceName> = new Map(
  Object.entries(FACES).map(([key, entry]) => [entry.name, key as FaceName]),
);

function faceNamed(name: string): FaceName | null {
  return FACE_BY_FONT_NAME.get(name) ?? null;
}

/**
 * Registers the four faces on a document and selects the body face.
 *
 * pdfkit picks Helvetica in its constructor, before any of this runs; without
 * the explicit selection a run drawn before the first `.font()` call would be
 * set in a standard-14 face and quietly reintroduce the encoding this change
 * exists to remove.
 */
function useEmbeddedFonts(doc: PDFKit.PDFDocument): void {
  // The open face, not its path — see `openFaces`. pdfkit re-read and re-parsed
  // all four files for every document it was handed a path for.
  for (const [key, entry] of Object.entries(FACES)) {
    doc.registerFont(entry.name, faceMetrics(key as FaceName) as unknown as string);
  }
  doc.font(FONTS.regular);
}

/**
 * What to draw for a character the face has no glyph for.
 *
 * The embedded faces draw every entry in this table, so nothing here fires
 * today. It is kept because the reasoning behind it outlives the font: the
 * mapping is transliteration, not deletion, so meaning survives a missing
 * glyph. `σ` becomes `sigma` rather than `s` because a bare `s` beside a
 * percentage reads as a typo rather than as a symbol.
 *
 * A character that is neither drawable nor in this table becomes `?` — which is
 * what a CJK company name still does, DejaVu having no Han glyphs. That is a
 * font to add, not a rule to change: the report will set 中国科技 the day a face
 * that covers it is registered here.
 */
const FALLBACK_GLYPHS: ReadonlyMap<number, string> = new Map([
  // The minus sign proper (U+2212) — indistinguishable from a hyphen on the
  // page, and the reason every negative figure in the value bridge was broken
  // in the days when the face could not draw it.
  [0x2212, '-'],
  // Greek letters used as finance symbols. Spelled out rather than dropped.
  [0x03c3, 'sigma'],
  [0x03bc, 'mu'],
  [0x03c0, 'pi'],
  [0x0394, 'delta'],
  [0x03b2, 'beta'],
  [0x03b1, 'alpha'],
  // Capital sigma, which is what a summation is written with as often as the
  // operator below.
  [0x03a3, 'sum'],
  // Capital phi — the standard normal CDF, which is how every DLOM model in
  // this domain is written down. `N` is the other conventional name for the
  // same function, so the transliteration is one a reader of the model
  // recognises rather than a spelled-out word.
  [0x03a6, 'N'],
  // Comparison and maths operators.
  [0x2264, '<='],
  [0x2265, '>='],
  [0x2260, '!='],
  [0x2248, '~='],
  [0x221e, 'infinity'],
  [0x221a, 'sqrt'],
  [0x2211, 'sum'],
  // The partial-derivative operator. A valuation report reaches for it wherever
  // it explains a sensitivity — the class-volatility exhibit states the gearing
  // as sigma × (S/V) × ∂V/∂S — and `d` is how the same quantity is written in
  // every text that avoids the symbol.
  [0x2202, 'd'],
  [0x222b, 'integral'],
  // Arrows — a rollforward or bridge label reaches for these.
  [0x2192, '->'],
  [0x2190, '<-'],
  [0x2194, '<->'],
  // Two quotation marks and two hyphens outside Latin-1. The quotes a word
  // processor actually produces — ‘ ’ “ ” ‚ „ — and the ellipsis are
  // deliberately absent: downgrading those would make the typography of a
  // published deliverable worse to fix a problem it does not have.
  [0x201b, "'"],
  [0x201f, '"'],
  [0x2010, '-'],
  [0x2011, '-'],
]);

/**
 * Characters removed or normalised whatever the face can draw.
 *
 * Coverage is not the question for these. A zero-width space or a stray BOM in
 * pasted text does have a glyph in DejaVu — a glyph zero points wide — and
 * drawing it faithfully means carrying an invisible character into a legal
 * deliverable, where it breaks search and copy-paste for a reader who cannot
 * see why. The odd-width spaces are the same judgement: in analyst-pasted prose
 * they are paste artifacts rather than typography.
 *
 * Written as alternations rather than character classes where a class would
 * trip `no-misleading-character-class` — U+200D ZERO WIDTH JOINER inside a
 * class is what that rule warns about.
 */
const ZERO_WIDTH = /\u200b|\u200c|\u200d|\ufeff/g;
const ODD_SPACES = /[\u2007\u2009\u200a\u202f\u2060]/g;
// Tab, newline and carriage return are layout instructions pdfkit handles; the
// rest of C0, plus DEL and C1, would be drawn as garbage or dropped silently.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * A character `fontSafe` might have to act on: anything outside printable ASCII
 * (plus the three whitespace instructions pdfkit lays out), or a hyphen, which
 * may be a minus sign in disguise. Not `g`-flagged — it is only ever `test`ed,
 * and a sticky `lastIndex` would make alternate calls lie.
 */
const NEEDS_SANITIZING = /[^\u0020-\u007e\t\n\r]|-/;

/**
 * A hyphen-minus doing a minus sign's job: `-$1,200,000`, `-27.5%`, `(-5)`.
 *
 * The document was setting two different glyphs for one meaning, on one page.
 * Everything routed through `Intl.NumberFormat` — the DCF forecast rows, the
 * present values struck off them — carries U+002D, because that is what `Intl`
 * emits for a negative; everything the report composes by hand carries U+2212,
 * because whoever wrote those lines typed the character a typographer would.
 * Exhibit C printed `-$1,200,000` in its forecast table and `−$700,000` five
 * rows below it. In a document whose whole claim is that its arithmetic was
 * done carefully, two minus signs is the detail a reviewer circles.
 *
 * U+2212 is the one to keep: a hyphen is drawn short and set low, to join
 * words, and beside a run of figures it reads as a dash rather than a sign.
 *
 * The guard is on both sides, because most hyphens in a valuation report are
 * doing their actual job. It converts only a hyphen that opens a figure —
 * preceded by nothing, whitespace or an opening bracket, and followed
 * immediately by a digit or a currency symbol. `free cash flow`, `Exhibit B-1`,
 * `put-option`, `2026-03-31` and `2027-2031` all keep their hyphens: the first
 * three fail the right-hand test and the last two fail the left-hand one, a
 * date being the case that would be most visible if this got it wrong.
 */
const SIGN_HYPHEN = /(^|[\s([{<"'“‘—–])-(?=[\d$€£¥])/gu;

/** Sets a hyphen that is acting as a minus sign as one. */
export function typographicMinus(text: string): string {
  return text.replace(SIGN_HYPHEN, '$1−');
}

/**
 * Makes a string safe to hand to `face`.
 *
 * Applied at the one place text reaches pdfkit rather than at the 40-odd
 * `.text()` call sites. Two reasons, and the second is the one that matters: a
 * call site added later cannot forget it, and the largest source of unusual
 * characters is not this file at all — it is the authored section bodies, which
 * are free text an analyst pastes into a legal deliverable and which reach
 * pdfkit through the same method.
 *
 * With a Unicode face embedded this is now close to a pass-through: a character
 * is left exactly as it was written unless the face has no glyph for it. Only
 * then does the transliteration table apply, and only after that a `?`.
 *
 * Idempotent, which the callers below rely on: two of them sanitize a string
 * themselves so they can measure the form that will be drawn, and then hand
 * that same form to `.text()`, where it is sanitized again.
 */
export function fontSafe(
  text: string,
  face: FaceName = 'regular',
  /**
   * Told about a character this call gave up on (R412, methodology M11).
   *
   * Only the `?` case — a codepoint no face can draw *and* that
   * {@link FALLBACK_GLYPHS} has no transliteration for. A transliteration is
   * information-preserving by design ("`sigma` rather than `s`") and firing on
   * one would make the signal a description of the table rather than of the
   * document. A `?` is the case the table's own note calls "a font to add, not
   * a rule to change" — a person's decision, about a deliverable that has
   * already gone out without it.
   *
   * Codepoints only. This is a per-render sink and its consumer logs what it
   * collects, and the text reaching here is the client's own: a company name,
   * a shareholder's name, a section an analyst pasted. `U+4E2D` says which
   * script the face is missing, which is the whole of what the person adding a
   * font needs, and says nothing about whose report it was.
   */
  onUnrenderable?: (code: number) => void,
): string {
  // Nothing here has anything to do: no hyphen for `typographicMinus` to
  // reconsider, and nothing outside printable ASCII for the three character
  // classes below or for the coverage loop. That is the overwhelming majority
  // of the strings this sees, because pdfkit measures *word by word* while
  // wrapping — a large report makes 60k of these calls and most of them are on
  // a four-character word. The classes are all disjoint from this set (tab,
  // newline and carriage return are deliberately outside CONTROLS), so the fast
  // path returns exactly what the slow one would.
  if (!NEEDS_SANITIZING.test(text)) return text;
  const out = typographicMinus(text).replace(ZERO_WIDTH, '').replace(ODD_SPACES, ' ').replace(CONTROLS, '');
  // Fast path: the overwhelming majority of report text is ASCII, which every
  // face covers, and scanning is cheaper than rebuilding.
  if (!/[^ -~\t\n\r]/.test(out)) return out;
  let safe = '';
  for (const ch of out) {
    // A codepoint above the BMP arrives as one iteration but two UTF-16 units,
    // so it is judged — and if need be replaced — as the one character it is.
    const code = ch.codePointAt(0)!;
    if (faceCovers(face, code)) {
      safe += ch;
      continue;
    }
    const transliterated = FALLBACK_GLYPHS.get(code);
    if (transliterated === undefined) onUnrenderable?.(code);
    safe += transliterated ?? '?';
  }
  return safe;
}

/** The character a truncated string ends in. */
const ELLIPSIS = '\u2026';

/**
 * The longest prefix of `text` that fits in `width`, ellipsized if anything
 * was dropped.
 *
 * Measurement is injected rather than taken from a document, so the rule can be
 * stated and tested without rendering: `measure` is `widthOfString` under
 * whatever face and size the caller has selected.
 *
 * Cut by code point, not by UTF-16 unit. A 409A carries `d\u2081`, `\u2014` and
 * `\u2212` as a matter of course and an authored section can carry anything an
 * analyst pasted; slicing a surrogate pair in half would put a lone half-
 * character into the content stream, which is a worse failure than the overflow
 * being repaired. Trailing space is trimmed before the ellipsis so a cut at a
 * word boundary does not read as `Introduction \u2026`.
 */
export function ellipsize(text: string, width: number, measure: (text: string) => number): string {
  if (measure(text) <= width) return text;
  if (width <= 0) return '';
  const chars = [...text];
  // `lo` is always a length whose ellipsized form fits — 0 does trivially,
  // standing for the empty result — and `hi` is the largest not yet ruled out.
  let lo = 0;
  let hi = chars.length;
  const cut = (n: number) => chars.slice(0, n).join('').trimEnd();
  const fits = (n: number) => n === 0 || measure(cut(n) + ELLIPSIS) <= width;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  // Not one character of the field survives. An ellipsis on its own is a mark
  // the reader cannot interpret — it says something was cut without saying
  // what — so this yields the field instead, which is what lets `footerLine`
  // close up the gap rather than print `… · … · Page 1 of 20`.
  return lo === 0 ? '' : cut(lo) + ELLIPSIS;
}

/** What separates the fields of the running footer. */
const FOOTER_SEP = ' \u00b7 ';

/**
 * The running footer, fitted to one line by shortening everything except the
 * page number.
 *
 * The footer is the only line on the sheet that is the same on every sheet, so
 * an overflow there is not one bad page — it is the whole document. It had one:
 * `Intl`-free, all three fields at their natural width, `IRC 409A Valuation
 * Report \u2014 Northwind Robotics, Inc. (SAMPLE) \u00b7 SAMPLE \u2014 illustrative only, not a
 * valuation opinion \u00b7 Page 1 of 20` ran to 130 characters in a 468pt band and
 * wrapped, leaving `opinion \u00b7 Page 1 of 20` centred on a second line below the
 * bottom margin, on all twenty pages.
 *
 * The page number is last and is never cut. It is the field with no other
 * source — a loose sheet says which company and which document it belongs to in
 * the running head as well, but nothing else on the page says which sheet it
 * is — and it is also the shortest, so protecting it costs the others little.
 * Plain right-to-left elision would have cut exactly that field, since it sits
 * at the end of the line.
 *
 * The rest share what is left in proportion to their natural widths, so a long
 * confidentiality notice beside a short title gives up more than a short notice
 * beside a long title. A field elided to nothing is dropped rather than left as
 * a bare ellipsis between two separators.
 *
 * A budget too small even for the page number returns it alone and still
 * overflowing; `oneLine` is what stops that reaching the page as two lines.
 */
export function footerLine(
  parts: readonly string[],
  width: number,
  measure: (text: string) => number,
): string {
  const joined = parts.join(FOOTER_SEP);
  if (parts.length <= 1 || measure(joined) <= width) return joined;

  const last = parts[parts.length - 1]!;
  const rest = parts.slice(0, -1);
  const natural = rest.map(measure);
  const total = natural.reduce((sum, w) => sum + w, 0);
  const budget = width - measure(last) - measure(FOOTER_SEP) * rest.length;

  const kept =
    budget <= 0 || total === 0
      ? []
      : rest
          .map((part, i) => ellipsize(part, (budget * natural[i]!) / total, measure))
          .filter((part) => part !== '' && part !== ELLIPSIS);
  return [...kept, last].join(FOOTER_SEP);
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
      // Every piece of body text — paragraph, list item, table cell — passes
      // through here, so it is the one place the unbroken-run bound has to go.
      const text = breakLongRuns(decodeEntities(token.value).replace(/\s+/g, ' '));
      if (text.trim().length === 0 && !paragraphOpen && !listItem && tableCell === null) continue;
      if (tableCell !== null) tableCell += text;
      else if (listItem) {
        if (text.length > 0)
          listItem.push({ text, bold: bold > 0, italic: italic > 0, underline: underline > 0 });
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
          if (list && list.items.length > 0)
            blocks.push({ type: 'list', ordered: list.ordered, items: list.items });
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

// ── document structure (tagging) ──────────────────────────────────────────────

/**
 * The report is a *tagged* PDF: alongside the drawing instructions it carries a
 * structure tree naming what each run of content is — a heading, a paragraph, a
 * table cell, a figure — and in what order it is meant to be read.
 *
 * Without one, a PDF is a bag of positioned glyphs. Assistive technology has to
 * guess the reading order from coordinates, which on this report's two-column
 * cover facts and banded tables guesses wrong; a table stops being a table and
 * becomes rows of unrelated numbers, and the charts, being vector paths, are
 * simply absent. The structure tree is also what lets a reader reflow the
 * document on a phone and what a corporate accessibility checker looks for.
 *
 * We stop short of *claiming* PDF/UA-1 conformance in the metadata. Font
 * embedding — which conformance requires and which the standard-14 faces could
 * not give us — is now done (see the typeface section), so the remaining
 * distance is a validator run, not a defect: a claim is a statement about the
 * whole file, and nothing here has checked the whole file. A false conformance
 * claim is worse than none, because it tells a procurement reviewer not to
 * check the thing that would have failed.
 */
type Struct = PDFKit.PDFStructureElement;

/**
 * The bits of pdfkit's runtime surface that `@types/pdfkit` does not declare.
 *
 * Structure *attributes* (`/A`) have no typed accessor — pdfkit's own table
 * renderer reaches through `structElement.dictionary.data.A` to set them, and
 * `PDFReference.end()` is typed as requiring a chunk when the implementation
 * treats it as optional. Narrowed to exactly what is used, so a pdfkit upgrade
 * that moves either one fails to compile rather than silently doing nothing.
 */
interface StructDictionary {
  dictionary: { data: Record<string, unknown> };
}
interface AttributeRef {
  end(): void;
}

interface StructOptions {
  /** Replaces the element's content for a screen reader — figures, mainly. */
  alt?: string;
  title?: string;
  lang?: string;
  /** The text this content really says, when the glyphs differ from it. */
  actual?: string;
  /**
   * Standard structure *attributes* (`/A`), which are a different dictionary
   * from the options above and which pdfkit exposes only on the raw reference —
   * `{ O: 'Table', Scope: 'Column' }` on a header cell, for instance.
   */
  attributes?: Record<string, unknown>;
}

/**
 * Runs `body`, tagging everything it draws as one `type` element under `parent`.
 *
 * pdfkit runs a structure element's closure the moment the element is attached
 * to an attached parent, so the drawing happens in place — call order is
 * document order, which is exactly what the reading order has to be.
 */
function tagged<T>(
  doc: PDFKit.PDFDocument,
  parent: Struct,
  type: string,
  options: StructOptions,
  body: () => T,
): T {
  let out!: T;
  const { attributes, ...structOptions } = options;
  const element = doc.struct(type, structOptions, () => {
    out = body();
  });
  // The attribute reference has to exist before the element is flushed, which
  // `end()` triggers, and be ended after it — the order pdfkit's own table
  // renderer uses.
  const attributeRef = attributes ? (doc.ref(attributes) as unknown as AttributeRef) : null;
  if (attributeRef) (element as unknown as StructDictionary).dictionary.data.A = attributeRef;
  parent.add(element);
  element.end();
  attributeRef?.end();
  return out;
}

/**
 * A structure element that will be filled in later; caller must `.end()` it.
 *
 * Takes no `attributes`: they have to be attached before the element is ended,
 * and an element opened here is ended somewhere else entirely. Accepting them
 * and dropping them silently is the trap this signature exists to close.
 */
function openTag(
  doc: PDFKit.PDFDocument,
  parent: Struct,
  type: string,
  options: Omit<StructOptions, 'attributes'> = {},
): Struct {
  const element = doc.struct(type, options);
  parent.add(element);
  return element;
}

/**
 * Marks everything `body` draws as an artifact — page furniture and decoration
 * that carries no meaning and must stay out of the reading order.
 *
 * This matters most for the running heads and footers. They are real text, and
 * untagged they would be announced on every page: a reader would hear the
 * company name, the report title, "Confidential" and a page number between
 * every two paragraphs of the analysis.
 */
function artifact(doc: PDFKit.PDFDocument, body: () => void): void {
  doc.markContent('Artifact');
  try {
    body();
  } finally {
    doc.endMarkedContent();
  }
}

/**
 * Draws text that occupies exactly one line, truncating it when it will not
 * fit.
 *
 * This exists because `lineBreak: false` does not do what its name says, and
 * every place in this file that believed it did was wrong. pdfkit only consults
 * the flag to decide whether to *default* a missing width (`_initOptions`);
 * once `options.width` is set — and it is set at every one of these call sites,
 * because page furniture, chart labels and contents entries are all drawn into
 * a box — `_text` hands the string to the line wrapper regardless and it wraps.
 * The flag was inert at twenty call sites and the guarantee they were each
 * written to make was never in force.
 *
 * It showed on every page of every report: the running footer wrapped, and
 * `opinion \u00b7 Page 1 of 20` sat centred on a second line, below the bottom
 * margin. The rest were a character away rather than harmless — the longest
 * running head in the sample, `31. Exhibit C \u2014 Income Approach (Discounted Cash
 * Flow)`, fits its half of the band with 3pt to spare.
 *
 * `height` is the option that actually binds. The wrapper takes it as the box
 * it may fill, and with one line's worth it ellipsizes the first line and stops
 * — which is also what finally makes the `ellipsis: true` already passed at
 * several of these call sites mean anything, since the wrapper ignores it
 * unless a height is set.
 *
 * The font and size have to be selected before the call, as they are
 * everywhere here: the line height is read off the document.
 */
function oneLine(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  opts: PDFKit.Mixins.TextOptions & { width: number },
): void {
  doc.text(text, x, y, {
    ellipsis: true,
    ...opts,
    lineBreak: false,
    height: doc.currentLineHeight(true),
  });
}

/**
 * Structure type for a heading at `depth`, where 1 is a top-level section.
 *
 * PDF defines H1–H6 and expects them not to skip levels. The section heading is
 * H1, so an `<h1>` inside a section's prose is a level below it, and anything
 * deeper than H6 is clamped rather than emitted as an undefined type.
 */
export function headingTag(depth: number): string {
  return `H${Math.min(6, Math.max(1, Math.round(depth)))}`;
}

// ── pdfkit layout ─────────────────────────────────────────────────────────────

function fontFor(run: Pick<Run, 'bold' | 'italic'>): string {
  if (run.bold && run.italic) return FONTS.boldItalic;
  if (run.bold) return FONTS.bold;
  if (run.italic) return FONTS.italic;
  return FONTS.regular;
}

/**
 * One ink ramp for the whole document.
 *
 * These greys were previously written as literals at each call site, which is
 * how a report ends up with four almost-identical greys and no way to change
 * the emphasis of a tier without hunting for it.
 */
const INK = {
  strong: '#111111',
  body: '#222222',
  muted: '#666666',
  faint: '#888888',
  hint: '#777777',
  rule: '#cccccc',
  hair: '#e4e2dd',
  band: '#f6f5f2',
} as const;

// ── body copy metrics ─────────────────────────────────────────────────────────

/**
 * The draft stamp's colour. A warm red rather than the document greys: it has
 * to survive a photocopy and read as a status rather than as decoration, and
 * every other mark on the page is neutral, so anything neutral would blend in.
 */
const WATERMARK_INK = '#b03030';
/**
 * How much of the ink actually lands. Low enough that a paragraph under the
 * stamp is still comfortably legible — the report has to be *readable* in
 * draft, that being the point of circulating one — and high enough that a
 * glance at any page, or a monochrome print of it, says draft.
 */
const WATERMARK_OPACITY = 0.11;

/** The largest a stamp is ever set, and the smallest it is allowed to shrink to. */
const WATERMARK_MAX_SIZE = 96;
const WATERMARK_MIN_SIZE = 28;

/**
 * The font size at which `stamp` fits across `width` on one line.
 *
 * Glyph advances scale linearly with the font size, so the natural width at the
 * maximum gives the answer in one measurement; the floor is rounded *down* so
 * rounding cannot put it back over the edge.
 *
 * The floor is there because a stamp is meant to be read across a photographed
 * page. Below about 28pt it stops competing with the body text it sits over and
 * a reader's eye no longer picks it up as a stamp, which is worse than letting
 * a pathological one be cut — and cut is what `oneLine` does with it.
 */
function watermarkSize(doc: PDFKit.PDFDocument, stamp: string, width: number): number {
  const natural = doc.font(FONTS.bold).fontSize(WATERMARK_MAX_SIZE).widthOfString(stamp);
  if (natural <= width) return WATERMARK_MAX_SIZE;
  return Math.max(WATERMARK_MIN_SIZE, Math.floor((WATERMARK_MAX_SIZE * width) / natural));
}

const BODY_FONT_SIZE = 10.5;
const BODY_LINE_GAP = 2;

/**
 * Lines of a broken paragraph that must stay together on each side of the break.
 *
 * Two is the printer's convention, and the reason is legibility rather than
 * taste: one line stranded at the foot of a page (an orphan) or carried alone
 * to the top of the next (a widow) reads as a stray fragment, and in a report
 * whose paragraphs are mostly three or four lines long it happens constantly.
 */
export const MIN_LINES_KEPT = 2;

// ── tables ────────────────────────────────────────────────────────────────────

export type CellAlign = 'left' | 'right';

/** Cells that carry no value and so vote for neither alignment. */
const BLANK_CELLS = new Set(['', '-', '—', '–', 'n/a', 'N/A', 'N/M', 'n/m']);

/**
 * A figure rather than prose: optional currency or sign, digits with grouping,
 * an optional decimal, and an optional trailing unit — `1,234`, `$(4,200.50)`,
 * `12.5%`, `3.2x`.
 *
 * U+2212 sits in the sign class beside `-` and `+`, and has to. Every negative
 * figure in the document is set with it — see `typographicMinus` — so without
 * it here `−$700,000` reads as prose, votes against its own column, and a
 * column of losses left-aligns. That is the outcome `columnAlignments` below
 * calls the single thing that makes a report look amateur, arrived at by the
 * one route it was not watching.
 */
const NUMERIC_CELL = /^[($€£¥]?\s*[-+(−]?\s*[($€£¥]?\s*\d[\d,\s]*(\.\d+)?\s*[)%x×]?\s*$/u;

/** True when a cell reads as a figure, so its column should align right. */
export function isNumericCell(text: string): boolean {
  const trimmed = text.trim();
  if (BLANK_CELLS.has(trimmed)) return false;
  return NUMERIC_CELL.test(trimmed);
}

/**
 * Per-column alignment, decided from the body rows.
 *
 * A valuation report is mostly tables of money, and a left-aligned column of
 * figures is the single thing that makes one look amateur — digits no longer
 * line up by place value, so the reader cannot compare magnitudes down the
 * column. Headers are excluded from the vote because a header is always prose.
 */
export function columnAlignments(rows: readonly string[][], headerRows: number): CellAlign[] {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const body = rows.slice(headerRows);
  return Array.from({ length: cols }, (_, c) => {
    let numeric = 0;
    let prose = 0;
    for (const row of body) {
      const cell = (row[c] ?? '').trim();
      if (BLANK_CELLS.has(cell)) continue;
      if (isNumericCell(cell)) numeric += 1;
      else prose += 1;
    }
    // Ties go to the figures: a footnote marker in one cell of an otherwise
    // numeric column shouldn't unalign the column.
    return numeric > 0 && numeric >= prose ? 'right' : 'left';
  });
}

/** Narrowest a column may be squeezed to before it stops being readable. */
const MIN_COLUMN_WIDTH = 42;

/**
 * Column widths proportional to the widest cell each column holds — but figures
 * are served before prose.
 *
 * Equal columns waste the page: a "Metric / FY-1 / FY-2" table gave a third of
 * the width to two-character year headings and wrapped the labels. So each
 * column's natural width is measured, clamped so one long prose cell cannot
 * starve the rest, and the set normalised to fill the width — a table that
 * stops short of the margin reads as a rendering accident.
 *
 * Normalising *everything* proportionally is what went wrong. When the natural
 * widths exceed the page every column shrinks by the same factor, including one
 * holding a currency figure — and a figure has no wrap that reads as anything
 * but a mistake. Exhibit H, the table that states the conclusion of a 409A,
 * printed its DLOC line as `($0.1723` with the closing bracket alone on the
 * next line, because two prose columns either side had both hit the ceiling and
 * squeezed the number by the few points it was short.
 *
 * A typesetter setting a financial table does the opposite: the figures get the
 * width they need and the labels wrap around them, because a label that wraps
 * is still a label. So numeric columns are given their natural width first and
 * prose columns divide what is left. The reservation is itself capped, so a
 * table that is all figures cannot leave prose with nothing.
 */
export function columnWidths(
  rows: readonly string[][],
  usable: number,
  measure: (text: string, bold: boolean) => number,
  headerRows: number,
  /**
   * Precomputed alignments, where the caller already has them. `tableGeometry`
   * does — it needs them to draw with — and deriving them twice over a
   * four-hundred-row cap table is a scan of every cell for nothing.
   */
  alignments?: readonly CellAlign[],
): number[] {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  if (cols === 1) return [usable];

  const ceiling = Math.max(MIN_COLUMN_WIDTH, usable * 0.5);
  const clamp = (widest: number) => Math.min(ceiling, Math.max(MIN_COLUMN_WIDTH, widest + TABLE_PADDING * 2));
  /*
   * Both widths every column can be asked for, taken in one pass over the cells.
   *
   * The two questions below — how wide is this column, and how wide are its
   * *figures* — used to be answered by two separate sweeps that measured the
   * same body cells twice. Measurement is the expensive thing a table does
   * (`widthOfString` shapes the string through the embedded face), so the
   * second sweep was a straight duplicate on every over-full table, which is
   * every wide exhibit in a 409A.
   */
  const naturalWidest = new Array<number>(cols).fill(0);
  const bodyWidest = new Array<number>(cols).fill(0);
  rows.forEach((row, rowIdx) => {
    const bold = rowIdx < headerRows;
    for (let c = 0; c < cols; c++) {
      const cell = row[c] ?? '';
      if (cell === '') continue;
      const width = measure(cell, bold);
      if (width > naturalWidest[c]!) naturalWidest[c] = width;
      if (!bold && width > bodyWidest[c]!) bodyWidest[c] = width;
    }
  });
  const natural = naturalWidest.map(clamp);

  const total = natural.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return Array.from({ length: cols }, () => usable / cols);
  // Everything fits: proportional is proportional, and the two branches agree.
  if (total <= usable) return natural.map((w) => (w / total) * usable);

  // Over-full. Decide which columns hold figures the same way the renderer
  // decides which to right-align, so a column cannot be aligned as a figure and
  // widthed as prose.
  const alignment = alignments ?? columnAlignments(rows, headerRows);
  const numeric = alignment.map((a) => a === 'right');

  // What a numeric column *reserves* is the width of its widest figure, not of
  // its heading. The reservation exists because a wrapped number reads as a
  // mistake; a wrapped heading does not, and is the same trade this function
  // already makes for prose columns. Measuring the heading instead inverted it:
  // Exhibit H heads two columns "Value per share — marketable" and "Value per
  // share — non-marketable", which between them reserved 66% of the page for
  // cells holding "$2.0779", and the "Class" and "Type" columns either side were
  // squeezed to the floor — so the concluding exhibit of a 409A printed its
  // share classes as "Option / pool" and their type as "preferre / d".
  //
  // Only the squeeze reaches here, so this narrows nothing that already fitted:
  // a table with room keeps its headings on one line via the branch above.
  const reserved = natural.map((w, i) => (numeric[i] ? Math.min(w, clamp(bodyWidest[i]!)) : w));
  const reservedTotal = reserved.reduce((sum, w) => sum + w, 0);
  // Dropping the headings from the reservation is often the whole shortfall. When
  // it is, every column grows from there in proportion — which lets the headings
  // take back what the figures did not need, rather than handing the entire
  // surplus to the prose columns and leaving a label column three times the width
  // of anything in it.
  if (reservedTotal <= usable) return reserved.map((w) => (w / reservedTotal) * usable);

  const proseTotal = reserved.reduce((sum, w, i) => sum + (numeric[i] ? 0 : w), 0);
  const numericTotal = reservedTotal - proseTotal;

  // Prose has to keep a floor, or a wide figure column would reduce a label to
  // an unreadable ribbon — the failure this is meant to prevent, mirrored.
  const proseCols = numeric.filter((n) => !n).length;
  const proseFloor = proseCols * MIN_COLUMN_WIDTH;
  if (proseCols === 0 || numericTotal <= 0 || usable - numericTotal < proseFloor) {
    return natural.map((w) => (w / total) * usable);
  }

  const forProse = usable - numericTotal;
  return reserved.map((w, i) => (numeric[i] ? w : (w / proseTotal) * forProse));
}

const TABLE_PADDING = 5;
const TABLE_FONT_SIZE = 9.5;

/** Marker above a header re-drawn at the top of a continuation page. */
export const TABLE_CONTINUED = 'Table continued';

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

/**
 * A chart with every value the geometry cannot place removed, or null when
 * removing them leaves nothing to draw.
 *
 * `donutSegments` has always dropped non-finite slices; the other three
 * builders did not, and the three ways they failed had nothing in common:
 *
 *  - a bar chart scales off `Math.max(0, ...|values|)`. One `Infinity` makes
 *    every bar `Infinity / Infinity = NaN` wide and pdfkit refuses the rect
 *    with `unsupported number: NaN` — a 500 in place of the report. One `NaN`
 *    is quieter and worse: `max` becomes `NaN`, `max > 0` is false, and *every*
 *    bar in the chart silently vanishes while its labels stay.
 *  - a waterfall accumulates, so one non-finite step poisons the running total
 *    and every column after it, and the render throws.
 *  - `linePlot` already filters, so the line came out right and the alt text
 *    beside it — which reads `spec.points` directly — announced `NaN`.
 *
 * The wire schema says `z.number().finite()`, so nothing crosses `POST
 * /render/v1/pdf` that needs this. That is exactly why the library needs it:
 * a payload the wire rejects is answered with a 422, and `clients/reportRender.ts`
 * answers a 422 by rendering the same payload *here*, in the caller's process.
 * The one path that can carry a non-finite value is the one with no schema on
 * it, and the fallback exists so that a report renders anyway.
 *
 * Applied once, at the top of `renderChart`, so the geometry, the pagination
 * reserve and the alternative text are all computed from the same points. A
 * chart that omits a value while its alt text names it is the divergence this
 * placement exists to prevent.
 *
 * Dropping a point is as far as this goes. A chart left with none is still
 * drawn — the donut and the line already answer that state in words ("No
 * weighted components to show.", "No history to plot yet.") and an empty set is
 * a thing a caller can legitimately pass. Only the waterfall is suppressed
 * outright, and only when its *start* is not a number: that column is the axis
 * every other one is measured from, and there is no honest way to draw the
 * bridge without it.
 */
export function finiteChart(spec: ChartSpec): ChartSpec | null {
  const finite = (p: ChartPoint) => Number.isFinite(p.value);
  switch (spec.type) {
    case 'bar':
      return { ...spec, points: spec.points.filter(finite) };
    case 'line':
      return { ...spec, points: spec.points.filter(finite) };
    case 'donut':
      return { ...spec, slices: spec.slices.filter(finite) };
    case 'waterfall': {
      if (!finite(spec.start)) return null;
      const end = spec.end_value;
      return {
        ...spec,
        steps: spec.steps.filter(finite),
        end_value: end !== undefined && Number.isFinite(end) ? end : undefined,
      };
    }
  }
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

// ── donut ─────────────────────────────────────────────────────────────────────

export interface DonutSegment {
  label: string;
  display: string;
  value: number;
  /** Share of the total, 0–1. */
  fraction: number;
  /** Radians, 0 at twelve o'clock, increasing clockwise. */
  start: number;
  end: number;
}

/**
 * Slices as angles, largest first.
 *
 * Ordering by magnitude is not decoration: a weighting chart is read to find
 * which approach dominates, and putting the biggest slice at twelve o'clock
 * answers that before the legend is read. Non-positive and non-finite values
 * are dropped — a zero-weight approach is not a sliver, it is absent.
 */
export function donutSegments(slices: readonly ChartPoint[]): DonutSegment[] {
  const usable = slices.filter((s) => Number.isFinite(s.value) && s.value > 0);
  const total = usable.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) return [];

  let cursor = 0;
  return [...usable]
    .sort((a, b) => b.value - a.value)
    .map((slice) => {
      const fraction = slice.value / total;
      const start = cursor;
      cursor += fraction * Math.PI * 2;
      return {
        label: slice.label,
        display: slice.display ?? `${(fraction * 100).toFixed(1)}%`,
        value: slice.value,
        fraction,
        start,
        end: cursor,
      };
    });
}

// ── line ──────────────────────────────────────────────────────────────────────

export interface LinePoint {
  label: string;
  display: string;
  value: number;
  /** 0–1 across the plot width, left to right. */
  x: number;
  /** 0–1 up the plot height; 1 is the top of the band. */
  y: number;
}

export interface LinePlot {
  points: LinePoint[];
  min: number;
  max: number;
}

/**
 * Normalised coordinates for a time series.
 *
 * The band is padded by a tenth of the range at each end so the extremes are
 * not drawn on the frame, and a flat series is centred rather than dividing by
 * a zero range — an unchanged FMV is a perfectly ordinary thing to plot, and a
 * chart that renders it as a line along the axis reads as missing data.
 */
export function linePlot(points: readonly ChartPoint[]): LinePlot {
  const usable = points.filter((p) => Number.isFinite(p.value));
  if (usable.length === 0) return { points: [], min: 0, max: 0 };

  const values = usable.map((p) => p.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const pad = rawMax === rawMin ? Math.abs(rawMax) * 0.1 || 1 : (rawMax - rawMin) * 0.1;
  const min = rawMin - pad;
  const max = rawMax + pad;
  const span = max - min;

  return {
    min,
    max,
    points: usable.map((p, i) => ({
      label: p.label,
      display: p.display ?? formatChartValue(p.value),
      value: p.value,
      x: usable.length === 1 ? 0.5 : i / (usable.length - 1),
      y: (p.value - min) / span,
    })),
  };
}

// ── chart alternative text ────────────────────────────────────────────────────

/**
 * Points named individually in a chart's alternative text before it summarises
 * the rest.
 *
 * A comparable-company set runs to thirty names. Read aloud in full, the
 * alternative text for one chart is longer than the section it illustrates, and
 * a listener has no way to skip it — alt text is announced as a single unit.
 * Twelve is about as much as is worth hearing before the shape of the data is
 * clearer from the surrounding prose.
 */
export const ALT_MAX_POINTS = 12;

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const altPoint = (p: { label: string; value: number; display?: string }) =>
  `${p.label} ${p.display ?? formatChartValue(p.value)}`;

/**
 * A step label that already states its own direction.
 *
 * The engine labels its discount steps "Less DLOC 5.0%" — prefixing that with
 * our own word produces "less Less DLOC", which is what a listener actually
 * hears. Matched on the label rather than assumed either way, because a chart
 * assembled elsewhere may well pass a bare "DLOM".
 */
const SIGNED_LABEL = /^(less|plus|minus|add|deduct|discount)\b/i;

/**
 * A figure with any leading negative sign removed.
 *
 * Waterfall steps are announced as "less X" / "plus X", so the sign is already
 * spoken; the engine also formats its reductions with a leading U+2212, and
 * leaving both in place says "less minus forty-five cents". Accounting
 * parentheses are the same sign in another notation and are stripped too.
 */
export function unsignedFigure(display: string): string {
  const trimmed = display.trim();
  const bracketed = /^\((.*)\)$/.exec(trimmed);
  if (bracketed) return bracketed[1]!.trim();
  return trimmed.replace(/^[-−–—+]\s*/, '');
}

/** Semicolon-separated points, truncated to ALT_MAX_POINTS with a count of the rest. */
function altPoints(points: ReadonlyArray<{ label: string; value: number; display?: string }>): string {
  if (points.length === 0) return 'no data';
  const shown = points.slice(0, ALT_MAX_POINTS).map(altPoint);
  const omitted = points.length - shown.length;
  return omitted > 0 ? `${shown.join('; ')}; and ${plural(omitted, 'further point')}` : shown.join('; ');
}

/**
 * What a screen reader says in place of a chart.
 *
 * The charts are vector paths — lines, arcs and filled rectangles with the value
 * labels drawn as separate, positioned text runs. To assistive technology that
 * is either silence or a stream of unanchored numbers, and either way the
 * reader loses the one thing the chart was there to show. A 409A report is
 * delivered to boards, auditors and regulators, some of whom read it with a
 * screen reader; the conclusion of value must not be reachable only by eye.
 *
 * Each shape is described the way it is read rather than the way it is drawn:
 * a waterfall is a starting value, signed steps and a total, not eleven
 * rectangles. The `note` is appended because it is the chart's caption and
 * routinely carries the qualification the numbers need.
 */
export function chartAltText(spec: ChartSpec): string {
  const tail = spec.note ? ` ${spec.note.replace(/\.?\s*$/, '')}.` : '';
  switch (spec.type) {
    case 'bar':
      return `Bar chart. ${spec.title}. ${plural(spec.points.length, 'bar')}: ${altPoints(spec.points)}.${tail}`;
    case 'donut': {
      const segments = donutSegments(spec.slices);
      if (segments.length === 0) return `Donut chart. ${spec.title}. No positive values to plot.${tail}`;
      const parts = segments
        .slice(0, ALT_MAX_POINTS)
        .map((s) => `${s.label} ${s.display} (${(s.fraction * 100).toFixed(1)}%)`);
      const omitted = segments.length - parts.length;
      const list =
        omitted > 0 ? `${parts.join('; ')}; and ${plural(omitted, 'further segment')}` : parts.join('; ');
      const centre = spec.center ? ` Centre: ${spec.center}.` : '';
      return `Donut chart. ${spec.title}. ${plural(segments.length, 'segment')}: ${list}.${centre}${tail}`;
    }
    case 'line': {
      const plot = linePlot(spec.points);
      if (plot.points.length === 0) return `Line chart. ${spec.title}. No data to plot.${tail}`;
      const first = plot.points[0]!;
      const last = plot.points[plot.points.length - 1]!;
      // A trend is the question a reader asks of a time series, so it is stated
      // outright rather than left to be inferred from the enumerated points.
      const direction =
        plot.points.length < 2 || last.value === first.value
          ? 'unchanged'
          : last.value > first.value
            ? 'rising'
            : 'falling';
      const trend =
        plot.points.length < 2
          ? ''
          : ` Overall ${direction} from ${first.display} at ${first.label} to ${last.display} at ${last.label}.`;
      return `Line chart. ${spec.title}. ${plural(plot.points.length, 'point')}: ${altPoints(plot.points)}.${trend}${tail}`;
    }
    case 'waterfall': {
      const columns = waterfallColumns(
        spec.start,
        spec.steps,
        spec.end_label,
        spec.end_value,
        spec.end_display,
      );
      const start = columns[0]!;
      const end = columns[columns.length - 1]!;
      // Signed steps read as "less X" / "plus X": a discount for lack of
      // marketability is the whole point of the chart and has to be audible as
      // a reduction, not as a bar of some height.
      const steps = spec.steps.slice(0, ALT_MAX_POINTS).map((s) => {
        const figure = unsignedFigure(s.display ?? formatChartValue(Math.abs(s.value)));
        const prefix = SIGNED_LABEL.test(s.label.trim()) ? '' : s.value < 0 ? 'less ' : 'plus ';
        return `${prefix}${s.label} ${figure}`;
      });
      const omitted = spec.steps.length - steps.length;
      const body =
        omitted > 0 ? `${steps.join('; ')}; and ${plural(omitted, 'further step')}` : steps.join('; ');
      const middle = steps.length > 0 ? ` ${body};` : '';
      return `Waterfall chart. ${spec.title}. Starts at ${start.label} ${start.display};${middle} ends at ${end.label} ${end.display}.${tail}`;
    }
  }
}

/** Vertical space a chart needs, so pagination can decide before drawing. */
export function chartHeight(spec: ChartSpec): number {
  const title = 20;
  const note = spec.note ? 16 : 0;
  switch (spec.type) {
    case 'bar':
      return title + Math.max(1, spec.points.length) * 20 + 10 + note;
    case 'donut':
      // The legend can be taller than the ring once there are enough slices.
      return title + Math.max(DONUT_SIZE, donutSegments(spec.slices).length * 18 + 8) + 12 + note;
    case 'line':
      return title + LINE_PLOT_HEIGHT + 30 + note;
    case 'waterfall':
      return title + WATERFALL_PLOT_HEIGHT + 34 + note;
  }
}

const WATERFALL_PLOT_HEIGHT = 150;
const LINE_PLOT_HEIGHT = 140;
/** Width of the box a line chart's point and axis labels are centred in. */
const LABEL_BOX = 60;
const DONUT_SIZE = 130;
const CHART_INK = '#222222';
const CHART_MUTED = '#8a8a8a';
const CHART_GRID = '#dddddd';
const CHART_TRACK = '#f1efeb';

/**
 * Slice colours: the accent for the dominant share, then a descending grey
 * ramp. A valuation report is printed, photocopied and read in black and
 * white as often as not, so the series has to separate on lightness alone —
 * a rainbow palette would collapse into four identical greys on a fax.
 */
const DONUT_RAMP = ['#4a4a4a', '#7a7a7a', '#a5a5a5', '#c6c6c6', '#dedede'];

export function donutColor(index: number, accent: string): string {
  return index === 0 ? accent : (DONUT_RAMP[(index - 1) % DONUT_RAMP.length] ?? CHART_MUTED);
}

/** Bars are the accent colour; reductions are muted so a discount reads as one. */
function chartColor(kind: WaterfallColumn['kind'], accent: string): string {
  if (kind === 'decrease') return CHART_MUTED;
  if (kind === 'total') return CHART_INK;
  return accent;
}

/**
 * One chart, tagged as a single `Figure` carrying the alternative text.
 *
 * The whole chart — title, plot and caption — sits inside the figure rather
 * than the plot alone, because `Alt` substitutes for everything the element
 * encloses and `chartAltText` already restates the title and the note. Splitting
 * them would have the title read twice and the caption orphaned from the data
 * it qualifies.
 */
function renderChart(
  doc: PDFKit.PDFDocument,
  input: ChartSpec,
  usable: number,
  accent: string,
  parent: Struct,
): void {
  const spec = finiteChart(input);
  if (spec === null) return;
  // Outside the figure: a page break inside a marked-content region is legal but
  // pointless here, and the reserve has to be taken before the tag opens.
  ensureRoom(doc, chartHeight(spec));
  tagged(doc, parent, 'Figure', { alt: chartAltText(spec) }, () => {
    const left = doc.page.margins.left;
    doc.font(FONTS.bold).fontSize(10.5).fillColor(CHART_INK).text(spec.title, left, doc.y, { width: usable });
    doc.moveDown(0.4);

    if (spec.type === 'bar') renderBarChart(doc, spec, usable, accent);
    else if (spec.type === 'donut') renderDonutChart(doc, spec, usable, accent);
    else if (spec.type === 'line') renderLineChart(doc, spec, usable, accent);
    else renderWaterfallChart(doc, spec, usable, accent);

    if (spec.note) {
      doc
        .font(FONTS.italic)
        .fontSize(8.5)
        .fillColor('#777777')
        .text(spec.note, left, doc.y + 4, {
          width: usable,
        });
    }
    doc.x = left;
    doc.moveDown(1);
  });
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
    doc.font(FONTS.regular).fontSize(9.5).fillColor(CHART_INK).fillColor(CHART_INK);
    oneLine(doc, point.label, left, y + 1, { width: labelWidth - 8 });

    const barX = left + labelWidth;
    // A track behind every bar. Without it the shortest bar in a set reads as
    // a rendering fault rather than a small number, and there is nothing to
    // measure the others against.
    doc.rect(barX, y, trackWidth, barHeight).fillColor(CHART_TRACK).fill();
    if (max > 0 && point.value !== 0) {
      const width = Math.max(1, (Math.abs(point.value) / max) * trackWidth);
      doc
        .rect(barX, y, width, barHeight)
        .fillColor(point.value < 0 ? CHART_MUTED : accent)
        .fill();
    }
    doc.font(FONTS.regular).fontSize(9.5).fillColor(CHART_INK);
    oneLine(doc, point.display ?? formatChartValue(point.value), left + labelWidth + trackWidth + 8, y + 1, {
      width: valueWidth,
      align: 'right',
    });
    doc.y = y + rowHeight;
    doc.x = left;
  });
}

/**
 * An annulus segment, approximated as a polygon.
 *
 * pdfkit has no arc primitive, and stitching beziers for four slices is more
 * arithmetic than the drawing is worth. A degree of resolution is invisible at
 * print sizes and cannot get the winding wrong.
 */
function annulusPath(
  doc: PDFKit.PDFDocument,
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  start: number,
  end: number,
): void {
  // Angles run clockwise from twelve o'clock; PDF's y axis grows downward, so
  // sin drives x and −cos drives y.
  const at = (angle: number, r: number): [number, number] => [
    cx + Math.sin(angle) * r,
    cy - Math.cos(angle) * r,
  ];
  const steps = Math.max(2, Math.ceil(((end - start) / (Math.PI * 2)) * 180));
  const step = (end - start) / steps;

  doc.moveTo(...at(start, outer));
  for (let i = 1; i <= steps; i += 1) doc.lineTo(...at(start + step * i, outer));
  doc.lineTo(...at(end, inner));
  for (let i = steps - 1; i >= 0; i -= 1) doc.lineTo(...at(start + step * i, inner));
  doc.closePath();
}

function renderDonutChart(
  doc: PDFKit.PDFDocument,
  spec: Extract<ChartSpec, { type: 'donut' }>,
  usable: number,
  accent: string,
): void {
  const left = doc.page.margins.left;
  const top = doc.y;
  const segments = donutSegments(spec.slices);
  if (segments.length === 0) {
    doc
      .font(FONTS.italic)
      .fontSize(9)
      .fillColor(CHART_MUTED)
      .text('No weighted components to show.', left, top, { width: usable });
    doc.x = left;
    return;
  }

  const outer = DONUT_SIZE / 2;
  const inner = outer * 0.58;
  const cx = left + outer;
  const cy = top + outer;

  segments.forEach((segment, i) => {
    annulusPath(doc, cx, cy, outer, inner, segment.start, segment.end);
    doc.fillColor(donutColor(i, accent)).fill();
  });

  if (spec.center) {
    doc.font(FONTS.bold).fontSize(13).fillColor(CHART_INK);
    oneLine(doc, spec.center, cx - inner, cy - (spec.center_note ? 14 : 7), {
      width: inner * 2,
      align: 'center',
    });
  }
  if (spec.center_note) {
    doc.font(FONTS.regular).fontSize(7.5).fillColor('#777777');
    oneLine(doc, spec.center_note, cx - inner, cy + (spec.center ? 3 : -4), {
      width: inner * 2,
      align: 'center',
    });
  }

  // Legend to the right of the ring: a slice is unreadable without its name,
  // and labels laid on the arcs collide the moment two slices are thin.
  const legendX = left + DONUT_SIZE + 22;
  const legendWidth = Math.max(80, usable - DONUT_SIZE - 22);
  let legendY = top + Math.max(0, (DONUT_SIZE - segments.length * 18) / 2);
  segments.forEach((segment, i) => {
    doc
      .rect(legendX, legendY + 2.5, 8, 8)
      .fillColor(donutColor(i, accent))
      .fill();
    doc.font(FONTS.regular).fontSize(9).fillColor(CHART_INK);
    oneLine(doc, segment.label, legendX + 14, legendY + 1, { width: legendWidth - 76 });
    doc.font(FONTS.bold).fontSize(9).fillColor(CHART_INK);
    oneLine(doc, segment.display, legendX + legendWidth - 60, legendY + 1, {
      width: 60,
      align: 'right',
    });
    legendY += 18;
  });

  doc.x = left;
  doc.y = top + Math.max(DONUT_SIZE, segments.length * 18 + 8) + 4;
}

function renderLineChart(
  doc: PDFKit.PDFDocument,
  spec: Extract<ChartSpec, { type: 'line' }>,
  usable: number,
  accent: string,
): void {
  const left = doc.page.margins.left;
  const top = doc.y;
  const plot = linePlot(spec.points);
  const axisWidth = 56;
  const plotLeft = left + axisWidth;
  const plotWidth = Math.max(60, usable - axisWidth - 8);
  const plotHeight = LINE_PLOT_HEIGHT - 26;
  const baseline = top + plotHeight;

  if (plot.points.length === 0) {
    doc
      .font(FONTS.italic)
      .fontSize(9)
      .fillColor(CHART_MUTED)
      .text('No history to plot yet.', left, top, { width: usable });
    doc.x = left;
    doc.y = top + 16;
    return;
  }

  // Three gridlines with their values, so a reader can take a number off the
  // chart instead of only a shape.
  for (const level of [0, 0.5, 1]) {
    const y = baseline - level * plotHeight;
    doc
      .moveTo(plotLeft, y)
      .lineTo(plotLeft + plotWidth, y)
      .lineWidth(0.5)
      .strokeColor(CHART_GRID)
      .stroke();
    doc.font(FONTS.regular).fontSize(7.5).fillColor('#888888');
    oneLine(doc, formatChartValue(plot.min + level * (plot.max - plot.min)), left, y - 4, {
      width: axisWidth - 8,
      align: 'right',
    });
  }

  const coords = plot.points.map((p) => ({
    ...p,
    px: plotLeft + p.x * plotWidth,
    py: baseline - p.y * plotHeight,
  }));

  if (coords.length > 1) {
    doc.moveTo(coords[0]!.px, coords[0]!.py);
    for (const c of coords.slice(1)) doc.lineTo(c.px, c.py);
    doc.lineWidth(1.6).strokeColor(accent).stroke();
  }

  /*
   * A label box centred on its marker, nudged so it cannot cross the measure.
   *
   * The rightmost marker sits eight points short of the right margin, so a box
   * centred on it hung 22pt past it — and every trend chart has a rightmost
   * marker. The most recent date and, above it, the concluded value a board
   * reads this chart for were both set into the right margin on every report
   * that carried one, by five points for an ISO date and by nineteen for a
   * per-share figure in the thousands. Nudging the box keeps the label with its
   * marker to within half a box while putting it back inside the type area.
   */
  const labelBoxLeft = (px: number) =>
    Math.min(Math.max(px - LABEL_BOX / 2, left), left + usable - LABEL_BOX);

  /*
   * X labels thinned to what the axis can hold, endpoints always kept.
   *
   * The value labels were thinned to the endpoints from the start; the date
   * beneath each marker was not, and the series this chart plots is bounded at
   * `CHART_SERIES_LIMITS.line` — forty. Forty ISO dates, each about 35pt wide,
   * across a 400pt axis is 10pt of room per label: the axis of a client's
   * longest-running engagement was a solid band of overlapping digits, and the
   * chart was least readable on exactly the reports with the most history.
   *
   * Nothing is dropped from the chart by this: every point keeps its marker and
   * its place on the line, the alternative text still names its points, and the
   * note under the plot still says what the series is. It is the axis ticks
   * that are thinned, which is what an axis does when the ticks outnumber the
   * room — and the two labels a reader looks for, the first and the last, are
   * the two the spacing is anchored on.
   */
  doc.font(FONTS.regular).fontSize(7.5);
  const widestLabel = Math.min(LABEL_BOX, Math.max(...coords.map((c) => doc.widthOfString(c.label))));
  const pitch = widestLabel + 6;
  // Chosen on where a label is *drawn* rather than on where its marker is: the
  // nudge above moves the last box up to half a box left of its point, which an
  // evenly-spaced-by-index selection does not know about and which is exactly
  // where two labels would touch.
  const labelCentre = (px: number) => labelBoxLeft(px) + LABEL_BOX / 2;
  const labelled: number[] = [];
  coords.forEach((c, i) => {
    const previous = labelled[labelled.length - 1];
    if (previous === undefined || labelCentre(c.px) - labelCentre(coords[previous]!.px) >= pitch) {
      labelled.push(i);
    }
  });
  // The most recent point is the one the chart is read for, so it is kept even
  // when the walk above stopped short of it — at the cost of whichever earlier
  // labels it would land on.
  const lastPoint = coords.length - 1;
  if (labelled[labelled.length - 1] !== lastPoint) {
    while (
      labelled.length > 0 &&
      labelCentre(coords[lastPoint]!.px) - labelCentre(coords[labelled[labelled.length - 1]!]!.px) < pitch
    ) {
      labelled.pop();
    }
    labelled.push(lastPoint);
  }
  const labelledSet = new Set(labelled);

  coords.forEach((c, i) => {
    doc.circle(c.px, c.py, 2.6).fillColor(accent).fill();
    // Only the endpoints carry a value. Labelling every marker on a six-point
    // series produces a chart made of overlapping numbers.
    if (i === 0 || i === coords.length - 1) {
      doc.font(FONTS.bold).fontSize(7.5).fillColor(CHART_INK);
      oneLine(doc, c.display, labelBoxLeft(c.px), c.py - 13, { width: LABEL_BOX, align: 'center' });
    }
    if (!labelledSet.has(i)) return;
    doc.font(FONTS.regular).fontSize(7.5).fillColor('#777777');
    oneLine(doc, c.label, labelBoxLeft(c.px), baseline + 6, { width: LABEL_BOX, align: 'center' });
  });

  doc.x = left;
  doc.y = baseline + 20;
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
  const columns = waterfallColumns(spec.start, spec.steps, spec.end_label, spec.end_value, spec.end_display);

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

    doc.font(FONTS.bold).fontSize(8).fillColor(CHART_INK);
    oneLine(doc, column.display, centre - slotWidth / 2, yTop - 11, {
      width: slotWidth,
      align: 'center',
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
export const TOC_HEADING = 'Table of Contents';

/**
 * Named destinations, so a contents entry is a link rather than an instruction
 * to scroll. Stable and derived from position, not from the heading text —
 * two sections may legitimately share a title across a report's appendices.
 */
export const SUMMARY_DESTINATION = 'n409-summary';
export const sectionDestination = (index: number): string => `n409-section-${index + 1}`;

/**
 * Leading between the label, value and note of a supporting figure.
 *
 * The three runs are stacked by measurement, not at fixed offsets, so this is
 * the only vertical spacing the block declares. Two points is, to within half a
 * point, what the old fixed offsets left between the runs of a single-line
 * figure — 11 points to the value, of which 9.25 was the label's own line — so
 * a summary whose labels all fit on one line goes on setting as it always has.
 */
const FIGURE_RUN_GAP = 2;

function renderSummaryPage(
  doc: PDFKit.PDFDocument,
  summary: ReportPdfSummary,
  usable: number,
  accent: string,
  parent: Struct,
  destination?: string,
): void {
  const left = doc.page.margins.left;
  tagged(doc, parent, 'H1', {}, () => {
    doc
      .font(FONTS.bold)
      .fontSize(16)
      .fillColor('#111111')
      .text(SUMMARY_HEADING, left, doc.y, { destination });
  });
  doc.moveDown(0.8);

  // Headline: the one number the engagement exists to produce.
  const boxTop = doc.y;
  const boxHeight = summary.headline.note ? 78 : 66;
  artifact(doc, () => {
    doc.rect(left, boxTop, usable, boxHeight).fillColor('#f6f5f2').fill();
    doc.rect(left, boxTop, 4, boxHeight).fillColor(accent).fill();
  });
  // Label and value are drawn as two positioned runs a long way apart in
  // point size; tagged separately they would be read as two unrelated
  // fragments, so the pair is one paragraph whose ActualText is the sentence a
  // sighted reader assembles from the layout.
  tagged(doc, parent, 'P', { actual: summaryFigureText(summary.headline) }, () => {
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
      doc.font(FONTS.italic).fontSize(8.5).fillColor('#777777');
      oneLine(doc, summary.headline.note, left + 18, boxTop + 60, { width: usable - 36 });
    }
  });
  doc.x = left;
  doc.y = boxTop + boxHeight + 18;

  // Supporting figures, three to a row. See `FIGURE_RUN_GAP` for the stacking.
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
        // Three figures side by side are three columns of a visual grid, and
        // read by coordinate they interleave: every label, then every value.
        // One element per figure fixes the order and keeps each value with the
        // label that names it.
        const bottom = tagged(doc, parent, 'P', { actual: summaryFigureText(figure) }, () => {
          const width = columnWidth - 12;
          // Each run is measured before it is drawn and the next one starts
          // below where the last one ended. The offsets were previously fixed
          // — value at rowTop + 11, note at rowTop + 27 — which is the height
          // of a *one-line* label and no more. "DISCOUNT FOR LACK OF
          // MARKETABILITY" sets to 161pt in this column's 154.7pt, so it wrapped,
          // and its second line was drawn straight through the value beneath it:
          // the two figures a board reads off the summary page overprinted.
          //
          // `heightOfString` has to be given the same string `.text()` will
          // draw. Every draw goes through `fontSafe` (see `renderReportPdf`),
          // which can change a string's length, so the measurement is taken of
          // the sanitized form and that same form is handed to `.text()`.
          const label = fontSafe(figure.label.toUpperCase());
          doc.font(FONTS.regular).fontSize(8).fillColor('#888888');
          const valueTop = rowTop + doc.heightOfString(label, { width }) + FIGURE_RUN_GAP;
          doc.text(label, x, rowTop, { width });

          const value = fontSafe(figure.value);
          doc.font(FONTS.bold).fontSize(12).fillColor('#111111');
          const noteTop = valueTop + doc.heightOfString(value, { width }) + FIGURE_RUN_GAP;
          doc.text(value, x, valueTop, { width });

          if (!figure.note) return noteTop;
          doc.font(FONTS.regular).fontSize(8).fillColor('#777777').text(figure.note, x, noteTop, { width });
          return doc.y;
        });
        rowHeight = Math.max(rowHeight, bottom - rowTop);
      });
      doc.x = left;
      doc.y = rowTop + rowHeight + 14;
    }
  }

  if (summary.statement) {
    doc.moveDown(0.2);
    tagged(doc, parent, 'P', {}, () => {
      doc
        .font(FONTS.regular)
        .fontSize(10.5)
        .fillColor('#222222')
        .text(summary.statement!, left, doc.y, { width: usable, lineGap: 2, align: 'left' });
    });
    doc.moveDown(1);
  }

  for (const chart of summary.charts ?? []) renderChart(doc, chart, usable, accent, parent);
}

/** A summary figure as one spoken sentence, for the element's ActualText. */
export function summaryFigureText(figure: SummaryFigure): string {
  const label = figure.label.replace(/[:\s]+$/, '');
  return figure.note ? `${label}: ${figure.value}. ${figure.note}` : `${label}: ${figure.value}`;
}

export async function renderReportPdf(input: ReportPdfInput, opts: RenderOptions = {}): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 72, bottom: 72, left: 72, right: 72 },
    bufferPages: true,
    compress: opts.compress ?? true,
    /*
     * A valuation report leaves this service and spends the rest of its life in
     * other people's systems — a board pack, an auditor's document management
     * system, a data room's search index. Those read the document dictionary,
     * not the cover page, so it carries the same facts the cover does.
     *
     * On a white-label report the preparing firm is the author; N409 is the
     * software that produced the file, which is what Creator and Producer are
     * for. `displayTitle` makes a viewer show the report's title in its window
     * bar rather than whatever the download was named.
     */
    info: {
      Title: input.title,
      Author: input.branding?.partner_name ?? 'DoAide 409A',
      Subject: `${input.company_name} — ${input.title}`,
      Keywords: (input.keywords ?? [input.company_name, input.title, 'valuation']).join(', '),
      Creator: 'DoAide 409A',
      Producer: 'DoAide 409A report service',
      ...(input.generated_at ? { CreationDate: input.generated_at } : {}),
    },
    lang: 'en-US',
    displayTitle: true,
    // See the "document structure (tagging)" section: this is what carries the
    // reading order and the element roles out to assistive technology.
    tagged: true,
    // The structure tree, marked content and /Lang all postdate 1.3, which is
    // pdfkit's default and what the file previously declared itself to be.
    pdfVersion: '1.7',
  });

  /*
   * The four embedded faces, and a record of which one is currently selected.
   *
   * `fontSafe` needs to know the face a string is about to be drawn in, because
   * coverage is a property of the face and not of the document: the oblique
   * faces of DejaVu carry fewer scripts than the upright ones. Selection goes
   * through `doc.font()`, so that is where it is observed. A name this renderer
   * did not register — nothing does today — leaves the record alone rather than
   * guessing, so the worst case is measuring coverage against the wrong one of
   * our own faces rather than a crash.
   */
  useEmbeddedFonts(doc);
  let face: FaceName = 'regular';
  const selectFont = doc.font.bind(doc) as (src: unknown, ...rest: unknown[]) => PDFKit.PDFDocument;
  (doc as { font: unknown }).font = (src: unknown, ...rest: unknown[]) => {
    const named = typeof src === 'string' ? faceNamed(src) : null;
    if (named) face = named;
    return selectFont(src, ...rest);
  };

  /*
   * Every string this renderer draws goes through `fontSafe` first.
   *
   * Wrapped here, once, rather than applied at the 40-odd `.text()` call sites.
   * Two reasons, and the second is the one that matters: a call site added
   * later cannot forget it, and the largest source of unusual characters is not
   * this file at all — it is the authored section bodies, which are free text an
   * analyst pastes into a legal deliverable and which reach pdfkit through the
   * same method.
   *
   * Now that the faces are embedded Unicode ones this is nearly a no-op, but it
   * is the no-op that guarantees a character the face cannot draw is visibly
   * replaced rather than silently set as a blank box.
   */
  /*
   * WHAT THIS RENDER COULD NOT SET (R412, methodology M11).
   *
   * `fontSafe` replaces a character no embedded face can draw with `?`, and
   * `FALLBACK_GLYPHS` says in as many words what that means — "a CJK company
   * name still does [become `?`] … That is a font to add, not a rule to
   * change." A person's decision, then. Nobody was told it was owed.
   *
   * The deliverable is the only record there was. A company legally named
   * 中国科技 is set as `????` on the cover of its own valuation, the render
   * answers 200, the offload client stores the bytes, the report is signed and
   * published, and it is forwarded to an auditor and filed in a data room in
   * that state. Support has a client asking why their name is question marks
   * and nothing anywhere to look at — the same shape this module already
   * refused to accept one degrade over, when R155 named the ten ways a
   * white-labelled report comes out with no mark on it and gave the last of
   * them {@link issueLog}. A missing logo is a conversation with a firm; a
   * missing name is the client's own text gone out of a legal document.
   *
   * Collected per render rather than in a module-level tally: two renders can
   * be in flight in this service at once (`http_requests_in_flight` is
   * documented as "concurrent PDF renders, in practice"), and a shared bucket
   * would report one document's losses against the other's line.
   *
   * A set, not a count. pdfkit measures word by word while wrapping, so every
   * string passes through `fontSafe` many times over and an occurrence tally
   * would be a number about the layout algorithm. The distinct codepoints are
   * also the whole of the answer: they name the script whose face is missing.
   */
  const unrenderable = new Set<number>();
  const sanitize = (text: unknown): string =>
    // pdfkit accepts a number here too (it stringifies), so this coerces the
    // same way rather than refusing what the library allows.
    fontSafe(typeof text === 'string' ? text : String(text), face, (code) => unrenderable.add(code));

  const drawText = doc.text.bind(doc) as (text: string, ...rest: unknown[]) => PDFKit.PDFDocument;
  (doc as { text: unknown }).text = (text: unknown, ...rest: unknown[]) =>
    drawText(sanitize(text), ...rest);

  /*
   * …and so does every string it *measures*, which is the same statement or the
   * layout is computed for a document other than the one produced.
   *
   * `fontSafe` can change a string's length — a character the face cannot draw
   * becomes `?` or a multi-character transliteration, and a hyphen acting as a
   * minus becomes a wider glyph. Measure the raw form and draw the sanitized
   * one and every derived quantity is wrong: a column sized to fit, a heading
   * whose keep-with-next budget was computed one line short, a summary label
   * measured as one line and drawn as two.
   *
   * That last one is not hypothetical. It happened, it overprinted the two
   * figures a board reads off the summary page, and it was repaired by
   * sanitizing by hand at that one call site — which fixed the instance and
   * left the other twelve measurements taking the raw string. Wrapping the two
   * measure methods where `text` is already wrapped makes the guarantee general
   * and the hand-applied ones redundant rather than load-bearing.
   */
  const measured =
    <T>(fn: (text: string, ...rest: unknown[]) => T) =>
    (text: unknown, ...rest: unknown[]): T =>
      fn(sanitize(text), ...rest);
  (doc as { widthOfString: unknown }).widthOfString = measured(
    doc.widthOfString.bind(doc) as (text: string, ...rest: unknown[]) => number,
  );
  (doc as { heightOfString: unknown }).heightOfString = measured(
    doc.heightOfString.bind(doc) as (text: string, ...rest: unknown[]) => number,
  );

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  /*
   * Root of the structure tree. Everything with meaning hangs off this in the
   * order it is meant to be read, which is not the order it is drawn: the
   * contents pages are reserved now and filled in at the very end, once the
   * section page numbers are known, so their element is opened here — in
   * reading order — and populated later.
   */
  const docStruct = doc.struct('Document');
  doc.addStructure(docStruct);

  // Cover
  const brandColor = /^#[0-9a-fA-F]{6}$/.test(input.branding?.brand_color ?? '')
    ? input.branding!.brand_color!
    : '#999999';

  // A colour band across the head of the cover. The rule under the title said
  // "branded" only to someone looking for it; a band is the first thing seen,
  // and it is the firm's colour rather than ours on a white-label report.
  artifact(doc, () => doc.rect(0, 0, doc.page.width, 10).fillColor(brandColor).fill());

  // The title block is anchored rather than floated. Stacking moveDown()s meant
  // a two-line title or a tall logo pushed the meta block down the page, so no
  // two covers in a set sat at the same height.
  const COVER_TITLE_TOP = 250;
  if (input.branding?.logo) {
    /*
     * What the mark claims to be, before anything decodes it (round 265, M6).
     *
     * The catch below cannot be the guard for this. Every bound in front of the
     * logo is a bound on its *compressed* size — `MAX_LOGO_BYTES` on the fetch,
     * `logo_base64` on this service's contract, a sniff of the first eight
     * bytes — and a PNG deflates its pixels, so none of them says what decoding
     * it costs. A 995 KB file declaring 16000 × 16000 RGBA, inside every one of
     * those caps, takes `doc.image` to over 1.2 GB of resident memory in a
     * single call, allocated off the JS heap where `--max-old-space-size` does
     * not reach. On this estate's host that is an OOM kill of whichever process
     * is rendering — this service, or the API when the offload falls back in
     * process — and there is no `catch` for a process that is gone: no status
     * code, no issue line, no log.
     *
     * So the declaration is read from the header and refused before the
     * allocation, and refused in the same way an undecodable file is: the cover
     * is drawn without the mark and the reason is logged, because the report is
     * correct, complete and deliverable without it. An unreadable header is
     * refused too — `null` means unmeasured, not small, and passing it through
     * would make the bound optional to anything that can produce one.
     *
     * The pixels are wasted even when honest: the mark is drawn into a
     * 140 × 56 pt box, which nothing above a few hundred thousand pixels can
     * reach a reader through.
     */
    const declared = declaredImageSize(input.branding.logo);
    const drawable = declared !== null && declared.width * declared.height <= MAX_IMAGE_PIXELS;
    if (!drawable) {
      issueLog?.warn(
        {
          reason: declared === null ? 'unreadable_image_header' : 'image_too_many_pixels',
          partner: input.branding?.partner_name ?? null,
          bytes: input.branding.logo.length,
          width: declared?.width ?? null,
          height: declared?.height ?? null,
          max_pixels: MAX_IMAGE_PIXELS,
        },
        'partner logo was not drawn — rendering the cover without it',
      );
    }
    if (drawable)
      try {
        // Centered partner logo above the title, capped to a 140×56pt box. The
        // firm's name is set in words directly below, so the mark itself carries
        // no information a reader would otherwise miss — an artifact, not a
        // figure needing alternative text that would only repeat the next line.
        artifact(doc, () => {
          doc.image(input.branding!.logo!, doc.page.width / 2 - 70, COVER_TITLE_TOP - 110, {
            fit: [140, 56],
            align: 'center',
            valign: 'center',
          });
        });
      } catch (err) {
        /*
         * Undecodable image bytes — render the cover without the logo, and say
         * so, because nothing downstream of here can.
         *
         * This is the last of the ways a white-labelled report comes out with no
         * mark on it. R155 named the other nine, all of them in
         * `clients/partnerLogo.ts` where the bytes are fetched, for exactly the
         * reason this one needs naming too: the URL is stored and looks fine,
         * the render succeeds, and the PDF is simply missing the logo, so
         * support has nothing to look at. The fetch sniffs the format before it
         * stores anything, which is what makes the remaining case narrow — a
         * truncated or malformed file whose first bytes are a good PNG header —
         * and narrow is not the same as never, and a partner is watching every
         * report they ship go out unbranded either way.
         *
         * A `warn` and not an `error`: the report is correct, complete and
         * delivered. What it is missing is the firm's mark, which is a
         * conversation with that firm rather than a page.
         */
        issueLog?.warn(
          {
            reason: 'undecodable_image',
            partner: input.branding?.partner_name ?? null,
            bytes: input.branding?.logo?.length ?? 0,
            err,
          },
          'partner logo could not be drawn — rendering the cover without it',
        );
      }
  }
  doc.y = COVER_TITLE_TOP;
  // The document title proper. `Title` rather than `H1`: the section headings
  // are the H1s, and a cover title is not a level in that outline.
  tagged(doc, docStruct, 'Title', {}, () => {
    doc.font(FONTS.bold).fontSize(26).fillColor(INK.strong).text(input.title, doc.page.margins.left, doc.y, {
      width: usable,
      align: 'center',
    });
  });
  doc.moveDown(0.5);
  tagged(doc, docStruct, 'P', {}, () => {
    doc.font(FONTS.regular).fontSize(14).fillColor('#444444').text(input.company_name, { align: 'center' });
  });
  if (input.branding) {
    doc.moveDown(0.4);
    tagged(doc, docStruct, 'P', {}, () => {
      doc
        .font(FONTS.italic)
        .fontSize(10.5)
        .fillColor(INK.muted)
        .text(`Prepared in partnership with ${input.branding!.partner_name}`, { align: 'center' });
    });
  }
  /*
   * The draft notice, in words and in the reading order.
   *
   * The diagonal stamp below is drawn as an artifact, like every other piece of
   * page furniture in this renderer — repeated forty times, it would otherwise
   * interrupt the analysis once per page for anyone listening to the document.
   * But "this is a draft" is the one thing on a page of furniture that is not
   * decoration, and a reader who cannot see the stamp must still be told. So it
   * is said once, here, as real tagged text on the cover, and the stamp is what
   * carries it to the eye on every sheet after.
   */
  if (input.watermark) {
    doc.moveDown(0.8);
    tagged(doc, docStruct, 'P', {}, () => {
      doc
        .font(FONTS.bold)
        .fontSize(11)
        .fillColor(WATERMARK_INK)
        .text(`${input.watermark!.toUpperCase()} — subject to revision, not for distribution`, {
          width: usable,
          align: 'center',
        });
    });
  }

  doc.moveDown(1.6);
  const ruleY = doc.y;
  artifact(doc, () => {
    doc
      .moveTo(doc.page.margins.left + usable / 4, ruleY)
      .lineTo(doc.page.margins.left + (3 * usable) / 4, ruleY)
      .lineWidth(input.branding ? 1.2 : 0.5)
      .strokeColor(brandColor)
      .stroke();
  });

  /*
   * Cover facts sit in a block anchored to the *bottom* of the cover, so a long
   * title grows into the space above them instead of shunting them towards the
   * footer.
   *
   * The anchor is measured, not assumed. It used to be a fixed
   * `page.height - 250`, which fitted the five facts a cover carried when it
   * was written. A 409A now carries seven — the valuation date was added
   * because a reader who takes the render date for the valuation date takes the
   * wrong one — and 250pt is about 60pt short of seven stacked pairs. The block
   * ran past the bottom margin and pdfkit did the only thing it can: it broke
   * the page. The cover of every 409A this platform produced ended with
   * "CURRENCY" and page two began with "USD".
   *
   * Measuring with `heightOfString` under the same fonts the loop draws with is
   * what stops that recurring the next time a fact is added.
   */
  const metaHeight = input.meta.reduce((total, item) => {
    doc.font(FONTS.bold).fontSize(9);
    const label = doc.heightOfString(item.label.toUpperCase(), { width: usable, align: 'center' });
    doc.font(FONTS.regular).fontSize(11);
    const value = doc.heightOfString(item.value, { width: usable, align: 'center' });
    // `moveDown(n)` advances by `n * currentLineHeight(true)` — *with* the line
    // gap. Measuring without it under-reports every gap by a fifth, which on
    // seven facts is a whole fact's worth of page and put the last one
    // overleaf again.
    return total + label + value + doc.currentLineHeight(true) * 0.7;
  }, 0);
  // `max` with the cursor keeps the block clear of the rule above when there
  // are enough facts to need the whole page; the cover then fills downward from
  // the rule, which is still the best available layout and still one page.
  doc.y = Math.max(doc.y + 24, doc.page.height - doc.page.margins.bottom - metaHeight);
  for (const item of input.meta) {
    // Label and value are a stacked pair — one element, spoken as one fact, so
    // "Valuation date" cannot be read apart from the date it labels.
    tagged(doc, docStruct, 'P', { actual: `${item.label.replace(/[:\s]+$/, '')}: ${item.value}` }, () => {
      doc
        .font(FONTS.bold)
        .fontSize(9)
        .fillColor(INK.faint)
        .text(item.label.toUpperCase(), doc.page.margins.left, doc.y, { width: usable, align: 'center' })
        .font(FONTS.regular)
        .fontSize(11)
        .fillColor(INK.strong)
        .text(item.value, { width: usable, align: 'center' });
    });
    doc.moveDown(0.7);
  }

  /*
   * PDF bookmarks. The contents page serves a reader holding paper; anyone
   * reading a thirty-page report on a screen navigates by the sidebar, and
   * without an outline that sidebar is empty. Items are added as each landmark
   * is reached, because pdfkit binds an outline item to whichever page is
   * current when it is created.
   */
  const outline = doc.outline;

  // Contents. The pages are reserved here and filled in at the end, once the
  // section start pages are known — pdfkit cannot insert a page after the fact.
  const wantsToc = input.include_toc ?? input.sections.length >= TOC_MIN_SECTIONS;
  const tocPages: number[] = [];
  let tocLayout: TocCapacity | null = null;
  // Opened in reading order, populated after the last section. Left null when
  // there is no contents, so an empty TOC element is never emitted.
  let tocStruct: Struct | null = null;
  if (wantsToc && input.sections.length > 0) {
    const entryCount = input.sections.length + (input.summary ? 1 : 0);
    tocLayout = tocCapacity(doc);
    const reserve = tocPageCount(entryCount, tocLayout);
    for (let i = 0; i < reserve; i += 1) {
      doc.addPage();
      tocPages.push(currentPageIndex(doc));
      if (i === 0) outline.addItem(TOC_HEADING);
    }
    tocStruct = openTag(doc, docStruct, 'TOC');
  }

  // Executive summary — after the contents, before §1.
  let summaryPage: number | null = null;
  if (input.summary) {
    doc.addPage();
    summaryPage = currentPageIndex(doc);
    outline.addItem(SUMMARY_HEADING);
    const summaryStruct = openTag(doc, docStruct, 'Sect');
    renderSummaryPage(doc, input.summary, usable, brandColor, summaryStruct, SUMMARY_DESTINATION);
    summaryStruct.end();
  }

  // Sections
  const sectionStartPages: number[] = [];
  // Where down the page each section begins. A section that starts at the top
  // of a sheet owns that sheet's running head; one that starts two thirds of
  // the way down does not, because the two thirds above it belong to whatever
  // ran over from before. See `runningHeadings`.
  const sectionStartY: number[] = [];
  input.sections.forEach((section, idx) => {
    if (idx === 0) doc.addPage();
    else doc.moveDown(1.5);
    ensureRoom(doc, 96);
    sectionStartPages.push(currentPageIndex(doc));
    sectionStartY.push(doc.y);
    // Both the bookmark and the destination bind to the page that is current
    // now, which is why they are created here and not in a later pass.
    outline.addItem(`${idx + 1}. ${section.heading}`);
    // Sect per section, mirroring the outline: it is what lets a reader jump
    // by section rather than paging through, the same way the bookmarks do
    // for a sighted one.
    const sectionStruct = openTag(doc, docStruct, 'Sect', { title: section.heading });
    tagged(doc, sectionStruct, 'H1', {}, () => {
      doc
        .font(FONTS.bold)
        .fontSize(16)
        .fillColor(INK.strong)
        .text(`${idx + 1}. ${section.heading}`, doc.page.margins.left, doc.y, {
          width: usable,
          destination: sectionDestination(idx),
        });
    });
    // A rule in the brand colour under each section heading, so the reader can
    // find where a section begins while flipping rather than reading.
    doc.y += 6;
    artifact(doc, () => {
      doc
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.margins.left + usable, doc.y)
        .lineWidth(1)
        .strokeColor(brandColor)
        .stroke();
    });
    doc.x = doc.page.margins.left;
    doc.moveDown(0.8);
    const blocks = htmlToBlocks(section.html);
    blocks.forEach((block, i) => renderBlock(doc, block, usable, sectionStruct, blocks[i + 1]));
    for (const chart of section.charts ?? []) {
      renderChart(doc, chart, usable, brandColor, sectionStruct);
    }
    sectionStruct.end();
  });

  const range = doc.bufferedPageRange();

  if (tocPages.length > 0 && tocLayout && tocStruct) {
    const entries: TocEntry[] = input.sections.map((section, idx) => ({
      heading: section.heading,
      number: `${idx + 1}.`,
      page: sectionStartPages[idx]! - range.start + 1,
      destination: sectionDestination(idx),
    }));
    // The summary is unnumbered — it precedes §1 rather than being part of it.
    if (summaryPage !== null) {
      entries.unshift({
        heading: SUMMARY_HEADING,
        number: null,
        page: summaryPage - range.start + 1,
        destination: SUMMARY_DESTINATION,
      });
    }
    renderTableOfContents(doc, entries, usable, tocPages, tocLayout, tocStruct);
    tocStruct.end();
  }

  // Page furniture. Both bands are stamped after layout, when the total page
  // count and the section each page belongs to are finally known.
  const confidentiality = input.confidentiality === null ? null : (input.confidentiality ?? 'Confidential');
  /*
   * The footer names the document once.
   *
   * It used to be built as `${company} — ${title}`, and the default title
   * `domain/report.ts` generates is already `${template.name} — ${company}`. So
   * every page of every report produced by the platform's own templates read
   * "Northwind Robotics, Inc. — IRC 409A Valuation Report — Northwind Robotics,
   * Inc.", which then had to be truncated to fit and looked like a bug because
   * it was one.
   *
   * The company name is still prefixed when the title does not carry it, which
   * is the case for a title an analyst has retyped — the footer is the only
   * place a loose page says which company it belongs to, and losing that is the
   * worse failure of the two.
   */
  const runningTitle = input.title.includes(input.company_name)
    ? input.title
    : `${input.company_name} — ${input.title}`;
  const headings = runningHeadings(range.count, range.start, [
    ...(tocPages.length > 0 ? [{ page: tocPages[0]!, label: TOC_HEADING }] : []),
    ...(summaryPage !== null ? [{ page: summaryPage, label: SUMMARY_HEADING }] : []),
    ...input.sections.map((section, idx) => ({
      page: sectionStartPages[idx]!,
      label: `${idx + 1}. ${section.heading}`,
      y: sectionStartY[idx],
    })),
  ]);

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    const top = doc.page.margins.top;
    // Writing into the reserved margins is the point of these bands.
    doc.page.margins.bottom = 0;
    doc.page.margins.top = 0;

    // Running head: what the reader is holding, and where they are in it. The
    // cover carries its own title block and would only be cluttered by it.
    // All of it is page furniture: repeated on every sheet, carrying nothing
    // the body does not already say. Marked as artifacts it is skipped by a
    // screen reader instead of interrupting the analysis once per page.
    const heading = headings[i - range.start];
    if (i > range.start && heading) {
      artifact(doc, () => {
        doc.font(FONTS.regular).fontSize(8).fillColor(INK.faint);
        oneLine(doc, input.company_name, doc.page.margins.left, 42, { width: usable / 2 });
        // The two fields share the band, so the heading is elided into its half
        // rather than allowed to run under the company name. The longest in the
        // sample report, `31. Exhibit C — Income Approach (Discounted Cash
        // Flow)`, clears its half by 3pt — which is how close this was to being
        // a visible defect rather than a latent one.
        oneLine(doc, heading, doc.page.margins.left + usable / 2, 42, {
          width: usable / 2,
          align: 'right',
        });
        doc
          .moveTo(doc.page.margins.left, 56)
          .lineTo(doc.page.margins.left + usable, 56)
          .lineWidth(0.5)
          .strokeColor(INK.hair)
          .stroke();
      });
    }

    /*
     * The diagonal stamp, drawn last of the furniture so it sits over the body
     * rather than under it.
     *
     * Under the text would be tidier and is wrong: a table with filled header
     * cells, a chart's plot area and the cover's colour band are all opaque, so
     * a stamp behind them disappears on exactly the pages a reader is most
     * likely to photograph and send on. Over the text at eleven percent costs
     * legibility nothing measurable and cannot be hidden by anything the
     * document draws.
     *
     * `save`/`restore` rather than unwinding the rotation by hand: the graphics
     * state this leaves behind is inherited by the next page's furniture, and a
     * mismatched rotate would tip the whole document a degree at a time.
     */
    if (input.watermark) {
      const stamp = input.watermark.toUpperCase();
      artifact(doc, () => {
        doc.save();
        doc.rotate(-38, { origin: [doc.page.width / 2, doc.page.height / 2] });
        // Fitted rather than elided. A stamp is a single word read at a
        // glance, and `PRELIMINARY — DO NOT DISTRIBUTE` cut to `PRELIMIN…`
        // says less than the same words set smaller. Width is linear in the
        // font size, so one measurement gives the size that fits; `oneLine`
        // still backs it up for a stamp so long that even the floor overflows.
        doc.font(FONTS.bold).fontSize(watermarkSize(doc, stamp, doc.page.width));
        doc.fillColor(WATERMARK_INK, WATERMARK_OPACITY);
        oneLine(doc, stamp, 0, doc.page.height / 2 - 60, {
          width: doc.page.width,
          align: 'center',
        });
        doc.restore();
      });
      // `restore` returns the graphics state but not pdfkit's own fill opacity
      // bookkeeping, which the footer below would otherwise inherit and draw at
      // eleven percent.
      doc.fillOpacity(1);
    }

    const parts = [runningTitle];
    if (confidentiality) parts.push(confidentiality);
    parts.push(`Page ${i - range.start + 1} of ${range.count}`);
    artifact(doc, () => {
      doc.font(FONTS.regular).fontSize(8).fillColor(INK.faint);
      oneLine(
        doc,
        footerLine(parts, usable, (text) => doc.widthOfString(text)),
        doc.page.margins.left,
        doc.page.height - 46,
        { width: usable, align: 'center' },
      );
    });
    doc.page.margins.bottom = bottom;
    doc.page.margins.top = top;
  }

  // Ended after the page furniture, because the contents pages are populated
  // above and their elements are children of this one.
  docStruct.end();

  doc.end();
  const pdf = await done;
  reportUnrenderable(unrenderable);
  return pdf;
}

/** How many distinct codepoints one line names before it summarises the rest. */
const LOGGED_CODEPOINTS = 20;

/**
 * The one line a render leaves behind when it could not set the text it was given.
 *
 * `warn` and not `error`: the bytes are a complete, valid, delivered PDF and
 * every figure in it is right — the reasoning the partner-logo branch above
 * gives for its own level. What is wrong with it is a person's job to fix, and
 * cannot be fixed by anything retrying, so it carries `alert: true`, the
 * estate's one "somebody has to act" contract and the field
 * `log_alert_lines_total` counts. The condition is narrow enough to be worth
 * paging on: DejaVu covers Latin, Greek, Cyrillic, Hebrew, Arabic, the currency
 * block and the mathematical operators this domain writes with, so a line here
 * means a script nothing on the platform can set, not a stray dash.
 *
 * NOT ONE CHARACTER OF THE DOCUMENT, not even its title. Every string this
 * line could name is the client's own — the company, the title that quotes it,
 * a section an analyst pasted — and it lands in the report service's journal,
 * which is the shape `ai/app/documents.py` refuses to put a filename into for
 * the same reason. The codepoints are the whole diagnosis: they name the script
 * whose face is missing, and `reqId` on the line joins it to the render that
 * produced it for anyone entitled to go further.
 */
function reportUnrenderable(codes: ReadonlySet<number>): void {
  if (codes.size === 0) return;
  const named = [...codes]
    .sort((a, b) => a - b)
    .slice(0, LOGGED_CODEPOINTS)
    .map((c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`);
  issueLog?.warn(
    {
      reason: 'unrenderable_characters',
      distinct: codes.size,
      codepoints: named,
      truncated: codes.size > named.length,
      alert: true,
    },
    'characters no embedded face can draw were set as "?" — the report was delivered without them',
  );
}

function ensureRoom(doc: PDFKit.PDFDocument, needed: number): void {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

/** Vertical space between the cursor and the bottom margin. */
function roomLeft(doc: PDFKit.PDFDocument): number {
  return doc.page.height - doc.page.margins.bottom - doc.y;
}

/**
 * How many lines a set of runs occupies at `width`, and the height of one.
 *
 * Measured in bold if any run is bold. A mixed-weight line is wider than the
 * same words set regular, and over-estimating only ever breaks a shade early —
 * whereas under-estimating lets through the very widow this exists to stop.
 */
interface BodyLines {
  lines: number;
  lineHeight: number;
}

/**
 * Memoised for the same reason the table geometry is: a paragraph that follows
 * a heading is measured twice before a word of it is drawn.
 *
 * `renderBlock`'s heading branch reserves room for the heading *plus the
 * opening of whatever comes next*, and asks `openingHeight` — which for a
 * paragraph is this function, at exactly the width the paragraph will then ask
 * for itself a moment later. Wrapping a paragraph is the expensive half of
 * setting one, and in a report most paragraphs follow a heading.
 *
 * Keyed on the runs array, which `htmlToBlocks` builds fresh per render, and
 * carrying the document and width so a hit can only serve the question it
 * answered.
 */
const bodyLinesCache = new WeakMap<
  readonly Run[],
  { doc: PDFKit.PDFDocument; width: number; value: BodyLines }
>();

function bodyLines(doc: PDFKit.PDFDocument, runs: readonly Run[], width: number): BodyLines {
  // The face selection is a side effect callers may be relying on, so it
  // happens on the cached path too — it is a field assignment, not a measure.
  const bold = runs.some((run) => run.bold);
  doc.font(bold ? FONTS.bold : FONTS.regular).fontSize(BODY_FONT_SIZE);
  const cached = bodyLinesCache.get(runs);
  if (cached && cached.doc === doc && cached.width === width) return cached.value;
  const lineHeight = doc.currentLineHeight(true) + BODY_LINE_GAP;
  const text = runs.map((run) => run.text).join('');
  const value: BodyLines =
    text.trim() === ''
      ? { lines: 1, lineHeight }
      : {
          lines: Math.max(
            1,
            Math.round(doc.heightOfString(text, { width, lineGap: BODY_LINE_GAP }) / lineHeight),
          ),
          lineHeight,
        };
  bodyLinesCache.set(runs, { doc, width, value });
  return value;
}

/**
 * Start a new page if setting `lines` here would break them badly.
 *
 * A break is only allowed to fall where at least `MIN_LINES_KEPT` lines stay
 * on this page *and* at least that many carry to the next. Anything else — a
 * lone opening line at the foot, a lone closing line at the head — moves the
 * whole block to the next page instead. A block taller than a full page is
 * left alone: it has to break somewhere, and refusing would loop.
 */
function keepLinesTogether(doc: PDFKit.PDFDocument, lines: number, lineHeight: number): void {
  const fits = Math.floor(roomLeft(doc) / lineHeight);
  if (lines <= fits) return;
  if (fits >= MIN_LINES_KEPT && lines - fits >= MIN_LINES_KEPT) return;
  const perPage = Math.floor((doc.page.height - doc.page.margins.top - doc.page.margins.bottom) / lineHeight);
  if (lines > perPage) return;
  doc.addPage();
}

/**
 * Zero-based index of the page currently being written.
 *
 * Which is the last buffered page for all but one caller — `renderTable` sends
 * the cursor back to a row's own page when a cell has overflowed, and while it
 * is there the last page and the current page are different sheets. Reading the
 * buffer for the page pdfkit is actually on answers both callers; taking the
 * last one answered the table's question with the wrong sheet and put the row
 * after a tall one back where the tall one started.
 */
function currentPageIndex(doc: PDFKit.PDFDocument): number {
  const range = doc.bufferedPageRange();
  const buffer = (doc as unknown as { _pageBuffer?: readonly unknown[] })._pageBuffer;
  const at = Array.isArray(buffer) ? buffer.indexOf(doc.page) : -1;
  return at >= 0 ? range.start + at : range.start + range.count - 1;
}

export interface PageLandmark {
  /** Absolute buffered-page index where this part of the report starts. */
  page: number;
  label: string;
  /**
   * How far down the page it starts, in points. Omitted for the landmarks that
   * always begin a fresh sheet (the contents, the summary).
   */
  y?: number;
}

/**
 * How far down a page a section may begin and still own that page's running
 * head.
 *
 * Anything within a heading's height of the top margin is the top of the page
 * for this purpose — the section is what a reader sees when they look up. Below
 * that, something else is.
 */
export const RUNNING_HEAD_TOP_SLACK = 24;

/**
 * The running-head label for every page: the section a reader is looking at
 * when they glance at the top of that sheet.
 *
 * Derived after layout because a section's start page is not known until it has
 * been laid out, and a section that runs over three pages has to keep labelling
 * all three — a header that only appeared on the page where a section began
 * would be worse than none at all.
 *
 * Two rules, and both come from the same question: what is at the top of this
 * sheet?
 *
 * Where several sections begin on one page — six one-paragraph sections fit on
 * a sheet comfortably — the page is labelled with the *first* of them. Taking
 * the last produced the reliably wrong answer: a page opening with "1.
 * Introduction and Scope" carried a running head reading "5. Allocation of
 * Equity Value", naming a section four headings further down.
 *
 * And where the first section to begin on a page begins *part way down it*, the
 * page is labelled with whatever ran over from the sheet before, because that
 * is what occupies the top. That case is not rare on a valuation report: a long
 * exhibit's table continues onto the next page and the next exhibit starts
 * under it, so a sheet whose top half was Exhibit F's breakpoint schedule was
 * headed "29. Exhibit H — Discounts and Concluded Value". A reader checking
 * which schedule they are looking at is told the wrong one.
 *
 * "Whatever ran over" is the last section to have *begun* on or before the
 * previous page — not the label that page displayed. The two differ, and taking
 * the displayed one is how the bug above survived its own fix: page 11 of the
 * sample deliverable opens with §23 and also carries §24 and §25, so it is
 * correctly headed "23. Index of Exhibits". Page 12 is the continuation of §25's
 * table with §26 starting under it — and reading page 11's *label* propagated
 * "23. Index of Exhibits" onto it, naming a section that had finished two
 * schedules earlier. Reading the section that was actually running when page 11
 * ended gives "25. Exhibit B", which is what the page shows.
 */
export function runningHeadings(
  pageCount: number,
  firstPage: number,
  landmarks: readonly PageLandmark[],
  topMargin = 72,
): Array<string | null> {
  const sorted = [...landmarks].sort((a, b) => a.page - b.page);
  const headings: Array<string | null> = [];
  let carried: string | null = null;
  let next = 0;
  for (let page = firstPage; page < firstPage + pageCount; page += 1) {
    // The section running as this page opens, captured before the loop below
    // advances `carried` past it. This is the label for a page whose top
    // belongs to an earlier section.
    const runningIn = carried;
    let firstOnPage: string | null = null;
    let firstStartsAtTop = false;
    while (next < sorted.length && sorted[next]!.page <= page) {
      const landmark = sorted[next]!;
      if (firstOnPage === null) {
        firstOnPage = landmark.label;
        // No `y` means the landmark begins its own page (the contents, the
        // summary), so it is at the top by construction.
        firstStartsAtTop = landmark.y === undefined || landmark.y <= topMargin + RUNNING_HEAD_TOP_SLACK;
      }
      // The last one still becomes what later pages carry, since it is the
      // section actually running when the page ends.
      carried = landmark.label;
      next += 1;
    }
    if (firstOnPage === null) headings.push(carried);
    else if (firstStartsAtTop) headings.push(firstOnPage);
    // `runningIn` is null only on the very first page of the range, where
    // nothing has run over — there the section that begins on it is the only
    // honest answer however far down it starts.
    else headings.push(runningIn ?? firstOnPage);
  }
  return headings;
}

export interface TocEntry {
  heading: string;
  /** 1-based page number as stamped in the footer. */
  page: number;
  /** Prefix such as "3."; null for an unnumbered entry (the summary). */
  number?: string | null;
  /** Named destination to link the entry to; omitted entries render unlinked. */
  destination?: string;
}

/** Vertical space one contents line occupies. */
const TOC_ENTRY_HEIGHT = 18;

export interface TocCapacity {
  /** Entries that fit on the first contents page, which carries the heading. */
  first: number;
  /** Entries that fit on each continuation page. */
  rest: number;
}

/**
 * How many contents pages to reserve for `entries`.
 *
 * The count has to be known *before* the sections are laid out, because pdfkit
 * cannot insert a page after the fact — the contents pages are reserved up
 * front and filled in at the end. Getting this wrong is not a cosmetic
 * problem: the previous renderer reserved exactly one page and let the entries
 * run off the bottom, where `ensureRoom` appended a fresh page *at the end of
 * the document*. A forty-section report therefore finished with a stray sheet
 * of contents entries 34–40 after the last appendix, and because the page
 * count had already been read off the buffer before that page existed, every
 * footer in the report read "of 8" across nine pages and the last page got no
 * footer at all.
 */
export function tocPageCount(entries: number, capacity: TocCapacity): number {
  if (entries <= capacity.first) return 1;
  return 1 + Math.ceil((entries - capacity.first) / Math.max(1, capacity.rest));
}

/** Entries per contents page, measured from the real font metrics. */
function tocCapacity(doc: PDFKit.PDFDocument): TocCapacity {
  const body = doc.page.height - doc.page.margins.bottom - doc.page.margins.top;
  doc.font(FONTS.bold).fontSize(16);
  // The heading line plus the moveDown(1) that follows it, both at 16pt.
  const headingBlock = doc.currentLineHeight() * 2;
  return {
    first: Math.max(1, Math.floor((body - headingBlock) / TOC_ENTRY_HEIGHT)),
    rest: Math.max(1, Math.floor(body / TOC_ENTRY_HEIGHT)),
  };
}

/**
 * Contents: numbered headings with a dot leader out to the page number, each
 * one a link to the section it names. The leader is sized from the measured
 * text so it lands flush against the number instead of wrapping.
 *
 * Runs over the pages reserved in `pages`, switching at the capacity computed
 * for the reservation rather than calling `ensureRoom` — an appended page here
 * would land after the last section and be counted by nothing.
 */
function renderTableOfContents(
  doc: PDFKit.PDFDocument,
  entries: readonly TocEntry[],
  usable: number,
  pages: readonly number[],
  capacity: TocCapacity,
  parent: Struct,
): void {
  let slot = 0;
  let remaining = capacity.first;

  const startPage = (index: number, withHeading: boolean) => {
    doc.switchToPage(pages[index]!);
    doc.x = doc.page.margins.left;
    doc.y = doc.page.margins.top;
    if (withHeading) {
      tagged(doc, parent, 'H1', {}, () => {
        doc.font(FONTS.bold).fontSize(16).fillColor(INK.strong).text(TOC_HEADING);
      });
      doc.moveDown(1);
    }
  };

  startPage(0, true);

  const left = doc.page.margins.left;
  const numberWidth = 34;
  entries.forEach((entry, idx) => {
    // Reservation and consumption share `capacity`, so the last page always has
    // room; the bound is here so a future divergence truncates the contents
    // rather than writing off the bottom of the sheet.
    if (remaining === 0 && slot + 1 < pages.length) {
      slot += 1;
      startPage(slot, false);
      remaining = capacity.rest;
    }
    remaining -= 1;

    const prefix = entry.number === undefined ? `${idx + 1}.` : entry.number;
    const label = prefix ? `${prefix} ${entry.heading}` : entry.heading;
    const page = String(entry.page);
    const y = doc.y;
    const goTo = entry.destination;

    // One TOCI per entry, spoken via ActualText. The dot leader is sixty
    // literal full stops: left as content a screen reader reads them out, and
    // an entry becomes "Introduction dot dot dot dot … three". ActualText
    // substitutes the sentence the layout is drawing instead.
    tagged(doc, parent, 'TOCI', { actual: `${label}, page ${page}` }, () => {
      doc.font(FONTS.regular).fontSize(11).fillColor('#222222');
      // Elided here rather than left to `oneLine`, because the leader has to
      // start where the label actually ends: measuring the full string and
      // drawing a shortened one would open a gap between the heading and its
      // dots. The `actual` text above stays whole, so what a screen reader
      // announces is the entry, not the entry as far as it fitted.
      const drawn = ellipsize(label, usable - numberWidth, (text) => doc.widthOfString(text));
      const labelWidth = doc.widthOfString(drawn);
      oneLine(doc, drawn, left, y, { width: usable - numberWidth, goTo });

      const leaderStart = left + labelWidth + 4;
      const leaderEnd = left + usable - numberWidth - 4;
      if (leaderEnd > leaderStart) {
        const dotWidth = doc.widthOfString('.');
        const dots = '.'.repeat(Math.max(0, Math.floor((leaderEnd - leaderStart) / dotWidth)));
        // No `width` here either, and for the same reason: it is what stops
        // pdfkit wrapping the leader into the entry below.
        doc.fillColor('#bbbbbb').text(dots, leaderStart, y, { lineBreak: false });
      }

      doc.fillColor('#222222');
      oneLine(doc, page, left + usable - numberWidth, y, {
        width: numberWidth,
        align: 'right',
        goTo,
      });
    });
    doc.y = y + TOC_ENTRY_HEIGHT;
    doc.x = left;
  });
}

function renderRuns(doc: PDFKit.PDFDocument, runs: Run[], opts: { indent?: number; width: number }): void {
  const x = doc.page.margins.left + (opts.indent ?? 0);
  runs.forEach((run, idx) => {
    const last = idx === runs.length - 1;
    doc
      .font(fontFor(run))
      .fontSize(BODY_FONT_SIZE)
      .fillColor(INK.body)
      .text(run.text, x, doc.y, {
        width: opts.width - (opts.indent ?? 0),
        continued: !last,
        underline: run.underline,
        align: 'left',
        lineGap: BODY_LINE_GAP,
      });
  });
}

/**
 * How much of `block` has to fit on a page for setting a heading above it to be
 * worth anything: two lines of a paragraph or list item, a table's header plus
 * its first row, and for a heading just its own height.
 */
function openingHeight(doc: PDFKit.PDFDocument, block: Block | undefined, usable: number): number {
  if (!block) return 0;
  switch (block.type) {
    case 'table':
      return tableLeadHeight(doc, block, usable);
    case 'heading': {
      const size = block.level === 1 ? 14 : block.level === 2 ? 12.5 : 11.5;
      doc.font(FONTS.bold).fontSize(size);
      return doc.heightOfString(block.runs.map((r) => r.text).join(''), { width: usable });
    }
    case 'list': {
      const { lineHeight } = bodyLines(doc, block.items[0] ?? [], usable - 10);
      return lineHeight * MIN_LINES_KEPT;
    }
    case 'paragraph': {
      const { lineHeight } = bodyLines(doc, block.runs, usable - (block.quote ? 18 : 0));
      return lineHeight * MIN_LINES_KEPT;
    }
  }
}

function renderBlock(
  doc: PDFKit.PDFDocument,
  block: Block,
  usable: number,
  parent: Struct,
  next?: Block,
): void {
  switch (block.type) {
    case 'heading': {
      const size = block.level === 1 ? 14 : block.level === 2 ? 12.5 : 11.5;
      const text = block.runs.map((r) => r.text).join('');
      doc.moveDown(0.6);
      doc.font(FONTS.bold).fontSize(size);
      const headingHeight = doc.heightOfString(text, { width: usable });
      // Keep-with-next. A heading alone at the foot of a page announces
      // something the reader then has to turn the page to reach, and the
      // previous fixed 60pt reserve was a hair short of the heading plus a
      // line or two of what follows — so it happened. The reserve is measured
      // against the block that actually follows, because "enough for two lines
      // of prose" is not enough for a table's header row.
      ensureRoom(doc, headingHeight + openingHeight(doc, next, usable));
      // The section's own heading is H1, so prose headings start a level below.
      tagged(doc, parent, headingTag(block.level + 1), {}, () => {
        doc.font(FONTS.bold).fontSize(size).fillColor(INK.strong);
        doc.text(text, doc.page.margins.left, doc.y, { width: usable });
      });
      doc.moveDown(0.3);
      break;
    }
    case 'paragraph': {
      const indent = block.quote ? 18 : 0;
      const { lines, lineHeight } = bodyLines(doc, block.runs, usable - indent);
      keepLinesTogether(doc, lines, lineHeight);
      // A pull quote is a BlockQuote wrapping its paragraph, not a paragraph
      // that happens to be indented — the indent is the only thing a sighted
      // reader has to go on, and it is invisible to everyone else.
      const host = block.quote ? openTag(doc, parent, 'BlockQuote') : parent;
      tagged(doc, host, 'P', {}, () => {
        renderRuns(doc, block.runs, { indent, width: usable });
      });
      if (host !== parent) host.end();
      doc.moveDown(0.7);
      break;
    }
    case 'list': {
      // L > LI > (Lbl, LBody) is the structure a screen reader announces as a
      // list of n items; without it the bullets are read aloud as text.
      const list = openTag(doc, parent, 'L');
      block.items.forEach((item, idx) => {
        const marker = block.ordered ? `${idx + 1}. ` : '•  ';
        doc.font(FONTS.regular).fontSize(BODY_FONT_SIZE);
        const markerWidth = doc.widthOfString(marker);
        const { lines, lineHeight } = bodyLines(doc, item, usable - 10 - markerWidth);
        keepLinesTogether(doc, lines, lineHeight);
        const li = openTag(doc, list, 'LI');

        /*
         * The item's text is its own column, to the right of the marker.
         *
         * Marker and text used to be one continued run opened at the marker's
         * x, and pdfkit wraps a run back to where the run began — so the second
         * line of an item started *under the bullet*, a hair to the left of the
         * first line and level with the marker itself. A list whose runover
         * lines out-dent has no left edge for the eye to follow: the items stop
         * looking like items and read as prose with bullets loose in it. The
         * five-item list under Purpose & Intended Use, where four items run to
         * three lines, is what a 409A's second page opens with.
         *
         * Drawing the body from `textX` gives every line of the item the same
         * left edge — a hanging indent, which is what a list is. It also makes
         * the drawn wrap agree with `bodyLines` above, which has always
         * measured against `usable - 10 - markerWidth`: the old draw passed the
         * full `usable - 10` and let the marker eat into the first line only,
         * so the line count `keepLinesTogether` was given could differ from the
         * one actually set, on exactly the long items where the keep decision
         * matters.
         *
         * `top` is captured before either call, so the two are set on one
         * baseline whatever y the marker's own draw leaves behind — the point
         * of the previous arrangement, kept.
         */
        const top = doc.y;
        const textX = doc.page.margins.left + 10 + markerWidth;
        const textWidth = usable - 10 - markerWidth;
        // Marker and text are separate calls but still one LBody, so nothing
        // changes for a screen reader: the bullet is announced as part of the
        // item. Lbl is optional and LBody alone is correct, which is what this
        // stayed as when the two were a single continued run and could not be
        // relied on to emit in order.
        tagged(doc, li, 'LBody', {}, () => {
          // No `width`, which is what makes `lineBreak: false` bind: with one
          // set, pdfkit wraps regardless (see `oneLine`), and the box here was
          // the marker's own measured width — a float comparison against
          // itself, one rounding away from wrapping the bullet onto a second
          // line and leaving the first blank. `oneLine` is the wrong tool for
          // this one field: it ellipsizes, and a bullet cut to `…` is worse
          // than the overflow. Unbounded is right for a string whose width is
          // three characters of the renderer's own choosing.
          doc
            .font(FONTS.regular)
            .fontSize(BODY_FONT_SIZE)
            .fillColor(INK.body)
            .text(marker, doc.page.margins.left + 10, top, {
              lineBreak: false,
              lineGap: BODY_LINE_GAP,
            });
          if (item.length === 0) {
            doc.text('', textX, top, { width: textWidth, lineGap: BODY_LINE_GAP });
            return;
          }
          item.forEach((run, runIdx) => {
            const last = runIdx === item.length - 1;
            const opts = { continued: !last, underline: run.underline, lineGap: BODY_LINE_GAP };
            doc.font(fontFor(run));
            if (runIdx === 0) doc.text(run.text, textX, top, { ...opts, width: textWidth });
            else doc.text(run.text, opts);
          });
        });
        li.end();
        doc.moveDown(0.2);
      });
      list.end();
      doc.moveDown(0.5);
      break;
    }
    case 'table': {
      renderTable(doc, block, usable, parent);
      break;
    }
  }
}

/**
 * A table, banded and column-aware, that survives a page break.
 *
 * The previous renderer walked the rows and let `ensureRoom` start a new page
 * mid-table. Every row after the break then arrived with no header — in a
 * report whose longest tables are cap tables and comparable-company sets, a
 * reader turning the page found six unlabelled columns of numbers. The header
 * rows are therefore re-drawn at the top of each continuation.
 */
interface TableGeometry {
  widths: number[];
  aligns: CellAlign[];
  offsets: number[];
  heightOf: (row: string[], bold: boolean) => number;
}

/**
 * Column widths, alignments and row heights for a table.
 *
 * Shared with the keep-with-next check, which has to know how tall a table's
 * opening is before deciding whether a heading can be set above it — measuring
 * it a second way there would let the two disagree at exactly the boundary
 * where it matters.
 */
/**
 * Geometry is derived once per table, not once per question asked about it.
 *
 * A table preceded by a heading — every exhibit in a 409A — used to have its
 * columns measured *three* times over: `renderBlock` asks `openingHeight` how
 * much of the table has to fit under the heading, which builds a geometry to
 * answer; `renderTable` builds its own; and then `renderTable` asks
 * `tableLeadHeight` the same question again, which builds a third. Each build
 * shapes every cell of the table through the embedded face. On a cap table with
 * a few hundred share classes that is three full sweeps to place one heading.
 *
 * Keyed on the block, which `htmlToBlocks` creates fresh for each render, and
 * carrying the document and page width it was derived under so a geometry can
 * never be served to a document that would have measured differently.
 */
const tableGeometryCache = new WeakMap<
  Extract<Block, { type: 'table' }>,
  { doc: PDFKit.PDFDocument; usable: number; geometry: TableGeometry }
>();

function tableGeometry(
  doc: PDFKit.PDFDocument,
  block: Extract<Block, { type: 'table' }>,
  usable: number,
): TableGeometry {
  const cached = tableGeometryCache.get(block);
  if (cached && cached.doc === doc && cached.usable === usable) return cached.geometry;

  const measure = (text: string, bold: boolean) =>
    doc
      .font(bold ? FONTS.bold : FONTS.regular)
      .fontSize(TABLE_FONT_SIZE)
      .widthOfString(text);

  const aligns = columnAlignments(block.rows, block.headerRows);
  const widths = columnWidths(block.rows, usable, measure, block.headerRows, aligns);
  const offsets: number[] = [];
  widths.reduce((x, width) => {
    offsets.push(x);
    return x + width;
  }, 0);

  /*
   * Row heights are memoised on the row itself, for the same reason: every body
   * row is measured once to decide whether it still fits on this page and again
   * inside `drawRow` to know how tall to draw it, and the header rows are
   * measured once more by `tableLeadHeight`. The answer cannot differ between
   * those calls — it depends on the row, the face and the column widths, all
   * fixed by the time the geometry exists.
   */
  const heights: [WeakMap<string[], number>, WeakMap<string[], number>] = [new WeakMap(), new WeakMap()];
  const heightOf = (row: string[], bold: boolean): number => {
    const memo = heights[bold ? 1 : 0];
    const hit = memo.get(row);
    if (hit !== undefined) return hit;
    const cellHeights = row.map((cell, c) =>
      doc
        .font(bold ? FONTS.bold : FONTS.regular)
        .fontSize(TABLE_FONT_SIZE)
        .heightOfString(cell || ' ', { width: (widths[c] ?? usable) - TABLE_PADDING * 2 }),
    );
    const height = Math.max(14, ...cellHeights, 0) + TABLE_PADDING * 2;
    memo.set(row, height);
    return height;
  };

  const geometry = { widths, aligns, offsets, heightOf };
  tableGeometryCache.set(block, { doc, usable, geometry });
  return geometry;
}

/**
 * The header rows plus the first body row: the smallest fragment of a table
 * worth leaving on a page, and so also the room a heading above one needs.
 */
function tableLeadHeight(
  doc: PDFKit.PDFDocument,
  block: Extract<Block, { type: 'table' }>,
  usable: number,
): number {
  const { heightOf } = tableGeometry(doc, block, usable);
  const headerRows = block.rows.slice(0, block.headerRows);
  const firstBody = block.rows[block.headerRows];
  return (
    headerRows.reduce((sum, row) => sum + heightOf(row, true), 0) +
    (firstBody ? heightOf(firstBody, false) : 0) +
    6
  );
}

function renderTable(
  doc: PDFKit.PDFDocument,
  block: Extract<Block, { type: 'table' }>,
  usable: number,
  parent: Struct,
): void {
  const left = doc.page.margins.left;
  const { widths, aligns, offsets, heightOf } = tableGeometry(doc, block, usable);

  const headerRows = block.rows.slice(0, block.headerRows);
  const bodyRows = block.rows.slice(block.headerRows);

  // The header plus one body row is the smallest fragment worth leaving on a
  // page; anything less is a stub the reader has to turn back from. Taken
  // before the Table element opens, so the reserve cannot break the row that
  // opens it.
  ensureRoom(doc, tableLeadHeight(doc, block, usable));

  // Table > TR > TH/TD. This is the single biggest structural gain in the
  // report: a cap table or a comparable-company set read without it is a
  // sequence of numbers with no association to the column that names them, and
  // a screen reader can no longer answer "what is this figure?".
  const table = openTag(doc, parent, 'Table');
  // Header cells declare the axis they head. /Scope Column is what lets a
  // reader ask for the heading of the cell they are on; every header row here
  // spans the columns, so Column is right and Row never applies.
  const headerCell: StructOptions = { attributes: { O: 'Table', Scope: 'Column' } };

  const drawRow = (row: string[], bold: boolean, fill: string | null): number => {
    const height = heightOf(row, bold);
    const y = doc.y;
    const startPage = currentPageIndex(doc);
    const pageFloor = doc.page.height - doc.page.margins.bottom;
    // The zebra band is decoration; tagged, it would be an empty cell in the row.
    if (fill) artifact(doc, () => doc.rect(left, y, usable, height).fillColor(fill).fill());
    const tr = openTag(doc, table, 'TR');
    /*
     * Where the row actually ends, which for all but one shape of row is where
     * the arithmetic says.
     *
     * A cell holding more prose than the page has room for is set by pdfkit
     * across as many sheets as it needs, and pdfkit leaves the document on the
     * sheet it finished on. Every later cell of that row was then drawn at the
     * row's own `y` on *that* sheet: the figure belonging beside a paragraph,
     * alone two pages further on, under no heading and level with nothing. The
     * following row was worse — `doc.y` was set to `y + height` for a height
     * measured as if the row had fitted, which on the page the cell ended on is
     * a point near the foot, so the next row was set into the bottom margin.
     *
     * Neither is reachable from a schedule this file builds; both are reachable
     * from an authored chapter, where the table is whatever an analyst pasted
     * in and a cell may hold a paragraph.
     */
    let endPage = startPage;
    let endY = y + height;
    row.forEach((cell, c) => {
      const width = widths[c] ?? usable;
      /*
       * Back to the row's own page for a cell that fits on it. Measured per
       * cell rather than per row, and only once a cell has already overflowed
       * — shaping every cell twice to answer a question that is "no" on every
       * ordinary table is the cost this file's geometry cache exists to avoid.
       *
       * A cell that does not fit either is left where pdfkit put it: `addPage`
       * appends, so sending a second overflowing cell back would set its
       * continuation after the end of the report rather than after this table.
       */
      if (currentPageIndex(doc) !== startPage) {
        const cellHeight = doc
          .font(bold ? FONTS.bold : FONTS.regular)
          .fontSize(TABLE_FONT_SIZE)
          .heightOfString(cell || ' ', { width: width - TABLE_PADDING * 2, lineGap: 1 });
        if (y + TABLE_PADDING + cellHeight <= pageFloor) doc.switchToPage(startPage);
      }
      tagged(doc, tr, bold ? 'TH' : 'TD', bold ? headerCell : {}, () => {
        doc
          .font(bold ? FONTS.bold : FONTS.regular)
          .fontSize(TABLE_FONT_SIZE)
          .fillColor(bold ? INK.strong : INK.body)
          .text(cell, left + (offsets[c] ?? 0) + TABLE_PADDING, y + TABLE_PADDING, {
            width: width - TABLE_PADDING * 2,
            align: aligns[c] ?? 'left',
            lineGap: 1,
          });
      });
      const page = currentPageIndex(doc);
      if (page > endPage) {
        endPage = page;
        endY = doc.y + TABLE_PADDING;
      } else if (page === endPage && doc.y + TABLE_PADDING > endY) {
        endY = doc.y + TABLE_PADDING;
      }
    });
    tr.end();
    if (currentPageIndex(doc) !== endPage) doc.switchToPage(endPage);
    doc.y = endPage === startPage ? y + height : endY;
    doc.x = left;
    return height;
  };

  const rule = (weight: number, color: string) => {
    artifact(doc, () => {
      doc
        .moveTo(left, doc.y)
        .lineTo(left + usable, doc.y)
        .lineWidth(weight)
        .strokeColor(color)
        .stroke();
    });
  };

  const drawHeader = (continued: boolean) => {
    if (headerRows.length === 0) return;
    if (continued) {
      // Without this a repeated header reads as a second, unrelated table
      // beginning at the top of the page. It is a printing artifact of the
      // break, not part of the table's data, so it stays out of the structure.
      artifact(doc, () => {
        doc
          .font(FONTS.italic)
          .fontSize(8)
          .fillColor(INK.hint)
          .text(TABLE_CONTINUED, left, doc.y, { width: usable });
      });
      doc.y += 2;
      doc.x = left;
    }
    rule(0.8, INK.muted);
    for (const row of headerRows) drawRow(row, true, INK.band);
    rule(0.8, INK.muted);
  };

  drawHeader(false);
  if (headerRows.length === 0) rule(0.8, INK.muted);

  bodyRows.forEach((row, idx) => {
    const height = heightOf(row, false);
    if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      drawHeader(true);
    }
    drawRow(row, false, null);
    if (idx < bodyRows.length - 1) rule(0.4, INK.hair);
  });

  rule(0.8, INK.muted);
  table.end();
  doc.y += 2;
  doc.moveDown(0.7);
}
