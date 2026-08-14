import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation, type ValuationRow } from '../../src/repos/valuations.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { readable } from './support/pdfText.js';

/**
 * A recalculation has to reach every surface, or none of them should be trusted.
 *
 * Each surface here reads `latestSucceededCalculation` for itself — the
 * deliverable, the auditor workbook and the QA review are three separate
 * queries in three separate routes, and nothing joins them. That is fine while
 * they all read the same row, and it is the whole problem the moment one of
 * them holds on to an older one. A cache added to the render path, a report
 * version that froze a figure into its authored prose when it was instantiated,
 * an export keyed on the valuation instead of the calculation: each produces a
 * board packet whose pages disagree, and none of them fails an assertion that
 * only ever looks at one surface at one point in time.
 *
 * So this suite supersedes a calculation and asserts on the *delta*. Two
 * claims, and the second is the one single-snapshot tests cannot make:
 *
 *   1. every surface moves to the new figure, and
 *   2. the old figure survives nowhere.
 *
 * (2) is what catches a stale read. A surface that kept the first calculation
 * still shows a plausible, well-formatted, internally consistent 409A — the
 * failure looks like a correct document until it is put beside another one.
 *
 * The figures are chosen to be unmistakable in a text dump: `1.2345` and
 * `3.9876` share no digit run, so neither can be a substring of the other's
 * rounding, and both differ from every share count and preference on the table.
 */

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };
const VALUATION_DATE = '2026-03-31';

const COMMON_SHARES = 8_000_000;
const PREFERRED_SHARES = 4_000_000;

/** One engine result, parameterised by the figures that must propagate. */
function results(fmv: number, equity: number, commonValue: number) {
  const perShare = commonValue / COMMON_SHARES;
  return {
    equity_value: equity,
    fmv_per_share: fmv,
    common_equity_value: commonValue,
    fully_diluted_common: COMMON_SHARES,
    fully_diluted_basis: 'cap_table_common',
    allocation_method: 'opm',
    approaches: {
      opm_backsolve: { weight: 1.0, method: 'backsolve_waterfall', equity_value: equity },
    },
    allocation: {
      method: 'opm_waterfall',
      common_per_share: perShare,
      common_shares: COMMON_SHARES,
      common_value: commonValue,
      breakpoints: [
        { from: 0, to: 10_000_000, participants: { 'Series Seed': 1 }, value: 10_000_000 },
        { from: 10_000_000, to: null, participants: { Common: 1 }, value: equity - 10_000_000 },
      ],
      classes: {
        Common: { kind: 'common', shares: COMMON_SHARES, value: commonValue, per_share: perShare },
        'Series Seed': {
          kind: 'preferred',
          shares: PREFERRED_SHARES,
          value: equity - commonValue,
          per_share: (equity - commonValue) / PREFERRED_SHARES,
        },
      },
    },
    assumptions: { time_to_exit_years: 3.5, risk_free_rate: 0.042, volatility: 0.65 },
    discounts: { dloc: 0.1, dlom: 0.25, dlom_method: 'chaffee' },
  };
}

const ENGINE_INPUTS = {
  valuation_date: VALUATION_DATE,
  share_classes: [
    { kind: 'common', name: 'Common', shares: COMMON_SHARES },
    {
      kind: 'preferred',
      name: 'Series Seed',
      shares: PREFERRED_SHARES,
      preference: 10_000_000,
      seniority: 1,
      conversion_ratio: 1,
    },
  ],
};

const FIRST = results(1.2345, 42_000_000, 14_625_184);
const SECOND = results(3.9876, 96_000_000, 47_240_000);

const STALE = '1.2345';
const FRESH = '3.9876';

describe.skipIf(!dbUp)('a superseding calculation reaches every surface', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let v: ValuationRow;
  let tmp: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Meridian Instruments, Inc.', userId: client.id, currency: 'USD' },
      { ...actor, actorId: client.id },
    );
    tmp = mkdtempSync(join(tmpdir(), 'n409-propagation-'));
  });
  afterAll(async () => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    await ctx?.teardown();
  });

  const opsGet = (url: string) => ctx.app.inject({ method: 'GET', url, headers: authHeader(ops.token) });

  async function addCalculation(r: ReturnType<typeof results>): Promise<void> {
    await createCalculation(
      ctx.pool,
      {
        valuationId: v.id,
        engineVersion: '1.4.0',
        status: 'succeeded',
        inputs: { params: {}, inputs: ENGINE_INPUTS },
        results: r,
        equityValue: r.equity_value,
        fmvPerShare: r.fmv_per_share,
        createdBy: client.id,
      },
      { ...actor, actorId: client.id },
    );
  }

  // ── the surfaces, each read the way its consumer reads it ─────────────────

  /** The deliverable: rendered afresh, then read back out of the PDF bytes. */
  async function deliverable(): Promise<string> {
    await opsGet(`/api/v1/valuations/${v.id}/report`); // instantiates on first access
    const rendered = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/report/render`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(rendered.statusCode).toBe(200);
    const pdf = await opsGet(`/api/v1/valuations/${v.id}/report.pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    return readable(pdf.rawPayload);
  }

  /** The auditor workbook, as the strings an auditor would see in the cells. */
  async function workbook(): Promise<string> {
    const res = await opsGet(`/api/v1/valuations/${v.id}/workbook.xlsx`);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
    // Unzipped from a file rather than parsed in-process, for the reason
    // `xlsxExport.test.ts` gives: the failure that matters is a workbook Excel
    // cannot open, and only a real unzip proves the archive is one.
    const file = join(tmp, `workbook-${Date.now()}.xlsx`);
    writeFileSync(file, res.rawPayload);
    // Every worksheet and the shared string table — a figure may be inlined or
    // pooled depending on how the writer chose to emit it, and this assertion
    // is about whether the number is in the file, not where.
    return execFileSync('unzip', ['-p', file, 'xl/*.xml'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  /** The QA review — the gate that decides whether this may be published. */
  async function qaReview(): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${v.id}/qa`,
      headers: authHeader(ops.token),
      payload: {},
    });
    // 201: running a review creates one.
    expect(res.statusCode).toBe(201);
    return JSON.stringify(res.json());
  }

  /** What the calculation record itself reports to an API consumer. */
  async function calculationApi(): Promise<string> {
    const res = await opsGet(`/api/v1/valuations/${v.id}/calculations`);
    expect(res.statusCode).toBe(200);
    return JSON.stringify(res.json());
  }

  const SURFACES: Record<string, () => Promise<string>> = {
    'the rendered 409A': () => deliverable(),
    'the auditor workbook': () => workbook(),
    'the QA review': () => qaReview(),
    'the calculations API': () => calculationApi(),
  };

  let before: Record<string, string>;
  let after: Record<string, string>;

  beforeAll(async () => {
    await addCalculation(FIRST);
    before = Object.fromEntries(
      await Promise.all(Object.entries(SURFACES).map(async ([n, read]) => [n, await read()])),
    );

    // A second run supersedes the first. `latestSucceededCalculation` orders on
    // `created_at`, which defaults to `now()` — transaction start time — so the
    // two inserts need to land in different transactions to be ordered at all.
    // They do: `createCalculation` opens its own. The wait is belt and braces
    // against a clock coarse enough to tie them.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await addCalculation(SECOND);

    after = Object.fromEntries(
      await Promise.all(Object.entries(SURFACES).map(async ([n, read]) => [n, await read()])),
    );
  });

  describe('before it is superseded', () => {
    it.each(Object.keys(SURFACES))('%s states the first calculation', (name) => {
      expect(before[name]).toContain(STALE);
      expect(before[name]).not.toContain(FRESH);
    });
  });

  describe('after it is superseded', () => {
    it.each(Object.keys(SURFACES))('%s states the new calculation', (name) => {
      expect(after[name]).toContain(FRESH);
    });

    /**
     * The claim a single-surface test cannot make. A surface that kept the
     * first calculation still renders a complete, internally consistent
     * document — it is only wrong next to the others.
     *
     * The calculations API is excluded because it is the one surface that is
     * *supposed* to show both: it lists the run history, and a superseded run
     * disappearing from it would be the defect.
     */
    it.each(Object.keys(SURFACES).filter((n) => n !== 'the calculations API'))(
      '%s keeps nothing of the superseded one',
      (name) => {
        expect(after[name]).not.toContain(STALE);
      },
    );

    it('the calculations API still lists the superseded run, because it is history', () => {
      expect(after['the calculations API']).toContain(STALE);
      expect(after['the calculations API']).toContain(FRESH);
    });
  });

  /**
   * The figures that move together.
   *
   * `fmv_per_share` is one number and a surface could carry it while still
   * reading an older allocation for everything else — the concluded price
   * right and the schedule behind it wrong, which is the harder version of the
   * same bug to see. These are the equity value and the common value from the
   * same run, formatted as the deliverable prints them.
   */
  describe('the schedules behind the conclusion move with it', () => {
    it('the deliverable states the new equity value, not the old one', () => {
      expect(after['the rendered 409A']).toContain('96,000,000');
      expect(after['the rendered 409A']).not.toContain('42,000,000');
    });

    it('the deliverable states the new common equity value, not the old one', () => {
      expect(after['the rendered 409A']).toContain('47,240,000');
      expect(after['the rendered 409A']).not.toContain('14,625,184');
    });

    it('the cap table is unchanged, so its figures are in both renders', () => {
      // The control on the two assertions above: these share counts did not
      // move between the runs, so a render that dropped them entirely would
      // otherwise satisfy every `not.toContain` here for the wrong reason.
      for (const text of [before['the rendered 409A'], after['the rendered 409A']]) {
        expect(text).toContain('8,000,000');
        expect(text).toContain('Series Seed');
      }
    });
  });
});
