import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { WorkbookTab, WorkbookRow } from '../src/pages/valuation/WorkbookTab';
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

  it('says the workbook is empty instead of spinning on a finished load', async () => {
    // Regression: an empty `sheets` left `activeSheet` null, which fell into
    // the `!sheet` spinner branch — so a load that had already returned looked
    // exactly like one still in flight, forever.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ sheets: [] }));
    renderTab();

    expect(await screen.findByText('No workbook yet')).toBeInTheDocument();
    expect(screen.getByText(/Run the engine from the Methodology tab/)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
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

/**
 * `drafts` is one `Map` shared by every row of the active sheet, and typing
 * into one cell replaces it wholesale — so with no row-level component
 * boundary, that keystroke re-rendered every row's JSX, not just the one
 * being edited. `WorkbookRow` is memoized against exactly that (R425).
 *
 * As with `EntriesTable`'s test, this counts actual invocations of the
 * memoized render function (`WorkbookRow.type`) rather than trusting a DOM
 * assertion or `React.Profiler`, neither of which can tell "rendered again
 * with identical output" apart from "did not render again".
 */
describe('WorkbookRow', () => {
  const trueRender = (WorkbookRow as unknown as { type: (props: unknown) => unknown }).type;

  afterEach(() => {
    (WorkbookRow as unknown as { type: typeof trueRender }).type = trueRender;
  });

  function spyOnRender() {
    const spy = vi.fn(trueRender);
    (WorkbookRow as unknown as { type: typeof trueRender }).type = spy;
    return spy;
  }

  const TWO_INPUT_ROWS: typeof SHEETS = [
    {
      ...SHEETS[0]!,
      rows: [
        {
          key: 'revenue',
          label: 'Revenue',
          kind: 'input',
          format: 'currency',
          cells: [{ column_key: 'fy_current', value: 100 }],
        },
        {
          key: 'opex',
          label: 'Opex',
          kind: 'input',
          format: 'currency',
          cells: [{ column_key: 'fy_current', value: 50 }],
        },
      ],
    },
  ];

  const callsFor = (spy: ReturnType<typeof spyOnRender>, rowKey: string) =>
    spy.mock.calls.filter(([props]) => (props as { row: { key: string } }).row.key === rowKey).length;

  it('does not re-render an untouched row when a sibling cell is edited', async () => {
    const renderSpy = spyOnRender();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ sheets: TWO_INPUT_ROWS }));
    renderTab();

    await screen.findByLabelText('Revenue fy_current');
    expect(callsFor(renderSpy, 'opex')).toBe(1);
    expect(callsFor(renderSpy, 'revenue')).toBe(1);

    await userEvent.type(screen.getByLabelText('Revenue fy_current'), '1');
    // The edited row redraws (its own draft changed); the sibling row, whose
    // props are unchanged, must not run its render function again.
    expect(callsFor(renderSpy, 'revenue')).toBeGreaterThan(1);
    expect(callsFor(renderSpy, 'opex')).toBe(1);
  });
});
