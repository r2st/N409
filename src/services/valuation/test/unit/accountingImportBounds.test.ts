import { describe, expect, it } from 'vitest';
import {
  MAX_REVENUE_CENTS,
  parseQuickBooksBalanceSheet,
  parseQuickBooksProfitAndLoss,
  parseXeroBalanceSheet,
  parseXeroProfitAndLoss,
  storableLedgerCents,
  storableRevenueCents,
} from '../../src/clients/accounting.js';

/**
 * Ledger figures held to the bounds the params form is held to (round 259,
 * methodology M6).
 *
 * `PATCH /api/v1/valuations/:id/params` reads both revenue fields through
 * `z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)`, because both are
 * `bigint` columns. The accounting import wrote whatever `toCents` made of the
 * provider's cell into the same columns, through a different repo, with no
 * bound at all — the shape `mapGrant` states the rule against: hold the import
 * to what the form is held to, because a provider's payload is no more
 * trustworthy than a form's.
 */

describe('storableRevenueCents', () => {
  it('accepts an ordinary figure and an absent one', () => {
    expect(storableRevenueCents(0)).toBe(true);
    expect(storableRevenueCents(2_460_000_000)).toBe(true);
    expect(storableRevenueCents(null)).toBe(true);
    expect(storableRevenueCents(MAX_REVENUE_CENTS)).toBe(true);
  });

  it('refuses a negative revenue rather than filing the company as pre-revenue', () => {
    // A period whose credit notes exceed its invoices is a real ledger answer
    // and an impossible column value; the route derives `revenue_status` from
    // the sign, so storing it valued a trading company as one that has never
    // sold anything.
    expect(storableRevenueCents(-1)).toBe(false);
    expect(storableRevenueCents(-5_000_000)).toBe(false);
  });

  it('refuses a figure past the column rather than letting the driver refuse it', () => {
    // `patchParams` sits outside the import route's catch, so `22003 value out
    // of range for type bigint` left no error on the connection and a 500 in
    // Postgres's words.
    expect(storableRevenueCents(MAX_REVENUE_CENTS + 2)).toBe(false);
    expect(storableRevenueCents(1e302)).toBe(false);
  });

  it('refuses a figure that is not whole', () => {
    expect(storableRevenueCents(1.5)).toBe(false);
  });
});

/**
 * The bound round 259 did not put on the balance sheet (round 265, M6).
 *
 * `total_assets_cents` and `total_liabilities_cents` are the asset approach's
 * two required inputs — `approaches.asset_value` refuses NAV without them — and
 * they went into `engine_inputs.asset` through a `jsonb` column that has no
 * rule to be held to. `toCents` is not that rule: it tests `Number.isFinite` on
 * the parsed cell and *then* multiplies by a hundred, so the check is on the
 * input and the overflow is in the output.
 */
describe('storableLedgerCents', () => {
  it('accepts an ordinary balance sheet and an absent one', () => {
    expect(storableLedgerCents(0)).toBe(true);
    expect(storableLedgerCents(4_500_000_00)).toBe(true);
    expect(storableLedgerCents(null)).toBe(true);
  });

  it('refuses the figure that reaches the engine as no figure at all', () => {
    // `Infinity` is not representable in JSON, so `JSON.stringify` writes it as
    // `null` and `inputs.asset.total_assets` arrives present-and-null. The
    // engine then reports "total_assets is required", telling the analyst the
    // ledger supplied no balance sheet by way of the import that read one.
    expect(storableLedgerCents(Number.POSITIVE_INFINITY)).toBe(false);
    expect(storableLedgerCents(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(storableLedgerCents(Number.NaN)).toBe(false);
  });

  it('refuses a figure that stores fine and values to nonsense', () => {
    // Finite the whole way through, so `_finite_result` guards the subtraction
    // and passes: NAV concludes an equity value of 1e300 and it is weighted
    // into the conclusion with nothing calling it out of range.
    expect(storableLedgerCents(1e302)).toBe(false);
    expect(storableLedgerCents(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
  });

  it('does not make sign part of the rule', () => {
    // The engine already reasons about liabilities exceeding assets; refusing a
    // negative here would be a bound the approach itself does not have.
    expect(storableLedgerCents(-250_000_00)).toBe(true);
  });
});

describe('the parsed cell an unbounded balance sheet comes from', () => {
  it('turns a finite provider cell into a figure that is not finite', () => {
    // The demonstration that `toCents`'s own check cannot stand in for this
    // one: `1e307` is a finite string a provider — or an ingress rewriting one
    // — can put in a Total Assets cell, and it comes back `Infinity`.
    const sheet = parseXeroBalanceSheet({
      Reports: [{ Rows: [{ Rows: [{ Cells: [{ Value: 'Total Assets' }, { Value: '1e307' }] }] }] }],
    });
    expect(Number.isFinite(sheet.total_assets_cents)).toBe(false);
    expect(storableLedgerCents(sheet.total_assets_cents)).toBe(false);
  });

  it('turns a large provider cell into one that stores and cannot be valued on', () => {
    const sheet = parseQuickBooksBalanceSheet({
      Rows: {
        Row: [{ Summary: { ColData: [{ value: 'Total Liabilities' }, { value: '1e300' }] } }],
      },
    });
    expect(Number.isFinite(sheet.total_liabilities_cents)).toBe(true);
    expect(storableLedgerCents(sheet.total_liabilities_cents)).toBe(false);
  });
});

describe('balance sheet as-of', () => {
  const NUL = '\u0000';

  it('drops a Xero report date that cannot be stored', () => {
    // `as_of` is copied into two jsonb documents — the engagement's
    // `engine_inputs.accounting_import` and `last_import_summary`, the second
    // written after both applies have committed and outside the route's catch.
    const sheet = parseXeroBalanceSheet({
      Reports: [
        {
          Fields: [{ Id: 'ToDate', Value: `2026-08-31${NUL}` }],
          Rows: [{ Rows: [{ Cells: [{ Value: 'Total Assets' }, { Value: '1000' }] }] }],
        },
      ],
    });
    expect(sheet.as_of).toBeNull();
    expect(sheet.total_assets_cents).toBe(100_000);
  });

  it('drops a Xero report date that is not text', () => {
    const sheet = parseXeroBalanceSheet({
      Reports: [{ Fields: [{ Id: 'ToDate', Value: { date: '2026-08-31' } }], Rows: [] }],
    });
    expect(sheet.as_of).toBeNull();
  });

  it('drops a QuickBooks period end that cannot be stored', () => {
    const sheet = parseQuickBooksBalanceSheet({
      Header: { EndPeriod: `2026-08-31${NUL}` },
      Rows: { Row: [] },
    });
    expect(sheet.as_of).toBeNull();
  });

  it('keeps an ordinary report date', () => {
    expect(
      parseXeroBalanceSheet({ Reports: [{ Fields: [{ Id: 'ToDate', Value: '2026-08-31' }], Rows: [] }] })
        .as_of,
    ).toBe('2026-08-31');
    expect(
      parseQuickBooksBalanceSheet({ Header: { EndPeriod: '2026-08-31' }, Rows: { Row: [] } }).as_of,
    ).toBe('2026-08-31');
  });
});

describe('profit-and-loss header text', () => {
  const NUL = '\u0000';

  it('drops a Xero currency and period that cannot be stored', () => {
    const pl = parseXeroProfitAndLoss({
      Reports: [
        {
          Fields: [
            { Id: 'Currency', Value: `USD${NUL}` },
            { Id: 'FromDate', Value: { d: 1 } },
            { Id: 'ToDate', Value: '2026-08-31' },
          ],
          Rows: [],
        },
      ],
    });
    expect(pl.currency).toBeNull();
    expect(pl.period_start).toBeNull();
    expect(pl.period_end).toBe('2026-08-31');
  });

  it('drops a QuickBooks header that cannot be stored', () => {
    const pl = parseQuickBooksProfitAndLoss({
      Header: { Currency: 'USD', StartPeriod: `2026-01-01${NUL}`, EndPeriod: '2026-08-31' },
      Rows: { Row: [] },
    });
    expect(pl.currency).toBe('USD');
    expect(pl.period_start).toBeNull();
    expect(pl.period_end).toBe('2026-08-31');
  });
});
