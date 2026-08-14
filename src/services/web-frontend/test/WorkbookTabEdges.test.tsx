import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { WorkbookTab } from '../src/pages/valuation/WorkbookTab';
import type { Valuation } from '../src/lib/types';

/**
 * The workbook's failures and the edits that are not "type a number into an
 * empty cell": clearing a value, typing one back to what it was, the export,
 * and the finding that names no single cell.
 */

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  number: 'V-1042',
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
    ],
  },
  {
    key: 'balance_sheet',
    label: 'Balance sheet',
    description: 'Position',
    columns: [{ key: 'fy_current', label: 'FY (current)' }],
    rows: [
      {
        key: 'cash',
        label: 'Cash',
        kind: 'input',
        format: 'currency',
        cells: [{ column_key: 'fy_current', value: 250 }],
      },
    ],
  },
];

const anomaly = (over: Record<string, unknown> = {}) => ({
  check: 'negative_cost',
  severity: 'error',
  summary: 'Cost of revenue is negative',
  detail: 'A negative cost is added back into every margin below it.',
  sheet: 'income_statement',
  sheet_label: 'Income statement',
  row_key: 'revenue',
  row_label: 'Revenue',
  column_key: 'fy_minus_1',
  column_label: 'FY-1',
  ...over,
});

const report = (anomalies: Array<Record<string, unknown>>, counts: Record<string, number>) => ({
  empty: false,
  anomalies,
  counts: { error: 0, warning: 0, info: 0, ...counts },
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/wb']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/wb" element={<WorkbookTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('WorkbookTab — edges', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('when the server will not answer', () => {
    it("repeats the API's own words instead of the grid", async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ title: 'This valuation is not yours to read' }), {
          status: 403,
          headers: { 'content-type': 'application/problem+json' },
        }),
      );
      renderTab();

      expect(await screen.findByText('This valuation is not yours to read')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save workbook' })).not.toBeInTheDocument();
    });

    it('falls back to its own words when the failure carries none', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
      renderTab();
      expect(await screen.findByText('Could not load the workbook.')).toBeInTheDocument();
    });

    /**
     * A save that fails keeps the grid and the drafts: the cells are the
     * analyst's only copy of what they typed, and losing them to a 500 is worse
     * than the 500.
     */
    it('keeps the unsaved cells when the save fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        if (init?.method === 'PATCH') throw new TypeError('Failed to fetch');
        return jsonResponse({ sheets: SHEETS });
      });
      renderTab();

      await userEvent.type(await screen.findByLabelText('Revenue fy_current'), '1000');
      await userEvent.click(screen.getByRole('button', { name: 'Save workbook' }));

      expect(await screen.findByText('Could not save the workbook.')).toBeInTheDocument();
      expect(screen.getByLabelText('Revenue fy_current')).toHaveValue('1000');
      expect(screen.getByText(/1 unsaved cell/)).toBeInTheDocument();
    });

    it('says why the auditor export could not be produced', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
        String(url).includes('.xlsx')
          ? jsonResponse({ title: 'The workbook is still being recalculated' }, 409)
          : jsonResponse({ sheets: SHEETS }),
      );
      renderTab();

      await screen.findByText('Revenue');
      await userEvent.click(screen.getByRole('button', { name: /Export auditor workbook/ }));

      expect(await screen.findByText('The workbook is still being recalculated')).toBeInTheDocument();
      // And the button comes back rather than staying on "Preparing…".
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Export auditor workbook/ })).not.toBeDisabled(),
      );
    });

    it('falls back to its own words when the export fails without a message', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('.xlsx')) throw new TypeError('Failed to fetch');
        return jsonResponse({ sheets: SHEETS });
      });
      renderTab();

      await screen.findByText('Revenue');
      await userEvent.click(screen.getByRole('button', { name: /Export auditor workbook/ }));
      expect(await screen.findByText('Could not export the workbook.')).toBeInTheDocument();
    });
  });

  describe('editing a cell', () => {
    const mockOk = () => {
      const calls: unknown[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        if (init?.method === 'PATCH') calls.push(JSON.parse(String(init.body)));
        return jsonResponse({ sheets: SHEETS });
      });
      return calls as Array<{ cells: Array<Record<string, unknown>> }>;
    };

    it('sends a cleared cell as null rather than as a zero', async () => {
      const calls = mockOk();
      renderTab();

      await userEvent.clear(await screen.findByLabelText('Revenue fy_minus_1'));
      expect(screen.getByText(/1 unsaved cell/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Save workbook' }));

      // A revenue of zero and a revenue nobody entered are different facts, and
      // every margin below reads them differently.
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]!.cells).toEqual([
        { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_minus_1', value: null },
      ]);
    });

    it('stops counting a cell typed back to what it already was', async () => {
      mockOk();
      renderTab();

      const cell = await screen.findByLabelText('Revenue fy_minus_1');
      await userEvent.clear(cell);
      expect(screen.getByText(/1 unsaved cell/)).toBeInTheDocument();

      await userEvent.type(cell, '800');
      expect(screen.queryByText(/unsaved cell/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save workbook' })).toBeDisabled();
    });

    it('counts two edited cells in the plural, across sheets', async () => {
      mockOk();
      renderTab();

      await userEvent.type(await screen.findByLabelText('Revenue fy_current'), '1000');
      await userEvent.click(screen.getByRole('button', { name: 'Balance sheet' }));
      await userEvent.type(await screen.findByLabelText('Cash fy_current'), '5');

      // The drafts are keyed by sheet, so switching tabs must not lose the
      // first sheet's edit — the save carries both.
      expect(screen.getByText(/2 unsaved cells/)).toBeInTheDocument();
    });

    it('names the row and column of the cell it will not send', async () => {
      const calls = mockOk();
      renderTab();

      await userEvent.type(await screen.findByLabelText('Revenue fy_current'), '1,000');
      await userEvent.click(screen.getByRole('button', { name: 'Save workbook' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('revenue / fy_current');
      expect(calls).toHaveLength(0);
    });
  });

  describe('the statement review', () => {
    const withReport = (r: unknown) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ sheets: SHEETS, anomalies: r }));
    };

    it('counts one error in the singular', async () => {
      withReport(report([anomaly()], { error: 1 }));
      renderTab();
      expect(await screen.findByText('1 error')).toBeInTheDocument();
    });

    it('counts errors, checks and notes together', async () => {
      withReport(
        report(
          [
            anomaly(),
            anomaly({ check: 'a', severity: 'warning', summary: 'Margin jump' }),
            anomaly({ check: 'b', severity: 'info', summary: 'Short history' }),
          ],
          { error: 2, warning: 1, info: 3 },
        ),
      );
      renderTab();
      expect(await screen.findByText('2 errors · 1 to check · 3 noted')).toBeInTheDocument();
    });

    /**
     * A finding that spans lines — a missing period, an absent balance sheet —
     * has no single cell to mark, so it only switches sheets. Marking an
     * arbitrary row would imply that row is the one at fault.
     */
    it('switches sheets without marking a cell for a finding about no one cell', async () => {
      withReport(
        report(
          [
            anomaly({
              check: 'missing_period',
              severity: 'warning',
              summary: 'No balance sheet entered',
              sheet: 'balance_sheet',
              sheet_label: 'Balance sheet',
              row_key: null,
              row_label: null,
              column_key: null,
              column_label: null,
            }),
          ],
          { warning: 1 },
        ),
      );
      renderTab();

      await userEvent.click(await screen.findByRole('button', { name: /No balance sheet entered/ }));
      const cash = await screen.findByLabelText('Cash fy_current');
      expect(cash).toBeInTheDocument();
      expect(cash.className).not.toContain('border-red-400');
    });

    it('marks the cell a finding names, and unmarks it the moment it is touched', async () => {
      withReport(report([anomaly()], { error: 1 }));
      renderTab();

      await userEvent.click(await screen.findByRole('button', { name: /Cost of revenue is negative/ }));
      const cell = screen.getByLabelText('Revenue fy_minus_1');
      expect(cell.className).toContain('border-red-400');

      await userEvent.click(cell);
      expect(cell.className).not.toContain('border-red-400');
    });

    it('says nothing when the report is flagged empty even with counts on it', async () => {
      withReport({ empty: true, anomalies: [], counts: { error: 0, warning: 0, info: 0 } });
      renderTab();
      await screen.findByText('Revenue');
      expect(screen.queryByText('Statement review')).not.toBeInTheDocument();
    });
  });
});
