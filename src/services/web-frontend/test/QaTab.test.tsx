import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { QaTab } from '../src/pages/valuation/QaTab';
import type { Valuation } from '../src/lib/types';

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'reviewed',
  company_name: 'Acme',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const REVIEW = {
  id: '01JQAREVIEWAAAAAAAAAAAAAAA',
  calculation_id: 'calc-1',
  status: 'warn',
  checks: [
    { key: 'fmv_positive', label: 'FMV per share is positive', status: 'pass', detail: 'FMV/share 2' },
    {
      key: 'dlom_range',
      label: 'DLOM within market norms',
      status: 'warn',
      detail: 'DLOM 45.0% exceeds the 35% benchmark auditors scrutinize',
    },
  ],
  ai_findings: {
    findings: [{ area: 'assumptions', finding: 'Volatility looks low', severity: 'warn' }],
    assessment: 'Broadly reasonable.',
    verdict: 'warn',
  },
  ai_model: 'stub/model',
  created_at: '2026-07-01T00:00:00Z',
};

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/qa']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/qa" element={<QaTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('QaTab (quality gate §4.3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows an unsatisfied gate and runs the checks', async () => {
    let posted = false;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (init?.method === 'POST') {
        posted = true;
        return jsonResponse({ review: REVIEW }, 201);
      }
      return jsonResponse({
        reviews: posted ? [REVIEW] : [],
        latest_calculation_id: 'calc-1',
        gate: posted
          ? { satisfied: true, review_id: REVIEW.id, status: 'warn' }
          : { satisfied: false, review_id: null, status: null },
      });
    });
    renderTab();

    const banner = await screen.findByTestId('qa-gate-banner');
    expect(banner).toHaveTextContent(/NOT satisfied/);
    expect(screen.getByText('No QA reviews yet')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Run checks' }));

    await waitFor(() => {
      expect(screen.getByTestId('qa-gate-banner')).toHaveTextContent(/gate satisfied/i);
    });
    expect(screen.getByText('DLOM within market norms')).toBeInTheDocument();
    expect(screen.getByText(/exceeds the 35% benchmark/)).toBeInTheDocument();
    // The AI reviewer section renders findings + assessment.
    expect(screen.getByText('Broadly reasonable.')).toBeInTheDocument();
    expect(screen.getByText(/Volatility looks low/)).toBeInTheDocument();

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post![1]!.body))).toEqual({ ai: false });
  });

  it('sends ai: true for the AI review button', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (init?.method === 'POST') return jsonResponse({ review: REVIEW }, 201);
      return jsonResponse({
        reviews: [],
        latest_calculation_id: 'calc-1',
        gate: { satisfied: false, review_id: null, status: null },
      });
    });
    renderTab();

    await userEvent.click(await screen.findByRole('button', { name: 'Run checks + AI review' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post![1]!.body))).toEqual({ ai: true });
    });
  });

  it('disables running until a calculation exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        reviews: [],
        latest_calculation_id: null,
        gate: { satisfied: true, review_id: null, status: null },
      }),
    );
    renderTab();

    expect(await screen.findByTestId('qa-gate-banner')).toHaveTextContent(/No completed calculation/);
    expect(screen.getByRole('button', { name: 'Run checks' })).toBeDisabled();
  });

  it('flags a review of an older calculation as stale', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        reviews: [{ ...REVIEW, calculation_id: 'calc-0' }],
        latest_calculation_id: 'calc-1',
        gate: { satisfied: false, review_id: null, status: null },
      }),
    );
    renderTab();
    expect(await screen.findByText(/stale — reviews an older calculation/)).toBeInTheDocument();
  });
});
