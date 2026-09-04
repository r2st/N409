import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sliceChars } from '../../src/domain/textSlice.js';
import { cellText } from '../../src/domain/capTable.js';
import { contentDisposition } from '../../src/routes/documents.js';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * A bound this service applies *itself*, applied with a slicer that can cut a
 * character in half.
 *
 * `domain/textSlice.ts` was written for this in R217 and says why: an astral
 * character is two UTF-16 code units, `String.prototype.slice` counts code
 * units, and a cut that lands between the halves leaves an unpaired surrogate —
 * a string JavaScript will hold and UTF-8 cannot encode. A `jsonb` parameter is
 * then refused outright (`22P02`, and the transaction rolls back under a 500), a
 * `text` parameter is stored with the half rewritten to `U+FFFD`, and the
 * boundary hook in app.ts cannot help with either, because the half-character
 * never arrived: this service made it.
 *
 * R217 fixed the site it found (`safeFilename`) and eleven others kept the bare
 * spelling, most of them on exactly the text this failure needs — an agent's
 * prose, a spreadsheet cell, a provider's error string, a firm's name.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');

/** A high surrogate at the cut, which is how the bad string is made. */
const ASTRAL = '\u{1F600}'; // U+1F600, two code units

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

describe('the cut this guards against', () => {
  it('splits an astral character when the bound lands inside it', () => {
    const value = `${'a'.repeat(9)}${ASTRAL}bbb`;
    expect(hasLoneSurrogate(value.slice(0, 10))).toBe(true);
    expect(hasLoneSurrogate(sliceChars(value, 10))).toBe(false);
  });

  it('is refused by JSON round-tripping the way jsonb refuses it', () => {
    const half = `${'a'.repeat(9)}${ASTRAL}`.slice(0, 10);
    // Well-formed stringify emits the half as the literal escape Postgres's
    // JSON parser rejects.
    expect(JSON.stringify(half)).toContain('\\ud83d');
  });
});

describe('the truncators that write what they cut', () => {
  it('cellText keeps whole characters at the cap', () => {
    // CELL_TEXT_MAX is not exported; drive past it with a long value.
    const long = `${'x'.repeat(400)}${ASTRAL}${'x'.repeat(400)}`;
    expect(hasLoneSurrogate(cellText(long))).toBe(false);
  });

  it('contentDisposition keeps whole characters at its 200-char cap', () => {
    const name = `${'n'.repeat(199)}${ASTRAL}.pdf`;
    expect(hasLoneSurrogate(contentDisposition(name))).toBe(false);
  });
});

/**
 * Every remaining `.slice(0, …)` in the service, with the ones that are not a
 * length bound on caller text named and reasoned.
 *
 * Scanned rather than listed, because the point is that the last round to fix
 * one of these fixed one. Arrays are excluded by the shape of the receiver
 * where that is unambiguous; everything else is either `sliceChars` or an
 * exemption below.
 */
const EXEMPT: Record<string, string> = {
  'domain/textSlice.ts': 'the definition — the bare slice here is what the exported helper repairs',
  'domain/pagination.ts':
    'cursor internals: an ISO instant and a base64url payload, both ASCII by construction',
  'domain/billing.ts': 'an ISO instant sliced to its year and month',
  'domain/emailDelivery.ts': 'a hex sha256 digest',
  'domain/apiCatalog.ts': 'splits a `METHOD path` key at a known index; not a length bound',
  'domain/asc718.ts': 'an ISO date sliced to its year',
  'domain/partnerSubdomain.ts': 'strips a known suffix by length; not a length bound',
  'domain/sampleReportPdf.ts': 'a first-party instruction string in a build-time report check',
  'db/queryStats.ts': 'a SQL fingerprint built from this repository’s own statements',
  'domain/boundedJson.ts': 'slices the array and the key list of a value being bounded, not text',
  'db/migrate.ts': 'hex sha256 digests in a mismatch message',
  'payments/stripe.ts': 'a hex digest',
  'repos/apiTokens.ts': 'the ASCII scheme prefix of a token this service minted',
  'documents/mediaType.ts': 'splits a media type at its `;`; not a length bound',
  'export/pdf.ts':
    'a PDF text run. The cut cannot reach a database or a JSON parser, and PDFKit draws a replacement glyph rather than failing.',
  'routes/compare.ts': 'slugged to `[a-z0-9-]` before the cut, so there is nothing astral left',
  'routes/documents.ts': 'the storage path uses a hex sha256 prefix; the filename half is sliceChars',
  'email/smtp.ts': 'reads the three ASCII digits of an SMTP reply code',
};

interface Site {
  file: string;
  line: number;
  text: string;
}

/** `.slice(0, N)` whose receiver is not obviously an array or an ISO date. */
function bareSlices(): Site[] {
  /** A receiver named on the same line that is plainly a list. */
  const ARRAY_RECEIVER =
    /(rows|all|items|fields|list|page|candidates|entries|tickers|comps|codes|changes|years|points|lines|bytes|invoices|subscriptions|held|weighted_|fetched|byStaleness|reviewTaskPage|adminEventPage|allAttention|selectedRaw|excludedRaw|raw|projections|documents)\s*\.slice\(0,/;
  /** An array-producing step earlier in a chain broken across lines. */
  const ARRAY_CHAIN = /\.(map|filter|sort|split|flatMap|concat|reverse)\(|\[\.\.\.|Array\.isArray/;
  const found: Site[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      const trimmed = text.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
      if (!/\.slice\(0,/.test(text)) return;
      if (/sliceChars|ellipsize/.test(text)) return;
      // `toISOString().slice(0, 10)` and friends: an ISO instant is ASCII.
      if (/\.slice\(0,\s*10\)/.test(text)) return;
      if (ARRAY_RECEIVER.test(text)) return;
      // The house style breaks a chain across lines, so a `.slice` that opens
      // one names no receiver. Look back up the chain for a step that produced
      // a list — a scan that read only the line would report every
      // `.filter(…).slice(n)` and be switched off for noise.
      if (trimmed.startsWith('.slice(0,')) {
        const window = lines.slice(Math.max(0, i - 5), i).join(' ');
        if (ARRAY_CHAIN.test(window)) return;
      }
      found.push({ file: rel, line: i + 1, text: trimmed });
    });
  }
  return found;
}

describe('no length bound on caller text is applied with a bare slice', () => {
  it('is looking at a population, not at nothing', () => {
    const all = sourceFiles(SRC).filter((f) => readFileSync(f, 'utf8').includes('.slice(0,'));
    expect(all.length).toBeGreaterThan(20);
  });

  it('leaves none outside the exemption list', () => {
    const offenders = bareSlices()
      .filter((s) => !EXEMPT[s.file])
      .map((s) => `${s.file}:${s.line}  ${s.text}`);
    expect(
      offenders,
      `use sliceChars from domain/textSlice.js, or add the file to EXEMPT with why:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps the exemption list honest — every entry still has a site', () => {
    const files = new Set(bareSlices().map((s) => s.file));
    for (const file of Object.keys(EXEMPT)) {
      expect(files.has(file), `${file} no longer has a bare slice; drop its exemption`).toBe(true);
    }
  });
});
