/**
 * Reading the text back out of a rendered report.
 *
 * Every test in this suite that asserts what the document *says* has to get the
 * words back out of the PDF, and until the renderer embedded a Unicode face
 * that was a one-liner: the standard-14 fonts encode text as WinAnsi, so the
 * bytes inside `<...>` in a content stream were very nearly the characters.
 *
 * An embedded font is not encoded that way. pdfkit subsets the face, writes it
 * as a Type0 font with Identity-H encoding, and the two-byte codes in the
 * content stream are *glyph indices in the subset* — arbitrary numbers assigned
 * in the order the glyphs were first used, different for each face and
 * different between two documents that set different text. Decoding them means
 * doing what a PDF reader does: following the font's `/ToUnicode` CMap.
 *
 * Which is worth doing for its own sake. That CMap is the only reason a
 * finished report can be searched, copied out of, or read aloud by a screen
 * reader, and it is invisible on the page — so a test suite that decoded the
 * page any other way would keep passing on a document nobody could search.
 * Everything here goes through it, so it is exercised by every assertion in the
 * suite about what the report says.
 *
 * Compression is handled here rather than switched off at the call site. A
 * report rendered with `{ compress: false }` is not the document anybody
 * receives, and the difference is not cosmetic: `/FlateDecode` covers the
 * `/ToUnicode` CMaps too, so a decoder that cannot inflate cannot read a
 * delivered PDF *at all* — it has no glyph table to decode against and returns
 * the subset's glyph indices as text. Every reader here inflates, so the bytes
 * asserted on can be the bytes a client downloads.
 */

import { inflateSync } from 'node:zlib';

/** One indirect object: its dictionary, and its stream payload once decoded. */
interface PdfObject {
  dict: string;
  stream: string | null;
}

/**
 * The indirect objects, by object number, in the order the file writes them.
 *
 * Bounded by `/Length` rather than by a search for `endstream`, because a
 * deflated stream is arbitrary bytes: `endstream`, `endobj` and the header of
 * the next object all occur inside compressed payloads, and a parser that
 * scans for them cuts the stream short on roughly one document in ten.
 */
function objects(pdf: Buffer): Map<string, PdfObject> {
  const raw = pdf.toString('latin1');
  const found = new Map<string, PdfObject>();
  for (const m of raw.matchAll(/(?:^|[\r\n])(\d+) 0 obj\r?\n/g)) {
    const bodyStart = m.index + m[0].length;
    const endobj = raw.indexOf('endobj', bodyStart);
    const streamAt = raw.indexOf('stream', bodyStart);
    // `endstream` also starts with `stream`; the keyword we want is the one
    // that opens the payload, and it is the first either way.
    if (streamAt < 0 || (endobj >= 0 && endobj < streamAt)) {
      found.set(m[1]!, { dict: raw.slice(bodyStart, endobj < 0 ? undefined : endobj), stream: null });
      continue;
    }
    const dict = raw.slice(bodyStart, streamAt);
    const dataStart = streamAt + (raw.startsWith('stream\r\n', streamAt) ? 8 : 7);
    const declared = /\/Length (\d+)/.exec(dict);
    // A stream with no direct `/Length` is legal (it may be an indirect
    // reference). Nothing pdfkit writes takes that shape, so falling back to
    // the first `endstream` is a best effort rather than a supported path.
    const end = declared
      ? dataStart + Number(declared[1])
      : Math.max(dataStart, raw.indexOf('endstream', dataStart));
    const bytes = pdf.subarray(dataStart, end);
    let stream: string;
    try {
      stream = dict.includes('/FlateDecode')
        ? inflateSync(bytes).toString('latin1')
        : bytes.toString('latin1');
    } catch {
      // Truncated or not actually deflate — an embedded font subset that the
      // renderer wrote raw, say. Nothing here can read it, and nothing needs to.
      stream = '';
    }
    found.set(m[1]!, { dict, stream });
  }
  return found;
}

/** The stream payload of an object, or null if it does not carry one. */
function streamBody(object: PdfObject | undefined): string | null {
  return object?.stream ?? null;
}

/** UTF-16BE hex — one `<...>` of a CMap's destination — as a string. */
function fromUtf16Hex(hex: string): string {
  const clean = hex.replace(/\s+/g, '');
  let out = '';
  for (let i = 0; i + 4 <= clean.length; i += 4)
    out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
  return out;
}

/**
 * Glyph code to text, read out of one `/ToUnicode` CMap.
 *
 * Three destination forms are legal and all three are handled: `bfchar` pairs,
 * a `bfrange` with an explicit array of destinations (which is what pdfkit
 * writes), and a `bfrange` with one destination that increments across the
 * range. A destination can be more than one character — a run set with the
 * `fi` ligature is one glyph that has to come back as two letters, which is
 * exactly the case a naive decoder silently drops a letter on.
 */
function parseCMap(cmap: string): Map<number, string> {
  const map = new Map<number, string>();

  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/g)) {
      map.set(parseInt(pair[1]!, 16), fromUtf16Hex(pair[2]!));
    }
  }

  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    // Walked token by token rather than matched by shape. The two destination
    // forms are not distinguishable by a pattern applied to the whole block:
    // three consecutive `<...>` inside a destination *array* read exactly like
    // a low, a high and a scalar destination, so a pattern for the scalar form
    // finds dozens of them inside every array and decodes the file to noise.
    const tokens = Array.from(block[1]!.matchAll(/<([0-9a-fA-F\s]+)>|(\[)|(\])/g));
    for (let i = 0; i + 2 < tokens.length;) {
      const lo = parseInt(tokens[i]![1] ?? '', 16);
      const hi = parseInt(tokens[i + 1]![1] ?? '', 16);
      if (Number.isNaN(lo) || Number.isNaN(hi)) {
        i += 1;
        continue;
      }
      i += 2;
      if (tokens[i]![2] === '[') {
        i += 1;
        for (let code = lo; i < tokens.length && tokens[i]![3] !== ']'; i += 1, code += 1) {
          map.set(code, fromUtf16Hex(tokens[i]![1] ?? ''));
        }
        i += 1;
      } else {
        const start = fromUtf16Hex(tokens[i]![1] ?? '');
        i += 1;
        // Only the last code unit increments, which is all the spec allows.
        const head = start.slice(0, -1);
        const tail = start.charCodeAt(start.length - 1);
        for (let code = lo; code <= hi; code += 1)
          map.set(code, head + String.fromCharCode(tail + (code - lo)));
      }
    }
  }

  return map;
}

/**
 * Every font this document can select, by the name a content stream uses.
 *
 * pdfkit numbers fonts across the whole document rather than per page, so one
 * table serves every page.
 */
function fontMaps(objs: Map<string, PdfObject>): Map<string, Map<number, string>> {
  const maps = new Map<string, Map<number, string>>();
  for (const obj of objs.values()) {
    for (const dict of obj.dict.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) {
      for (const entry of dict[1]!.matchAll(/\/(F\d+)\s+(\d+) 0 R/g)) {
        const name = entry[1]!;
        if (maps.has(name)) continue;
        const toUnicode = /\/ToUnicode (\d+) 0 R/.exec(objs.get(entry[2]!)?.dict ?? '');
        const cmap = toUnicode ? streamBody(objs.get(toUnicode[1]!)) : null;
        maps.set(name, cmap ? parseCMap(cmap) : new Map());
      }
    }
  }
  return maps;
}

/** One laid-out line: where pdfkit put it, at what size, and what it says. */
export interface Line {
  /** Left edge of the line, in PDF units from the left of the page. */
  x: number;
  /** The baseline, in PDF units up from the foot of the page. */
  baseline: number;
  size: number;
  text: string;
}

/**
 * The text of one `<hex>` run — or of a whole `TJ` array, whose kerning numbers
 * are ignored — as drawn in a given face.
 *
 * Codes are two bytes each: the encoding is Identity-H, so a code *is* a glyph
 * index in the subset and means nothing without the face's CMap.
 */
export function decodeGlyphs(hex: string, glyphs: Map<number, string> | undefined): string {
  let out = '';
  for (const run of hex.matchAll(/<([0-9a-fA-F]+)>/g)) {
    const digits = run[1]!;
    for (let i = 0; i + 4 <= digits.length; i += 4) {
      const code = parseInt(digits.slice(i, i + 4), 16);
      // An unmapped code means the document's CMap is incomplete, which is a
      // defect in the PDF rather than in this decoder. It is rendered visibly
      // so that a test failure names it instead of hiding it.
      out += glyphs?.get(code) ?? `\\u{${code.toString(16)}}`;
    }
  }
  return out;
}

/**
 * The lines of one content stream, in the order they were drawn.
 *
 * pdfkit emits `Tm` once per laid-out line, then the face and size, then the
 * glyphs — so one match of this shape is one line as the typesetter set it.
 */
function streamLines(stream: string, fonts: Map<string, Map<number, string>>): Line[] {
  return Array.from(
    stream.matchAll(/1 0 0 1 ([-\d.]+) ([-\d.]+) Tm\s*\/(F\d+) ([\d.]+) Tf\s*\[([^\]]*)\]/g),
    (m) => ({
      x: Number(m[1]),
      baseline: Number(m[2]),
      size: Number(m[4]),
      text: decodeGlyphs(m[5]!, fonts.get(m[3]!)),
    }),
  );
}

/**
 * Page content streams in page order.
 *
 * Resolved through each page's `/Contents` reference rather than by taking
 * every `stream` in the file: a page content stream is not the only kind of
 * stream a PDF holds. The document also carries an XMP metadata packet and one
 * `/ToUnicode` CMap per face, and treating those as pages had a footer
 * assertion reporting a missing footer on a page that does not exist.
 */
function pageStreams(objs: Map<string, PdfObject>): string[] {
  const streams: string[] = [];
  for (const obj of objs.values()) {
    // `/Type /Page` and not `/Type /Pages` — the tree node names a `/Count`,
    // not a content stream, and the page list is what this walks.
    if (!/\/Type \/Page[^s]/.test(obj.dict)) continue;
    const contents = /\/Contents (\d+) 0 R/.exec(obj.dict);
    if (contents) streams.push(streamBody(objs.get(contents[1]!)) ?? '');
  }
  return streams;
}

/**
 * A rendered document, opened once.
 *
 * The font tables have to be built before a single glyph can be read, so tests
 * that want more than one view of the same document — the raw streams *and*
 * their text, say — open it once and ask it questions.
 */
export interface PdfReader {
  /** Page content streams, in page order. */
  streams: string[];
  /** The laid-out lines of one stream. */
  lines(stream: string): Line[];
  /** Everything one stream draws, in drawing order. */
  text(stream: string): string;
  /** One `<hex>` run, as drawn in the named face. */
  decode(hex: string, font: string): string;
}

export function readPdf(pdf: Buffer): PdfReader {
  const objs = objects(pdf);
  const fonts = fontMaps(objs);
  const lines = (stream: string): Line[] => streamLines(stream, fonts);
  return {
    streams: pageStreams(objs),
    lines,
    text: (stream) =>
      lines(stream)
        .map((line) => line.text)
        .join(''),
    decode: (hex, font) => decodeGlyphs(hex, fonts.get(font)),
  };
}

/** Every laid-out line, page by page. */
export function pageLines(pdf: Buffer): Line[][] {
  const doc = readPdf(pdf);
  return doc.streams.map(doc.lines);
}

/** Page content streams, in page order, undecoded. */
export function contentStreams(pdf: Buffer): string[] {
  return readPdf(pdf).streams;
}

/** Text of each page, in the order the pages were written. */
export function pageTexts(pdf: Buffer): string[] {
  return pageLines(pdf).map((page) => page.map((line) => line.text).join(''));
}

/** Every word the document draws, in drawing order. */
export function extractText(pdf: Buffer): string {
  return pageTexts(pdf).join('');
}

/**
 * How many pages the document has.
 *
 * Counted over the parsed object dictionaries rather than over the whole file:
 * a compressed content stream is arbitrary bytes and can spell `/Type /Page`
 * by accident, which reads as an extra page that does not exist.
 */
export function pageCount(pdf: Buffer): number {
  let pages = 0;
  for (const obj of objects(pdf).values()) if (/\/Type \/Page[^s]/.test(obj.dict)) pages += 1;
  return pages;
}
