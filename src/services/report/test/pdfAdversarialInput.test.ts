import { describe, expect, it } from 'vitest';
import {
  breakLongRuns,
  chartAltText,
  decodeEntities,
  finiteChart,
  fontSafe,
  renderReportPdf,
  waterfallColumns,
  type ChartSpec,
  type ReportPdfInput,
} from '../src/pdf.js';
import { extractText, pageCount } from './support/pdfText.js';

/**
 * The renderer against input nobody would type on purpose.
 *
 * Every string in a 409A that names something — the company, an officer, a
 * share class, a benchmark — is free text somebody typed into a form, and the
 * PDF is the end of a pipe that starts there. The rest of the suite renders
 * documents that are *well formed*; this one renders documents that are legal
 * per the wire schema and hostile to every assumption underneath it, and holds
 * the renderer to three promises:
 *
 *  1. it produces a PDF — no input in this file may throw;
 *  2. what it draws is what was written, escapes and entities resolved, not
 *     a fragment of it and not the markup around it; and
 *  3. nothing a caller writes can become PDF *syntax*.
 *
 * The third is the one worth stating plainly. A PDF is a container of typed
 * objects and a report's title reaches its `/Info` dictionary as a string; a
 * name carrying an unbalanced `)` would close that string early and everything
 * after it would be read as dictionary keys. pdfkit escapes, so the answer is
 * "it cannot" — asserted here rather than assumed, because the day it stops
 * being true nothing else in this suite would notice.
 *
 * Where a case is a *documented* limitation rather than a defect, it is
 * asserted as the limitation: CJK still sets as `?` (see `FALLBACK_GLYPHS` —
 * DejaVu has no Han glyphs and adding one is a font decision), and that is
 * pinned so the day a CJK face is registered this test says so.
 */

const base = (over: Partial<ReportPdfInput> = {}): ReportPdfInput => ({
  title: '409A Valuation Report',
  company_name: 'Acme Robotics, Inc.',
  meta: [],
  sections: [{ heading: 'Overview', html: '<p>Body.</p>' }],
  ...over,
});

/** A rendered document's text, with the soft hyphens the line breaker adds removed. */
const words = (pdf: Buffer): string => extractText(pdf).replace(/­/g, '');

const render = (over: Partial<ReportPdfInput>) => renderReportPdf(base(over), { compress: false });

// ── 1. company names ──────────────────────────────────────────────────────────

describe('company names the renderer has to survive', () => {
  /** [name, what the page must read] — the second is the first unless a face cannot draw it. */
  const NAMES: ReadonlyArray<readonly [string, string]> = [
    ['<script>alert(1)</script>', '<script>alert(1)</script>'],
    ["O'Brien & Sons", "O'Brien & Sons"],
    ['"Quoted Corp"', '"Quoted Corp"'],
    ['Ünïcödé GmbH', 'Ünïcödé GmbH'],
    ['Ångström AB', 'Ångström AB'],
    ['Ярославль ООО', 'Ярославль ООО'],
    ['A & B <Holdings> Ltd', 'A & B <Holdings> Ltd'],
    ['Acme (Cayman) Holdings, L.P.', 'Acme (Cayman) Holdings, L.P.'],
    ['Acme — Beta · Gamma', 'Acme — Beta · Gamma'],
    ['₹upee Ventures', '₹upee Ventures'],
    // Documented: no registered face carries Han. The transliteration is `?`,
    // one per character, and the day a CJK face joins `FACES` this line fails
    // and is the reminder to update it.
    ['中国科技有限公司', '????????'],
  ];

  it.each(NAMES)('sets %j on the cover as itself', async (name, expected) => {
    const text = words(await render({ company_name: name }));
    expect(text).toContain(expected);
  });

  it('does not let an Arabic name lose a character it has a glyph for', async () => {
    // Split from the table above because the renderer has no bidi engine: the
    // glyphs are drawn in the order the string holds them, so the *visual*
    // order of a right-to-left name is not something this asserts. What it does
    // assert is the part that would be a data loss rather than a layout one —
    // every character reaches the page as itself and none is transliterated.
    const name = 'شركة الرياض';
    const text = words(await render({ company_name: name }));
    for (const ch of new Set(name.replace(/ /g, ''))) expect(text, ch).toContain(ch);
    expect(text).not.toContain('?');
  });

  it('does not let a company name become PDF syntax', async () => {
    // An unbalanced `)` ends a PDF string; everything after it would be read as
    // the dictionary that contains it. `/Info` carries the title, the subject
    // and the keywords, so this is three strings, not one.
    //
    // The name is also *drawn*, and a content stream holds it as ordinary text
    // — so the file does contain the literal `/OpenAction` bytes, and looking
    // for their absence would be looking for the wrong thing. What has to hold
    // is that no string object ends before the writer meant it to.
    const name = 'Acme ) /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> (';
    const pdf = await render({ title: name, company_name: name });
    const raw = pdf.toString('latin1');
    expect(raw).toContain('\\) /Type /Catalog');
    const strings = [...raw.matchAll(/\n\d+ 0 obj\n\((.*)\)\nendobj/g)].map((m) => m[1]!);
    expect(strings.length).toBeGreaterThan(0);
    for (const value of strings) {
      // No bare parenthesis: every one the name carried is a quoted-pair, so
      // the string it sits in still closes where its writer closed it.
      expect(value.replace(/\\./g, ''), value.slice(0, 40)).not.toMatch(/[()]/);
    }
    // The document still parses and still says what it says.
    expect(pageCount(pdf)).toBeGreaterThan(0);
    expect(words(pdf)).toContain('Acme ) /Type /Catalog');
  });

  it('does not let a trailing backslash escape the string that holds it', async () => {
    const pdf = await render({ company_name: 'Acme\\', title: 'Acme\\' });
    expect(pdf.toString('latin1')).toContain('(Acme\\\\)');
    expect(pageCount(pdf)).toBeGreaterThan(0);
  });

  it('renders a 300-character name — the schema maximum — without overflowing the page', async () => {
    const long = 'Ø'.repeat(300);
    const pdf = await render({ company_name: long });
    expect(pageCount(pdf)).toBeGreaterThan(0);
    // The running footer ellipsizes rather than running off the paper; the
    // cover keeps the whole name.
    expect(words(pdf)).toContain('Ø'.repeat(60));
  });

  it('renders a 300-character name with no space in it', async () => {
    // Nothing to wrap on: the line breaker's soft hyphens are the only reason
    // this fits, and the character count has to survive them.
    const pdf = await render({ company_name: 'W'.repeat(300) });
    expect(words(pdf)).toContain('W'.repeat(129));
  });

  it('renders a whitespace-only name without losing the document around it', async () => {
    const pdf = await render({ company_name: '   ' });
    expect(words(pdf)).toContain('409A Valuation Report');
    expect(pageCount(pdf)).toBeGreaterThan(0);
  });

  it('draws HTML entities in a name as the characters they spell', async () => {
    // A name is a string, not markup, on the cover and in the running head —
    // but it also reaches the *body* through the valuation service's template
    // fill, where it arrives escaped. Both spellings have to reach the page as
    // one company.
    const pdf = await render({
      company_name: 'A &amp; B',
      sections: [{ heading: 'H', html: '<p>Held by A &amp; B and by A &lt;B&gt;.</p>' }],
    });
    const text = words(pdf);
    expect(text).toContain('Held by A & B and by A <B>.');
    // The cover is text, so its ampersand is the one that was typed.
    expect(text).toContain('A &amp; B');
  });
});

// ── 2. names of people, 3. names of share classes ─────────────────────────────

describe('officer, holder and share-class names in tables and metadata', () => {
  const table = (cells: readonly string[]) =>
    `<table><thead><tr><th>Holder</th></tr></thead><tbody>${cells
      .map((c) => `<tr><td>${c}</td></tr>`)
      .join('')}</tbody></table>`;

  it('sets accented and non-Latin holder names as themselves', async () => {
    const holders = ['José Núñez', 'Zoë O’Hara', 'Łukasz Ćwik', 'Δημήτρης Παπάς', 'Пётр Ильич'];
    const pdf = await render({ sections: [{ heading: 'Holders', html: table(holders) }] });
    const text = words(pdf);
    for (const holder of holders) expect(text, holder).toContain(holder);
  });

  it('keeps a share class whose name is markup as its own name', async () => {
    // `esc` in the valuation service escapes these on the way in; the renderer
    // has to give them back. A class called `Series A & B <old>` is the case
    // that module's docstring names.
    const pdf = await render({
      sections: [
        { heading: 'Classes', html: table(['Series A &amp; B &lt;old&gt;', 'Series B-1 (as converted)']) },
      ],
    });
    const text = words(pdf);
    expect(text).toContain('Series A & B <old>');
    expect(text).toContain('Series B-1 (as converted)');
  });

  it('does not let a cell close its own table', async () => {
    // Unescaped, this would have been a `</td>` and a new row. It is text.
    const pdf = await render({
      sections: [{ heading: 'Classes', html: table(['Series &lt;/td&gt;&lt;td&gt;X']) }],
    });
    expect(words(pdf)).toContain('Series </td><td>X');
  });

  it('ellipsizes a 300-character class name rather than overrunning the column', async () => {
    const pdf = await render({
      sections: [{ heading: 'Classes', html: table(['Series ' + 'A'.repeat(300)]) }],
    });
    expect(pageCount(pdf)).toBeGreaterThan(0);
    expect(words(pdf)).toContain('Series');
  });

  it('carries adversarial metadata rows onto the cover', async () => {
    const pdf = await render({
      meta: [
        { label: 'Prepared for', value: 'Ünïcödé GmbH & Co. KG' },
        { label: 'Address', value: '1 Main St\nSuite 2\tFloor 3' },
        { label: 'Signatory', value: '"J. O\'Brien" <j@example.com>' },
      ],
    });
    const text = words(pdf);
    expect(text).toContain('Ünïcödé GmbH & Co. KG');
    expect(text).toContain('"J. O\'Brien" <j@example.com>');
    expect(pageCount(pdf)).toBeGreaterThan(0);
  });
});

// ── 4. numbers ────────────────────────────────────────────────────────────────

describe('numeric extremes', () => {
  const chartSection = (chart: ChartSpec): ReportPdfInput['sections'] => [
    { heading: 'Charts', html: '<p>See chart.</p>', charts: [chart] },
  ];

  it('states a trillion-dollar conclusion and a sub-cent one on the same summary', async () => {
    const pdf = await render({
      summary: {
        headline: { label: 'Equity value', value: '$1,234,567,890,123.45' },
        figures: [
          { label: 'FMV per share', value: '$0.0001' },
          { label: 'Deficit', value: '−$987,654,321,098.76' },
        ],
      },
    });
    const text = words(pdf);
    expect(text).toContain('$1,234,567,890,123.45');
    expect(text).toContain('$0.0001');
    expect(text).toContain('−$987,654,321,098.76');
  });

  it.each([
    [
      'bar' as const,
      (v: number): ChartSpec => ({
        type: 'bar',
        title: 'B',
        points: [
          { label: 'a', value: v },
          { label: 'b', value: 10 },
        ],
      }),
    ],
    [
      'line' as const,
      (v: number): ChartSpec => ({
        type: 'line',
        title: 'L',
        points: [
          { label: 'a', value: v },
          { label: 'b', value: 10 },
        ],
      }),
    ],
    [
      'donut' as const,
      (v: number): ChartSpec => ({
        type: 'donut',
        title: 'D',
        slices: [
          { label: 'a', value: v },
          { label: 'b', value: 10 },
        ],
      }),
    ],
  ])('renders a %s chart carrying NaN and Infinity instead of throwing', async (_kind, make) => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const pdf = await render({ sections: chartSection(make(bad)) });
      const text = words(pdf);
      expect(text, String(bad)).not.toContain('NaN');
      expect(text, String(bad)).not.toContain('Infinity');
      expect(text, String(bad)).toContain('b');
    }
  });

  it('drops a waterfall whose start is not a number rather than throwing', async () => {
    const pdf = await render({
      sections: chartSection({
        type: 'waterfall',
        title: 'Bridge to FMV',
        start: { label: 'Marketable', value: Number.NaN },
        steps: [{ label: 'Less DLOM', value: -5 }],
        end_label: 'Concluded',
      }),
    });
    expect(words(pdf)).not.toContain('Bridge to FMV');
    expect(pageCount(pdf)).toBeGreaterThan(0);
  });

  it('drops only the poisoned step of an otherwise good waterfall', async () => {
    const pdf = await render({
      sections: chartSection({
        type: 'waterfall',
        title: 'Bridge',
        start: { label: 'Marketable', value: 100, display: '$100.00' },
        steps: [
          { label: 'Less DLOC', value: -10, display: '−$10.00' },
          { label: 'Broken', value: Number.POSITIVE_INFINITY },
        ],
        end_label: 'Concluded',
      }),
    });
    const text = words(pdf);
    expect(text).toContain('Less DLOC');
    expect(text).not.toContain('Broken');
  });

  it('keeps the geometry and the alternative text reading the same points', () => {
    // The screen-reader text used to be built from the raw spec while the
    // drawing was built from filtered points, so a chart that omitted a value
    // announced it anyway.
    const spec: ChartSpec = {
      type: 'bar',
      title: 'B',
      points: [
        { label: 'good', value: 5 },
        { label: 'bad', value: Number.NaN },
      ],
    };
    const cleaned = finiteChart(spec)!;
    expect(chartAltText(cleaned)).toContain('good');
    expect(chartAltText(cleaned)).not.toContain('bad');
    expect(chartAltText(cleaned)).not.toContain('NaN');
  });

  it('leaves a finite chart untouched', () => {
    const spec: ChartSpec = { type: 'bar', title: 'B', points: [{ label: 'a', value: 1 }] };
    expect(finiteChart(spec)).toEqual(spec);
  });

  it('places a value at the far end of the double range without a NaN width', async () => {
    const pdf = await render({
      sections: chartSection({
        type: 'bar',
        title: 'B',
        points: [
          { label: 'huge', value: 1e308 },
          { label: 'tiny', value: 5e-324 },
        ],
      }),
    });
    expect(words(pdf)).not.toContain('NaN');
    expect(pageCount(pdf)).toBeGreaterThan(0);
  });

  it('accumulates a waterfall of extreme steps without producing a non-finite column', () => {
    const columns = waterfallColumns({ label: 's', value: 1e308 }, [{ label: 'a', value: 1e308 }], 'end');
    // The running total *may* saturate to Infinity; what it may not do is reach
    // the renderer, and `finiteChart` is upstream of that. This pins the
    // arithmetic so the guard's reason stays visible.
    expect(columns).toHaveLength(3);
    expect(Number.isNaN(columns[1]!.top)).toBe(false);
  });
});

// ── 5. notes and footnotes ────────────────────────────────────────────────────

describe('authored notes carrying other notations', () => {
  it('sets markdown, LaTeX and template syntax as the literal text it is', async () => {
    const pdf = await render({
      sections: [
        {
          heading: 'Notes',
          html:
            '<p>**not bold** and _not italic_ and `not code`.</p>' +
            '<p>\\begin{document}\\input{/etc/passwd}\\end{document}</p>' +
            '<p>{{unresolved_placeholder}} and ${shell} and #{ruby}.</p>',
        },
      ],
    });
    const text = words(pdf);
    expect(text).toContain('**not bold** and _not italic_ and `not code`.');
    expect(text).toContain('\\begin{document}\\input{/etc/passwd}\\end{document}');
    expect(text).toContain('{{unresolved_placeholder}} and ${shell} and #{ruby}.');
  });

  it('draws a chart note that is 400 characters of punctuation', async () => {
    const note = '(*) '.repeat(100).trim();
    const pdf = await render({
      sections: [
        {
          heading: 'Charts',
          html: '<p>x</p>',
          charts: [{ type: 'bar', title: 'B', points: [{ label: 'a', value: 1 }], note }],
        },
      ],
    });
    expect(pageCount(pdf)).toBeGreaterThan(0);
    expect(words(pdf)).toContain('(*) (*)');
  });
});

// ── 6. control characters and invisible input ─────────────────────────────────

describe('control characters, invisible characters and other paste artifacts', () => {
  it('removes a NUL rather than carrying it into the content stream', async () => {
    const pdf = await render({
      company_name: 'Acme\u0000 Robotics',
      sections: [{ heading: 'H', html: '<p>Line\u0000 one.</p>' }],
    });
    const text = words(pdf);
    expect(text).toContain('Acme Robotics');
    expect(text).toContain('Line one.');
    expect(text).not.toContain('\u0000');
  });

  it('removes zero-width characters and normalises odd spaces', async () => {
    const pdf = await render({
      sections: [{ heading: 'H', html: '<p>in\u200bvisible and thin\u2009spaced.</p>' }],
    });
    const text = words(pdf);
    expect(text).toContain('invisible and thin spaced.');
    expect(text).not.toMatch(/\u200b|\ufeff|\u2009/);
  });

  it('turns a stray BOM into a space rather than carrying it', async () => {
    // Not `fontSafe`'s doing, and worth pinning where it actually happens:
    // `htmlToBlocks` collapses runs of whitespace before anything else sees the
    // text, and JavaScript's `\s` includes U+FEFF. So a BOM pasted mid-word is
    // a word break by the time the zero-width sweep runs, and the sweep never
    // gets the chance to delete it. Visible, but not invisible \u2014 which is the
    // property that mattered.
    const text = words(await render({ sections: [{ heading: 'H', html: '<p>in\ufeffvisible</p>' }] }));
    expect(text).toContain('in visible');
    expect(text).not.toContain('\ufeff');
  });

  it('collapses an address written with newlines and tabs into a drawable line', async () => {
    const pdf = await render({
      sections: [{ heading: 'Address', html: '<p>1 Main St\nSuite 2\tFloor 3\r\nSpringfield</p>' }],
    });
    expect(words(pdf)).toContain('1 Main St Suite 2 Floor 3 Springfield');
  });

  it('keeps a bidirectional override from reordering the document around it', async () => {
    // U+202E is not a control character pdfkit strips and it has a glyph, so it
    // is drawn. What matters is that the text on either side is still there and
    // still in order — the renderer has no bidi engine and must not pretend to.
    const pdf = await render({ company_name: 'ACME‮evil' });
    const text = words(pdf);
    expect(text).toContain('ACME');
    expect(text).toContain('evil');
  });
});

// ── the character-level rules the above depend on ─────────────────────────────

describe('the primitives the renderer sanitizes with', () => {
  it('never splits a surrogate pair when breaking a long run', () => {
    // The bug: `slice` counts UTF-16 units, so a boundary that fell between the
    // halves of an astral character cut the character in two and put a soft
    // hyphen inside it. `fontSafe` then replaced both halves with `?`.
    for (const run of [
      'A' + '\u{1F600}'.repeat(100),
      '\u{1F600}'.repeat(100) + 'A',
      '\u{20BB7}'.repeat(90),
    ]) {
      const out = breakLongRuns(run);
      const lone = [...out].filter((ch) => {
        const code = ch.codePointAt(0)!;
        return code >= 0xd800 && code <= 0xdfff;
      });
      expect(lone, JSON.stringify(run.slice(0, 8))).toEqual([]);
      expect(out.replace(/­/g, '')).toBe(run);
    }
  });

  it('keeps a combining mark with the character it modifies', () => {
    const run = 'A' + 'é'.repeat(100);
    const out = breakLongRuns(run);
    expect(out).not.toMatch(/­\p{M}/u);
    expect(out.replace(/­/g, '')).toBe(run);
  });

  it('still bounds a chunk when the run is nothing but marks', () => {
    // The clause that keeps marks attached must not be able to swallow the
    // whole run — that is the quadratic fitting cost this function removes.
    const run = 'A' + '́'.repeat(4000);
    const chunks = breakLongRuns(run, 128).split('­');
    expect(chunks.length).toBeGreaterThan(20);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(128 + 16 + 1);
  });

  it('leaves an unresolvable numeric character reference as the text it was', () => {
    expect(decodeEntities('&#x110000;')).toBe('&#x110000;');
    expect(decodeEntities('&#99999999;')).toBe('&#99999999;');
    expect(decodeEntities('&notanentity;')).toBe('&notanentity;');
    expect(decodeEntities('&#65;&#x42;&amp;')).toBe('AB&');
  });

  it('replaces an unpaired surrogate arriving as an entity rather than emitting it', () => {
    expect(fontSafe(decodeEntities('&#xD800;'))).toBe('?');
  });
});

// ── 7. dates ──────────────────────────────────────────────────────────────────

describe('dates at the edges of what a Date can hold', () => {
  it.each([
    ['far future', new Date('9999-12-31T00:00:00Z')],
    ['before the platform existed', new Date('1900-01-01T00:00:00Z')],
    ['the unix epoch', new Date(0)],
  ])('stamps a %s generated_at into the document', async (_label, generated_at) => {
    const pdf = await render({ generated_at });
    expect(pdf.toString('latin1')).toMatch(/\/CreationDate/);
    expect(pageCount(pdf)).toBeGreaterThan(0);
  });

  it('renders a valuation date the caller states in words, whatever it says', async () => {
    // The renderer does not validate a date against an incorporation date —
    // that is the valuation service's rule and its 422. What it must not do is
    // refuse to draw one.
    const pdf = await render({
      meta: [
        { label: 'Valuation date', value: '2099-12-31' },
        { label: 'Incorporated', value: '2100-01-01' },
      ],
    });
    const text = words(pdf);
    expect(text).toContain('2099-12-31');
    expect(text).toContain('2100-01-01');
  });
});

// ── the whole document at once ────────────────────────────────────────────────

describe('a report where every field is hostile at the same time', () => {
  it('renders, parses, and reads back as what was written', async () => {
    const pdf = await renderReportPdf(
      {
        title: 'Rapport d’évaluation « 409A » — <b>final</b>',
        company_name: 'Ünïcödé & Sons ) Ltd\u0000',
        generated_at: new Date('2099-01-01T00:00:00Z'),
        confidentiality: 'Confidential \\ Privileged (draft)',
        keywords: ['a & b', '<c>', 'ü'],
        meta: [{ label: 'Ref', value: 'VAL-)-001' }],
        summary: {
          headline: { label: 'FMV', value: '$0.0001' },
          statement: 'Concluded at $0.0001 per share; see §4 & Exhibit H <as filed>.',
        },
        sections: [
          {
            heading: 'Conclusion & Certification',
            html:
              '<p>Value of <strong>Ünïcödé &amp; Sons</strong> at &lt;$0.0001&gt;.</p>' +
              `<p>${'Z'.repeat(400)}</p>` +
              '<table><tr><th>Class</th></tr><tr><td>Series A &amp; B</td></tr></table>',
            charts: [
              {
                type: 'bar',
                title: 'Approach',
                points: [
                  { label: 'Income', value: Number.NaN },
                  { label: 'Market', value: 1e12 },
                ],
              },
            ],
          },
        ],
      },
      { compress: false },
    );

    const text = words(pdf);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(pdf)).toBeGreaterThan(1);
    expect(text).toContain('Ünïcödé & Sons ) Ltd');
    expect(text).toContain('Value of Ünïcödé & Sons at <$0.0001>.');
    expect(text).toContain('Series A & B');
    expect(text).toContain('Concluded at $0.0001 per share; see §4 & Exhibit H <as filed>.');
    expect(text).toContain('Z'.repeat(120));
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('\u0000');
  });
});
