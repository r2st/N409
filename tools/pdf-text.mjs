/**
 * Pull readable text out of a PDF the report service produced.
 *
 * Shared by `seed-samples.mjs` and `sample-report.mjs`, which both make the
 * same assertion for the same reason: the claim worth checking is about the
 * *document*, not about the JSON that preceded it. A Conclusion of Value that
 * reads "$ {{fmv}} per share" three pages after the summary printed a figure
 * passes every unit test in the suite.
 *
 * Both used to decode the hex strings as UTF-16LE, and both were therefore
 * asserting against mojibake. `pdfkit` writes standard-14 text as single-byte
 * WinAnsi, so " Standard" comes out of the stream as the bytes `20 53 74 61 6e
 * 64 61 72 64`; read two at a time as UTF-16LE that is `匠慴摮牡`, and no
 * `{{placeholder}}` can ever match it. The check the tools exist for was inert
 * — and the one thing it did report was an artifact of the mis-decode, because
 * the "& " in a heading like "Standard & Premise of Value" is the bytes `26 20`
 * and lands on U+2026, the ellipsis the tools were looking for.
 */

/**
 * The CP1252 upper range, which is where WinAnsi and Latin-1 disagree.
 *
 * Only 0x80–0x9F needs a table; everything else in the byte range is Latin-1,
 * which `latin1` already decodes correctly. `undefined` marks the five
 * unassigned slots — `fontSafe` in the report service will not emit them.
 */
const CP1252_HIGH = [
  '€',
  undefined,
  '‚',
  'ƒ',
  '„',
  '…',
  '†',
  '‡',
  'ˆ',
  '‰',
  'Š',
  '‹',
  'Œ',
  undefined,
  'Ž',
  undefined,
  undefined,
  '‘',
  '’',
  '“',
  '”',
  '•',
  '–',
  '—',
  '˜',
  '™',
  'š',
  '›',
  'œ',
  undefined,
  'ž',
  'Ÿ',
];

function decodeWinAnsi(hex) {
  const bytes = Buffer.from(hex, 'hex');
  let out = '';
  for (const b of bytes) {
    if (b >= 0x80 && b <= 0x9f) out += CP1252_HIGH[b - 0x80] ?? '�';
    else out += String.fromCharCode(b);
  }
  return out;
}

/** A PDF literal string, `(like this)`, with the escapes it is allowed to use. */
function decodeLiteral(body) {
  return body.replace(/\\(\d{1,3}|.)/g, (_, esc) => {
    if (/^\d/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[esc] ?? esc;
  });
}

/**
 * Concatenate the string operands of one `TJ` array, dropping the numbers.
 *
 * The numbers are kerning adjustments, and pdfkit emits them *inside* words:
 * "Value" is written as `[... of  50 V 70 alue]`. Keeping them — or joining the
 * chunks with anything at all — is what made `{{fmv}}` unfindable whenever the
 * pair happened to be kerned, which is the one thing this extractor is for.
 */
function showArray(body) {
  let out = '';
  for (const m of body.matchAll(/<([0-9a-fA-F\s]*)>|\(((?:\\.|[^\\)])*)\)/g)) {
    out += m[1] !== undefined ? decodeWinAnsi(m[1].replace(/\s+/g, '')) : decodeLiteral(m[2]);
  }
  return out;
}

/**
 * Inflate every Flate stream in the file and read back the text it draws.
 *
 * Walks the text-showing operators rather than substituting hex runs wherever
 * they appear, so what comes out is the drawn string and not the string with
 * the content stream's own operators and coordinates interleaved through it.
 * One line of the document is one line of the result.
 */
export function pdfText(buffer, { inflateSync }) {
  const lines = [];
  for (const m of buffer.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content;
    try {
      content = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      continue; /* not a Flate stream */
    }
    for (const op of content.matchAll(
      /\[((?:<[0-9a-fA-F\s]*>|\((?:\\.|[^\\)])*\)|[^\][])*)\]\s*TJ|<([0-9a-fA-F\s]*)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g,
    )) {
      if (op[1] !== undefined) lines.push(showArray(op[1]));
      else if (op[2] !== undefined) lines.push(decodeWinAnsi(op[2].replace(/\s+/g, '')));
      else lines.push(decodeLiteral(op[3]));
    }
  }
  return lines.join('\n');
}

/**
 * The contents page draws its dot leaders as literal full stops — sixty-odd of
 * them per entry — so a naive search for "..." finds a table of contents and
 * nothing else. An analyst's unfinished sentence is three dots or one U+2026;
 * a run of four or more is the layout, not the prose.
 */
export function stripDotLeaders(text) {
  return text.replace(/\.{4,}/g, ' ');
}
