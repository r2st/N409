import { describe, expect, it } from 'vitest';
import {
  MAX_REVENUE_CENTS,
  parseQuickBooksBalanceSheet,
  parseXeroBalanceSheet,
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
