import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { CompletenessTab } from '../src/pages/valuation/CompletenessTab';
import type { Valuation } from '../src/lib/types';

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'drafted',
  company_name: 'Acme',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const BLOCKED = {
  score: 62,
  grade: 'partial' as const,
  ready: false,
  counts: { blocking: 2, important: 1, optional: 0 },
  byCategory: { questionnaire: 1, documents: 1, financials: 1, cap_table: 0, parameters: 0 },
  questionnaire: { percentComplete: 40, requiredAnswered: 4, requiredTotal: 10, ready: false },
  gaps: [
    {
      key: 'financials.revenue_ntm',
      category: 'financials',
      severity: 'blocking',
      label: 'No NTM revenue to strike the multiple against',
      detail:
        'The market approach is configured for the next twelve months revenue multiple, so ' +
        '`revenue_ntm` is the figure it needs.',
      remedy: 'Extract or enter revenue_ntm, or switch the market horizon to the one you have.',
    },
    {
      key: 'documents.captable_documents',
      category: 'documents',
      severity: 'blocking',
      label: 'No cap table uploaded',
      detail: 'Current capitalization: every share class and its liquidation preference.',
      remedy: 'Request the cap table from the client.',
    },
    {
      key: 'questionnaire.company',
      category: 'questionnaire',
      severity: 'important',
      label: 'Company: 2 required answers outstanding',
      detail: 'Unanswered: Incorporation date, State of incorporation.',
      remedy: 'Ask the client to complete the section.',
    },
  ],
};

const READY = {
  ...BLOCKED,
  score: 94,
  grade: 'ready' as const,
  ready: true,
  counts: { blocking: 0, important: 1, optional: 0 },
  gaps: [BLOCKED.gaps[2]],
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/completeness']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/completeness" element={<CompletenessTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('CompletenessTab', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reports not-ready with the blocking count', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ completeness: BLOCKED }));
    renderTab();
    await waitFor(() =>
      expect(screen.getByTestId('completeness-banner')).toHaveTextContent(/not ready to value/i),
    );
    expect(screen.getByTestId('completeness-banner')).toHaveTextContent(/2 blocking gaps/i);
  });

  it('groups gaps by category, setup first', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ completeness: BLOCKED }));
    renderTab();
    // By heading: "Questionnaire" also appears as a stat label above.
    await screen.findByRole('heading', { name: /Financials/ });
    expect(screen.getByRole('heading', { name: /Documents/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Questionnaire/ })).toBeInTheDocument();
  });

  it('shows each gap with its detail and its next action', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ completeness: BLOCKED }));
    renderTab();
    await screen.findByTestId('gap-financials.revenue_ntm');
    expect(screen.getByText(/No NTM revenue to strike/)).toBeInTheDocument();
    expect(screen.getByText(/Extract or enter revenue_ntm/)).toBeInTheDocument();
  });

  it('names the unanswered questionnaire fields rather than only counting them', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ completeness: BLOCKED }));
    renderTab();
    await screen.findByText(/Unanswered: Incorporation date, State of incorporation./);
  });

  it('reports ready on a score below 100 when nothing blocks', async () => {
    // The point of separating `ready` from `score`: an engagement can be short
    // optional evidence and still be entirely modellable.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ completeness: READY }));
    renderTab();
    await waitFor(() =>
      expect(screen.getByTestId('completeness-banner')).toHaveTextContent(/ready to value/i),
    );
    expect(screen.getByTestId('completeness-score')).toHaveTextContent('94%');
  });

  it('does not read a high score as ready while a gap blocks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ completeness: { ...BLOCKED, score: 95 } }),
    );
    renderTab();
    await waitFor(() =>
      expect(screen.getByTestId('completeness-banner')).toHaveTextContent(/not ready/i),
    );
    expect(screen.getByTestId('completeness-score')).toHaveTextContent('95%');
  });

  it('shows questionnaire progress', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ completeness: BLOCKED }));
    renderTab();
    await screen.findByText('4/10');
  });

  it('refetches on refresh', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ completeness: BLOCKED }),
    );
    renderTab();
    await screen.findByTestId('completeness-score');
    const before = spy.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(before));
  });

  it('surfaces a load failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ title: 'Not found' }, 404),
    );
    renderTab();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});
