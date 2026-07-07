import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { WorkbookTab } from '../src/pages/valuation/WorkbookTab';
import type { Valuation } from '../src/lib/types';

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'started',
  company_name: 'Acme',
  user_id: 'u1',
} as unknown as Valuation;

const SHEETS = [
  {
    key: 'income_statement',
    label: 'Income statement',
    description: 'P&L',
    columns: [
      { key: 'fy_minus_1', label: 'FY-1' },
      { key: 'fy_current', label: 'FY (current)' },
    ],
    rows: [
      {
        key: 'revenue',
        label: 'Revenue',
        kind: 'input',
        format: 'currency',
        cells: [
          { column_key: 'fy_minus_1', value: 800 },
          { column_key: 'fy_current', value: null },
        ],
      },
      {
        key: 'gross_profit',
        label: 'Gross profit',
        kind: 'derived',
        format: 'currency',
        cells: [
          { column_key: 'fy_minus_1', value: 480 },
          { column_key: 'fy_current', value: null },
        ],
      },
    ],
  },
];

function WithWorkspace() {
  return <Outlet context={{ valuation, reload: async () => {} }} />;
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/wb']}>
      <Routes>
        <Route element={<WithWorkspace />}>
          <Route path="/wb" element={<WorkbookTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('WorkbookTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the grid with derived rows read-only', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ sheets: SHEETS }));
    renderTab();

    expect(await screen.findByText('Revenue')).toBeInTheDocument();
    expect(screen.getByText('Gross profit')).toBeInTheDocument();
    expect(screen.getAllByText('calc').length).toBeGreaterThanOrEqual(1);
    // input cell present for revenue, none for the derived row
    expect(screen.getByLabelText('Revenue fy_minus_1')).toHaveValue('800');
    expect(screen.queryByLabelText('Gross profit fy_minus_1')).not.toBeInTheDocument();
    expect(screen.getByText('480')).toBeInTheDocument();
  });

  it('saves edited cells via PATCH and shows the recomputed grid', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.method === 'PATCH') {
        return jsonResponse({ sheets: SHEETS });
      }
      return jsonResponse({ sheets: SHEETS });
    });
    renderTab();

    const cell = await screen.findByLabelText('Revenue fy_current');
    await userEvent.type(cell, '1000');
    expect(screen.getByText(/1 unsaved cell/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save workbook' }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch![1]!.body));
      expect(body.cells).toEqual([
        { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_current', value: 1000 },
      ]);
    });
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('rejects a non-numeric cell before calling the API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ sheets: SHEETS }));
    renderTab();

    const cell = await screen.findByLabelText('Revenue fy_current');
    await userEvent.type(cell, 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Save workbook' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not a number/);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });
});
