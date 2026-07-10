import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { ProgressTab } from '../src/pages/valuation/ProgressTab';
import type { Valuation } from '../src/lib/types';

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'user_finished',
  company_name: 'Acme',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const PROGRESS = {
  state: 'user_finished',
  halted: false,
  waiting_on_client: true,
  stages: [
    { key: 'setup', label: 'Getting started', description: 'd1', status: 'done', entered_at: '2026-06-01T00:00:00Z' },
    { key: 'documents', label: 'Document collection', description: 'd2', status: 'current', entered_at: '2026-06-02T00:00:00Z' },
    { key: 'analysis', label: 'Analysis & review', description: 'd3', status: 'upcoming', entered_at: null },
    { key: 'draft', label: 'Draft report', description: 'd4', status: 'upcoming', entered_at: null },
    { key: 'delivered', label: 'Final delivery', description: 'd5', status: 'upcoming', entered_at: null },
  ],
  checklist: [
    { kind: 'cap_table', label: 'Capitalization table', uploaded: true, count: 1 },
    { kind: 'income_statement', label: 'Income statement / P&L', uploaded: false, count: 0 },
  ],
  documents_uploaded: 1,
  report: { available: true },
  explanation: { available: false },
  timeline: [
    { type: 'document_uploaded', label: 'Document uploaded', detail: 'cap.csv', occurred_at: '2026-06-02T10:00:00Z' },
    { type: 'valuation_created', label: 'Valuation created', detail: null, occurred_at: '2026-06-01T09:00:00Z' },
  ],
};

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/progress']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/progress" element={<ProgressTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ProgressTab (client portal §5.6)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the stepper, checklist, timeline, report download and waiting banner', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(PROGRESS));
    renderTab();

    const stepper = await screen.findByTestId('progress-stepper');
    expect(stepper).toHaveTextContent('Getting started');
    expect(stepper).toHaveTextContent('Final delivery');
    // The current stage is exposed for a11y.
    const current = screen.getByText('Document collection').closest('li');
    expect(current).toHaveAttribute('aria-current', 'step');

    expect(screen.getByText(/waiting on you/i)).toBeInTheDocument();
    expect(screen.getByText('Capitalization table')).toBeInTheDocument();
    expect(screen.getByText(/1 item still needed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download your report' })).toBeInTheDocument();

    expect(screen.getByText('Document uploaded')).toBeInTheDocument();
    expect(screen.getByText(/cap\.csv/)).toBeInTheDocument();
    expect(screen.getByText('Valuation created')).toBeInTheDocument();
  });

  it('shows the halted banner and hides the report button when unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        ...PROGRESS,
        halted: true,
        waiting_on_client: false,
        state: 'cancelled',
        report: { available: false },
      }),
    );
    renderTab();

    expect(await screen.findByText(/not progressing/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download your report' })).not.toBeInTheDocument();
    expect(screen.queryByText(/waiting on you/i)).not.toBeInTheDocument();
  });

  it('surfaces API errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ title: 'Not Found', status: 404 }, 404),
    );
    renderTab();
    expect(await screen.findByText(/Not Found/)).toBeInTheDocument();
  });
});
