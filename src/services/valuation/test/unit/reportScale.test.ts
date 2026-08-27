import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RenderBody } from '@n409/report';
import { CHART_SERIES_LIMITS, renderReportPdf, type ChartSpec } from '@n409/report/pdf';
import type { CalculationRow } from '../../src/repos/calculations.js';
import { buildExhibits } from '../../src/domain/reportExhibits.js';
import {
  approachChart,
  buildReportSummary,
  discountChart,
  historyChart,
  weightingChart,
} from '../../src/domain/reportSummary.js';
import { reportRenderPayload } from '../../src/clients/reportRender.js';

/**
 * What a report costs when the engagement behind it is as large as the platform
 * lets one get.
 *
 * Every other report suite asks whether the deliverable is *correct*. This one
 * asks whether it still fits, and the reason it is a separate file is that the
 * failure it guards against does not look like a failure.
 *
 * `clients/reportRender.ts` offloads the render to the report service, and the
 * wire schema between them (`RenderBody`) carries caps the library does not: a
 * section's HTML at 200,000 characters, a line chart's series at 40 points, the
 * whole body at Fastify's 8 MB. A payload that outgrows one of them is a 422,
 * and a 422 *falls back* — the identical bytes render in-process instead,
 * blocking the valuation event loop for the whole render. Correct PDF, correct
 * route, no error, and the half-second the offload exists to remove quietly
 * back. Nothing but `report_render_total{mode="local"}` says it happened, and
 * it happens on the engagements with the most history and the biggest cap
 * tables — which is to say the reports that most needed the offload.
 *
 * So the question here is never "does it render". It always does. The question
 * is whether it still renders *over there*, and how much room is left.
 *
 * Three of the four bounds below were found by measurement rather than by
 * reading, and one of them was already breached: `historyChart` emitted one
 * point per prior valuation against a wire cap of 40, so a client on its
 * forty-first valuation lost the offload permanently.
 */

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8'));

/**
 * The largest cap table the platform will store, allocated by the real engine.
 *
 * `EngineInputsBody` (routes/engineInputs.ts) caps `share_classes` at 50, so 50
 * is the ceiling on every schedule that scales with the capital structure. The
 * shape is the worst 50 classes can do rather than a plausible 50: distinct
 * preferences, distinct participation caps, alternating participation, distinct
 * conversion ratios and distinct option strikes, which is what maximises the
 * breakpoint count the allocation schedules are drawn from. It produces 110
 * breakpoints where a realistic 50-class table produces about half that.
 *
 * Regenerate with `engine-wrapper/.venv/bin/python`:
 *
 *     from app.engine.waterfall import allocate_waterfall
 *     allocate_waterfall(500_000_000.0, share_classes, 3.5, 0.042, 0.65)
 *
 * Real engine output rather than a hand-written stand-in, for the same reason
 * `reportExhibits.test.ts` transcribes its option schedule: a plausible-looking
 * allocation would satisfy every assertion below and prove nothing about the
 * size of the document this platform actually produces.
 */
const MAX_CAP_TABLE = fixture('maxCapTableAllocation.json') as {
  share_classes: unknown[];
  allocation: Record<string, unknown>;
};

const CTX = { currency: 'USD', companyName: 'Northwind Robotics, Inc.', valuationDate: '2026-06-30' };

function maxCalculation(): CalculationRow {
  return {
    id: '01J000000000000000000000',
    valuation_id: '01J000000000000000000001',
    engine_version: '1.4.0',
    status: 'succeeded',
    inputs: {
      params: {},
      inputs: { valuation_date: '2026-06-30', share_classes: MAX_CAP_TABLE.share_classes },
    },
    results: {
      equity_value: 500_000_000,
      fmv_per_share: 1.2345,
      allocation_method: 'opm_waterfall',
      assumptions: { volatility: 0.65, risk_free_rate: 0.042, time_to_exit_years: 3.5 },
      allocation: MAX_CAP_TABLE.allocation,
    },
    equity_value: '500000000',
    fmv_per_share: '1.2345',
    error: null,
    diagnostics: [],
    created_by: null,
    created_at: new Date('2026-07-01T00:00:00Z'),
  } as unknown as CalculationRow;
}

/** The wire contract's verdict on a set of sections, as the report service gives it. */
function wireVerdict(
  sections: Array<{ heading: string; html: string; charts?: ChartSpec[] }>,
  summary?: unknown,
) {
  const input = {
    title: 'Valuation Report',
    company_name: CTX.companyName,
    meta: [{ label: 'Kind', value: '409a' }],
    sections,
    ...(summary ? { summary } : {}),
  };
  const payload = reportRenderPayload(input as never);
  return {
    parsed: RenderBody.safeParse(payload),
    bytes: Buffer.byteLength(JSON.stringify(payload)),
    input,
  };
}

// ── Chart series ─────────────────────────────────────────────────────────────

describe('every chart a report can carry fits the series the renderer can draw', () => {
  /**
   * The population guard, not a regression guard for the one that was broken.
   *
   * Each producer is fed a series far past its shape's limit and the resulting
   * spec has to survive `RenderBody`. Two of the four are safe by construction
   * and the assertion is still worth making: `approachChart` and
   * `weightingChart` iterate `results.approaches`, which is engine output today
   * and stored JSON by the time this code reads it, so "the engine only ever
   * writes four keys" is a fact about a different process's current version
   * rather than a property of this one's input.
   */
  const OVERSIZED = 200;

  it('bounds the approach bar chart, whatever the stored results carry', () => {
    const approaches = Object.fromEntries(
      Array.from({ length: OVERSIZED }, (_, i) => [
        `approach_${i}`,
        { weight: 0.005, equity_value: 1e6 + i },
      ]),
    );
    const chart = approachChart({ equity_value: 4.2e7, approaches } as never, 'USD') as Extract<
      ChartSpec,
      { type: 'bar' }
    >;
    expect(chart.points.length).toBe(CHART_SERIES_LIMITS.bar);
    // Truncated rather than folded into an aggregate bar: these are alternative
    // estimates of one quantity, so their sum is not a number.
    expect(chart.note).toContain(`${CHART_SERIES_LIMITS.bar} largest of ${OVERSIZED}`);
    expect(chart.note).toContain('Weighted concluded equity value');
  });

  it('bounds the weighting donut, whatever the stored results carry', () => {
    const approaches = Object.fromEntries(
      Array.from({ length: OVERSIZED }, (_, i) => [
        `approach_${i}`,
        { weight: 0.005, equity_value: 1e6 + i },
      ]),
    );
    const chart = weightingChart({ approaches } as never) as Extract<ChartSpec, { type: 'donut' }>;
    expect(chart.slices.length).toBe(CHART_SERIES_LIMITS.donut);
    // Folded, not truncated: the ring's whole claim is that the parts make a
    // whole, so the weights it draws still have to sum to the weights applied.
    const drawn = chart.slices.reduce((sum, s) => sum + s.value, 0);
    expect(drawn).toBeCloseTo(OVERSIZED * 0.005, 6);
    expect(chart.slices.at(-1)!.label).toBe(
      `Other approaches (${OVERSIZED - CHART_SERIES_LIMITS.donut + 1})`,
    );
    // And the centre counts approaches rather than arcs.
    expect(chart.center).toBe(String(OVERSIZED));
  });

  it('bounds the discount waterfall', () => {
    // Structurally three steps — marketable value, DLOC, DLOM — so this is a
    // statement about the shape rather than a truncation, and the assertion is
    // here so a fourth and fifth discount cannot arrive unnoticed.
    const chart = discountChart(
      { fmv_per_share: 1.2345, discounts: { dloc: 0.1, dlom: 0.25 } } as never,
      'USD',
    );
    expect(chart).not.toBeNull();
    expect((chart as Extract<ChartSpec, { type: 'waterfall' }>).steps.length).toBeLessThanOrEqual(
      CHART_SERIES_LIMITS.waterfall,
    );
  });

  it('bounds the FMV trend line — the one that was over', () => {
    const history = Array.from({ length: OVERSIZED }, (_, i) => ({
      as_of: new Date(Date.UTC(1990 + Math.floor(i / 4), (i % 4) * 3, 1)).toISOString(),
      fmv_per_share: 1 + i * 0.1,
    }));
    const chart = historyChart(history, 'USD') as Extract<ChartSpec, { type: 'line' }>;
    expect(chart.points.length).toBe(CHART_SERIES_LIMITS.line);
  });

  it('keeps the recent end of a long trend, because that is the question it answers', () => {
    const history = Array.from({ length: CHART_SERIES_LIMITS.line + 7 }, (_, i) => ({
      as_of: new Date(Date.UTC(2000 + i, 0, 1)).toISOString(),
      fmv_per_share: 1 + i,
    }));
    const chart = historyChart(history, 'USD') as Extract<ChartSpec, { type: 'line' }>;
    // Oldest-first within the window, and the window ends at the newest point:
    // a board comparing this 409A with the last one has to find the last one.
    expect(chart.points.at(-1)!.value).toBe(history.at(-1)!.fmv_per_share);
    expect(chart.points[0]!.value).toBe(history[7]!.fmv_per_share);
  });

  it('says on the page that earlier valuations were dropped', () => {
    // A schedule that silently loses rows is this platform's recurring defect,
    // and a signed report is the worst place for it: a reader takes the plotted
    // series for the client's whole history unless the caption says otherwise.
    const long = Array.from({ length: CHART_SERIES_LIMITS.line + 7 }, (_, i) => ({
      as_of: new Date(Date.UTC(2000 + i, 0, 1)).toISOString(),
      fmv_per_share: 1 + i,
    }));
    expect(historyChart(long, 'USD')!.note).toContain(
      `most recent ${CHART_SERIES_LIMITS.line} of ${long.length}`,
    );
    expect(historyChart(long, 'USD')!.note).toContain('7 earlier valuations are not plotted');

    const one = [...long.slice(0, CHART_SERIES_LIMITS.line), long.at(-1)!];
    expect(historyChart(one, 'USD')!.note).toContain('1 earlier valuation is not plotted');

    // And says nothing when nothing was dropped, rather than always hedging.
    const short = long.slice(0, CHART_SERIES_LIMITS.line);
    expect(historyChart(short, 'USD')!.note).toBe(
      'Concluded FMV of each prior valuation of this company, oldest first.',
    );
  });

  it('delegates a summary built on a history longer than the chart', () => {
    // The end the truncation exists for: the whole summary, through the whole
    // wire contract, on an engagement whose client has outlived the plot.
    const history = Array.from({ length: 400 }, (_, i) => ({
      as_of: new Date(Date.UTC(1900 + Math.floor(i / 4), (i % 4) * 3, 1)).toISOString(),
      fmv_per_share: 1 + i * 0.01,
    }));
    const summary = buildReportSummary(maxCalculation(), { ...CTX, history });
    expect(summary).not.toBeNull();
    const { parsed } = wireVerdict([{ heading: 'Body', html: '<p>x</p>' }], summary);
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues.slice(0, 2))).toBe(true);
  });
});

// ── Exhibits at the largest cap table the platform stores ────────────────────

describe('the largest cap table the platform stores still renders over the wire', () => {
  const exhibits = buildExhibits(maxCalculation(), CTX);

  it('produces the schedules a 50-class allocation should', () => {
    expect(exhibits.map((s) => s.heading)).toEqual([
      'Exhibit A — Capitalization Table',
      'Exhibit F — Allocation of Equity Value',
      'Exhibit H — Discounts and Concluded Value',
      'Appendix IV — Option Pricing Model Calculations',
    ]);
  });

  it('fits the wire contract, with the headroom stated rather than assumed', () => {
    const { parsed, bytes } = wireVerdict(exhibits);
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues.slice(0, 2))).toBe(true);

    /*
     * The number this test exists for.
     *
     * Exhibit F is quadratic in the class count twice over — one row per
     * breakpoint, and every row names every class participating in that tranche
     * with its share — so its HTML grows as n² while the cap it is measured
     * against is flat. Measured across the real engine's output: 24 KB at 26
     * classes, 69 KB at 50, 235 KB at 100. The cap is 200,000 characters, so
     * the crossing sits between 50 and 100 classes and the only thing keeping
     * this report on the report service is `EngineInputsBody`'s cap of 50.
     *
     * That cap is one number in one Zod schema, three files away, with nothing
     * in it to say that raising it stops the offload. This is that thing:
     * double the legal cap table and this assertion fails, months before an
     * operator notices `report_render_total{mode="local"}` climbing.
     */
    const biggest = Math.max(...exhibits.map((s) => s.html.length));
    expect(biggest).toBeLessThan(200_000);
    expect(biggest).toBeGreaterThan(40_000); // the measurement is live, not vacuous
    expect(bytes).toBeLessThan(8 * 1024 * 1024);
  });
});

// ── The whole deliverable, at every cap it has ───────────────────────────────

describe('the largest report the platform can be asked for', () => {
  /**
   * A body at `PutBody`'s ceiling: 50 chapters of 100,000 characters apiece.
   * Nobody authors this, and that is the point — it is the largest document the
   * editor will accept, so it is the bound on what the render path must carry.
   */
  const paragraph = `<p>${'The concluded fair market value of the common stock. '.repeat(40)}</p>`;
  const chapter = paragraph.repeat(Math.ceil(100_000 / paragraph.length)).slice(0, 100_000);
  const body = Array.from({ length: 50 }, (_, i) => ({ heading: `Chapter ${i + 1}`, html: chapter }));
  const sections = [...body, ...buildExhibits(maxCalculation(), CTX)];

  it('stays inside the report service body limit', () => {
    const { parsed, bytes } = wireVerdict(sections);
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues.slice(0, 2))).toBe(true);
    // `buildApp`'s `bodyLimit`. Measured at 4.9 MB, so a little over half of it
    // — the headroom that keeps the authored half and the generated half from
    // having to be budgeted against each other.
    expect(bytes).toBeLessThan(8 * 1024 * 1024);
    // Section count against `RenderBody`'s cap of 100: 50 authored chapters is
    // the editor's own ceiling, and the schedules are added to it rather than
    // sharing the budget.
    expect(sections.length).toBeLessThanOrEqual(100);
  });

  it('renders inside a bound, and holds a bounded amount of memory doing it', async () => {
    /*
     * Ceilings, not targets. Measured on a 2026 laptop: 1.7s and about 85 MB of
     * retained heap for this document, against 0.1–0.2s and 25 MB for a real
     * one. The numbers below are an order of magnitude clear of that on purpose
     * — a wall-clock assertion tight enough to be a benchmark is an assertion
     * that fails on a loaded CI box, and the regression worth catching here is
     * the one that turns a linear renderer into a quadratic one rather than the
     * one that costs 200ms.
     *
     * The memory bound is the more load-bearing of the two. pdfkit is
     * constructed with `bufferPages: true` — every page stays resident until
     * the running heads and the contents page can be written — and the output
     * is accumulated as chunks and then concatenated, so the finished document
     * exists twice at the end. That is the model `MAX_DELEGATED_QUEUED` and the
     * report unit's `MemoryMax` are sized from (see `modelledRenderCeilingBytes`),
     * and it is only safe while the input is bounded, which is what every
     * assertion above is for.
     */
    const before = process.memoryUsage().heapUsed;
    const startedAt = process.hrtime.bigint();
    const pdf = await renderReportPdf({
      title: 'Valuation Report',
      company_name: CTX.companyName,
      meta: [],
      sections,
    });
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const retained = process.memoryUsage().heapUsed - before;

    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(ms).toBeLessThan(20_000);
    expect(retained).toBeLessThan(600 * 1024 * 1024);
    // And the document is the size the input implies rather than an order of
    // magnitude over it — the check that says the bound above was measured on a
    // real render and not on an early return.
    expect(pdf.length).toBeGreaterThan(1024 * 1024);
  }, 60_000);

  it('costs about what one report costs, per report, when several render at once', async () => {
    /*
     * Concurrency here is a memory question rather than a throughput one, and
     * the answer is already written down: pdfkit is synchronous, so N renders
     * on one thread serialise whatever the caller does, and the only thing
     * concurrency buys is N documents resident at once. That is why
     * `MAX_DELEGATED_IN_FLIGHT` is 4 rather than large.
     *
     * What this pins is that the arithmetic still holds — four concurrent
     * renders of a real-sized report cost about four documents, not sixteen.
     * A renderer that shared mutable per-render state across calls, or cached
     * per-document layout on a module-level map, would break here and nowhere
     * else in the suite.
     */
    const one = { title: 'R', company_name: CTX.companyName, meta: [], sections: sections.slice(50) };
    const solo = await renderReportPdf(one);
    const many = await Promise.all(Array.from({ length: 4 }, () => renderReportPdf(one)));
    for (const pdf of many) expect(pdf.length).toBe(solo.length);
  }, 60_000);
});
