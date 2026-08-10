import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { WorkbookTab } from '../src/pages/valuation/WorkbookTab';
import type { Valuation } from '../src/lib/types';
import type { FinancialAnomalyReport } from '../src/lib/m2';

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', roles: ['admin'] } }),
}));

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  number: 'N-1001',
  state: 'review',
  company_name: 'Zorblatt Dynamics',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const SHEETS = [
  {
    key: 'income_statement',
    label: 'Income statement',
    description: 'Historical and projected P&L; margins and growth are derived.',
    columns: [
      { key: 'fy_minus_1', label: 'FY-1' },
      { key: 'fy_current', label: 'FY (current)' },
    ],
    rows: [
      {
        key: 'revenue',
        label: 'Revenue',
        kind: 'input' as const,
        format: 'currency' as const,
        cells: [
          { column_key: 'fy_minus_1', value: 1_000_000 },
          { column_key: 'fy_current', value: 1_200_000 },
        ],
      },
      {
        key: 'cogs',
        label: 'Cost of goods sold',
        kind: 'input' as const,
        format: 'currency' as const,
        cells: [
          { column_key: 'fy_minus_1', value: 400_000 },
          { column_key: 'fy_current', value: -480_000 },
        ],
      },
      {
        key: 'gross_profit',
        label: 'Gross profit',
        kind: 'derived' as const,
        format: 'currency' as const,
        cells: [
          { column_key: 'fy_minus_1', value: 600_000 },
          { column_key: 'fy_current', value: 1_680_000 },
        ],
      },
    ],
  },
  {
    key: 'balance_sheet',
    label: 'Balance sheet',
    description: 'Point-in-time balances.',
    columns: [
      { key: 'fy_minus_1', label: 'FY-1' },
      { key: 'fy_current', label: 'FY (current)' },
    ],
    rows: [
      {
        key: 'cash',
        label: 'Cash & equivalents',
        kind: 'input' as const,
        format: 'currency' as const,
        cells: [
          { column_key: 'fy_minus_1', value: 200_000 },
          { column_key: 'fy_current', value: 250_000 },
        ],
      },
    ],
  },
];

const ANOMALIES: FinancialAnomalyReport = {
  anomalies: [
    {
      check: 'cost_entered_negative',
      severity: 'error',
      sheet: 'income_statement',
      sheet_label: 'Income statement',
      column_key: 'fy_current',
      column_label: 'FY (current)',
      row_key: 'cogs',
      row_label: 'Cost of goods sold',
      value: -480_000,
      summary: 'Cost of goods sold is negative in FY (current).',
      detail: 'The model subtracts this line, so a negative figure is added back.',
    },
    {
      check: 'negative_book_equity',
      severity: 'info',
      sheet: 'balance_sheet',
      sheet_label: 'Balance sheet',
      column_key: 'fy_current',
      column_label: 'FY (current)',
      row_key: 'shareholders_equity',
      row_label: 'Shareholders’ equity',
      value: -50_000,
      summary: 'Book equity is negative in FY (current).',
      detail: 'Common for a company financed by convertible debt, and not an error.',
    },
  ],
  counts: { error: 1, warning: 0, info: 1 },
  empty: false,
};

const CLEAN: FinancialAnomalyReport = {
  anomalies: [],
  counts: { error: 0, warning: 0, info: 0 },
  empty: false,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi(anomalies: FinancialAnomalyReport, onSave?: () => FinancialAnomalyReport) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (!path.includes('/workbook')) throw new Error(`unexpected fetch ${path}`);
    if ((init?.method ?? 'GET') === 'PATCH') {
      return jsonResponse({ sheets: SHEETS, anomalies: onSave ? onSave() : anomalies });
    }
    return jsonResponse({ sheets: SHEETS, anomalies });
  });
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/workbook']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/workbook" element={<WorkbookTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('workbook statement review', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows each finding with the line and period it is about', async () => {
    mockApi(ANOMALIES);
    renderTab();
    expect(await screen.findByText('Statement review')).toBeInTheDocument();
    expect(screen.getByText('Cost of goods sold is negative in FY (current).')).toBeInTheDocument();
    expect(screen.getByText('Income statement · Cost of goods sold · FY (current)')).toBeInTheDocument();
  });

  it('separates a fault from a note, so the one that changes a number reads first', async () => {
    mockApi(ANOMALIES);
    renderTab();
    expect(await screen.findByText('Error')).toBeInTheDocument();
    expect(screen.getByText('Note')).toBeInTheDocument();
    expect(screen.getByText('1 error · 1 noted')).toBeInTheDocument();
  });

  /**
   * The panel is not a gate — nothing about a finding stops the analyst saving,
   * exporting or moving on. If that ever changes it should be a decision, not a
   * regression, so it is asserted here.
   */
  it('leaves the workbook fully usable while findings stand', async () => {
    mockApi(ANOMALIES);
    renderTab();
    expect(await screen.findByText('Statement review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export auditor workbook/ })).toBeEnabled();
  });

  it('says nothing at all when the statements read normally', async () => {
    mockApi(CLEAN);
    renderTab();
    // Waits on the grid so this cannot pass by asserting against an empty render.
    expect(await screen.findByLabelText('Revenue fy_current')).toBeInTheDocument();
    expect(screen.queryByText('Statement review')).not.toBeInTheDocument();
  });

  it('opens the sheet a finding names when the finding is clicked', async () => {
    mockApi(ANOMALIES);
    renderTab();
    await screen.findByText('Statement review');
    // The income statement is the sheet on load; the balance-sheet finding has
    // to be able to move the grid to its own sheet.
    expect(screen.queryByLabelText('Cash & equivalents fy_current')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Book equity is negative in FY (current).'));
    expect(await screen.findByLabelText('Cash & equivalents fy_current')).toBeInTheDocument();
  });

  it('clears a finding corrected in the cell that raised it, without a reload', async () => {
    mockApi(ANOMALIES, () => CLEAN);
    renderTab();
    await screen.findByText('Statement review');

    const cell = screen.getByLabelText('Cost of goods sold fy_current');
    await userEvent.clear(cell);
    await userEvent.type(cell, '480000');
    await userEvent.click(screen.getByRole('button', { name: 'Save workbook' }));

    await waitFor(() => expect(screen.queryByText('Statement review')).not.toBeInTheDocument());
  });
});
