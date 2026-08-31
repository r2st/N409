import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation, patchValuation, type ValuationRow } from '../../src/repos/valuations.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { readable } from './support/pdfText.js';
import { beforeRequest, expectMentionsToday, todayWindow } from '../support/today.js';

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
 * Assertions are on the bytes this route actually serves — compressed, and set
 * in a subsetted Unicode face. See `./support/pdfText.ts` for why that matters
 * and what has to happen to read one back.
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

  // ── the signature ──────────────────────────────────────────────────────────

  /**
   * The one thing the platform gated the deliverable on and never printed.
   *
   * `publishGate` refuses to publish an engagement with no `main` signature, so
   * the row is always there by the time the document is the file of record; the
   * PDF named nobody. What is pinned here is the seam — the render loads the
   * rows and resolves them into the certification — because both halves passed
   * their own tests while nothing connected them.
   */
  describe('the appraiser signature', () => {
    let unsigned: ValuationRow;

    beforeAll(async () => {
      unsigned = await seed('Halloway Instruments, Inc.', true);
    });

    const sign = (id: string, role: 'main' | 'second', name: string, title: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/signatures`,
        headers: authHeader(ops.token),
        payload: { role, signer_name: name, signer_title: title, signature_text: name },
      });

    it('says the report is unsigned until somebody signs it', async () => {
      const text = await pdfText(unsigned.id);
      expect(text).toContain('Appraiser Certification');
      expect(text).toContain('not yet signed');
    });

    it('prints the analyst who signed, and their title', async () => {
      const signed = await seed('Calder Dynamics, Inc.', true);
      const res = await sign(signed.id, 'main', 'Dana Whitfield', 'Managing Director, ASA');
      expect(res.statusCode).toBeLessThan(300);

      const text = await pdfText(signed.id);
      expect(text).toContain('Dana Whitfield');
      expect(text).toContain('Managing Director, ASA');
      expect(text).not.toContain('not yet signed');
    });

    it('picks up a concurring reviewer who signs after the body was drafted', async () => {
      /*
       * The reason the block is resolved at render rather than written into the
       * stored body. A second signature lands after the report has been drafted
       * and rendered once; the next render has to carry it, with no edit to the
       * certification chapter.
       */
      const signed = await seed('Brightwater Systems, Inc.', true);
      await sign(signed.id, 'main', 'Dana Whitfield', 'Managing Director, ASA');
      const first = await pdfText(signed.id);
      expect(first).not.toContain('Ravi Menon');

      await sign(signed.id, 'second', 'Ravi Menon', 'Director, CFA');
      const second = await pdfText(signed.id);
      expect(second).toContain('Dana Whitfield');
      expect(second).toContain('Ravi Menon');
    });

    it('replaces a superseded signature rather than printing both', async () => {
      // `upsertSignature` is insert-or-replace: re-signing after a change is how
      // a corrected report is re-signed, and the previous signer must not stay
      // on the page.
      const signed = await seed('Pemberton Optics, Inc.', true);
      await sign(signed.id, 'main', 'Dana Whitfield', 'Managing Director, ASA');
      await sign(signed.id, 'main', 'Ines Okafor', 'Partner, ABV');

      const text = await pdfText(signed.id);
      expect(text).toContain('Ines Okafor');
      expect(text).not.toContain('Dana Whitfield');
    });

    it('states the nine certification statements USPAP requires', async () => {
      const text = await pdfText(unsigned.id);
      for (const required of [
        'true and correct',
        'impartial and unbiased',
        'no present or prospective interest',
        'three-year period immediately preceding',
        'no bias with respect to',
        'engagement in this assignment was not contingent',
        'compensation is not contingent',
        'Uniform Standards of Professional Appraisal Practice',
        'Statement on Standards for Valuation Services No. 1',
        'significant professional assistance',
      ]) {
        expect(text, required).toContain(required);
      }
    });
  });

  // ── the assumptions the body states ────────────────────────────────────────

  /**
   * "Missing key assumptions" is the standard finding against a 409A that fails
   * review, and the discount rate is what it is usually about. Exhibit C has
   * printed the rate for as long as the exhibit has existed; the chapter that
   * describes the approach could only instruct its author to state it, so a
   * report where nobody typed over the instruction described a discounted cash
   * flow and never said what rate it discounted at.
   *
   * Pinned end to end rather than on `reportFigures`, because the seam is the
   * part that was missing: the figure has to be produced, the sentence has to
   * survive `resolveExhibitReferences`, and both have to reach the page.
   */
  describe('the income approach', () => {
    it('states the rate, the forecast length and the terminal basis', async () => {
      const text = await pdfText(computed.id);
      expect(text).toContain('discounted at 25.00%');
      expect(text).toContain('2-year explicit forecast period');
      expect(text).toContain('a perpetual growth rate of 3.00% beyond the forecast period');
    });

    it('sends the reader to no schedule this run did not build', async () => {
      /*
       * The other half of the pointer work, and the half `reportReview` already
       * grades: every new pointer is behind `EXHIBIT_IF`, so a chapter says
       * nothing about a schedule the calculation did not produce. This
       * engagement has no persisted peer set and no WACC build-up, so Exhibit
       * D-1 and Appendix I are absent and neither may be named.
       */
      const text = await pdfText(computed.id);
      expect(text).not.toContain('Exhibit D-1');
      expect(text).not.toContain('Appendix I');
      expect(text).not.toContain('Exhibit G');
      // And the pointers themselves never reach paper as markers.
      expect(text).not.toContain('{{#exhibit');
    });
  });

  // ── the valuation date ─────────────────────────────────────────────────────

  describe('the date the report states', () => {
    it('is the valuation date, not the day the report happened to be opened', async () => {
      const startedAt = beforeRequest();
      const res = await opsGet(`/api/v1/valuations/${computed.id}/report`);
      expect(res.statusCode).toBe(200);
      const sections = res.json().version.content.sections as Array<{ key: string; html: string }>;
      const intro = sections.find((s) => s.key === 'introduction')!;
      expect(intro.html).toContain(VALUATION_DATE);

      // "The day the report was opened" is the day the *server* is on, which is
      // what the fallback below would have used — so the day to prove absent is
      // the local one, not the UTC one that happens to share it for 20 hours.
      for (const today of todayWindow(startedAt)) {
        // The engagement was valued in March; the assertion is only meaningful
        // while the clock disagrees with that, which it will for as long as
        // this test is run.
        expect(today).not.toBe(VALUATION_DATE);
        expect(intro.html).not.toContain(today);
      }

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
      const startedAt = beforeRequest();
      const res = await opsGet(`/api/v1/valuations/${uncomputed.id}/report`);
      const sections = res.json().version.content.sections as Array<{ key: string; html: string }>;
      const intro = sections.find((s) => s.key === 'introduction')!;
      // `routes/reports.ts` falls back to `todayLocal()`. A report minted at
      // 9pm stating tomorrow's date is the auditor's finding, not ours.
      expectMentionsToday(intro.html, startedAt);
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

    /*
     * Which schedules a report carries is dispatched on the *shape* of the run
     * it is rendered from — `results.specialty` sends `buildExhibits` to the
     * specialty schedules, anything else to A–H. The run it was handed was
     * simply the newest succeeded one, and the Calculations tab offers the
     * ordinary 409A compute on every kind. So one pressed after the EMI run
     * swapped the whole exhibit set on a deliverable whose narrative, title
     * block and template are still the EMI report's: the UMV/AMV pair and the
     * Schedule 5 conditions the document exists to state fell out, and a
     * §409A allocation waterfall the client never commissioned took their
     * place — under an EMI report's chapter headings.
     */
    it('renders the schedules of the run the engagement is reported in, not the newest', async () => {
      const emi = await createValuation(
        ctx.pool,
        { kind: 'emi', companyName: 'Marlow Instruments Ltd', userId: client.id, currency: 'USD' },
        { ...actor, actorId: client.id },
      );
      await createCalculation(
        ctx.pool,
        {
          valuationId: emi.id,
          engineVersion: '1.4.0',
          status: 'succeeded',
          inputs: { params: { gross_assets: 2_000_000 } },
          results: {
            kind: 'emi',
            specialty: {
              pro_rata_per_share: 1.0,
              restriction_discount: 0.2,
              umv_per_share: 1.0,
              amv_per_share: 0.8,
              qualification: { scheme: 'emi', qualifies: true, checks: {} },
            },
          },
          equityValue: 1_000_000,
          fmvPerShare: 0.8,
          createdBy: client.id,
        },
        { ...actor, actorId: client.id },
      );
      await createCalculation(
        ctx.pool,
        {
          valuationId: emi.id,
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

      const text = await pdfText(emi.id);
      // The EMI schedule, off the EMI engine's own payload. Asserted on the
      // exhibit's own heading: the VAL231 appendix states a UMV/AMV pair of its
      // own, so the wording alone proves nothing about which schedules ran.
      expect(text).toContain('Exhibit — Share Valuation & Scheme Limits');
      expect(text).toContain('Restriction discount');
      // And not the 409A set, which this engagement did not commission.
      expect(text).not.toContain('Exhibit F — Allocation of Equity Value');
      expect(text).not.toContain('Tranche');
      expect(text).not.toContain('$34,000,000');
      // Nor a §409A conclusion in the summary of an HMRC report — the appendix
      // one page later states the AMV, and a document cannot say both.
      expect(text).not.toContain('$1.2345');
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

    it('refuses a chapter heading, or a report title, that is only whitespace', async () => {
      /*
       * `heading` names a chapter of the deliverable: it is drawn at the head
       * of the section, listed in the exhibit index, and quoted back by the QA
       * reviewer's own findings ("<heading> sends the reader to Exhibit …").
       * `min(1)` counts characters, so a heading of spaces saved with a 200 and
       * produced an unnamed chapter in a signed 409A and a blank row in its
       * index. A chapter with nothing to say is what `hidden` is for.
       */
      const current = (await opsGet(`/api/v1/valuations/${computed.id}/report`)).json();
      const put = (content: unknown) =>
        ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/valuations/${computed.id}/report`,
          headers: authHeader(ops.token),
          payload: { content },
        });

      const blankHeading = structuredClone(current.version.content);
      blankHeading.sections[0].heading = '  ';
      const headingRes = await put(blankHeading);
      expect(headingRes.statusCode).toBe(422);
      expect(headingRes.json().detail).toMatch(/whitespace/i);

      const blankTitle = structuredClone(current.version.content);
      blankTitle.title = '\n';
      expect((await put(blankTitle)).statusCode).toBe(422);

      // Unchanged content still saves, so the rule is about the blank and not
      // about the round trip.
      expect((await put(current.version.content)).statusCode).toBe(200);
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
   * Appendix II — the statements the Financial Analysis chapter discusses.
   *
   * Asserted on figures rather than on the heading. The template's index names
   * every appendix, so the heading is on the page whether or not the workbook
   * was ever read — which is the same trap the exhibit assertions above avoid.
   */
  describe('the historical financials appendix', () => {
    it('is absent while nobody has entered any financials', async () => {
      // `uncomputed` has no workbook and no calculation; `computed` has a
      // calculation but, until the next test writes them, no financials.
      const text = await pdfText(computed.id);
      expect(text).not.toContain('Income statement');
    });

    it('prints the reported statements, with the workbook’s own derived rows', async () => {
      const patched = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${computed.id}/workbook`,
        headers: authHeader(ops.token),
        payload: {
          cells: [
            { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_minus_1', value: 4_000_000 },
            { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_current', value: 6_000_000 },
            { sheet: 'income_statement', row_key: 'cogs', column_key: 'fy_current', value: 1_500_000 },
            { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_plus_1', value: 99_000_000 },
            { sheet: 'balance_sheet', row_key: 'cash', column_key: 'fy_current', value: 3_000_000 },
          ],
        },
      });
      expect(patched.statusCode).toBe(200);

      const text = await pdfText(computed.id);
      expect(text).toContain('Income statement');
      expect(text).toContain('Balance sheet');
      // Entered figures.
      expect(text).toContain('$6,000,000');
      expect(text).toContain('$3,000,000');
      // Derived by `computeWorkbook`, not by the appendix: 6.0M − 1.5M, and 75%.
      expect(text).toContain('$4,500,000');
      expect(text).toContain('75.0%');
      // The forecast period is management's expectation, not a reported figure,
      // and an appendix of this name must not carry it.
      expect(text).not.toContain('$99,000,000');
      expect(text).not.toContain('FY+1');
    });
  });

  /**
   * A chapter the analyst omitted.
   *
   * A template is a superset of what any one engagement needs, and the analyst's
   * only options were to leave the skeleton's instructions on the page or to
   * empty the section — and an empty chapter under a numbered heading reads as an
   * omission rather than a decision. What matters here is that "omitted" means
   * absent from the rendered document while still present in storage, because
   * unhiding has to restore the prose rather than the skeleton.
   */
  describe('a chapter marked as omitted', () => {
    let omitted: ValuationRow;

    beforeAll(async () => {
      if (!dbUp) return;
      omitted = await seed('Omit One, Inc.', true);
    });

    /** Save the body with `keys` marked hidden; returns the stored content. */
    async function omit(id: string, keys: string[]) {
      const current = (await opsGet(`/api/v1/valuations/${id}/report`)).json();
      const content = current.version.content;
      content.sections = content.sections.map((s: { key: string }) =>
        keys.includes(s.key) ? { ...s, hidden: true } : s,
      );
      const saved = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${id}/report`,
        headers: authHeader(ops.token),
        payload: { content },
      });
      expect(saved.statusCode).toBe(200);
      return saved.json().version.content as {
        sections: Array<{ key: string; heading: string; html: string; hidden?: boolean }>;
      };
    }

    it('is accepted by the save path and round-trips as hidden', async () => {
      const stored = await omit(omitted.id, ['asset_approach']);
      const section = stored.sections.find((s) => s.key === 'asset_approach');
      expect(section?.hidden).toBe(true);
      // Kept, not deleted — this is what makes unhiding restore the prose.
      expect(section?.html.length).toBeGreaterThan(0);
      // And nothing else grew the key.
      expect(stored.sections.filter((s) => s.hidden === true)).toHaveLength(1);
    });

    it('does not reach the rendered document', async () => {
      const v = await seed('Omit Two, Inc.', true);
      const before = await pdfText(v.id);
      expect(before).toContain('Qualifications of the Valuation Analyst');

      await omit(v.id, ['qualifications']);
      const after = await pdfText(v.id);
      expect(after).not.toContain('Qualifications of the Valuation Analyst');
      // The rest of the deliverable is untouched, including the schedules —
      // omitting a chapter is not a way to lose an exhibit.
      expect(after).toContain('Conclusion of Value');
      expect(after).toContain('Exhibit A');
    });

    it('leaves no gap in the numbering it was part of', async () => {
      /*
       * The contents, the bookmarks and the running heads are all derived from
       * the section list the renderer receives, so an omitted chapter has to be
       * absent from that list rather than present-and-blank. A gap in the
       * numbering would be the same omission the toggle exists to avoid,
       * differently spelled.
       */
      const v = await seed('Omit Three, Inc.', true);
      const sections = (await opsGet(`/api/v1/valuations/${v.id}/report`)).json().version.content
        .sections as Array<{ key: string; heading: string }>;

      // A chapter after both omissions, so its number has to move by exactly two.
      const dropped = ['economic_outlook', 'market_movement'];
      const later = sections.findIndex((s) => s.key === 'conclusion');
      expect(later).toBeGreaterThan(0);
      for (const key of dropped) {
        expect(sections.findIndex((s) => s.key === key)).toBeGreaterThan(0);
        expect(sections.findIndex((s) => s.key === key)).toBeLessThan(later);
      }
      const heading = sections[later]!.heading;

      // Asserted as "<number>. <heading>" — the form the contents and the chapter
      // title both take. A bare number would match any figure on the page.
      const full = await pdfText(v.id);
      expect(full).toContain(`${later + 1}. ${heading}`);

      await omit(v.id, dropped);
      const after = await pdfText(v.id);
      expect(after).toContain(`${later - 1}. ${heading}`);
      expect(after).not.toContain(`${later + 1}. ${heading}`);
      // And the omitted chapters are gone from the contents, not merely renumbered.
      for (const key of dropped) {
        expect(after).not.toContain(sections.find((s) => s.key === key)!.heading);
      }
    });

    it('comes back when the chapter is included again', async () => {
      const v = await seed('Omit Four, Inc.', true);
      await omit(v.id, ['safe_harbor']);
      expect(await pdfText(v.id)).not.toContain('Section 409A Safe Harbor');

      const stored = (await opsGet(`/api/v1/valuations/${v.id}/report`)).json();
      stored.version.content.sections = stored.version.content.sections.map(
        (s: { key: string; hidden?: boolean }) =>
          s.key === 'safe_harbor' ? { key: s.key, heading: 'x', html: 'y', ...s, hidden: false } : s,
      );
      // Re-save with the flag cleared rather than with a fresh skeleton: the
      // prose that comes back has to be the prose that was there.
      const restored = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${v.id}/report`,
        headers: authHeader(ops.token),
        payload: { content: stored.version.content },
      });
      expect(restored.statusCode).toBe(200);
      expect(await pdfText(v.id)).toContain('Section 409A Safe Harbor');
    });

    it('does not hold up the QA gate on a marker inside it', async () => {
      /*
       * The skeleton's instructions are written with fill-me markers in them, and
       * hiding a chapter is what an analyst does when it does not apply — a
       * company with no option plan has nothing to say under ASC 718. Grading the
       * hidden text would make the toggle useless where it is most wanted: the
       * gate would refuse to publish over prose no reader will see.
       */
      const v = await seed('Omit Five, Inc.', true);
      const current = (await opsGet(`/api/v1/valuations/${v.id}/report`)).json();
      const content = current.version.content;
      const asc718 = {
        key: 'asc718',
        heading: 'ASC 718 Stock-Based Compensation',
        html: '<p>Grant … at $ … per share.</p>',
      };
      const body = {
        title: content.title,
        sections: [{ key: 'introduction', heading: 'Introduction', html: '<p>Finished prose.</p>' }, asc718],
      };

      /** The gate's verdict on the report body specifically. */
      const placeholderCheck = async () => {
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${v.id}/qa`,
          headers: authHeader(ops.token),
          payload: {},
        });
        expect(res.statusCode).toBe(201); // a review is a created record
        return (res.json().review.checks as Array<{ key: string; status: string }>).find(
          (c) => c.key === 'report_placeholders',
        );
      };

      const put = async (sections: unknown[]) => {
        const res = await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/valuations/${v.id}/report`,
          headers: authHeader(ops.token),
          payload: { content: { ...body, sections } },
        });
        expect(res.statusCode).toBe(200);
      };

      // Visible, the unfilled marker is a finding — this is the control.
      await put(body.sections);
      expect((await placeholderCheck())?.status).not.toBe('pass');

      // Omitted, it is not.
      await put([body.sections[0], { ...asc718, hidden: true }]);
      expect((await placeholderCheck())?.status).toBe('pass');
    });
  });

  /**
   * A figure the prose froze, and the calculation has since moved past.
   *
   * The unit tests fix the rule; this fixes the wiring, which is the half that
   * can be wrong on its own — the check is fed from `listCalculations`, and it
   * can only see a superseded run if that query carries `results` and the route
   * excludes the run being reviewed from what it passes as "earlier".
   */
  describe('the QA gate on a body left behind by a recalculation', () => {
    /** The `report_coherence` verdict, and the findings behind it. */
    async function coherence(id: string) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/qa`,
        headers: authHeader(ops.token),
        payload: {},
      });
      expect(res.statusCode).toBe(201);
      return (res.json().review.checks as Array<{ key: string; status: string; detail: string }>).find(
        (c) => c.key === 'report_coherence',
      );
    }

    /** A conclusion chapter stating `literal` where the skeleton had a marker. */
    async function putConclusion(id: string, literal: string): Promise<void> {
      const res = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/valuations/${id}/report`,
        headers: authHeader(ops.token),
        payload: {
          content: {
            title: 'IRC 409A Valuation Report',
            sections: [
              {
                key: 'conclusion',
                heading: 'Conclusion of Value',
                // The derivation paragraph keeps its markers, which is the case
                // `frozen_figure` passes over: the chapter has not lost every
                // computed figure, only the one the document exists to state.
                html:
                  `<p>The fair market value of one share is <strong>${literal}</strong> per share. ` +
                  'It derives from a concluded total equity value of {{equity_value}}, less a ' +
                  'discount for lack of marketability of {{dlom}}.</p>',
              },
            ],
          },
        },
      });
      expect(res.statusCode).toBe(200);
    }

    it('reports the prose still stating what an earlier run concluded', async () => {
      const v = await seed('Frozen Conclusion, Inc.', true);
      // Correct on the day it was typed: the only succeeded run concludes 1.2345.
      await putConclusion(v.id, '$1.2345');
      const before = await coherence(v.id);
      expect(before?.detail ?? '').not.toMatch(/earlier run/);

      // The engine runs again and concludes something else.
      await createCalculation(
        ctx.pool,
        {
          valuationId: v.id,
          engineVersion: '1.4.0',
          status: 'succeeded',
          inputs: { params: {}, inputs: ENGINE_INPUTS },
          results: { ...RESULTS, fmv_per_share: 2.5 },
          equityValue: RESULTS.equity_value,
          fmvPerShare: 2.5,
          createdBy: client.id,
        },
        { ...actor, actorId: client.id },
      );

      const after = await coherence(v.id);
      expect(after?.status).toBe('warn');
      // Names both figures: the one on the page and the one behind the schedules.
      expect(after?.detail).toContain('$1.2345');
      expect(after?.detail).toContain('$2.5000');
    });

    it('says nothing about a body that still restates itself from the calculation', async () => {
      const v = await seed('Live Conclusion, Inc.', true);
      await putConclusion(v.id, '{{fmv_per_share}}');
      await createCalculation(
        ctx.pool,
        {
          valuationId: v.id,
          engineVersion: '1.4.0',
          status: 'succeeded',
          inputs: { params: {}, inputs: ENGINE_INPUTS },
          results: { ...RESULTS, fmv_per_share: 2.5 },
          equityValue: RESULTS.equity_value,
          fmvPerShare: 2.5,
          createdBy: client.id,
        },
        { ...actor, actorId: client.id },
      );
      expect((await coherence(v.id))?.detail ?? '').not.toMatch(/earlier run/);
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
    /**
     * Publish through the repo, not with raw SQL.
     *
     * `findValuationById` reads through a cache that every write path
     * invalidates, so an UPDATE issued behind it leaves the application holding
     * the old state — which is a fair description of what a test using SQL to
     * set up application state deserves.
     */
    async function publish(id: string): Promise<void> {
      const { rows } = await ctx.pool.query<ValuationRow>('SELECT * FROM valuations WHERE id = $1', [id]);
      await patchValuation(ctx.pool, rows[0]!, { state: 'published' }, { ...actor, actorId: ops.id });
    }

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

    /**
     * And the limit of that, which is the compliance half of the same fact.
     *
     * Deriving the exhibits fresh is what keeps them agreeing with the summary
     * page. It is also what means a recalculation moves every figure a
     * re-render would produce — so on an engagement the client has already been
     * given, re-rendering in place would put a different document under the
     * same version number, with a different concluded value, and nobody outside
     * this system would have any way to notice.
     */
    describe('once the engagement is published', () => {
      async function publishedWithPdf(company: string): Promise<string> {
        const id = await withResults(company, { ...RESULTS, fmv_per_share: 1.11 });
        await pdfText(id); // renders and stores v1
        await publish(id);
        return id;
      }

      it('refuses to re-render the version the client already holds', async () => {
        const id = await publishedWithPdf('Delivered One, Inc.');
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${id}/report/render`,
          headers: authHeader(ops.token),
          payload: {},
        });
        expect(res.statusCode).toBe(409);
        expect(res.json().detail).toMatch(/already been delivered/);
      });

      it('keeps serving the bytes that were delivered', async () => {
        const id = await publishedWithPdf('Delivered Two, Inc.');
        // A recalculation lands afterwards — the ordinary reason somebody
        // reaches for the render button.
        await createCalculation(
          ctx.pool,
          {
            valuationId: id,
            engineVersion: '1.4.0',
            status: 'succeeded',
            inputs: { params: {}, inputs: ENGINE_INPUTS },
            results: { ...RESULTS, fmv_per_share: 7.77 },
            equityValue: RESULTS.equity_value,
            fmvPerShare: 7.77,
            createdBy: client.id,
          },
          { ...actor, actorId: client.id },
        );

        const pdf = await opsGet(`/api/v1/valuations/${id}/report.pdf`);
        expect(pdf.statusCode).toBe(200);
        const text = readable(pdf.rawPayload);
        expect(text).toContain('$1.1100');
        expect(text).not.toContain('$7.7700');
      });

      it('renders a new version, which is how revised figures are published', async () => {
        // The escape hatch, and it is the right one: both documents stay in the
        // history, each with its own version number and its own bytes.
        const id = await publishedWithPdf('Delivered Three, Inc.');
        const current = (await opsGet(`/api/v1/valuations/${id}/report`)).json();
        const saved = await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/valuations/${id}/report`,
          headers: authHeader(ops.token),
          payload: { content: current.version.content },
        });
        expect(saved.statusCode).toBe(200);

        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${id}/report/render`,
          headers: authHeader(ops.token),
          payload: {},
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().version).toBe(2);
      });

      it('still renders a published report that was never rendered at all', async () => {
        // Nothing has been delivered, so there is nothing to protect — and
        // refusing here would leave the engagement with no deliverable.
        const id = await withResults('Delivered Four, Inc.', { ...RESULTS, fmv_per_share: 2.22 });
        await opsGet(`/api/v1/valuations/${id}/report`); // create, do not render
        await publish(id);
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${id}/report/render`,
          headers: authHeader(ops.token),
          payload: {},
        });
        expect(res.statusCode).toBe(200);
      });

      it('leaves a draft engagement free to re-render', async () => {
        // Render, recalculate, re-render is the ordinary drafting loop, and
        // nothing outside the platform holds those bytes.
        const id = await withResults('Drafting, Inc.', { ...RESULTS, fmv_per_share: 3.33 });
        await pdfText(id);
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${id}/report/render`,
          headers: authHeader(ops.token),
          payload: {},
        });
        expect(res.statusCode).toBe(200);
      });
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

  // ── the body states the conclusion ─────────────────────────────────────────

  /**
   * The defect that motivated `domain/reportFigures.ts`.
   *
   * The exhibits and the summary page have been computed at render time since
   * they existed. The authored body never was, so the chapter whose entire
   * purpose is to state the conclusion said "the fair market value … is $ …
   * per share" — three pages after the summary printed it. Every unit test
   * passed while it did, because a test asserts what somebody thought to check.
   */
  describe('the authored body', () => {
    // Its own engagement per test rather than the shared `computed`, whose body
    // earlier tests in this file overwrite with a one-line placeholder to
    // exercise the editor. These assertions are about the *skeleton*, so they
    // need one that nobody has edited.
    let body: ValuationRow;
    beforeAll(async () => {
      body = await seed('Skeleton Figures, Inc.', true);
    });

    it('states the concluded figures rather than an ellipsis', async () => {
      const text = await pdfText(body.id);
      expect(text).toContain('$1.2345');
      expect(text).toContain('$42,000,000');
      // The literal shape of the defect, in the chapter that carried it.
      expect(text).not.toContain('is$…pershare');
    });

    it('leaves no unresolved placeholder anywhere in a computed deliverable', async () => {
      // A `{{…}}` on the page is a figure the skeleton asked for and nothing
      // supplied — the failure this whole mechanism can produce, so it is
      // asserted directly rather than inferred from the figures above.
      expect(await pdfText(body.id)).not.toMatch(/\{\{\w+\}\}/);
    });

    it('fills the ASC 718 assumptions the 409A supplies', async () => {
      const text = await pdfText(body.id);
      expect(text).toContain('65.0%'); // volatility, as applied in the allocation
      expect(text).toContain('4.20%'); // risk-free rate
    });

    it('does not write the figures back into the stored version', async () => {
      // The stored body keeps its placeholders, which is what lets a re-render
      // after a recalculation restate the prose instead of carrying a stale
      // number. See the re-render test above.
      const v = await seed('Skeleton Stored, Inc.', true);
      await pdfText(v.id);
      const res = await opsGet(`/api/v1/valuations/${v.id}/report`);
      const sections = res.json().version.content.sections as Array<{ html: string }>;
      expect(sections.map((s) => s.html).join('')).toContain('{{fmv_per_share}}');
    });

    it('leaves the placeholders visible when no calculation has succeeded', async () => {
      // Deliberate. An unresolved placeholder is a draft nobody can mistake for
      // a conclusion; an em-dash or a zero reads as an answer.
      const text = await pdfText(uncomputed.id);
      expect(text).toMatch(/\{\{\w+\}\}/);
    });

    it('carries the chapters a reviewer of a 409A works through', async () => {
      const v = await seed('Skeleton Chapters, Inc.', true);
      const res = await opsGet(`/api/v1/valuations/${v.id}/report`);
      const keys = (res.json().version.content.sections as Array<{ key: string }>).map((s) => s.key);
      // The four the skeleton had no counterpart for against the legacy
      // deliverable's chapter list.
      expect(keys).toContain('purpose_and_scope');
      expect(keys).toContain('company_analysis');
      expect(keys).toContain('market_movement');
      expect(keys).toContain('use_and_distribution');
    });
  });

  // ── re-drafting onto a newer skeleton ──────────────────────────────────────

  describe('POST /report/draft', () => {
    const draft = (id: string, token: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/report/draft`,
        headers: authHeader(token),
        payload: {},
      });

    it('re-instantiates the body from the kind’s current template', async () => {
      const v = await seed('Redraft One, Inc.', true);
      await opsGet(`/api/v1/valuations/${v.id}/report`);
      const res = await draft(v.id, ops.token);
      expect(res.statusCode).toBe(200);
      expect(res.json().template_version).toBe('409a.v64');
      const keys = (res.json().version.content.sections as Array<{ key: string }>).map((s) => s.key);
      expect(keys).toContain('purpose_and_scope');
    });

    it('appends a version rather than overwriting the analyst’s draft', async () => {
      // The whole reason this is a separate endpoint: adopting a newer skeleton
      // must not silently discard prose somebody wrote.
      const v = await seed('Redraft Two, Inc.', true);
      const before = await opsGet(`/api/v1/valuations/${v.id}/report`);
      const beforeVersion = before.json().report.current_version;

      const res = await draft(v.id, ops.token);
      expect(res.json().report.current_version).toBe(beforeVersion + 1);

      const versions = await opsGet(`/api/v1/valuations/${v.id}/report/versions`);
      expect(versions.json().versions.length).toBeGreaterThan(1);
    });

    it('moves the report onto the new template version', async () => {
      const v = await seed('Redraft Three, Inc.', true);
      await opsGet(`/api/v1/valuations/${v.id}/report`);
      const res = await draft(v.id, ops.token);
      expect(res.json().report.template_version).toBe('409a.v64');
    });

    it('is refused to a client', async () => {
      const v = await seed('Redraft Four, Inc.', true);
      await opsGet(`/api/v1/valuations/${v.id}/report`);
      expect((await draft(v.id, client.token)).statusCode).toBe(403);
    });
  });
});
