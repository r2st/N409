/**
 * The Invested figure the browser shows, against the one this service computes.
 *
 * `invested_amount` is a column an administrator's sheet frequently leaves
 * blank beside a stated round price, so every reader here derives it —
 * `price × shares` when the amount is absent. `investedAmount` is the shared
 * implementation, and the auditor workbook's Invested column is
 * `preferredInvested` on top of it.
 *
 * The Cap table *tab* rendered the raw column instead, so a preferred class off
 * such a sheet showed "—" on screen and a figure in the workbook exported from
 * the same table — while the Preference stack total printed on that same screen
 * was computed with the fallback, from rows whose visible cells summed to
 * nothing. The browser's half is now `web-frontend/src/lib/capTableFigures.ts`,
 * a deliberate duplicate since the bundle cannot import this service.
 *
 * This file is the other end of that contract: FIXTURES here is the same list
 * as `web-frontend/test/capTableInvested.test.ts`, and both halves assert the
 * same expected figures. If you add a case there, add it here.
 *
 * The workbook is asserted through the real sheet rather than through
 * `preferredInvested` directly — the claim that matters is what lands in the
 * delivered cell, and a column reordered above it would otherwise go unnoticed.
 */
import { describe, expect, it } from 'vitest';
import { investedAmount, type CapTableEntry } from '../../src/domain/capTable.js';
import { valuationWorkbookSheets } from '../../src/export/valuationWorkbook.js';

const entry = (e: Partial<CapTableEntry>): CapTableEntry => ({
  security_class: 'Class',
  class_type: 'common',
  shares: 0,
  price_per_share: null,
  invested_amount: null,
  liquidation_multiple: null,
  seniority: null,
  conversion_ratio: null,
  ...e,
});

interface Fixture {
  name: string;
  entry: CapTableEntry;
  /** `investedAmount` — the shared base of the preference stack. */
  invested: number;
  /** What the tab's Invested cell holds, and what the workbook's must match. */
  displayed: number | null;
}

const FIXTURES: Fixture[] = [
  {
    name: 'a preferred class stating its amount',
    entry: entry({
      class_type: 'preferred',
      shares: 1_000_000,
      price_per_share: 1.25,
      invested_amount: 1_250_000,
    }),
    invested: 1_250_000,
    displayed: 1_250_000,
  },
  {
    name: 'the Carta shape: a preferred class with a price and no amount',
    entry: entry({ class_type: 'preferred', shares: 2_000_000, price_per_share: 1.5 }),
    invested: 3_000_000,
    displayed: 3_000_000,
  },
  {
    name: 'a fractional price, which must not be rounded on the way to the cell',
    entry: entry({ class_type: 'preferred', shares: 1_234_567, price_per_share: 0.0001 }),
    invested: 123.4567,
    displayed: 123.4567,
  },
  {
    name: 'a preferred class with neither column',
    entry: entry({ class_type: 'preferred', shares: 500_000 }),
    invested: 0,
    displayed: null,
  },
  {
    name: 'a stated amount of zero, which is stated rather than missing',
    entry: entry({ class_type: 'preferred', shares: 500_000, price_per_share: 2, invested_amount: 0 }),
    invested: 0,
    displayed: null,
  },
  {
    name: 'common at a founder price, which has not invested its issue value',
    entry: entry({ class_type: 'common', shares: 8_000_000, price_per_share: 0.0001 }),
    invested: 800,
    displayed: null,
  },
  {
    name: 'common stating an amount, which the preview must keep showing',
    entry: entry({ class_type: 'common', shares: 8_000_000, price_per_share: 0.0001, invested_amount: 800 }),
    invested: 800,
    displayed: 800,
  },
  {
    name: 'an option pool, which never carries a preference',
    entry: entry({ class_type: 'option', shares: 1_000_000 }),
    invested: 0,
    displayed: null,
  },
];

/** The Invested cell of the workbook's Cap table sheet, for a one-entry table. */
function workbookInvested(e: CapTableEntry): number | null {
  const sheets = valuationWorkbookSheets({
    valuation: {
      id: '01J0000000000000000000000A',
      number: 1,
      kind: '409a',
      company_name: 'Parity Co',
      currency: 'USD',
      state: 'pending',
    } as never,
    cells: [],
    capTable: { entries: [e], validation: { valid: true, issues: [], summary: {} as never } },
    grants: [],
    fmvPerShare: null,
    generatedAt: new Date('2026-08-26T00:00:00Z'),
  });
  const sheet = sheets.find((s) => s.name === 'Cap table');
  if (!sheet) throw new Error(`no Cap table sheet; got ${sheets.map((s) => s.name).join(', ')}`);
  const column = sheet.columns.findIndex((c) => c.header.startsWith('Invested'));
  expect(column).toBeGreaterThanOrEqual(0);
  // Row 0 is the single entry; the row after it is the totals row.
  const cell = sheet.rows[0]![column];
  return cell === null || cell === undefined ? null : (cell as number);
}

describe('cap table invested amount, browser against service', () => {
  it.each(FIXTURES)('$name', ({ entry: e, invested, displayed }) => {
    expect(investedAmount(e)).toBeCloseTo(invested, 6);
    const cell = workbookInvested(e);
    if (e.class_type !== 'preferred') {
      // The workbook's column is preference-stack only, so it blanks every
      // non-preferred class — including one that states an amount. The tab is
      // the import preview and keeps showing that figure: a superset of the
      // sheet, never a different answer to the same cell.
      expect(cell).toBeNull();
    } else if (displayed === null) {
      expect(cell).toBeNull();
    } else {
      expect(cell).not.toBeNull();
      expect(cell!).toBeCloseTo(displayed, 6);
    }
  });
});
