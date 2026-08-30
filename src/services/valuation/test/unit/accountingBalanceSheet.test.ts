import { describe, expect, it, vi } from 'vitest';
import {
  fetchBalanceSheet,
  fetchFinancials,
  parseQuickBooksBalanceSheet,
  parseQuickBooksProfitAndLoss,
  parseXeroBalanceSheet,
  parseXeroProfitAndLoss,
} from '../../src/clients/accounting.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

// ── Xero fixtures ────────────────────────────────────────────────────────────

const xeroRow = (label: string, value: string) => ({ Cells: [{ Value: label }, { Value: value }] });

const XERO_BALANCE_SHEET = {
  Reports: [
    {
      Fields: [
        { Id: 'ToDate', Value: '2026-06-30' },
        { Id: 'Currency', Value: 'GBP' },
      ],
      Rows: [
        {
          Rows: [
            xeroRow('Bank Accounts', '150000.00'),
            xeroRow('Total Current Assets', '400000.00'),
            xeroRow('Total Assets', '900000.50'),
          ],
        },
        {
          Rows: [
            xeroRow('Total Current Liabilities', '120000.00'),
            xeroRow('Total Liabilities', '250000.00'),
          ],
        },
        { Rows: [xeroRow('Net Assets', '650000.50')] },
      ],
    },
  ],
};

const XERO_PL = {
  Reports: [
    {
      Fields: [
        { Id: 'Currency', Value: 'GBP' },
        { Id: 'FromDate', Value: '2025-07-01' },
        { Id: 'ToDate', Value: '2026-06-30' },
      ],
      Rows: [
        {
          Rows: [
            { Cells: [{ Value: 'Total Income' }, { Value: '500000' }, { Value: '400000' }] },
            { Cells: [{ Value: 'Net Profit' }, { Value: '75000' }] },
          ],
        },
      ],
    },
  ],
};

// ── QuickBooks fixtures ──────────────────────────────────────────────────────

const qboSummary = (label: string, value: string) => ({
  Summary: { ColData: [{ value: label }, { value }] },
});

const QBO_BALANCE_SHEET = {
  Header: { EndPeriod: '2026-06-30' },
  Rows: {
    Row: [
      {
        Rows: {
          Row: [
            qboSummary('Total Current Assets', '400000.00'),
            { Rows: { Row: [qboSummary('Cash and cash equivalents', '150000.00')] } },
          ],
        },
        ...qboSummary('Total Assets', '900000.50'),
      },
      { ...qboSummary('Total Liabilities', '250000.00') },
      { ...qboSummary('Total Equity', '650000.50') },
    ],
  },
};

describe('Xero balance sheet', () => {
  const sheet = parseXeroBalanceSheet(XERO_BALANCE_SHEET);

  it('reads every subtotal into cents', () => {
    expect(sheet.total_assets_cents).toBe(90_000_050);
    expect(sheet.total_liabilities_cents).toBe(25_000_000);
    expect(sheet.total_equity_cents).toBe(65_000_050);
    expect(sheet.current_assets_cents).toBe(40_000_000);
    expect(sheet.current_liabilities_cents).toBe(12_000_000);
    expect(sheet.cash_cents).toBe(15_000_000);
  });

  it('does not let "Total Current Assets" answer for "Total Assets"', () => {
    // The whole reason the patterns are anchored. Conflating the two
    // understates assets by whatever is fixed, and the asset approach reads
    // this number directly.
    expect(sheet.total_assets_cents).not.toBe(sheet.current_assets_cents);
  });

  it('dates the sheet at the period end — a balance sheet is a point in time', () => {
    expect(sheet.as_of).toBe('2026-06-30');
  });

  it('yields all-null on a shape it does not recognise, without throwing', () => {
    for (const junk of [null, undefined, {}, { Reports: [] }, 'nonsense', 42]) {
      const out = parseXeroBalanceSheet(junk);
      expect(out.total_assets_cents).toBeNull();
      expect(out.total_liabilities_cents).toBeNull();
    }
  });

  it('keeps the first of a repeated subtotal, not the last', () => {
    // Comparative or consolidated statements repeat the label; the first
    // occurrence belongs to the primary period.
    const out = parseXeroBalanceSheet({
      Reports: [{ Rows: [{ Rows: [xeroRow('Total Assets', '100'), xeroRow('Total Assets', '999')] }] }],
    });
    expect(out.total_assets_cents).toBe(10_000);
  });
});

describe('QuickBooks balance sheet', () => {
  const sheet = parseQuickBooksBalanceSheet(QBO_BALANCE_SHEET);

  it('walks nested Summary rows for the subtotals', () => {
    expect(sheet.total_assets_cents).toBe(90_000_050);
    expect(sheet.total_liabilities_cents).toBe(25_000_000);
    expect(sheet.total_equity_cents).toBe(65_000_050);
    expect(sheet.current_assets_cents).toBe(40_000_000);
    expect(sheet.cash_cents).toBe(15_000_000);
    expect(sheet.as_of).toBe('2026-06-30');
  });

  it('ignores "Total Liabilities and Equity" — that is assets by another name', () => {
    const out = parseQuickBooksBalanceSheet({
      Rows: { Row: [qboSummary('Total Liabilities and Equity', '900000.50')] },
    });
    expect(out.total_liabilities_cents).toBeNull();
  });

  it('survives junk without throwing', () => {
    for (const junk of [null, undefined, {}, { Rows: {} }, []]) {
      expect(() => parseQuickBooksBalanceSheet(junk)).not.toThrow();
    }
  });
});

/**
 * The report shaped to break the parser, rather than the report an accountant
 * exported.
 *
 * `asRecord` guards the body; every collection inside it was asserted by a cast
 * and read unguarded. A `TypeError` out of one of these parsers is caught by
 * the import route, run through `describeTransportFailure`, and written to
 * `accounting_connections.last_error` — which is the column the analyst is then
 * told to go and read, in a sentence about the provider having failed.
 */
describe('adversarial accounting reports', () => {
  it('reads a section list that is not a list as no sections', () => {
    expect(parseXeroBalanceSheet({ Reports: [{ Rows: { Assets: {} } }] })).toMatchObject({
      total_assets_cents: null,
    });
    expect(parseXeroProfitAndLoss({ Reports: [{ Rows: 'Income' }] })).toMatchObject({
      revenue_cents: null,
    });
    expect(parseQuickBooksProfitAndLoss({ Rows: { Row: { group: 'Income' } } })).toMatchObject({
      revenue_cents: null,
    });
  });

  it('skips a row that is not a row and keeps the ones beside it', () => {
    const report = {
      Reports: [
        {
          Fields: [{ Id: 'ToDate', Value: '2026-06-30' }],
          Rows: [null, { Rows: [null, xeroRow('Total Assets', '1000.00')] }],
        },
      ],
    };
    const sheet = parseXeroBalanceSheet(report);
    expect(sheet.total_assets_cents).toBe(100_000);
    expect(sheet.as_of).toBe('2026-06-30');
  });

  it('reads a Fields block that is not a list without losing the rest of the parse', () => {
    const sheet = parseXeroBalanceSheet({
      Reports: [{ Fields: { ToDate: '2026-06-30' }, Rows: [{ Rows: [xeroRow('Total Assets', '5.00')] }] }],
    });
    expect(sheet.total_assets_cents).toBe(500);
    expect(sheet.as_of).toBeNull();
  });

  it('keeps a QuickBooks summary beside a null row', () => {
    const report = {
      Header: { EndPeriod: '2026-06-30' },
      Rows: {
        Row: [
          null,
          { group: 'TotalAssets', Summary: { ColData: [{ value: 'Total Assets' }, { value: '250' }] } },
        ],
      },
    };
    expect(parseQuickBooksBalanceSheet(report).total_assets_cents).toBe(25_000);
  });

  /*
   * V8's JSON parser is iterative, so nesting this deep parses cleanly at about
   * 340 KB — three orders of magnitude inside the 16 MB body cap — and the
   * unbounded `walk` below it then exhausted the stack. `RangeError: Maximum
   * call stack size exceeded` became the provider's recorded failure.
   */
  it('stops walking a report nested deeper than any real one', () => {
    const depth = 20_000;
    const leaf = '{"group":"Income","Summary":{"ColData":[{"value":"1"}]}}';
    const text = '{"Rows":{"Row":['.repeat(depth) + leaf + ']}}'.repeat(depth);
    const report = JSON.parse(`{"Rows":{"Row":[${text}]}}`) as unknown;
    expect(() => parseQuickBooksProfitAndLoss(report)).not.toThrow();
    expect(() => parseQuickBooksBalanceSheet(report)).not.toThrow();
  });

  it('still reads a report nested as deep as a real one', () => {
    const report = {
      Rows: {
        Row: [
          {
            Rows: {
              Row: [{ group: 'Income', Summary: { ColData: [{ value: 'Income' }, { value: '900' }] } }],
            },
          },
        ],
      },
    };
    expect(parseQuickBooksProfitAndLoss(report).revenue_cents).toBe(90_000);
  });
});

describe('fetchBalanceSheet', () => {
  it('sends the Xero tenant header', async () => {
    const fetchFn = vi.fn(async () => json(XERO_BALANCE_SHEET));
    await fetchBalanceSheet('xero', { accessToken: 'at', externalOrgId: 'tenant-1' }, fetchFn as never);
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    expect(String(fetchFn.mock.calls[0]![0])).toContain('Reports/BalanceSheet');
    expect((init.headers as Record<string, string>)['xero-tenant-id']).toBe('tenant-1');
  });

  it('refuses a QuickBooks pull with no realm id rather than calling a bad URL', async () => {
    const fetchFn = vi.fn(async () => json({}));
    await expect(
      fetchBalanceSheet('quickbooks', { accessToken: 'at', externalOrgId: null }, fetchFn as never),
    ).rejects.toThrow(/realm id/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reports an upstream error with its status', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 503 }));
    await expect(
      fetchBalanceSheet('xero', { accessToken: 'at', externalOrgId: 't' }, fetchFn as never),
    ).rejects.toThrow(/balance sheet fetch failed \(503\)/);
  });

  it('declines the providers that have no parser', async () => {
    await expect(
      fetchBalanceSheet('sage', { accessToken: 'at', externalOrgId: null }, (async () => json({})) as never),
    ).rejects.toThrow(/not supported yet/);
  });
});

describe('fetchFinancials pulls both statements', () => {
  const route = (bs: unknown, pl: unknown = XERO_PL) =>
    vi.fn(async (url: unknown) => json(String(url).includes('BalanceSheet') ? bs : pl));

  it('returns the P&L and the balance sheet together', async () => {
    const fetchFn = route(XERO_BALANCE_SHEET);
    const out = await fetchFinancials('xero', { accessToken: 'at', externalOrgId: 't' }, fetchFn as never);
    expect(out.revenue_cents).toBe(50_000_000);
    expect(out.balance_sheet!.total_assets_cents).toBe(90_000_050);
    expect(out.balance_sheet_error).toBeNull();
  });

  it('still delivers the P&L when the balance sheet call fails', async () => {
    // An org that has never run a balance sheet must still get the revenue
    // import it asked for — the P&L is what the params depend on.
    const fetchFn = vi.fn(async (url: unknown) =>
      String(url).includes('BalanceSheet') ? new Response('', { status: 500 }) : json(XERO_PL),
    );
    const out = await fetchFinancials('xero', { accessToken: 'at', externalOrgId: 't' }, fetchFn as never);
    expect(out.revenue_cents).toBe(50_000_000);
    expect(out.balance_sheet).toBeNull();
    expect(out.balance_sheet_error).toMatch(/500/);
  });

  it('says so when the sheet parsed to nothing, rather than returning null rows', async () => {
    const out = await fetchFinancials(
      'xero',
      { accessToken: 'at', externalOrgId: 't' },
      route({ Reports: [{ Rows: [{ Rows: [xeroRow('Mystery Subtotal', '1')] }] }] }) as never,
    );
    expect(out.balance_sheet).toBeNull();
    expect(out.balance_sheet_error).toMatch(/no recognised subtotals/i);
  });

  it('fails the whole import when the P&L itself fails', async () => {
    const fetchFn = vi.fn(async (url: unknown) =>
      String(url).includes('BalanceSheet') ? json(XERO_BALANCE_SHEET) : new Response('', { status: 401 }),
    );
    await expect(
      fetchFinancials('xero', { accessToken: 'at', externalOrgId: 't' }, fetchFn as never),
    ).rejects.toThrow(/report fetch failed \(401\)/);
  });

  it('calls the two reports sequentially, P&L first', async () => {
    // Concurrent report calls on one token are what trips both providers'
    // rate limits, and the balance sheet is worthless if the P&L failed.
    const seen: string[] = [];
    const fetchFn = vi.fn(async (url: unknown) => {
      seen.push(String(url).includes('BalanceSheet') ? 'bs' : 'pl');
      return json(String(url).includes('BalanceSheet') ? XERO_BALANCE_SHEET : XERO_PL);
    });
    await fetchFinancials('xero', { accessToken: 'at', externalOrgId: 't' }, fetchFn as never);
    expect(seen).toEqual(['pl', 'bs']);
  });
});
