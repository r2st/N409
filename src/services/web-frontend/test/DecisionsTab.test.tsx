import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { DecisionsTab } from '../src/pages/valuation/DecisionsTab';
import type { Valuation } from '../src/lib/types';

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'review',
  company_name: 'Acme',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const CATEGORIES = ['approach_selection', 'weighting', 'dlom', 'other'];

const FIRST = {
  id: '01JDECISIONAAAAAAAAAAAAAAA',
  category: 'dlom',
  decision: 'DLOM of 30% via Finnerty',
  rationale: 'Pre-revenue, no secondary activity.',
  supersedes: null,
  superseded: true,
  decided_by: 'u2',
  created_at: '2026-07-01T00:00:00Z',
};

const SECOND = {
  id: '01JDECISIONBBBBBBBBBBBBBBB',
  category: 'dlom',
  decision: 'DLOM revised to 25%',
  rationale: 'Secondary transaction observed in Q2.',
  supersedes: FIRST.id,
  superseded: false,
  decided_by: 'u2',
  created_at: '2026-07-02T00:00:00Z',
};

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/decisions']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/decisions" element={<DecisionsTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('DecisionsTab (audit defense §5.3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the log with superseded strike-through and rationale', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ decisions: [FIRST, SECOND], categories: CATEGORIES }),
    );
    renderTab();

    expect(await screen.findByText('DLOM revised to 25%')).toBeInTheDocument();
    expect(screen.getByText('superseded')).toBeInTheDocument();
    expect(screen.getByText('DLOM of 30% via Finnerty')).toHaveClass('line-through');
    expect(screen.getByText(/Secondary transaction observed/)).toBeInTheDocument();
    // The supersede picker only offers ACTIVE decisions.
    expect(screen.getByLabelText(/Supersedes/)).toBeInTheDocument();
    expect(screen.queryByText(/dlom: DLOM of 30%/i)).not.toBeInTheDocument();
  });

  it('records a decision with category, decision and rationale', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (init?.method === 'POST') return jsonResponse({ decision: FIRST }, 201);
      return jsonResponse({ decisions: [], categories: CATEGORIES });
    });
    renderTab();

    expect(await screen.findByText('No decisions recorded yet')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/Category/), 'dlom');
    await userEvent.type(screen.getByLabelText(/Decision/), 'DLOM of 30% via Finnerty');
    await userEvent.type(screen.getByLabelText('Rationale'), 'Pre-revenue, no secondary activity.');
    await userEvent.click(screen.getByRole('button', { name: 'Record decision' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post![1]!.body))).toEqual({
        category: 'dlom',
        decision: 'DLOM of 30% via Finnerty',
        rationale: 'Pre-revenue, no secondary activity.',
        supersedes: null,
      });
    });
  });

  it('disables submitting until decision and rationale are filled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ decisions: [], categories: CATEGORIES }));
    renderTab();
    expect(await screen.findByRole('button', { name: 'Record decision' })).toBeDisabled();
  });
});
