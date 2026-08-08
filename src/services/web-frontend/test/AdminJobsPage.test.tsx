import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminJobsPage } from '../src/pages/AdminJobsPage';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const JOBS = [
  {
    id: 'J1',
    source: 'pipeline_run',
    status: 'running',
    detail: 'extracting',
    name: 'upload',
    valuation_id: 'V1',
    valuation_number: '1766',
    company_name: 'Acme Corp',
    error: null,
    attempts: null,
    created_at: '2026-08-08T09:00:00Z',
    finished_at: null,
    duration_ms: null,
  },
  {
    id: 'J2',
    source: 'ai_job',
    status: 'failed',
    detail: 'failed',
    name: 'extract',
    valuation_id: 'V1',
    valuation_number: '1766',
    company_name: 'Acme Corp',
    error: 'upstream timeout',
    attempts: null,
    created_at: '2026-08-08T08:00:00Z',
    finished_at: '2026-08-08T08:01:00Z',
    duration_ms: 60_000,
  },
  {
    id: 'J3',
    source: 'email',
    status: 'skipped',
    detail: 'skipped',
    name: 'draft_ready',
    valuation_id: null,
    valuation_number: null,
    company_name: null,
    error: null,
    attempts: 0,
    created_at: '2026-08-08T07:00:00Z',
    finished_at: null,
    duration_ms: null,
  },
];

const STATS = {
  since_hours: 24,
  totals: { active: 2, failed: 1, succeeded: 40, skipped: 3 },
  by_source: [
    {
      source: 'pipeline_run',
      label: 'Pipeline run',
      active: 1,
      failed: 0,
      succeeded: 20,
      skipped: 0,
      oldest_active_at: '2026-08-08T09:00:00Z',
    },
    {
      source: 'ai_job',
      label: 'AI job',
      active: 0,
      failed: 1,
      succeeded: 20,
      skipped: 0,
      oldest_active_at: null,
    },
    {
      source: 'calculation',
      label: 'Calculation',
      active: 0,
      failed: 0,
      succeeded: 0,
      skipped: 0,
      oldest_active_at: null,
    },
    {
      source: 'email',
      label: 'Outbound message',
      active: 0,
      failed: 0,
      succeeded: 0,
      skipped: 3,
      oldest_active_at: null,
    },
    {
      source: 'webhook_delivery',
      label: 'Webhook delivery',
      active: 1,
      failed: 0,
      succeeded: 0,
      skipped: 0,
      oldest_active_at: '2026-08-08T06:00:00Z',
    },
  ],
};

function mockApi() {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.includes('/admin/jobs/stats')) return jsonResponse(STATS);
    if (path.includes('/admin/jobs')) return jsonResponse({ jobs: JOBS, total: JOBS.length });
    return jsonResponse({}, 404);
  });
  return calls;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <AdminJobsPage />
    </MemoryRouter>,
  );

describe('AdminJobsPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-08-08T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('reads all five queues as one feed', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText('upload')).toBeInTheDocument();
    expect(screen.getByText('extract')).toBeInTheDocument();
    expect(screen.getByText('draft_ready')).toBeInTheDocument();
  });

  it("shows the queue's own word alongside the normalised status", async () => {
    // "extracting" is more informative than "running" once you have found the
    // row, so it is carried through rather than thrown away.
    mockApi();
    renderPage();
    const table = await screen.findByLabelText('Background jobs');
    const row = within(table).getByText('upload').closest('tr')!;
    // Scoped to the row: 'Running' is also a filter button.
    expect(within(row).getByText('Running')).toBeInTheDocument();
    expect(within(row).getByText('extracting')).toBeInTheDocument();
  });

  it('does not repeat the status when the two words agree', async () => {
    mockApi();
    renderPage();
    const table = await screen.findByLabelText('Background jobs');
    const row = within(table).getByText('extract').closest('tr')!;
    // 'failed' → 'Failed': the badge only, not "Failed failed".
    expect(within(row).getByText('Failed')).toBeInTheDocument();
    expect(within(row).queryByText('failed')).toBeNull();
  });

  it('counts skipped separately from succeeded and failed', async () => {
    // An outbound message is skipped when notification preferences say not to
    // send it — the system working, not a failure.
    mockApi();
    renderPage();
    // 'Outstanding' names both a stat card and a column in the health table.
    expect(await screen.findAllByText('Outstanding')).not.toHaveLength(0);
    expect(screen.getByText(/Skipped \(24h\)/)).toBeInTheDocument();
    expect(screen.getByText(/Succeeded \(24h\)/)).toBeInTheDocument();
  });

  it('reports how long the oldest outstanding item has waited', async () => {
    // A count cannot tell a busy queue from a stopped one; an age can.
    mockApi();
    renderPage();
    const health = await screen.findByLabelText('Queue health');
    const webhookRow = within(health).getByText('Webhook delivery').closest('tr')!;
    expect(within(webhookRow).getByText('4 h 0 min')).toBeInTheDocument();
  });

  it('shows an em dash for a queue with nothing outstanding', async () => {
    mockApi();
    renderPage();
    const health = await screen.findByLabelText('Queue health');
    const calcRow = within(health).getByText('Calculation').closest('tr')!;
    expect(within(calcRow).getByText('—')).toBeInTheDocument();
  });

  it('surfaces the error text on a failed job', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText('upstream timeout')).toBeInTheDocument();
  });

  it('shows a duration only where the job has finished', async () => {
    mockApi();
    renderPage();
    await screen.findByText('extract');
    expect(screen.getByText('1 min')).toBeInTheDocument();
  });

  it('filters by the common status', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const calls = mockApi();
    renderPage();
    await screen.findByText('upload');
    await user.click(screen.getByRole('button', { name: 'Failed' }));
    await waitFor(() => expect(calls.some((c) => c.includes('status=failed'))).toBe(true));
  });

  it('filters by queue', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const calls = mockApi();
    renderPage();
    await screen.findByText('upload');
    await user.selectOptions(screen.getByLabelText('Filter by queue'), 'ai_job');
    await waitFor(() => expect(calls.some((c) => c.includes('source=ai_job'))).toBe(true));
  });

  it('refreshes on an interval — a page that never moves looks like a dead queue', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByText('upload');
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it('explains a non-ops visit rather than showing an empty feed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ title: 'Forbidden', status: 403 }, 403));
    renderPage();
    expect(await screen.findByText(/job monitor is operations-only/i)).toBeInTheDocument();
  });
});
