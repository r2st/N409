import { describe, expect, it } from 'vitest';
import {
  ALT_MAX_POINTS,
  SUMMARY_HEADING,
  TOC_HEADING,
  chartAltText,
  headingTag,
  renderReportPdf,
  summaryFigureText,
  unsignedFigure,
  type ChartSpec,
  type ReportPdfInput,
} from '../src/pdf.js';
import { contentStreams, readPdf, type PdfReader } from './support/pdfText.js';

/**
 * The report as assistive technology receives it.
 *
 * A 409A report is delivered to boards, auditors and regulators, and some of
 * them read it with a screen reader. Untagged, a PDF is a bag of positioned
 * glyphs: the reading order is guessed from coordinates, a cap table becomes
 * rows of unassociated numbers, and the charts — vector paths with no text
 * behind them — are simply not there. None of that is visible on any page,
 * which is exactly why it rots unless something asserts on it.
 */

// ── reading the structure tree back out of the bytes ──────────────────────────

/** A PDF string, whether written literally or as a UTF-16BE hex run. */
function pdfString(raw: string): string {
  if (raw.startsWith('<')) {
    const hex = raw.slice(1, -1).replace(/\s+/g, '');
    const bytes = Buffer.from(hex, 'hex');
    return bytes.subarray(0, 2).toString('hex') === 'feff'
      ? bytes.subarray(2).swap16().toString('utf16le')
      : bytes.toString('latin1');
  }
  return raw.slice(1, -1).replace(/\\([()\\])/g, '$1');
}

const STRING = String.raw`\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]*>`;

interface StructNode {
  type: string;
  alt?: string;
  actual?: string;
  title?: string;
  /** The `/A` attribute dictionary, flattened to `key -> value` text. */
  attributes: Record<string, string>;
  children: StructNode[];
}

/** Parses the document's structure tree — the thing a screen reader walks. */
function structTree(pdf: Buffer): StructNode {
  const raw = pdf.toString('latin1');
  const objects = new Map<string, string>();
  for (const m of raw.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)) objects.set(m[1]!, m[2]!);

  const root = [...objects.entries()].find(([, body]) => body.includes('/Type /StructTreeRoot'));
  if (!root) throw new Error('no StructTreeRoot: the document is not tagged');

  const build = (id: string): StructNode => {
    const body = objects.get(id) ?? '';
    const attributes: Record<string, string> = {};
    const attrRef = /\/A (\d+) 0 R/.exec(body);
    if (attrRef) {
      for (const m of (objects.get(attrRef[1]!) ?? '').matchAll(/\/(\w+) \/?(\w+)/g)) {
        attributes[m[1]!] = m[2]!;
      }
    }
    const str = (key: string): string | undefined => {
      const m = new RegExp(`/${key} (${STRING})`).exec(body);
      return m ? pdfString(m[1]!) : undefined;
    };
    // /K holds structure element references and bare MCIDs; only the former
    // are nodes. Anything inside a nested dictionary (an /A attribute set, a
    // marked-content reference) is skipped by taking only top-level refs.
    const kids = /\/K \[([\s\S]*?)\]/.exec(body);
    const children = kids
      ? Array.from(kids[1]!.matchAll(/(\d+) 0 R/g))
          .map((m) => m[1]!)
          .filter((child) => (objects.get(child) ?? '').includes('/S /'))
          .map(build)
      : [];
    return {
      type: /\/S \/(\w+)/.exec(body)?.[1] ?? 'StructTreeRoot',
      ...(str('Alt') !== undefined ? { alt: str('Alt') } : {}),
      ...(str('ActualText') !== undefined ? { actual: str('ActualText') } : {}),
      ...(str('T') !== undefined ? { title: str('T') } : {}),
      attributes,
      children,
    };
  };

  const rootKids = /\/K \[([\s\S]*?)\]/.exec(root[1]);
  const documents = Array.from(rootKids?.[1]?.matchAll(/(\d+) 0 R/g) ?? []).map((m) => build(m[1]!));
  expect(documents, 'exactly one Document element').toHaveLength(1);
  return documents[0]!;
}

/** Every node of `type`, in reading order. */
function nodesOfType(node: StructNode, type: string): StructNode[] {
  const found = node.type === type ? [node] : [];
  return found.concat(node.children.flatMap((child) => nodesOfType(child, type)));
}

/** Every structure type in reading order, depth-first. */
function typeOrder(node: StructNode): string[] {
  return [node.type, ...node.children.flatMap(typeOrder)];
}

/**
 * Text drawn inside `/Artifact` regions, and text drawn outside them —
 * i.e. what a screen reader skips versus what it reads.
 */
function partitionByArtifact(stream: string, doc: PdfReader): { artifact: string; content: string } {
  let depth = 0;
  let artifactDepth = 0;
  let font = '';
  const parts = { artifact: '', content: '' };
  // Operators, face selections and hex text runs, in order. The face has to be
  // tracked because the glyph codes in a run are indices into that face's
  // subset and say nothing on their own.
  const tokens = /\/Artifact|(?:^|\s)(BDC|BMC|EMC)(?=\s|$)|\/(F\d+) [\d.]+ Tf|<[0-9a-fA-F]+>/gm;
  for (const token of stream.matchAll(tokens)) {
    const text = token[0]!;
    if (text === '/Artifact') {
      // The tag precedes its BDC, so remember that the region about to open is
      // an artifact one.
      artifactDepth = artifactDepth || depth + 1;
    } else if (token[1] === 'EMC') {
      if (artifactDepth === depth) artifactDepth = 0;
      depth -= 1;
    } else if (token[1]) {
      depth += 1;
    } else if (token[2]) {
      font = token[2];
    } else {
      const decoded = doc.decode(text, font);
      if (artifactDepth > 0) parts.artifact += decoded;
      else parts.content += decoded;
    }
  }
  return parts;
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const base: ReportPdfInput = {
  title: 'IRC 409A Valuation Report',
  company_name: 'Acme Robotics, Inc',
  meta: [
    { label: 'Valuation date', value: '2026-06-30' },
    { label: 'Reference', value: 'ACME-2026-01' },
  ],
  sections: [{ heading: 'Introduction', html: '<p>Body copy.</p>' }],
};

const waterfall: ChartSpec = {
  type: 'waterfall',
  title: 'Value bridge',
  start: { label: 'Marketable common', value: 10 },
  steps: [
    { label: 'DLOC', value: -1.2 },
    { label: 'DLOM', value: -2.5 },
  ],
  end_label: 'Fair market value',
  note: 'Discounts applied in order.',
};

// ── alternative text ──────────────────────────────────────────────────────────

describe('chartAltText', () => {
  it('describes a bar chart by its bars', () => {
    const alt = chartAltText({
      type: 'bar',
      title: 'Equity value by approach',
      points: [
        { label: 'Income', value: 12_500_000 },
        { label: 'Market', value: 14_200_000, display: '$14.2m' },
      ],
    });
    expect(alt).toContain('Bar chart');
    expect(alt).toContain('Equity value by approach');
    expect(alt).toContain('2 bars');
    expect(alt).toContain('Income 12.50m');
    // An explicit display string wins over the default formatting.
    expect(alt).toContain('Market $14.2m');
  });

  it('reads a waterfall as a bridge, with reductions named as reductions', () => {
    const alt = chartAltText(waterfall);
    expect(alt).toContain('Starts at Marketable common 10.00');
    // The whole point of the shape: a discount has to be audible as one.
    expect(alt).toContain('less DLOC');
    expect(alt).toContain('less DLOM');
    expect(alt).toContain('ends at Fair market value 6.30');
    // The caption qualifies the numbers, so it travels with them.
    expect(alt).toContain('Discounts applied in order.');
  });

  it('names an increase as an increase', () => {
    const alt = chartAltText({
      type: 'waterfall',
      title: 'Bridge',
      start: { label: 'Start', value: 10 },
      steps: [{ label: 'Option pool', value: 2 }],
      end_label: 'End',
    });
    expect(alt).toContain('plus Option pool');
    expect(alt).not.toContain('less Option pool');
  });

  it('does not stutter over a label that already states its direction', () => {
    // What the engine actually emits: the label leads with "Less" and the
    // display carries a U+2212. Prefixing our own word and keeping the sign
    // gives "less Less DLOC 5.0% −$0.4500" — heard as a double negative.
    const alt = chartAltText({
      type: 'waterfall',
      title: 'From marketable value to fair market value',
      start: { label: 'Marketable common', value: 9.0, display: '$9.0000' },
      steps: [
        { label: 'Less DLOC 5.0%', value: -0.45, display: '−$0.4500' },
        { label: 'Less DLOM 25.0%', value: -2.1375, display: '−$2.1375' },
      ],
      end_label: 'Concluded FMV',
      end_value: 6.4125,
      end_display: '$6.4125',
    });
    expect(alt).toContain('Less DLOC 5.0% $0.4500');
    expect(alt).not.toContain('less Less');
    expect(alt).not.toContain('−$0.4500');
    expect(alt).toContain('ends at Concluded FMV $6.4125');
  });

  it('strips a sign the spoken direction already carries', () => {
    const alt = chartAltText({
      type: 'waterfall',
      title: 'Bridge',
      start: { label: 'Start', value: 10 },
      steps: [
        { label: 'DLOM', value: -3, display: '-$3.00' },
        { label: 'Accounting notation', value: -1, display: '($1.00)' },
      ],
      end_label: 'End',
    });
    expect(alt).toContain('less DLOM $3.00');
    expect(alt).toContain('less Accounting notation $1.00');
  });

  it('only suppresses the prefix when the label *leads* with the direction', () => {
    // "Value after less-liquid comps" contains "less" but does not begin with
    // it, so the step still needs its own direction word or the reduction is
    // never announced as one.
    const alt = chartAltText({
      type: 'waterfall',
      title: 'Bridge',
      start: { label: 'Start', value: 10 },
      steps: [{ label: 'Value after less-liquid comps', value: -2, display: '2.00' }],
      end_label: 'End',
    });
    expect(alt).toContain('less Value after less-liquid comps 2.00');
  });

  it('gives donut segments their share of the whole', () => {
    const alt = chartAltText({
      type: 'donut',
      title: 'Approach weighting',
      slices: [
        { label: 'Income', value: 60 },
        { label: 'Market', value: 40 },
      ],
      center: '100%',
    });
    expect(alt).toContain('2 segments');
    expect(alt).toContain('(60.0%)');
    expect(alt).toContain('(40.0%)');
    expect(alt).toContain('Centre: 100%');
  });

  it('states the trend of a time series rather than leaving it to be inferred', () => {
    const rising = chartAltText({
      type: 'line',
      title: 'FMV history',
      points: [
        { label: '2024', value: 1 },
        { label: '2025', value: 2 },
      ],
    });
    expect(rising).toContain('Overall rising from');
    const falling = chartAltText({
      type: 'line',
      title: 'FMV history',
      points: [
        { label: '2024', value: 2 },
        { label: '2025', value: 1 },
      ],
    });
    expect(falling).toContain('Overall falling from');
    const flat = chartAltText({
      type: 'line',
      title: 'FMV history',
      points: [
        { label: '2024', value: 2 },
        { label: '2025', value: 2 },
      ],
    });
    expect(flat).toContain('Overall unchanged from');
  });

  it('truncates a long series instead of reading thirty names aloud', () => {
    const points = Array.from({ length: ALT_MAX_POINTS + 7 }, (_, i) => ({
      label: `Comp ${i + 1}`,
      value: i + 1,
    }));
    const alt = chartAltText({ type: 'bar', title: 'Comparables', points });
    expect(alt).toContain(`Comp ${ALT_MAX_POINTS}`);
    expect(alt).not.toContain(`Comp ${ALT_MAX_POINTS + 1} `);
    expect(alt).toContain('and 7 further points');
    // The count is still the true one, so a listener knows what was withheld.
    expect(alt).toContain(`${ALT_MAX_POINTS + 7} bars`);
  });

  it('truncates a long bridge too — a roll-forward can have dozens of steps', () => {
    const steps = Array.from({ length: ALT_MAX_POINTS + 4 }, (_, i) => ({
      label: `Adjustment ${i + 1}`,
      value: -(i + 1),
    }));
    const alt = chartAltText({
      type: 'waterfall',
      title: 'Bridge',
      start: { label: 'Start', value: 500 },
      steps,
      end_label: 'End',
    });
    expect(alt).toContain(`Adjustment ${ALT_MAX_POINTS}`);
    expect(alt).not.toContain(`Adjustment ${ALT_MAX_POINTS + 1}`);
    expect(alt).toContain('and 4 further steps');
    // The total is still stated, so a truncated list never hides the answer.
    expect(alt).toContain('ends at End');
  });

  it('truncates a long donut legend', () => {
    const slices = Array.from({ length: ALT_MAX_POINTS + 2 }, (_, i) => ({
      label: `Slice ${i + 1}`,
      value: i + 1,
    }));
    const alt = chartAltText({ type: 'donut', title: 'Mix', slices });
    expect(alt).toContain('and 2 further segments');
    expect(alt).toContain(`${ALT_MAX_POINTS + 2} segments`);
  });

  it('truncates a long time series', () => {
    const points = Array.from({ length: ALT_MAX_POINTS + 3 }, (_, i) => ({
      label: `Q${i + 1}`,
      value: i + 1,
    }));
    const alt = chartAltText({ type: 'line', title: 'History', points });
    expect(alt).toContain('and 3 further points');
    // The trend spans the whole series, not just the part that was read out.
    expect(alt).toContain(`to ${ALT_MAX_POINTS + 3}.00 at Q${ALT_MAX_POINTS + 3}`);
  });

  it('says a chart is empty rather than describing nothing', () => {
    expect(chartAltText({ type: 'donut', title: 'Weighting', slices: [] })).toContain(
      'No positive values to plot',
    );
    expect(chartAltText({ type: 'line', title: 'History', points: [] })).toContain('No data to plot');
    expect(chartAltText({ type: 'bar', title: 'Approaches', points: [] })).toContain('no data');
  });

  it('describes every chart shape the renderer can draw', () => {
    // A new ChartSpec variant that falls through here would render as a silent
    // figure, which is the failure this whole file exists to prevent.
    const specs: ChartSpec[] = [
      { type: 'bar', title: 'B', points: [{ label: 'a', value: 1 }] },
      { type: 'donut', title: 'D', slices: [{ label: 'a', value: 1 }] },
      { type: 'line', title: 'L', points: [{ label: 'a', value: 1 }] },
      waterfall,
    ];
    for (const spec of specs) {
      const alt = chartAltText(spec);
      expect(alt.length, `${spec.type} has no alternative text`).toBeGreaterThan(20);
      expect(alt).toContain(spec.title);
    }
  });
});

describe('unsignedFigure', () => {
  it('strips every notation the platform writes a negative in', () => {
    expect(unsignedFigure('−$0.4500')).toBe('$0.4500'); // U+2212, what the engine emits
    expect(unsignedFigure('-$3.00')).toBe('$3.00');
    expect(unsignedFigure('($1.00)')).toBe('$1.00');
    expect(unsignedFigure('–4')).toBe('4'); // en dash
    expect(unsignedFigure('+2.5%')).toBe('2.5%');
  });

  it('leaves an unsigned figure alone, including one with an inner hyphen', () => {
    expect(unsignedFigure('$1,234.00')).toBe('$1,234.00');
    expect(unsignedFigure('12.5x')).toBe('12.5x');
    expect(unsignedFigure('FY24-25')).toBe('FY24-25');
  });
});

describe('headingTag', () => {
  it('maps a depth to its PDF heading type', () => {
    expect(headingTag(1)).toBe('H1');
    expect(headingTag(4)).toBe('H4');
  });

  it('clamps rather than emitting a heading type PDF does not define', () => {
    expect(headingTag(7)).toBe('H6');
    expect(headingTag(0)).toBe('H1');
    expect(headingTag(-3)).toBe('H1');
  });
});

describe('summaryFigureText', () => {
  it('reads a label and value as one fact', () => {
    expect(summaryFigureText({ label: 'Fair market value', value: '$1.23' })).toBe(
      'Fair market value: $1.23',
    );
  });

  it('carries the note and does not double the punctuation', () => {
    expect(summaryFigureText({ label: 'Equity value:', value: '$45m', note: 'Post-money.' })).toBe(
      'Equity value: $45m. Post-money.',
    );
  });
});

// ── the tagged document ───────────────────────────────────────────────────────

describe('the rendered document is tagged', () => {
  it('declares a structure tree and a version that can hold one', async () => {
    const pdf = await renderReportPdf(base, { compress: false });
    const raw = pdf.toString('latin1');
    expect(raw).toMatch(/^%PDF-1\.7/);
    expect(raw).toContain('/Marked true');
    expect(raw).toContain('/StructTreeRoot');
    // Reverse lookup, content back to structure: without it a reader cannot
    // answer "what am I inside?" for the text under the cursor.
    expect(raw).toContain('/ParentTree');
    expect(raw).toMatch(/\/StructParents \d+/);
  });

  it('does not claim PDF/UA conformance it cannot meet with unembedded fonts', async () => {
    const pdf = await renderReportPdf(base, { compress: false });
    // The standard-14 faces are not embedded, which PDF/UA-1 requires. A false
    // conformance claim tells a procurement reviewer not to run the check that
    // would have failed.
    expect(pdf.toString('latin1')).not.toContain('pdfuaid');
  });

  it('balances every marked-content region on every page', async () => {
    const pdf = await renderReportPdf(
      {
        ...base,
        summary: { headline: { label: 'FMV', value: '$1.23' } },
        sections: Array.from({ length: 6 }, (_, i) => ({
          heading: `Section ${i + 1}`,
          html: '<p>Prose.</p><ul><li>item</li></ul><table><tr><th>H</th></tr><tr><td>1</td></tr></table>'.repeat(
            3,
          ),
          charts: [waterfall],
        })),
      },
      { compress: false },
    );
    const streams = contentStreams(pdf);
    expect(streams.length).toBeGreaterThan(4);
    streams.forEach((stream, i) => {
      let depth = 0;
      let lowest = 0;
      for (const t of stream.matchAll(/(?:^|\s)(BDC|BMC|EMC)(?=\s|$)/gm)) {
        depth += t[1] === 'EMC' ? -1 : 1;
        lowest = Math.min(lowest, depth);
      }
      // An unbalanced page is a corrupt content stream, not a cosmetic fault:
      // it is the failure mode of a region left open across a page break.
      expect(depth, `page ${i + 1} leaves ${depth} region(s) open`).toBe(0);
      expect(lowest, `page ${i + 1} closes a region it never opened`).toBe(0);
    });
  });

  it('keeps a region balanced when one element spans a page break', async () => {
    // A comparable-company chart taller than the page it starts on: the Figure
    // opens on one page and closes on another. A marked-content region cannot
    // cross a page boundary in the file — it has to be closed at the end of one
    // content stream and reopened at the top of the next — so this is where an
    // unbalanced stream would come from, and an unbalanced stream is a corrupt
    // page rather than a cosmetic fault.
    const points = Array.from({ length: 45 }, (_, i) => ({
      label: `Comparable company ${i + 1}`,
      value: (i + 1) * 1_000_000,
    }));
    const pdf = await renderReportPdf(
      {
        ...base,
        sections: [
          {
            heading: 'Comparables',
            html: '<p>Intro.</p>',
            charts: [{ type: 'bar', title: 'EV/Revenue', points }],
          },
        ],
      },
      { compress: false },
    );
    const streams = contentStreams(pdf);
    expect(streams.length, 'the chart fitted on one page, so this proves nothing').toBeGreaterThan(2);
    streams.forEach((stream, i) => {
      let depth = 0;
      let lowest = 0;
      for (const t of stream.matchAll(/(?:^|\s)(BDC|BMC|EMC)(?=\s|$)/gm)) {
        depth += t[1] === 'EMC' ? -1 : 1;
        lowest = Math.min(lowest, depth);
      }
      expect(depth, `page ${i + 1} leaves ${depth} region(s) open`).toBe(0);
      expect(lowest, `page ${i + 1} closes a region it never opened`).toBe(0);
    });
    // Still one figure with one description, not one per page it touched.
    const figures = nodesOfType(structTree(pdf), 'Figure');
    expect(figures).toHaveLength(1);
    expect(figures[0]!.alt).toContain('45 bars');
  });

  it('numbers marked content uniquely within each page', async () => {
    const pdf = await renderReportPdf(
      { ...base, sections: [{ heading: 'S', html: '<p>a</p><p>b</p><p>c</p>' }] },
      { compress: false },
    );
    for (const [i, stream] of contentStreams(pdf).entries()) {
      const ids = Array.from(stream.matchAll(/\/MCID (\d+)/g)).map((m) => Number(m[1]));
      // A duplicate MCID points two structure elements at the same content.
      expect(new Set(ids).size, `page ${i + 1} reuses an MCID`).toBe(ids.length);
    }
  });
});

describe('reading order', () => {
  const longEnoughForToc: ReportPdfInput = {
    ...base,
    summary: { headline: { label: 'FMV', value: '$1.23' }, statement: 'We conclude.' },
    sections: Array.from({ length: 5 }, (_, i) => ({
      heading: `Chapter ${i + 1}`,
      html: `<p>Body ${i + 1}.</p>`,
    })),
  };

  it('places the contents before the sections, though it is written last', async () => {
    // The contents pages are reserved up front and filled in only once the
    // section page numbers are known — after the last section is laid out. Tag
    // them where they are written and a screen reader reads the whole report
    // and then the contents.
    const tree = structTree(await renderReportPdf(longEnoughForToc, { compress: false }));
    const order = typeOrder(tree);
    expect(order).toContain('TOC');
    expect(order.indexOf('TOC')).toBeLessThan(order.indexOf('Sect'));
    // And the cover comes before both.
    expect(order.indexOf('Title')).toBeLessThan(order.indexOf('TOC'));
  });

  it('gives one Sect per section plus one for the summary, in document order', async () => {
    const tree = structTree(await renderReportPdf(longEnoughForToc, { compress: false }));
    const sects = tree.children.filter((c) => c.type === 'Sect');
    expect(sects).toHaveLength(6); // summary + 5 chapters
    expect(sects.slice(1).map((s) => s.title)).toEqual([
      'Chapter 1',
      'Chapter 2',
      'Chapter 3',
      'Chapter 4',
      'Chapter 5',
    ]);
  });

  it('spells out each contents entry instead of reading the dot leader', async () => {
    const tree = structTree(await renderReportPdf(longEnoughForToc, { compress: false }));
    const entries = nodesOfType(tree, 'TOCI');
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.actual).toMatch(/, page \d+$/);
      // Sixty literal full stops, read aloud, is the alternative.
      expect(entry.actual).not.toContain('....');
    }
    expect(entries[0]!.actual).toContain(SUMMARY_HEADING);
  });

  it('keeps each cover fact with the label that names it', async () => {
    const tree = structTree(await renderReportPdf(base, { compress: false }));
    const actuals = tree.children.filter((c) => c.actual).map((c) => c.actual);
    expect(actuals).toContain('Valuation date: 2026-06-30');
    expect(actuals).toContain('Reference: ACME-2026-01');
  });
});

describe('element roles', () => {
  it('sets the section heading as H1 and steps prose headings below it', async () => {
    const pdf = await renderReportPdf(
      {
        ...base,
        sections: [{ heading: 'Analysis', html: '<h1>Method</h1><p>a</p><h2>Detail</h2><h3>Finer</h3>' }],
      },
      { compress: false },
    );
    const sect = structTree(pdf).children.find((c) => c.type === 'Sect')!;
    // The section's own heading owns H1; an <h1> inside its prose is a level
    // down, so the outline never skips and never has two competing tops.
    expect(sect.children.map((c) => c.type)).toEqual(['H1', 'H2', 'P', 'H3', 'H4']);
  });

  it('marks a table up as a table, with its header cells scoped to their column', async () => {
    const pdf = await renderReportPdf(
      {
        ...base,
        sections: [
          {
            heading: 'Cap table',
            html: '<table><tr><th>Holder</th><th>Shares</th></tr><tr><td>Founders</td><td>1,000</td></tr><tr><td>Series A</td><td>500</td></tr></table>',
          },
        ],
      },
      { compress: false },
    );
    const table = nodesOfType(structTree(pdf), 'Table')[0]!;
    expect(table.children.map((r) => r.type)).toEqual(['TR', 'TR', 'TR']);
    const [header, ...body] = table.children;
    expect(header!.children.map((c) => c.type)).toEqual(['TH', 'TH']);
    // /Scope is what lets a reader ask which heading governs the cell they are
    // on — the question a column of figures exists to answer.
    for (const cell of header!.children) {
      expect(cell.attributes.Scope).toBe('Column');
      expect(cell.attributes.O).toBe('Table');
    }
    for (const row of body) expect(row.children.map((c) => c.type)).toEqual(['TD', 'TD']);
  });

  it('marks a list up as a list, and a pull quote as a quotation', async () => {
    const pdf = await renderReportPdf(
      {
        ...base,
        sections: [
          { heading: 'S', html: '<ol><li>first</li><li>second</li></ol><blockquote>Quoted.</blockquote>' },
        ],
      },
      { compress: false },
    );
    const tree = structTree(pdf);
    const list = nodesOfType(tree, 'L')[0]!;
    expect(list.children.map((c) => c.type)).toEqual(['LI', 'LI']);
    for (const item of list.children) expect(item.children.map((c) => c.type)).toEqual(['LBody']);
    // The indent is the only cue a sighted reader gets; it is invisible to
    // everyone else unless the quotation says it is one.
    const quote = nodesOfType(tree, 'BlockQuote')[0]!;
    expect(quote.children.map((c) => c.type)).toEqual(['P']);
  });

  it('gives every chart a Figure carrying its data as alternative text', async () => {
    const pdf = await renderReportPdf(
      { ...base, sections: [{ heading: 'Conclusion', html: '<p>a</p>', charts: [waterfall] }] },
      { compress: false },
    );
    const figures = nodesOfType(structTree(pdf), 'Figure');
    expect(figures).toHaveLength(1);
    expect(figures[0]!.alt).toBe(chartAltText(waterfall));
    expect(figures[0]!.alt).toContain('less DLOM');
  });

  it('tags the summary charts too, not only the section ones', async () => {
    const pdf = await renderReportPdf(
      {
        ...base,
        summary: { headline: { label: 'FMV', value: '$1.23' }, charts: [waterfall] },
      },
      { compress: false },
    );
    expect(nodesOfType(structTree(pdf), 'Figure')).toHaveLength(1);
  });
});

describe('page furniture stays out of the reading order', () => {
  it('marks the running head and footer as artifacts', async () => {
    const pdf = await renderReportPdf(
      {
        ...base,
        confidentiality: 'Confidential',
        sections: Array.from({ length: 5 }, (_, i) => ({
          heading: `Chapter ${i + 1}`,
          html: `<p>Body ${i + 1}.</p>`,
        })),
      },
      { compress: false },
    );
    const doc = readPdf(pdf);
    const streams = doc.streams;
    // Skip the cover, which carries no running head.
    const bodyPages = streams.slice(1);
    expect(bodyPages.length).toBeGreaterThan(1);
    for (const [i, stream] of bodyPages.entries()) {
      const { artifact, content } = partitionByArtifact(stream, doc);
      expect(artifact, `page ${i + 2} footer is not an artifact`).toMatch(/Page \d+ of \d+/);
      expect(artifact).toContain('Confidential');
      // Read as content, the company name, the title, "Confidential" and a
      // page number are announced between every two paragraphs of analysis.
      expect(content, `page ${i + 2} reads its footer aloud`).not.toMatch(/Page \d+ of \d+/);
    }
    // The text is still in the file for a sighted reader and for search.
    expect(doc.text(streams[1]!)).toMatch(/Page \d+ of \d+/);
  });

  it('leaves the table continuation marker out of the table', async () => {
    // "Table continued" is an artifact of where the page broke, not a row.
    const rows = Array.from(
      { length: 90 },
      (_, i) => `<tr><td>Holder ${i + 1}</td><td>${i * 11}</td></tr>`,
    ).join('');
    const pdf = await renderReportPdf(
      {
        ...base,
        sections: [
          { heading: 'Cap table', html: `<table><tr><th>Holder</th><th>Shares</th></tr>${rows}</table>` },
        ],
      },
      { compress: false },
    );
    const table = nodesOfType(structTree(pdf), 'Table')[0]!;
    // One header row per page the table spans, plus every body row — and
    // nothing else.
    expect(table.children.every((r) => r.type === 'TR')).toBe(true);
    const cells = table.children.flatMap((r) => r.children);
    expect(cells.every((c) => c.type === 'TH' || c.type === 'TD')).toBe(true);
    expect(cells.filter((c) => c.type === 'TD')).toHaveLength(180);

    const marked = readPdf(pdf);
    const continuation = marked.streams
      .map((s) => partitionByArtifact(s, marked))
      .filter((p) => p.artifact.includes('Table continued'));
    expect(continuation.length, 'the table never broke, so this proves nothing').toBeGreaterThan(0);
    for (const page of continuation) expect(page.content).not.toContain('Table continued');
  });

  it('does not tag the cover logo as a figure needing a description', async () => {
    // A 1×1 PNG: the smallest thing that decodes.
    const logo = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const pdf = await renderReportPdf(
      { ...base, branding: { partner_name: 'Bright Line Advisors', logo } },
      { compress: false },
    );
    // The firm is named in words on the next line, so a Figure here would only
    // make a reader hear the name twice.
    expect(nodesOfType(structTree(pdf), 'Figure')).toHaveLength(0);
    const cover = readPdf(pdf);
    expect(cover.text(cover.streams[0]!)).toContain('Bright Line Advisors');
  });
});

describe('degenerate documents still produce a usable tree', () => {
  it('tags a report with no sections at all', async () => {
    const tree = structTree(await renderReportPdf({ ...base, sections: [] }, { compress: false }));
    expect(tree.type).toBe('Document');
    expect(tree.children.map((c) => c.type)).toContain('Title');
    // No sections means no contents to enumerate, and an empty TOC element
    // would be a container a reader can enter and find nothing in.
    expect(typeOrder(tree)).not.toContain('TOC');
  });

  it('tags a section whose prose is empty', async () => {
    const tree = structTree(
      await renderReportPdf({ ...base, sections: [{ heading: 'Empty', html: '' }] }, { compress: false }),
    );
    const sect = tree.children.find((c) => c.type === 'Sect')!;
    expect(sect.children.map((c) => c.type)).toEqual(['H1']);
  });

  it('keeps the contents heading tagged when the report has one', async () => {
    const pdf = await renderReportPdf(
      {
        ...base,
        sections: Array.from({ length: 5 }, (_, i) => ({ heading: `C${i + 1}`, html: '<p>x</p>' })),
      },
      { compress: false },
    );
    const toc = nodesOfType(structTree(pdf), 'TOC')[0]!;
    expect(toc.children[0]!.type).toBe('H1');
    const doc = readPdf(pdf);
    expect(doc.text(doc.streams[1]!)).toContain(TOC_HEADING);
  });
});
