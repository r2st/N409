import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalculationPanel } from '../src/components/valuation/CalculationPanel';
import { fieldLabel, type Calculation, type EngineIssue } from '../src/lib/pipeline';

const VALUATION_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';

const ERROR_ISSUE: EngineIssue = {
  code: 'required',
  field: 'inputs.volatility',
  message: 'volatility is required for the OPM allocation / model DLOM',
  severity: 'error',
  hint: 'Run the volatility estimator over the comparable set.',
};

const WARNING_ISSUE: EngineIssue = {
  code: 'high_discount',
  field: 'params.dlom',
  message: 'a 60.0% discount for lack of marketability is above the range normally supportable',
  severity: 'warning',
  hint: null,
};

const SUCCEEDED: Calculation = {
  id: 'c1',
  valuation_id: VALUATION_ID,
  engine_version: 'py-1.0.0',
  status: 'succeeded',
  inputs: {},
  results: {
    approaches: { income: { equity_value: 12_000_000, weight: 1 } },
    discounts: { dloc: 0.1, dlom: 0.25, dlom_method: 'finnerty' },
    assumptions: { time_to_exit_years: 3, volatility: 0.6, risk_free_rate: 0.042 },
  },
  equity_value: '12000000',
  fmv_per_share: '1.2',
  error: null,
  diagnostics: [],
  created_at: '2026-07-01T00:00:00Z',
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Routes the calculation list, the preflight dry run, and the compute POST. */
function mockApi(opts: {
  calculations?: Calculation[];
  preflight?: unknown;
  compute?: { status: number; body: unknown };
} = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.includes('/calculations/preflight')) {
      return jsonResponse(
        opts.preflight ?? { ok: true, engine_version: 'py-1.0.0', errors: [], warnings: [] },
      );
    }
    if (init?.method === 'POST') {
      const { status, body } = opts.compute ?? { status: 201, body: { calculation: SUCCEEDED } };
      return jsonResponse(body, status);
    }
    return jsonResponse({ calculations: opts.calculations ?? [] });
  });
}

const renderPanel = () => render(<CalculationPanel valuationId={VALUATION_ID} currency="USD" />);

describe('fieldLabel', () => {
  it('turns a dotted engine path into a readable label', () => {
    expect(fieldLabel('inputs.income.discount_rate')).toBe('Income · discount rate');
    expect(fieldLabel('params.dlom')).toBe('Dlom');
    expect(fieldLabel('inputs.pwerm.scenarios[2].probability')).toBe(
      'Pwerm · scenarios 2 · probability',
    );
  });
});

describe('CalculationPanel pre-flight', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a clean payload as ready to compute', async () => {
    mockApi();
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Check inputs' }));

    expect(await screen.findByText(/Ready to compute — no issues found/)).toBeInTheDocument();
  });

  it('lists every blocking error with its field and hint', async () => {
    mockApi({
      preflight: {
        ok: false,
        engine_version: 'py-1.0.0',
        errors: [ERROR_ISSUE, { ...ERROR_ISSUE, field: 'inputs.market.metric', code: 'not_positive' }],
        warnings: [WARNING_ISSUE],
      },
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Check inputs' }));

    expect(await screen.findByText(/2 problems blocking the calculation/)).toBeInTheDocument();
    expect(screen.getByText('Volatility')).toBeInTheDocument();
    expect(screen.getByText('Market · metric')).toBeInTheDocument();
    expect(screen.getAllByText(/Run the volatility estimator/)).toHaveLength(2);
    // Warnings render alongside the errors rather than being hidden by them.
    expect(screen.getByText('Dlom')).toBeInTheDocument();
  });

  it('counts warnings separately when nothing blocks', async () => {
    mockApi({
      preflight: { ok: true, engine_version: 'py-1.0.0', errors: [], warnings: [WARNING_ISSUE] },
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Check inputs' }));

    expect(await screen.findByText(/Ready to compute · 1 to review/)).toBeInTheDocument();
  });

  it('does not persist anything — the check only calls the preflight endpoint', async () => {
    const fetchMock = mockApi();
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Check inputs' }));
    await screen.findByText(/Ready to compute/);

    const posted = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posted).toHaveLength(1);
    expect(String(posted[0]![0])).toContain('/calculations/preflight');
  });

  it('shows the engine field issues when a compute is rejected', async () => {
    mockApi({
      compute: {
        status: 422,
        body: {
          title: 'Unprocessable Entity',
          status: 422,
          detail: 'engine rejected the request: volatility is required',
          issues: [ERROR_ISSUE],
        },
      },
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Run calculation' }));

    await waitFor(() => expect(screen.getByText('Volatility')).toBeInTheDocument());
    expect(screen.getByText(/1 problem blocking the calculation/)).toBeInTheDocument();
  });

  it('surfaces the warnings stored with the latest successful run', async () => {
    mockApi({ calculations: [{ ...SUCCEEDED, diagnostics: [WARNING_ISSUE] }] });
    renderPanel();

    expect(await screen.findByText('Review points from the latest run')).toBeInTheDocument();
    expect(screen.getByText(/above the range normally supportable/)).toBeInTheDocument();
  });

  it('shows no review section when the run came back clean', async () => {
    mockApi({ calculations: [SUCCEEDED] });
    renderPanel();

    await screen.findByText('Approach breakdown');
    expect(screen.queryByText('Review points from the latest run')).not.toBeInTheDocument();
  });
});
