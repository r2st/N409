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
    due_at: '2026-08-08T09:00:00Z',
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
    due_at: '2026-08-08T08:00:00Z',
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
    due_at: '2026-08-08T07:00:00Z',
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

/**
 * Two deliveries that are queued for opposite reasons.
 *
 * `W1` failed at 06:00 and is not claimable again until 13:00 — three hours
 * from the test's clock — which is the retry ladder working. `W2` came due an
 * hour ago and is still sitting there, which is a worker that has stopped. Both
 * read `queued`/`pending` and nothing else on the row separates them.
 */
const WAITING_JOBS = [
  {
    id: 'W1',
    source: 'webhook_delivery',
    status: 'queued',
    detail: 'pending',
    name: 'valuation.report_ready',
    valuation_id: 'V1',
    valuation_number: '1766',
    company_name: 'Acme Corp',
    error: 'receiver responded 503',
    attempts: 4,
    created_at: '2026-08-08T06:00:00Z',
    due_at: '2026-08-08T13:00:00Z',
    finished_at: null,
    duration_ms: null,
  },
  {
    id: 'W2',
    source: 'webhook_delivery',
    status: 'queued',
    detail: 'pending',
    name: 'valuation.state_changed',
    valuation_id: 'V1',
    valuation_number: '1766',
    company_name: 'Acme Corp',
    error: null,
    attempts: 1,
    created_at: '2026-08-08T06:00:00Z',
    due_at: '2026-08-08T09:00:00Z',
    finished_at: null,
    duration_ms: null,
  },
];

const RULES = [
  { source: 'email', enabled: true, stall_minutes: 120, failure_count: 10, failure_window_hours: 24 },
  { source: 'ai_job', enabled: true, stall_minutes: 60, failure_count: 5, failure_window_hours: 24 },
];

const QUIET = { alerts: [], rules: RULES, open: 0 };

const STALLED = {
  alerts: [
    {
      id: '01N409ALERT0000000000000AA',
      source: 'email',
      kind: 'stalled',
      detail: 'Outbound message: oldest outstanding job is 8h old (threshold 2h), 3 still owed',
      observed: 480,
      threshold: 120,
      opened_at: '2026-08-08T04:00:00Z',
      last_seen_at: '2026-08-08T12:00:00Z',
      resolved_at: null,
    },
  ],
  rules: RULES,
  open: 1,
};

/** Swapped per test; the mock reads it at request time. */
let alertsBody: unknown = QUIET;
let jobsBody: typeof JOBS | typeof WAITING_JOBS = JOBS;

function mockApi() {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.includes('/admin/jobs/stats')) return jsonResponse(STATS);
    if (path.includes('/admin/jobs/alerts')) return jsonResponse(alertsBody);
    if (path.includes('/admin/jobs')) return jsonResponse({ jobs: jobsBody, total: jobsBody.length });
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
    alertsBody = QUIET;
    jobsBody = JOBS;
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

  it('says when a queued row is waiting out a retry rather than stuck', async () => {
    // Both rows read Queued/pending. One is not claimable for another three
    // hours because its receiver answered 503 and the ladder is doing its job;
    // the other came due an hour ago and nothing has taken it. Opposite
    // responses, and until the row carried `due_at` the page could not tell
    // them apart at all — which is the same confusion the stall alert had.
    jobsBody = WAITING_JOBS;
    mockApi();
    renderPage();
    const table = await screen.findByLabelText('Background jobs');

    const backingOff = within(table).getByText('valuation.report_ready').closest('tr')!;
    expect(within(backingOff).getByText('Queued')).toBeInTheDocument();
    expect(within(backingOff).getByText('retry in 3 h 0 min')).toBeInTheDocument();

    const overdue = within(table).getByText('valuation.state_changed').closest('tr')!;
    expect(within(overdue).getByText('Queued')).toBeInTheDocument();
    expect(within(overdue).queryByText(/retry in/)).toBeNull();
  });

  it('does not label a row that is not queued as awaiting a retry', async () => {
    // `due_at` is whatever the last attempt left behind on a settled row, and a
    // succeeded or skipped job is not owed another one. Reading it there would
    // put "retry in …" on work that is over.
    mockApi();
    renderPage();
    const table = await screen.findByLabelText('Background jobs');
    expect(within(table).queryByText(/retry in/)).toBeNull();
  });

  it('says which status filter is on, not only which one is dark', async () => {
    // The chip row conveyed the active filter with a background colour and
    // nothing else — invisible to a screen reader and to a forced-colours mode.
    // `toggleStateCensus` states the rule over the whole app; this is the one
    // place it is watched actually reaching the DOM and flipping.
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('upload');

    expect(screen.getByRole('button', { name: 'All', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Failed', pressed: false })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Failed' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Failed', pressed: true })).toBeInTheDocument(),
    );
    // The one it left must stop claiming to be on: two pressed chips describe a
    // filter combination the page cannot be in.
    expect(screen.getByRole('button', { name: 'All', pressed: false })).toBeInTheDocument();
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
  // ── Alerting (design §17.1 item 13) ────────────────────────────────────────

  it('puts an open alert above every count on the page', async () => {
    alertsBody = STALLED;
    mockApi();
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Outbound message — stalled');
    expect(alert).toHaveTextContent('oldest outstanding job is 8h old');
  });

  it('states the thresholds when nothing is wrong, so silence is legible', async () => {
    mockApi();
    renderPage();
    // "No alerts" and "alerting is broken" look identical without this.
    expect(await screen.findByText(/No queue alerts open/)).toBeInTheDocument();
    expect(screen.getByText(/Outbound message 120m \/ 10 failures/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('re-checks the queues on demand', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByText(/No queue alerts open/);
    await userEvent.click(screen.getByRole('button', { name: 'Check queues now' }));
    await waitFor(() => expect(calls.some((c) => c.includes('/admin/jobs/alerts/scan'))).toBe(true));
  });

  // ── A queue that drains while somebody is reading page 2 ───────────────────

  /**
   * The job monitor is the sharpest case for an out-of-range page because it
   * refetches itself every fifteen seconds and its list is the one list in the
   * product that routinely *shrinks*: jobs settle, sweeps purge them, an
   * operator retries a batch. A reader who has paged into a backlog is left
   * asking for a page the queue no longer has, and nothing on the server side
   * corrects them — `domain/pagination.ts` answers an over-range page with an
   * empty list on purpose.
   *
   * The old failure was total: the empty page rendered no rows *and* no
   * pagination control, because `pageCount` had collapsed to 1 and the control
   * hid itself. Every fifteen seconds it refetched page 2 and drew the same
   * blank table, with nothing to click.
   */
  it('recovers when the backlog drains out from under a reader on page 2', async () => {
    let total = 60; // three pages of 25
    const pagesAsked: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/admin/jobs/stats')) return jsonResponse(STATS);
      if (path.includes('/admin/jobs/alerts')) return jsonResponse(QUIET);
      if (path.includes('/admin/jobs')) {
        const page = new URL(path, 'http://x').searchParams.get('page') ?? '1';
        pagesAsked.push(page);
        // The queue only ever had rows on page 1; page 2 was reachable because
        // the backlog was three pages deep when the reader clicked into it.
        return jsonResponse({ jobs: page === '1' ? JOBS : [], total });
      }
      return jsonResponse({}, 404);
    });

    renderPage();
    await screen.findByText('upload');
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(screen.getByText('Page 2 of 3')).toBeInTheDocument());

    // The backlog drains: 60 jobs settle down to the three still on page 1.
    total = JOBS.length;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    // Previously: an empty table, no Pagination (pageCount 1), and a 15-second
    // poll that asked for page 2 forever.
    expect(await screen.findByText('upload')).toBeInTheDocument();
    expect(pagesAsked.at(-1)).toBe('1');
  });
});
