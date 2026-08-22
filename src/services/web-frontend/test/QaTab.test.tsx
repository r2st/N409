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

  /**
   * The gate refuses a publish whose report body was saved after the review
   * that would otherwise clear it, and this banner is the only place an analyst
   * is told whether the engagement can publish. A banner reading "gate
   * satisfied" over a gate returning 409 is worse than no banner.
   *
   * Said in its own words, too: "run a QA review" is the wrong instruction
   * here. There is one — it graded prose that is no longer in the document.
   */
  it('says the body moved, not that a review is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        reviews: [{ ...REVIEW, report_version: 3 }],
        latest_calculation_id: 'calc-1',
        report_version: 4,
        gate: { satisfied: false, review_id: REVIEW.id, status: 'warn', body_stale: true },
      }),
    );
    renderTab();

    const banner = await screen.findByTestId('qa-gate-banner');
    expect(banner).toHaveTextContent(/NOT satisfied/);
    expect(banner).toHaveTextContent(/report body has been edited since the last QA review/);
    expect(banner).not.toHaveTextContent(/needs a non-failing QA review/);
    expect(screen.getByText('stale — reviews an older report body')).toBeInTheDocument();
  });

  it('does not call a review stale when the body has not moved', async () => {
    // The vacuity guard: a pill that showed on every review would carry no
    // information, and `report_version` null on both sides is the shape a
    // pre-migration review takes.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        reviews: [{ ...REVIEW, report_version: 4 }],
        latest_calculation_id: 'calc-1',
        report_version: 4,
        gate: { satisfied: true, review_id: REVIEW.id, status: 'warn', body_stale: false },
      }),
    );
    renderTab();

    const banner = await screen.findByTestId('qa-gate-banner');
    expect(banner).toHaveTextContent(/satisfied/);
    expect(screen.queryByText('stale — reviews an older report body')).not.toBeInTheDocument();
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
