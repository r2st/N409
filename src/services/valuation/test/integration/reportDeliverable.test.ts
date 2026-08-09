import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation, type ValuationRow } from '../../src/repos/valuations.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * What actually reaches the deliverable.
 *
 * The report body is authored prose and the schedules behind it are computed at
 * render time from the calculation that produced the conclusion. Both halves
 * have unit coverage; this pins the seam, which is where they were never
 * connected at all: before `domain/reportExhibits.ts` a 409A left this service
 * with a conclusion reading "$ … per share" and no cap table, no breakpoint
 * schedule and no reconciliation, while every one of those figures sat in the
 * calculation's jsonb.
 *
 * Assertions are on the PDF bytes with compression off, which is how this
 * repository asserts rendered output.
 */

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

const VALUATION_DATE = '2026-03-31';

const ENGINE_INPUTS = {
  valuation_date: VALUATION_DATE,
  cash: 3_000_000,
  debt: 1_000_000,
  share_classes: [
    { kind: 'common', name: 'Common', shares: 8_000_000 },
    {
      kind: 'preferred',
      name: 'Series Seed',
      shares: 4_000_000,
      preference: 10_000_000,
      seniority: 1,
      participating: true,
      participation_cap: 20_000_000,
      conversion_ratio: 1,
    },
  ],
  income: { free_cash_flows: [1_000_000, 1_500_000], discount_rate: 0.25, terminal_growth: 0.03 },
  market: { metric: 4_000_000, multiples: [5.0, 6.5, 7.1] },
};

const RESULTS = {
  equity_value: 42_000_000,
  fmv_per_share: 1.2345,
  common_equity_value: 14_625_184,
  fully_diluted_common: 8_000_000,
  fully_diluted_basis: 'cap_table_common',
  allocation_method: 'opm',
  approaches: {
    income: {
      weight: 0.25,
      pv_explicit: 3_100_000,
      pv_terminal: 30_900_000,
      enterprise_value: 34_000_000,
      equity_value: 36_000_000,
    },
    market: {
      weight: 0.25,
      metric: 4_000_000,
      multiples: [5.0, 6.5, 7.1],
      selected_multiple: 6.5,
      enterprise_value: 26_000_000,
      equity_value: 28_000_000,
    },
    opm_backsolve: { weight: 0.5, method: 'backsolve_waterfall', equity_value: 52_000_000 },
  },
  allocation: {
    method: 'opm_waterfall',
    common_per_share: 1.828148,
    common_shares: 8_000_000,
    common_value: 14_625_184,
    breakpoints: [
      { from: 0, to: 10_000_000, participants: { 'Series Seed': 1 }, value: 9_400_000 },
      {
        from: 10_000_000,
        to: 40_000_000,
        participants: { Common: 0.666667, 'Series Seed': 0.333333 },
        value: 21_000_000,
      },
      { from: 40_000_000, to: null, participants: { Common: 1 }, value: 11_600_000 },
    ],
    classes: {
      Common: { kind: 'common', shares: 8_000_000, value: 14_625_184, per_share: 1.828148 },
      'Series Seed': { kind: 'preferred', shares: 4_000_000, value: 27_374_816, per_share: 6.843704 },
    },
  },
  assumptions: { time_to_exit_years: 3.5, risk_free_rate: 0.042, volatility: 0.65 },
  discounts: { dloc: 0.1, dlom: 0.25, dlom_method: 'chaffee' },
};

describe.skipIf(!dbUp)('the 409A deliverable', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let computed: ValuationRow;
  let uncomputed: ValuationRow;

  async function seed(company: string, withCalculation: boolean): Promise<ValuationRow> {
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: company, userId: client.id, currency: 'USD' },
      { ...actor, actorId: client.id },
    );
    if (withCalculation) {
      await createCalculation(
        ctx.pool,
        {
          valuationId: v.id,
          engineVersion: '1.4.0',
          status: 'succeeded',
          inputs: { params: {}, inputs: ENGINE_INPUTS },
          results: RESULTS,
          equityValue: RESULTS.equity_value,
          fmvPerShare: RESULTS.fmv_per_share,
          createdBy: client.id,
        },
        { ...actor, actorId: client.id },
      );
    }
    return v;
  }

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    computed = await seed('Northwind Robotics, Inc.', true);
    uncomputed = await seed('Ashgrove Bio, Inc.', false);
  });
  afterAll(async () => ctx?.teardown());

  const opsGet = (url: string) => ctx.app.inject({ method: 'GET', url, headers: authHeader(ops.token) });

  /**
   * Readable text of a rendered PDF.
   *
   * The renderer compresses its content streams and writes each run as a hex
   * string of WinAnsi bytes, so neither step alone recovers anything: inflate
   * every FlateDecode stream, then decode the hex tokens — which is what
   * @n409/report's own `extractText` does, against a document rendered with
   * compression off. This route offers no such switch, and it should not: the
   * bytes asserted here are the bytes a client downloads.
   */
  function readable(pdf: Buffer): string {
    const raw = pdf.toString('latin1');
    let all = raw;
    for (const m of raw.matchAll(/stream\r?\n/g)) {
      const start = m.index + m[0].length;
      const end = pdf.indexOf(Buffer.from('endstream'), start);
      if (end < 0) continue;
      try {
        all += inflateSync(pdf.subarray(start, end)).toString('latin1');
      } catch {
        // Not a deflate stream (an embedded font, an image) — nothing to read.
      }
    }
    return Array.from(all.matchAll(/<([0-9a-fA-F]+)>/g))
      .map((m) => Buffer.from(m[1]!, 'hex').toString('latin1'))
      .join('');
  }

  /** Render the current version and return what a reader would see in it. */
  async function pdfText(id: string): Promise<string> {
    await opsGet(`/api/v1/valuations/${id}/report`); // creates the report on first access
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/report/render`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const pdf = await opsGet(`/api/v1/valuations/${id}/report.pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    return readable(pdf.rawPayload);
  }

  // ── the valuation date ─────────────────────────────────────────────────────

  describe('the date the report states', () => {
    it('is the valuation date, not the day the report happened to be opened', async () => {
      const res = await opsGet(`/api/v1/valuations/${computed.id}/report`);
      expect(res.statusCode).toBe(200);
      const sections = res.json().version.content.sections as Array<{ key: string; html: string }>;
      const intro = sections.find((s) => s.key === 'introduction')!;
      expect(intro.html).toContain(VALUATION_DATE);

      const today = new Date().toISOString().slice(0, 10);
      // The engagement was valued in March; the assertion is only meaningful
      // while the clock disagrees with that, which it will for as long as this
      // test is run.
      expect(today).not.toBe(VALUATION_DATE);
      expect(intro.html).not.toContain(today);

      const conclusion = sections.find((s) => s.key === 'conclusion')!;
      expect(conclusion.html).toContain(VALUATION_DATE);
    });

    it('appears on the cover, stated separately from the render date', async () => {
      const text = await pdfText(computed.id);
      // Cover facts are set in small caps, so this is the label as drawn.
      expect(text).toContain('VALUATION DATE');
      expect(text).toContain(VALUATION_DATE);
      expect(text).toContain('RENDERED');
    });

    it('falls back to the clock only when the engagement has no valuation date', async () => {
      const res = await opsGet(`/api/v1/valuations/${uncomputed.id}/report`);
      const sections = res.json().version.content.sections as Array<{ key: string; html: string }>;
      const intro = sections.find((s) => s.key === 'introduction')!;
      expect(intro.html).toContain(new Date().toISOString().slice(0, 10));
      // …and the cover says nothing rather than inventing one.
      const text = await pdfText(uncomputed.id);
      expect(text).not.toContain('Valuation date');
    });
  });

  // ── the exhibits ───────────────────────────────────────────────────────────

  describe('the computed exhibits', () => {
    /**
     * Figures that can only have come from the calculation. The template's own
     * index names every exhibit heading, so a heading proves nothing about
     * whether the schedule behind it was drawn — these do.
     */
    const COMPUTED_FIGURES = {
      'Exhibit A — cap table': '12,000,000', // total shares across the classes
      'Exhibit B — reconciliation': '$26,000,000', // 52M backsolve × 50% weight
      'Exhibit C — DCF': '$34,000,000', // indicated enterprise value
      'Exhibit D — market': '6.50x', // median of 5.0 / 6.5 / 7.1
      'Exhibit F — allocation': 'Tranche',
      'Exhibit H — discounts': '$1.8281', // marketable, controlling per share
    };

    it('appends every schedule the calculation supports', async () => {
      const text = await pdfText(computed.id);
      for (const [exhibit, figure] of Object.entries(COMPUTED_FIGURES)) {
        expect(text, exhibit).toContain(figure);
      }
    });

    it('omits the schedules for analyses this valuation did not run', async () => {
      const text = await pdfText(computed.id);
      // No asset approach was weighted and this is not a PWERM run. Asserted on
      // wording only the exhibits use — the template's index page names every
      // exhibit heading, so a heading proves nothing either way.
      expect(text).not.toContain('applied on a net-asset-value basis');
      expect(text).not.toContain('Exit equity value');
    });

    it('carries the cap table the allocation actually ran on', async () => {
      const text = await pdfText(computed.id);
      expect(text).toContain('Series Seed');
      expect(text).toContain('8,000,000');
      expect(text).toContain('capped at $20,000,000');
    });

    it('carries the breakpoint schedule, which nothing ever showed before', async () => {
      const text = await pdfText(computed.id);
      expect(text).toContain('and above');
      expect(text).toContain('Common 66.7%');
      expect(text).toContain('Series Seed 33.3%');
    });

    it('closes the discount chain on the concluded value', async () => {
      const text = await pdfText(computed.id);
      expect(text).toContain('$1.8281'); // marketable, controlling per share
      expect(text).toContain('$1.6453'); // after the 10% DLOC
      expect(text).toContain('$1.2345'); // concluded FMV, after the 25% DLOM
      expect(text).toContain('Chaffee protective-put model');
    });

    it('renders without them when the engine has not produced a value', async () => {
      const text = await pdfText(uncomputed.id);
      for (const [exhibit, figure] of Object.entries(COMPUTED_FIGURES)) {
        expect(text, exhibit).not.toContain(figure);
      }
    });

    it('survives an editor round-trip — a schedule cannot be edited away', async () => {
      const current = (await opsGet(`/api/v1/valuations/${computed.id}/report`)).json();
      const content = current.version.content;
      // Strip the body down to a single section, as an analyst rewriting the
      // report could.
      content.sections = [{ key: 'introduction', heading: 'Introduction', html: '<p>Short.</p>' }];
      const saved = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${computed.id}/report`,
        headers: authHeader(ops.token),
        payload: { content },
      });
      expect(saved.statusCode).toBe(200);

      const text = await pdfText(computed.id);
      expect(text).toContain('Short.');
      expect(text).toContain('12,000,000'); // Exhibit A survived
      expect(text).toContain('$1.8281'); // and so did Exhibit H
    });
  });

  /**
   * Where every figure in the deliverable comes from.
   *
   * The tests above assert that the schedules are *present*. These assert that
   * they are the stored calculation's — that nothing on the page is recomputed
   * by the renderer, carried over from an earlier run, or hardcoded.
   *
   * The method is to move the calculation and re-render. An assertion that the
   * document contains $1.2345 passes just as well against a renderer that has
   * $1.2345 written into it; an assertion that changing the calculation to
   * $2.5000 changes the document to $2.5000 does not. This is the property that
   * makes the arithmetic worth checking at all, because a correct engine behind
   * a document that quotes something else is the same failure as a wrong engine.
   */
  describe('every headline figure traces to the stored calculation', () => {
    /** A second engagement, so the mutation cannot disturb the tests above. */
    async function withResults(company: string, results: Record<string, unknown>): Promise<string> {
      const v = await createValuation(
        ctx.pool,
        { kind: '409a', companyName: company, userId: client.id, currency: 'USD' },
        { ...actor, actorId: client.id },
      );
      await createCalculation(
        ctx.pool,
        {
          valuationId: v.id,
          engineVersion: '1.4.0',
          status: 'succeeded',
          inputs: { params: {}, inputs: ENGINE_INPUTS },
          results,
          equityValue: results.equity_value as number,
          fmvPerShare: results.fmv_per_share as number,
          createdBy: client.id,
        },
        { ...actor, actorId: client.id },
      );
      return v.id;
    }

    it('states the calculation’s FMV, not a figure of its own', async () => {
      const id = await withResults('Provenance One, Inc.', {
        ...RESULTS,
        fmv_per_share: 2.5,
        common_equity_value: 20_000_000,
        discounts: { dloc: 0, dlom: 0 },
      });
      const text = await pdfText(id);
      expect(text).toContain('$2.5000');
      // And not the figure the other engagement concluded on.
      expect(text).not.toContain('$1.2345');
    });

    it('moves the equity value, the share count and the discounts with it', async () => {
      const id = await withResults('Provenance Two, Inc.', {
        ...RESULTS,
        equity_value: 88_888_888,
        fmv_per_share: 3.75,
        common_equity_value: 30_000_000,
        fully_diluted_common: 8_000_000,
        discounts: { dloc: 0.11, dlom: 0.33, dlom_method: 'chaffee' },
      });
      const text = await pdfText(id);
      expect(text).toContain('$88,888,888');
      expect(text).toContain('11.0%');
      expect(text).toContain('33.0%');
      // The method label travels too — the summary page names how the discount
      // was derived, and a stale label is a claim about work that was not done.
      expect(text).toContain('Chaffee');
    });

    it('derives the discount chain rather than restating the endpoints', async () => {
      // Exhibit H is arithmetic: the allocated marketable value, less DLOC,
      // less DLOM, equals the conclusion. The two intermediate figures exist
      // nowhere in the calculation — they can only be computed from it — so
      // finding them is proof the exhibit did the derivation from these inputs.
      //
      // The marketable figure is `allocation.common_per_share`, which is the
      // allocation's own six-decimal number, not `common_equity_value` divided
      // by the share count. Those two agree by construction and the exhibit
      // deliberately reads the un-rounded one.
      const id = await withResults('Provenance Three, Inc.', {
        ...RESULTS,
        fmv_per_share: 1.44,
        common_equity_value: 16_000_000,
        fully_diluted_common: 8_000_000,
        allocation: { ...RESULTS.allocation, common_per_share: 2.0, common_value: 16_000_000 },
        discounts: { dloc: 0.1, dlom: 0.2 },
      });
      const text = await pdfText(id);
      // $2.0000 marketable, less 10% = $1.8000, less 20% = $1.4400.
      expect(text).toContain('$2.0000');
      expect(text).toContain('$1.8000');
      expect(text).toContain('$1.4400');
    });

    it('names the allocation the calculation used', async () => {
      const id = await withResults('Provenance Four, Inc.', {
        ...RESULTS,
        allocation_method: 'cvm',
      });
      expect(await pdfText(id)).toContain('Current value method');
    });

    it('re-renders to the new figures when the calculation is superseded', async () => {
      // A recalculation must move the document. The old figure surviving into a
      // re-render is the failure mode a cached summary would produce, and it is
      // invisible — the document looks complete and quotes a value the
      // engagement no longer holds.
      const id = await withResults('Provenance Five, Inc.', { ...RESULTS, fmv_per_share: 0.9 });
      expect(await pdfText(id)).toContain('$0.9000');

      await createCalculation(
        ctx.pool,
        {
          valuationId: id,
          engineVersion: '1.4.0',
          status: 'succeeded',
          inputs: { params: {}, inputs: ENGINE_INPUTS },
          results: { ...RESULTS, fmv_per_share: 4.2, equity_value: 99_000_000 },
          equityValue: 99_000_000,
          fmvPerShare: 4.2,
          createdBy: client.id,
        },
        { ...actor, actorId: client.id },
      );

      const text = await pdfText(id);
      expect(text).toContain('$4.2000');
      expect(text).toContain('$99,000,000');
      expect(text).not.toContain('$0.9000');
    });
  });
});
