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

  /**
   * The log is append-only: a revision supersedes the earlier entry rather than
   * editing it, so the picker is how a correction is recorded at all. Nothing
   * had exercised it.
   */
  it('records a revision against the decision it supersedes', async () => {
    // The picker offers ACTIVE decisions only, so the entry being revised has
    // to be one nothing has superseded yet.
    const active = { ...FIRST, superseded: false };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (init?.method === 'POST') return jsonResponse({ decision: SECOND }, 201);
      return jsonResponse({ decisions: [active], categories: CATEGORIES });
    });
    renderTab();

    await screen.findByText('DLOM of 30% via Finnerty');
    await userEvent.type(screen.getByLabelText(/Decision/), 'DLOM revised to 25%');
    await userEvent.type(screen.getByLabelText('Rationale'), 'Secondary transaction observed in Q2.');
    await userEvent.selectOptions(screen.getByLabelText(/Supersedes/), FIRST.id);
    await userEvent.click(screen.getByRole('button', { name: 'Record decision' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post![1]!.body)).supersedes).toBe(FIRST.id);
    });
  });

  /**
   * A refusal has to reach the analyst inside the form they are still looking
   * at, rather than replacing the whole tab — the log loaded fine, it is the
   * write that failed.
   */
  it('shows a failed write beside the form, keeping the log on screen', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (init?.method === 'POST') return jsonResponse({ detail: 'Valuation is locked' }, 409);
      return jsonResponse({ decisions: [FIRST], categories: CATEGORIES });
    });
    renderTab();

    await screen.findByText('DLOM of 30% via Finnerty');
    await userEvent.type(screen.getByLabelText(/Decision/), 'DLOM revised to 25%');
    await userEvent.type(screen.getByLabelText('Rationale'), 'Secondary transaction observed.');
    await userEvent.click(screen.getByRole('button', { name: 'Record decision' }));

    expect(await screen.findByText('Valuation is locked')).toBeInTheDocument();
    // The log is still there — this was not a load failure.
    expect(screen.getByText('DLOM of 30% via Finnerty')).toBeInTheDocument();
  });

  /** A transport failure is not an ApiError, so it takes the written fallback. */
  it('falls back to its own wording when the write fails without a problem document', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (init?.method === 'POST') throw new TypeError('network down');
      return jsonResponse({ decisions: [], categories: CATEGORIES });
    });
    renderTab();

    await screen.findByText('No decisions recorded yet');
    await userEvent.type(screen.getByLabelText(/Decision/), 'DLOM of 30%');
    await userEvent.type(screen.getByLabelText('Rationale'), 'Pre-revenue.');
    await userEvent.click(screen.getByRole('button', { name: 'Record decision' }));

    expect(await screen.findByText(/Could not record the decision\./)).toBeInTheDocument();
  });

  /** A log that will not load replaces the tab, because there is nothing to show. */
  it('replaces the tab when the log itself cannot be loaded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ detail: 'The decision log is operations-only' }, 403),
    );
    renderTab();

    expect(await screen.findByText('The decision log is operations-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record decision' })).not.toBeInTheDocument();
  });

  /**
   * R31 — the rule used to live in a disabled button, which states that
   * something is missing without saying what. Both boxes are now named.
   */
  it('names both empty boxes rather than disabling the button', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ decisions: [], categories: CATEGORIES }));
    renderTab();

    const submit = await screen.findByRole('button', { name: 'Record decision' });
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    expect(await screen.findByText('Decision is required.')).toBeInTheDocument();
    expect(screen.getByText('Rationale is required.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')).toBeUndefined();
  });

  /** A rationale is what an auditor reads — a decision without one is the gap. */
  it('refuses a decision with no rationale', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ decisions: [], categories: CATEGORIES }));
    renderTab();

    await screen.findByText('No decisions recorded yet');
    await userEvent.type(screen.getByLabelText(/Decision/), 'DLOM of 30% via Finnerty');
    await userEvent.click(screen.getByRole('button', { name: 'Record decision' }));

    expect(await screen.findByText('Rationale is required.')).toBeInTheDocument();
    expect(screen.queryByText('Decision is required.')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')).toBeUndefined();
  });

  /**
   * The panel stays mounted for the next decision, so the revealed state has to
   * be cleared with the values — otherwise the boxes it empties are instantly
   * marked as errors for a decision that recorded fine.
   */
  it('does not mark the emptied boxes after a successful record', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (init?.method === 'POST') return jsonResponse({ decision: FIRST }, 201);
      return jsonResponse({ decisions: [], categories: CATEGORIES });
    });
    renderTab();

    await screen.findByText('No decisions recorded yet');
    await userEvent.type(screen.getByLabelText(/Decision/), 'DLOM of 30% via Finnerty');
    await userEvent.type(screen.getByLabelText('Rationale'), 'Pre-revenue, no secondary activity.');
    await userEvent.click(screen.getByRole('button', { name: 'Record decision' }));

    await waitFor(() => expect(screen.getByLabelText(/Decision/)).toHaveValue(''));
    expect(screen.queryByText('Decision is required.')).not.toBeInTheDocument();
    expect(screen.queryByText('Rationale is required.')).not.toBeInTheDocument();
  });
});
