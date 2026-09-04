import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminOperationsPage } from '../src/pages/AdminOperationsPage';

/**
 * The System health console (R191).
 *
 * Three endpoints that had been served and never called. What the tests
 * insist on is the part that is easy to get wrong once and never notice: a
 * measurement that was *not taken* must not be drawn as a measurement of zero,
 * and a delivery the server would refuse must not be tickable — the row's
 * `replayable` flag is the server's verdict, and the whole reason it is
 * computed per row is that the operator sees it before clicking.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const METRICS = {
  service: 'valuation',
  build_sha: 'abc1234',
  uptime_s: 9000,
  error_rates: {
    window_minutes: 15,
    requests: 2000,
    client_errors: 12,
    server_errors: 40,
    error_rate: 0.02,
    worst_routes: [{ route: 'POST /api/v1/valuations/:id/calculations', requests: 100, server_errors: 30 }],
    routes_truncated: false,
  },
  valuations: { all: 42, open: 10, in_review: 4, drafted: 6, published: 20, closed: 2 },
  throughput: [{ week: '2026-08-24', count: 5 }],
  webhooks: { pending: 7, due: 2, failed: 3, delivered: 88, window_hours: 24 },
  pool: {
    total: 8,
    idle: 2,
    waiting: 1,
    max: 10,
    checkedOut: 6,
    saturation: 0.6,
    suspectedLeaks: 1,
    exhaustedForMs: 0,
    oldestCheckoutMs: 45_000,
    leaksDetected: 2,
  },
  circuits: [
    {
      name: 'engine',
      state: 'open',
      consecutiveFailures: 5,
      retryAfterMs: 30_000,
      rejected: 17,
      openedBy: 'timeout',
    },
    { name: 'ai', state: 'closed', consecutiveFailures: 0, retryAfterMs: 0, rejected: 0, openedBy: null },
  ],
};

const SLOW = {
  instrumented: true,
  tracked: 64,
  queries: [
    {
      fingerprint: 'SELECT * FROM valuations WHERE id = $1',
      count: 900,
      totalMs: 36_000,
      maxMs: 120,
      slowCount: 4,
      meanMs: 40,
    },
  ],
};

/** One replayable row and one the server has already ruled out. */
const DELIVERIES = {
  replay_max_age_hours: 72,
  deliveries: [
    {
      id: 'D1',
      webhook_id: 'W1',
      partner_id: 'P1',
      url: 'https://partner.example/hooks',
      enabled: true,
      event_type: 'valuation.published',
      valuation_id: 'V1',
      attempts: 5,
      max_attempts: 5,
      last_error: '503 from receiver',
      created_at: '2026-08-27T10:00:00Z',
      replayable: true,
    },
    {
      id: 'D2',
      webhook_id: 'W2',
      partner_id: 'P2',
      url: 'https://stale.example/hooks',
      enabled: false,
      event_type: 'valuation.published',
      valuation_id: null,
      attempts: 5,
      max_attempts: 5,
      last_error: 'connection refused',
      created_at: '2026-06-01T10:00:00Z',
      replayable: false,
    },
  ],
};

let metricsBody: unknown = METRICS;

function mockApi(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    calls.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : null });
    for (const [fragment, body] of Object.entries(overrides)) {
      if (path.includes(fragment)) return jsonResponse(body);
    }
    if (path.includes('/admin/system/metrics')) return jsonResponse(metricsBody);
    if (path.includes('/admin/db/slow-queries')) return jsonResponse(SLOW);
    if (path.includes('/admin/webhooks/deliveries/failed')) return jsonResponse(DELIVERIES);
    if (path.includes('/admin/webhooks/deliveries/replay')) return jsonResponse({ replayed: 1, ids: ['D1'] });
    if (path.includes('/admin/webhooks/retry'))
      return jsonResponse({ attempted: 2, delivered: 2, retrying: 0, failed: 0, reaped: 0 });
    return jsonResponse({}, 404);
  });
  return calls;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <AdminOperationsPage />
    </MemoryRouter>,
  );

describe('AdminOperationsPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    metricsBody = METRICS;
  });

  it('reads the three endpoints that had no caller', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByText(/System health/);
    await waitFor(() => {
      const urls = calls.map((c) => c.url);
      expect(urls.some((u) => u.includes('/admin/system/metrics'))).toBe(true);
      expect(urls.some((u) => u.includes('/admin/db/slow-queries'))).toBe(true);
      expect(urls.some((u) => u.includes('/admin/webhooks/deliveries/failed'))).toBe(true);
    });
  });

  it('reports the error rate against the sample it was measured over', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText('2.00%')).toBeInTheDocument();
    // The denominator travels with the rate: 2% of two thousand requests and
    // 2% of fifty are not the same fact.
    expect(screen.getByText(/40 of 2000 requests/)).toBeInTheDocument();
  });

  it('says "not measured" rather than 0% when the metrics hook was never installed', async () => {
    // The route returns null here on purpose. A tile that renders that as
    // "0.00%" reports a healthy service when what it has is no measurement.
    metricsBody = { ...METRICS, error_rates: null, pool: null };
    mockApi();
    renderPage();
    expect(await screen.findByText('Not measured')).toBeInTheDocument();
    expect(screen.queryByText('0.00%')).not.toBeInTheDocument();
    expect(screen.getByText(/HTTP metrics hook is not installed/)).toBeInTheDocument();
  });

  it('names the upstream that has stopped taking calls, and why', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText(/engine · open/)).toBeInTheDocument();
    expect(screen.getByText(/opened by timeout after 5 failures/)).toBeInTheDocument();
  });

  it('ranks statements by total time and says how many it is choosing from', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText('SELECT * FROM valuations WHERE id = $1')).toBeInTheDocument();
    expect(screen.getByText(/64 distinct statements tracked/)).toBeInTheDocument();
  });

  it('refuses to tick a delivery the server has already ruled out', async () => {
    mockApi();
    renderPage();
    const table = await screen.findByLabelText('Failed webhook deliveries');
    const boxes = within(table).getAllByRole('checkbox');
    expect(boxes[0]).toBeEnabled();
    // Not merely styled as unavailable: the disabled attribute is what stops a
    // replay being sent for a row the route would refuse.
    expect(boxes[1]).toBeDisabled();
    expect(boxes[1]).toHaveAttribute('title', expect.stringContaining('disabled this endpoint'));
  });

  it('replays exactly the ticked rows and reports what came back', async () => {
    const user = userEvent.setup();
    const calls = mockApi();
    renderPage();
    const table = await screen.findByLabelText('Failed webhook deliveries');
    await user.click(within(table).getAllByRole('checkbox')[0]!);
    await user.click(screen.getByRole('button', { name: /Replay 1 delivery/ }));

    await waitFor(() => {
      const replay = calls.find((c) => c.url.includes('/admin/webhooks/deliveries/replay'));
      expect(replay?.body).toEqual({ ids: ['D1'] });
    });
    expect(await screen.findByText('Re-queued 1 delivery.')).toBeInTheDocument();
  });

  it('says so when the server replayed fewer than were asked for', async () => {
    // A count alone cannot tell "12 replayed" from "12 of the 40 I asked for",
    // which is the whole reason the route returns the ids.
    const user = userEvent.setup();
    mockApi({ '/admin/webhooks/deliveries/replay': { replayed: 0, ids: [] } });
    renderPage();
    const table = await screen.findByLabelText('Failed webhook deliveries');
    await user.click(within(table).getAllByRole('checkbox')[0]!);
    await user.click(screen.getByRole('button', { name: /Replay 1 delivery/ }));
    expect(await screen.findByText(/Re-queued 0 of the 1 selected/)).toBeInTheDocument();
  });

  it('selects every replayable row and no others', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await screen.findByLabelText('Failed webhook deliveries');
    await user.click(screen.getByRole('button', { name: /Select every replayable row \(1\)/ }));
    expect(screen.getByRole('button', { name: /Replay 1 delivery/ })).toBeEnabled();
  });

  it('runs the retry sweep and reports the pass', async () => {
    const user = userEvent.setup();
    const calls = mockApi();
    renderPage();
    await screen.findByLabelText('Failed webhook deliveries');
    await user.click(screen.getByRole('button', { name: 'Run retry sweep' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/admin/webhooks/retry'))).toBe(true));
    expect(await screen.findByText(/2 attempted, 2 delivered/)).toBeInTheDocument();
  });

  /*
   * R414 (M5). `retryDueDeliveries` counts `unsettled`, `superseded` and
   * `reaped` apart from `failed` precisely because they are statements about us
   * rather than about a receiver, and the note read neither — so a pass in
   * which every POST landed and none was recorded reported "attempted, 0
   * delivered", the same sentence as a pass in which every receiver was down.
   */
  it('names the endings that are ours rather than the receiver’s', async () => {
    const user = userEvent.setup();
    mockApi({
      '/admin/webhooks/retry': {
        attempted: 5,
        delivered: 0,
        retrying: 0,
        failed: 0,
        reaped: 2,
        superseded: 1,
        unsettled: 4,
      },
    });
    renderPage();
    await screen.findByLabelText('Failed webhook deliveries');
    await user.click(screen.getByRole('button', { name: 'Run retry sweep' }));
    const note = await screen.findByText(/5 attempted, 0 delivered/);
    expect(note.textContent).toContain('4 deliveries reached the receiver and could not be recorded');
    expect(note.textContent).toContain('1 outcome was discarded because another sweeper held the row');
    expect(note.textContent).toContain('2 deliveries had been abandoned mid-attempt');
  });

  it('says nothing extra about a clean pass, and reads an older build’s answer', async () => {
    const user = userEvent.setup();
    mockApi({ '/admin/webhooks/retry': { attempted: 3, delivered: 3 } });
    renderPage();
    await screen.findByLabelText('Failed webhook deliveries');
    await user.click(screen.getByRole('button', { name: 'Run retry sweep' }));
    expect(await screen.findByText('Retry sweep ran — 3 attempted, 3 delivered.')).toBeInTheDocument();
  });

  it('explains the disabled replay button instead of leaving a dead control', async () => {
    mockApi();
    renderPage();
    await screen.findByLabelText('Failed webhook deliveries');
    const button = screen.getByRole('button', { name: /Replay 0 deliveries/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringContaining('Tick the deliveries'));
  });

  it('does not claim the queue is clear when the load failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 403 }, 403));
    renderPage();
    expect(await screen.findByText('System health is operations-only.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing has been dropped')).not.toBeInTheDocument();
  });
});
