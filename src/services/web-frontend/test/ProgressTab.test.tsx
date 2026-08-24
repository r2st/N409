import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  percent_complete: 35,
  next_action: {
    key: 'upload_documents',
    label: 'Upload 1 remaining document',
    detail: 'We cannot finish the analysis until the checklist is complete.',
    tab: 'documents',
    client_action_required: true,
  },
  estimated_delivery_at: '2026-06-12T00:00:00Z',
  days_in_progress: 9,
  last_activity_at: '2026-06-02T10:00:00Z',
  stages: [
    {
      key: 'setup',
      label: 'Getting started',
      description: 'd1',
      status: 'done',
      entered_at: '2026-06-01T00:00:00Z',
      duration_days: 1,
      typical_days: 1,
    },
    {
      key: 'documents',
      label: 'Document collection',
      description: 'd2',
      status: 'current',
      entered_at: '2026-06-02T00:00:00Z',
      duration_days: 8,
      typical_days: 5,
    },
    {
      key: 'analysis',
      label: 'Analysis & review',
      description: 'd3',
      status: 'upcoming',
      entered_at: null,
      duration_days: null,
      typical_days: 3,
    },
    {
      key: 'draft',
      label: 'Draft report',
      description: 'd4',
      status: 'upcoming',
      entered_at: null,
      duration_days: null,
      typical_days: 2,
    },
    {
      key: 'delivered',
      label: 'Final delivery',
      description: 'd5',
      status: 'upcoming',
      entered_at: null,
      duration_days: null,
      typical_days: 0,
    },
  ],
  checklist: [
    { kind: 'cap_table', label: 'Capitalization table', uploaded: true, count: 1 },
    { kind: 'income_statement', label: 'Income statement / P&L', uploaded: false, count: 0 },
  ],
  documents_uploaded: 1,
  documents_missing: 1,
  report: { available: true },
  explanation: { available: false },
  timeline: [
    {
      type: 'document_uploaded',
      label: 'Document uploaded',
      detail: 'cap.csv',
      occurred_at: '2026-06-02T10:00:00Z',
    },
    {
      type: 'valuation_created',
      label: 'Valuation created',
      detail: null,
      occurred_at: '2026-06-01T09:00:00Z',
    },
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
  });

  it('surfaces API errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ title: 'Not Found', status: 404 }, 404));
    renderTab();
    expect(await screen.findByText(/Not Found/)).toBeInTheDocument();
  });
  it('shows the completion bar, headline stats and the next action', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(PROGRESS));
    renderTab();

    const bar = await screen.findByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '35');
    expect(screen.getByTestId('progress-bar')).toHaveTextContent('35%');

    const stats = screen.getByTestId('progress-stats');
    expect(stats).toHaveTextContent('Days in progress');
    expect(stats).toHaveTextContent('9');

    const next = screen.getByTestId('next-action');
    expect(next).toHaveTextContent('Upload 1 remaining document');
    expect(screen.getByRole('link', { name: /Go to documents/ })).toHaveAttribute(
      'href',
      `/valuations/${valuation.id}/documents`,
    );
  });

  it('flags a current stage that is running longer than usual', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(PROGRESS));
    renderTab();

    const stepper = await screen.findByTestId('progress-stepper');
    expect(stepper).toHaveTextContent('8 days');
    expect(stepper).toHaveTextContent(/longer than usual/);
  });

  it('does not flag a stage that is inside its typical duration', async () => {
    const stages = PROGRESS.stages.map((s) => (s.key === 'documents' ? { ...s, duration_days: 2 } : s));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ...PROGRESS, stages }));
    renderTab();

    const stepper = await screen.findByTestId('progress-stepper');
    expect(stepper).not.toHaveTextContent(/longer than usual/);
  });

  it('omits the call-to-action link when there is nothing for the client to do', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        ...PROGRESS,
        next_action: {
          key: 'awaiting_us',
          label: 'Nothing needed from you',
          detail: 'Our analysts are working on your valuation.',
          tab: null,
          client_action_required: false,
        },
      }),
    );
    renderTab();

    expect(await screen.findByText('Nothing needed from you')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Go to/ })).not.toBeInTheDocument();
  });

  it('renders an em dash when there is no delivery estimate', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ ...PROGRESS, estimated_delivery_at: null, last_activity_at: null }),
    );
    renderTab();
    const stats = await screen.findByTestId('progress-stats');
    expect(stats.textContent).toContain('\u2014');
  });
  /*
   * This is the client-facing tab, and the button is why a client opens it: it
   * renders the 409A on demand, so it can genuinely 5xx. `.catch(() => {})`
   * rendered that as nothing whatsoever — the page after the click identical to
   * the page before it, which is also what a broken button looks like. The
   * client clicks again, and again, and then emails somebody.
   */
  it('says so when the report download fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('report.pdf')) return jsonResponse({ detail: 'nope' }, 503);
      return jsonResponse(PROGRESS);
    });
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole('button', { name: 'Download your report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/download did not start/i);
  });

  it('keeps the progress it was showing when the download fails', async () => {
    // `error` replaces the whole tab, so reusing it here would have answered a
    // failed download by removing the progress the client came to read.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('report.pdf')) return jsonResponse({ detail: 'nope' }, 503);
      return jsonResponse(PROGRESS);
    });
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole('button', { name: 'Download your report' }));
    await screen.findByRole('alert');
    expect(screen.getByTestId('progress-stepper')).toBeInTheDocument();
  });

  it('says nothing when the download succeeds', async () => {
    // The other half. jsdom defines neither object-URL function, and
    // `downloadPdf` calls both on the success path — without these the success
    // case would throw exactly where the failure does and this would pass
    // against a component that never told them apart.
    Object.assign(URL, { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('report.pdf'))
        return new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } });
      return jsonResponse(PROGRESS);
    });
    const user = userEvent.setup();
    renderTab();

    const button = await screen.findByRole('button', { name: 'Download your report' });
    await user.click(button);
    await waitFor(() => expect(screen.getByRole('button', { name: /Download your report/ })).not.toBeDisabled());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
