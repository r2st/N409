import { describe, expect, it } from 'vitest';
import {
  chartHeight,
  donutColor,
  donutSegments,
  linePlot,
  renderReportPdf,
  type ChartSpec,
  type ReportPdfInput,
} from '../src/pdf.js';
import { extractText } from './support/pdfText.js';

/**
 * The two chart shapes added for composition and for trend.
 *
 * The geometry is tested as pure functions — angles, normalised coordinates,
 * ordering — because those are the parts that can be silently wrong in a PDF
 * nobody opens. The render pass then only has to prove the labels reach the
 * page and that a degenerate series does not take the document down with it.
 */

const BASE: ReportPdfInput = {
  title: 'IRC 409A Valuation Report',
  company_name: 'Acme Robotics, Inc.',
  meta: [],
  sections: [{ heading: 'Conclusion', html: '<p>See charts.</p>' }],
};

const withChart = (chart: ChartSpec): ReportPdfInput => ({
  ...BASE,
  sections: [{ heading: 'Conclusion', html: '<p>See charts.</p>', charts: [chart] }],
});

const TAU = Math.PI * 2;

describe('donutSegments', () => {
  const slices = [
    { label: 'Market', value: 0.3 },
    { label: 'OPM backsolve', value: 0.5 },
    { label: 'Income', value: 0.2 },
  ];

  it('orders slices largest first, starting at twelve o’clock', () => {
    const segments = donutSegments(slices);
    expect(segments.map((s) => s.label)).toEqual(['OPM backsolve', 'Market', 'Income']);
    expect(segments[0]!.start).toBe(0);
  });

  it('closes the ring exactly', () => {
    const segments = donutSegments(slices);
    expect(segments.at(-1)!.end).toBeCloseTo(TAU, 10);
    // Each slice picks up where the last left off — a gap would render as a
    // white wedge that looks like missing data.
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]!.start).toBeCloseTo(segments[i - 1]!.end, 10);
    }
  });

  it('normalises to the total, so raw values work as well as weights', () => {
    const fromRaw = donutSegments([
      { label: 'a', value: 50_000_000 },
      { label: 'b', value: 50_000_000 },
    ]);
    expect(fromRaw.map((s) => s.fraction)).toEqual([0.5, 0.5]);
    expect(fromRaw[0]!.end).toBeCloseTo(Math.PI, 10);
  });

  it('labels each slice with its share by default', () => {
    expect(donutSegments(slices)[0]!.display).toBe('50.0%');
  });

  it('honours an explicit display string', () => {
    expect(donutSegments([{ label: 'a', value: 1, display: '70%' }])[0]!.display).toBe('70%');
  });

  it('drops zero, negative and non-finite slices', () => {
    // A zero-weight approach was not used. Rendering it as an invisible sliver
    // with a legend entry would claim it was.
    const segments = donutSegments([
      { label: 'used', value: 1 },
      { label: 'unused', value: 0 },
      { label: 'nonsense', value: -1 },
      { label: 'broken', value: Number.NaN },
    ]);
    expect(segments.map((s) => s.label)).toEqual(['used']);
    expect(segments[0]!.fraction).toBe(1);
  });

  it('returns nothing rather than dividing by zero', () => {
    expect(donutSegments([])).toEqual([]);
    expect(donutSegments([{ label: 'a', value: 0 }])).toEqual([]);
  });
});

describe('donutColor', () => {
  it('gives the dominant slice the brand accent and the rest a grey ramp', () => {
    // The report is printed and photocopied; the series has to separate on
    // lightness alone.
    expect(donutColor(0, '#12936f')).toBe('#12936f');
    expect(donutColor(1, '#12936f')).not.toBe('#12936f');
    expect(donutColor(1, '#12936f')).not.toBe(donutColor(2, '#12936f'));
  });

  it('wraps rather than running out of colours', () => {
    expect(donutColor(99, '#12936f')).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('linePlot', () => {
  const points = [
    { label: '2023-06-30', value: 1.0 },
    { label: '2024-06-30', value: 1.42 },
    { label: '2025-06-30', value: 1.87 },
  ];

  it('spreads points evenly from the left edge to the right', () => {
    expect(linePlot(points).points.map((p) => p.x)).toEqual([0, 0.5, 1]);
  });

  it('pads the band so the extremes are not drawn on the frame', () => {
    const plot = linePlot(points);
    expect(plot.min).toBeLessThan(1.0);
    expect(plot.max).toBeGreaterThan(1.87);
    expect(plot.points[0]!.y).toBeGreaterThan(0);
    expect(plot.points.at(-1)!.y).toBeLessThan(1);
  });

  it('places a higher value higher up the band', () => {
    const ys = linePlot(points).points.map((p) => p.y);
    expect(ys[0]!).toBeLessThan(ys[1]!);
    expect(ys[1]!).toBeLessThan(ys[2]!);
  });

  it('centres a flat series instead of dividing by a zero range', () => {
    // An unchanged FMV is ordinary. A line pinned to the axis reads as an
    // empty chart, and NaN coordinates take the whole render down.
    const plot = linePlot([
      { label: 'a', value: 2 },
      { label: 'b', value: 2 },
    ]);
    for (const p of plot.points) {
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.y).toBeCloseTo(0.5, 10);
    }
  });

  it('handles an all-zero series', () => {
    const plot = linePlot([
      { label: 'a', value: 0 },
      { label: 'b', value: 0 },
    ]);
    expect(plot.points.every((p) => Number.isFinite(p.y))).toBe(true);
  });

  it('centres a lone point', () => {
    expect(linePlot([{ label: 'a', value: 5 }]).points[0]!.x).toBe(0.5);
  });

  it('drops non-finite values and copes with none at all', () => {
    expect(linePlot([{ label: 'a', value: Number.NaN }]).points).toEqual([]);
    expect(linePlot([])).toEqual({ points: [], min: 0, max: 0 });
  });

  it('honours an explicit display string, defaulting to compact formatting', () => {
    const plot = linePlot([
      { label: 'a', value: 1.42, display: '$1.4200' },
      { label: 'b', value: 2_500_000 },
    ]);
    expect(plot.points[0]!.display).toBe('$1.4200');
    expect(plot.points[1]!.display).toBe('2.50m');
  });
});

describe('chartHeight', () => {
  it('reserves space for each new chart type', () => {
    const donut: ChartSpec = {
      type: 'donut',
      title: 'Approach weighting',
      slices: [
        { label: 'a', value: 1 },
        { label: 'b', value: 1 },
      ],
    };
    const line: ChartSpec = {
      type: 'line',
      title: 'FMV over time',
      points: [
        { label: 'a', value: 1 },
        { label: 'b', value: 2 },
      ],
    };
    expect(chartHeight(donut)).toBeGreaterThan(100);
    expect(chartHeight(line)).toBeGreaterThan(100);
  });

  it('grows a donut once its legend outruns the ring', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `slice ${i}`, value: 1 }));
    const few = many.slice(0, 2);
    expect(chartHeight({ type: 'donut', title: 't', slices: many })).toBeGreaterThan(
      chartHeight({ type: 'donut', title: 't', slices: few }),
    );
  });

  it('adds room for a note', () => {
    const spec = (note?: string): ChartSpec => ({
      type: 'line',
      title: 't',
      points: [{ label: 'a', value: 1 }],
      note,
    });
    expect(chartHeight(spec('caption'))).toBeGreaterThan(chartHeight(spec()));
  });
});

describe('rendering the new charts', () => {
  it('puts the donut’s legend and centre text on the page', async () => {
    const pdf = await renderReportPdf(
      withChart({
        type: 'donut',
        title: 'Approach weighting',
        slices: [
          { label: 'OPM backsolve', value: 0.7, display: '70%' },
          { label: 'Market comparables', value: 0.3, display: '30%' },
        ],
        center: '2',
        center_note: 'approaches',
        note: 'Weights applied in concluding equity value.',
      }),
      { compress: false },
    );
    const text = extractText(pdf);
    expect(text).toContain('Approach weighting');
    expect(text).toContain('OPM backsolve');
    expect(text).toContain('Market comparables');
    expect(text).toContain('70%');
    expect(text).toContain('approaches');
    expect(text).toContain('Weights applied in concluding equity value.');
  });

  it('labels a line chart’s endpoints and every period', async () => {
    const pdf = await renderReportPdf(
      withChart({
        type: 'line',
        title: 'FMV per share over time',
        points: [
          { label: '2023-06-30', value: 1.0, display: '$1.0000' },
          { label: '2024-06-30', value: 1.42, display: '$1.4200' },
          { label: '2025-06-30', value: 1.87, display: '$1.8700' },
        ],
      }),
      { compress: false },
    );
    const text = extractText(pdf);
    expect(text).toContain('FMV per share over time');
    // Every period is dated; only the ends carry a value, or a six-point
    // series becomes a pile of overlapping numbers.
    expect(text).toContain('2023-06-30');
    expect(text).toContain('2024-06-30');
    expect(text).toContain('$1.0000');
    expect(text).toContain('$1.8700');
    expect(text).not.toContain('$1.4200');
  });

  it('says so plainly when there is nothing to plot', async () => {
    const empty = await renderReportPdf(
      withChart({ type: 'donut', title: 'Approach weighting', slices: [] }),
      { compress: false },
    );
    expect(extractText(empty)).toContain('No weighted components to show.');

    const noHistory = await renderReportPdf(withChart({ type: 'line', title: 'Trend', points: [] }), {
      compress: false,
    });
    expect(extractText(noHistory)).toContain('No history to plot yet.');
  });

  it('renders a single-point line without dividing by zero', async () => {
    const pdf = await renderReportPdf(
      withChart({ type: 'line', title: 'Trend', points: [{ label: '2025-06-30', value: 1.42 }] }),
      { compress: false },
    );
    expect(extractText(pdf)).toContain('2025-06-30');
  });

  it('paginates a page-full of charts rather than overflowing one', async () => {
    const charts: ChartSpec[] = Array.from({ length: 6 }, (_, i) => ({
      type: 'line',
      title: `Trend ${i}`,
      points: [
        { label: 'a', value: 1 },
        { label: 'b', value: 2 },
      ],
    }));
    const pdf = await renderReportPdf(
      { ...BASE, sections: [{ heading: 'Charts', html: '<p>x</p>', charts }] },
      { compress: false },
    );
    const pages = (pdf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
    expect(extractText(pdf)).toContain('Trend 5');
  });
});
