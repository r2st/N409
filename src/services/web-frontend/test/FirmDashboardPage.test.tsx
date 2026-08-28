import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { FirmDashboardPage } from '../src/pages/FirmDashboardPage';
import { canUseFirmConsole } from '../src/lib/rbac';

/**
 * The firm console. Two things matter on the client: the triage queue the
 * server ranked is rendered in the order it arrived (the page must not re-sort
 * and quietly disagree with the API), and the ops path — where the firm is
 * named in the URL rather than the session — actually scopes every request.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const DASHBOARD = {
  firm: { id: '01N409FIRM0000000000000AA', name: 'Meridian Valuations' },
  summary: {
    total: 40,
    active: 12,
    published: 26,
    closed: 2,
    waiting_on_client: 3,
    overdue: 2,
    due_soon: 4,
    unassigned: 1,
    by_state: {},
  },
  team: [
    { user_id: 'u1', name: 'Dana Reyes', email: 'dana@meridian.test', assigned: 30, active: 7, overdue: 2 },
    { user_id: 'u2', name: null, email: 'sam@meridian.test', assigned: 9, active: 3, overdue: 0 },
  ],
  attention: [
    {
      id: '01N409VAL00000000000000AA',
      number: 118,
      company_name: 'Northwind Robotics',
      state: 'in_review',
      due_date: '2026-07-20',
      assigned_reviewer_name: 'Dana Reyes',
      reason: 'overdue' as const,
      severity: 'high' as const,
      days: 12,
      detail: '12 days past due',
    },
    {
      id: '01N409VAL00000000000000BB',
      number: 121,
      company_name: 'Halcyon Bio',
      state: 'drafted',
      due_date: null,
      assigned_reviewer_name: null,
      reason: 'unassigned' as const,
      severity: 'high' as const,
      days: 5,
      detail: 'No reviewer assigned',
    },
  ],
  attention_total: 9,
  attention_counts: {
    overdue: 2,
    unassigned: 1,
    stalled_with_client: 3,
    stalled_in_review: 2,
    due_soon: 1,
  },
};

const CLIENTS = [
  {
    company_name: 'Northwind Robotics',
    engagements: 4,
    active: 1,
    latest_valuation_id: '01N409VAL00000000000000AA',
    latest_state: 'in_review',
    latest_created_at: '2026-06-01T00:00:00Z',
    next_due_date: '2026-07-20',
    last_published_at: '2025-08-14T00:00:00Z',
  },
  {
    company_name: 'Halcyon Bio',
    engagements: 1,
    active: 1,
    latest_valuation_id: '01N409VAL00000000000000BB',
    latest_state: 'drafted',
    latest_created_at: '2026-07-01T00:00:00Z',
    next_due_date: null,
    last_published_at: null,
  },
];

/** Records every path the page asks for, so scoping can be asserted. */
/**
 * `/firm/attention` — "the full attention queue, for when 25 is not all of it".
 *
 * Its own envelope: `truncated` and `scan_limit` describe the ranking scan's
 * ceiling, which is a different number from the dashboard's page of 25.
 */
const FULL_QUEUE = {
  attention: [
    ...DASHBOARD.attention,
    {
      id: '01N409VAL00000000000000CC',
      number: 130,
      company_name: 'Cobalt Freight',
      state: 'open' as const,
      due_date: null,
      assigned_reviewer_name: null,
      reason: 'stalled_with_client' as const,
      severity: 'medium' as const,
      days: 21,
      detail: 'Waiting on the client for 21 days',
    },
  ],
  total: 3,
  counts: DASHBOARD.attention_counts,
  truncated: true,
  scan_limit: 1000,
};

function mockApi(opts: { dashboardStatus?: number; attentionStatus?: number } = {}) {
  const paths: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    paths.push(path);
    if (path.includes('/firm/dashboard')) {
      return opts.dashboardStatus
        ? jsonResponse({ title: 'nope' }, opts.dashboardStatus)
        : jsonResponse(DASHBOARD);
    }
    if (path.includes('/firm/attention')) {
      return opts.attentionStatus
        ? jsonResponse({ title: 'nope' }, opts.attentionStatus)
        : jsonResponse(FULL_QUEUE);
    }
    if (path.includes('/firm/clients')) return jsonResponse({ clients: CLIENTS, total: 2 });
    // The intake panel lives on this page; its own suite covers its behaviour.
    if (path.includes('/firm/intake-links')) return jsonResponse({ links: [] });
    throw new Error(`unexpected fetch ${path}`);
  });
  return paths;
}

function renderPage(route = '/firm') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <FirmDashboardPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('canUseFirmConsole', () => {
  it('admits firm users and ops, and nobody else', () => {
    // `member` is the ordinary seat inside a firm and sees the console too —
    // it only ever shows the book that seat can already list.
    expect(canUseFirmConsole({ roles: ['partner'] })).toBe(true);
    expect(canUseFirmConsole({ roles: ['member'] })).toBe(true);
    expect(canUseFirmConsole({ roles: ['admin'] })).toBe(true);
    expect(canUseFirmConsole({ roles: ['reviewer'] })).toBe(true);
    expect(canUseFirmConsole({ roles: ['valuation_user'] })).toBe(false);
    expect(canUseFirmConsole({ roles: ['investor'] })).toBe(false);
    expect(canUseFirmConsole(null)).toBe(false);
  });
});

describe('FirmDashboardPage', () => {
  it('leads with the firm name and the headline counts', async () => {
    mockApi();
    renderPage();

    expect(await screen.findByText('Meridian Valuations')).toBeInTheDocument();
    // "Overdue" and "Unassigned" also head columns further down the page, so
    // these assert presence rather than uniqueness.
    const cards = ['Live engagements', 'Overdue', 'Due in 7 days', 'Waiting on client', 'Unassigned'];
    for (const label of cards) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });

  it('renders the attention queue in the order the server ranked it', async () => {
    mockApi();
    renderPage();

    await screen.findByText('Northwind Robotics');
    // The server's ranking is the product decision; the page must present it
    // verbatim rather than re-sorting by whatever column looks sortable.
    const rendered = screen.getAllByText(/Northwind Robotics|Halcyon Bio/).map((el) => el.textContent);
    expect(rendered.indexOf('Northwind Robotics')).toBeLessThan(rendered.indexOf('Halcyon Bio'));

    expect(screen.getByText('12 days past due')).toBeInTheDocument();
    expect(screen.getByText('Nobody assigned')).toBeInTheDocument();
  });

  it('says how much of the queue is on screen when it is truncated', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText('Showing 2 of 9')).toBeInTheDocument();
  });

  it('falls back to the email when a reviewer has no name', async () => {
    mockApi();
    renderPage();
    // Dana also appears as the reviewer on an attention row; the workload table
    // is the one under test here.
    await screen.findByText('Reviewer workload');
    expect(screen.getAllByText('Dana Reyes').length).toBeGreaterThan(0);
    expect(screen.getByText('sam@meridian.test')).toBeInTheDocument();
  });

  it('scopes every request to the firm named in the URL, for ops', async () => {
    const paths = mockApi();
    renderPage('/firm?partner_id=01N409FIRM0000000000000AA');

    await screen.findByText('Meridian Valuations');
    await waitFor(() => expect(paths.some((p) => p.includes('/firm/clients'))).toBe(true));

    // Both the dashboard and the roster must carry the tenant, or the roster
    // would silently show the caller's own book beside another firm's totals.
    expect(paths.filter((p) => p.includes('/firm/'))).not.toHaveLength(0);
    for (const path of paths.filter((p) => p.includes('/firm/'))) {
      expect(path).toContain('partner_id=01N409FIRM0000000000000AA');
    }
  });

  it('sends no partner_id when the firm comes from the session', async () => {
    const paths = mockApi();
    renderPage();

    await screen.findByText('Meridian Valuations');
    await waitFor(() => expect(paths.some((p) => p.includes('/firm/clients'))).toBe(true));
    for (const path of paths) expect(path).not.toContain('partner_id');
  });

  it('debounces the client search into one request per pause', async () => {
    const paths = mockApi();
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Meridian Valuations');
    await waitFor(() => expect(paths.some((p) => p.includes('/firm/clients'))).toBe(true));
    const before = paths.filter((p) => p.includes('/firm/clients')).length;

    await user.type(screen.getByLabelText('Search clients'), 'halcyon');
    await waitFor(() => expect(paths.some((p) => p.includes('search=halcyon'))).toBe(true));

    // Seven keystrokes must not be seven round-trips.
    const after = paths.filter((p) => p.includes('/firm/clients')).length;
    expect(after - before).toBeLessThan(7);
  });

  it('explains a 403 in terms of who the console is for', async () => {
    mockApi({ dashboardStatus: 403 });
    renderPage();
    expect(await screen.findByText(/available to firm accounts/i)).toBeInTheDocument();
  });

  it('tells ops to pick a firm when none was named', async () => {
    mockApi({ dashboardStatus: 400 });
    renderPage();
    expect(await screen.findByText(/Open a firm from the partner console/i)).toBeInTheDocument();
  });
});

describe('FirmDashboardPage — the attention queue behind the count (R191)', () => {
  it('offers a way to open the rest instead of only counting it', async () => {
    // The console said "Showing 2 of 9" and stopped there: the one number a
    // principal plans against, and no path to the rows behind it.
    mockApi();
    render(
      <MemoryRouter>
        <FirmDashboardPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Showing 2 of 9/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show the full queue' })).toBeInTheDocument();
  });

  it('replaces the page with the full ranked queue', async () => {
    const user = userEvent.setup();
    const paths = mockApi();
    render(
      <MemoryRouter>
        <FirmDashboardPage />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Show the full queue' }));
    await waitFor(() => expect(paths.some((p) => p.includes('/firm/attention'))).toBe(true));
    expect(await screen.findByText('Cobalt Freight')).toBeInTheDocument();
    // The count now describes what is actually on screen.
    expect(screen.getByText(/Showing 3 of 9/)).toBeInTheDocument();
    // ...and the button is gone rather than left to re-ask the same question.
    expect(screen.queryByRole('button', { name: 'Show the full queue' })).not.toBeInTheDocument();
  });

  it('states the full queue’s own ceiling, which is not the dashboard’s', async () => {
    const user = userEvent.setup();
    mockApi();
    render(
      <MemoryRouter>
        <FirmDashboardPage />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Show the full queue' }));
    const note = await screen.findByTestId('list-truncated');
    expect(note).toHaveTextContent('Showing 3 engagements needing attention');
    expect(note).toHaveTextContent('scans the 1000 most recent engagements');
  });

  it('does not read a failed queue load as an empty queue', async () => {
    const user = userEvent.setup();
    mockApi({ attentionStatus: 500 });
    render(
      <MemoryRouter>
        <FirmDashboardPage />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Show the full queue' }));
    expect(await screen.findByText(/Could not load the full attention queue|nope/)).toBeInTheDocument();
    // The 25 already ranked stay on screen: they are still true.
    expect(screen.getByText('Northwind Robotics')).toBeInTheDocument();
    expect(screen.queryByText('Nothing needs chasing')).not.toBeInTheDocument();
  });
});
