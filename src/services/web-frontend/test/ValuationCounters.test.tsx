import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ValuationWorkspace } from '../src/pages/valuation/ValuationWorkspace';

/**
 * The header chip row and the Calculations `n/m` badge (design §4.6, §7.3).
 *
 * The counters exist to be read at a glance, so the assertions are about what
 * the glance says: a badge that is short of its denominator has to look
 * different from one that is not, and the chips have to be reachable rather
 * than merely printed.
 */

const ROLES = { current: ['admin'] as string[] };

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: {
      id: '01N409OPSUSER000000000000A',
      email: 'olive@n409.example',
      first_name: 'Olive',
      last_name: 'Ops',
      verified: true,
      sso_provider: null,
      partner_id: null,
      roles: ROLES.current,
    },
  }),
}));

// The workspace opens an SSE stream; jsdom has no EventSource and the presence
// channel is not what is under test here.
vi.mock('../src/lib/realtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useValuationStream: () => ({ viewers: [], commentTick: 0 }) };
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const VALUATION = {
  id: '01N409VA000000000000000001',
  number: 1766,
  kind: '409a',
  state: 'started',
  company_name: 'Counter Co',
  user_id: '01N409OWNER00000000000000A',
  partner_id: null,
  waiting_on_client: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const counters = (over: Record<string, unknown> = {}) => ({
  pending_files: 2,
  my_tasks: 1,
  all_tasks: 3,
  unread_comments: 4,
  calculations: { done: 2, total: 4, missing: ['income', 'market'] },
  ...over,
});

function mockApi(body: Record<string, unknown> = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url).includes(`/valuations/${VALUATION.id}`)) {
      return jsonResponse({ valuation: VALUATION, counters: counters(), ...body });
    }
    return jsonResponse({}, 404);
  });
}

const renderWorkspace = () =>
  render(
    <MemoryRouter initialEntries={[`/valuations/${VALUATION.id}`]}>
      <Routes>
        <Route path="/valuations/:id/*" element={<ValuationWorkspace />} />
      </Routes>
    </MemoryRouter>,
  );

describe('workspace header counters', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    ROLES.current = ['admin'];
  });

  it('shows the four counters served with the engagement', async () => {
    mockApi();
    renderWorkspace();
    expect(await screen.findByText(/Pending files/)).toBeInTheDocument();
    const expected: Array<[string, string]> = [
      ['Pending files', '(2)'],
      ['My tasks', '(1)'],
      ['All tasks', '(3)'],
      ['Unread chat', '(4)'],
    ];
    for (const [label, value] of expected) {
      expect(screen.getByText(label).closest('a')).toHaveTextContent(value);
    }
  });

  it('makes each counter a way to the tab that answers it', async () => {
    mockApi();
    renderWorkspace();
    await screen.findByText(/Pending files/);
    expect(screen.getByText('Pending files').closest('a')).toHaveAttribute(
      'href',
      `/valuations/${VALUATION.id}/documents`,
    );
    expect(screen.getByText('My tasks').closest('a')).toHaveAttribute(
      'href',
      `/valuations/${VALUATION.id}/tasks`,
    );
  });

  it('keeps a zero chip on screen rather than hiding it', async () => {
    // Vanishing chips make "no chips" ambiguous between "nothing outstanding"
    // and "not loaded yet", and the reader has to go and check.
    mockApi({ counters: counters({ pending_files: 0, my_tasks: 0, all_tasks: 0, unread_comments: 0 }) });
    renderWorkspace();
    const chip = (await screen.findByText('Pending files')).closest('a')!;
    expect(chip).toHaveTextContent('(0)');
  });

  it('badges Calculations with n/m and says what is missing', async () => {
    mockApi();
    renderWorkspace();
    const badge = await screen.findByText('2/4');
    expect(badge).toHaveAttribute('title', expect.stringContaining('income, market'));
  });

  it('marks a short badge differently from a complete one', async () => {
    mockApi();
    const { unmount } = renderWorkspace();
    expect((await screen.findByText('2/4')).className).toMatch(/amber/);
    unmount();

    vi.restoreAllMocks();
    mockApi({ counters: counters({ calculations: { done: 3, total: 3, missing: [] } }) });
    renderWorkspace();
    const complete = await screen.findByText('3/3');
    expect(complete.className).not.toMatch(/amber/);
    expect(complete).toHaveAttribute('title', expect.stringContaining('Every weighted approach'));
  });

  it('shows neither chips nor badge to a client — they count analyst working state', async () => {
    ROLES.current = ['valuation_user'];
    mockApi();
    renderWorkspace();
    await screen.findByText('Counter Co');
    expect(screen.queryByText('Pending files')).not.toBeInTheDocument();
    expect(screen.queryByText('2/4')).not.toBeInTheDocument();
  });

  it('renders the workspace unchanged when the server sends no counters', async () => {
    // Forward compatibility runs both ways: a cached older response must not
    // blank the header it is attached to.
    mockApi({ counters: undefined });
    renderWorkspace();
    expect(await screen.findByText('Counter Co')).toBeInTheDocument();
    expect(screen.queryByText('Pending files')).not.toBeInTheDocument();
  });
});
