import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppLayout } from '../src/components/AppLayout';

/**
 * Design §3.2 — live counts on the sidebar buckets.
 *
 * The counts have existed server-side the whole time; the nav carried static
 * labels. The cases here are that they arrive, that unread reads as attention
 * rather than as another total, and that a client — who has no worklist — is
 * not shown an ops worklist.
 */

const OPS_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

let currentRoles = ['admin'];

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    viewMode: 'real',
    logout: vi.fn(),
    user: {
      id: OPS_ID,
      email: 'ops@n409.example',
      first_name: 'Olive',
      last_name: 'Ops',
      verified: true,
      sso_provider: null,
      partner_id: null,
      roles: currentRoles,
    },
  }),
}));

const COUNTS = {
  all: 979,
  incomplete: 359,
  unverified: 2,
  in_progress: 21,
  waiting_on_client: 22,
  drafted: 41,
  published: 0,
  unread: 6,
  ignored: 326,
};

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  currentRoles = ['admin'];
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    if (path.includes('/valuations/counts')) return jsonResponse({ counts: COUNTS });
    if (path.includes('/inbox/unread-count')) return jsonResponse({ unread_threads: 0 });
    return jsonResponse({ unread_count: 0 });
  });
});

const renderLayout = () =>
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/dashboard" element={<div>dash</div>} />
          {/* The bucket links point at the listing; the shell is what these
              tests are about, so any of them renders a stand-in. */}
          <Route path="*" element={<div>page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

/** The desktop sidebar; the mobile drawer renders the same links. */
const sidebar = () => screen.getAllByRole('navigation', { name: 'Main' })[0]!;

/** Requests to the three nav-badge endpoints, across every rendered shell. */
const badgeCalls = () =>
  vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([url]) => /unread-count|valuations\/counts/.test(String(url))).length;

describe('sidebar bucket counts', () => {
  it('shows a bucket row per named tab with its count', async () => {
    renderLayout();
    const nav = sidebar();
    for (const [label, count] of [
      ['Incomplete', '359'],
      ['Unverified', '2'],
      ['In Progress', '21'],
      ['Waiting On Client', '22'],
      ['Drafted', '41'],
      ['Published', '0'],
    ] as const) {
      const link = await within(nav).findByRole('link', { name: new RegExp(`^${label}`) });
      expect(link.textContent, label).toContain(count);
    }
  });

  it('links each bucket to the listing pre-filtered', async () => {
    renderLayout();
    const link = await within(sidebar()).findByRole('link', { name: /^Waiting On Client/ });
    expect(link).toHaveAttribute('href', '/valuations?bucket=waiting_on_client');
  });

  /**
   * Unread is a property of the reader and cuts across every bucket, so it sits
   * on the parent row rather than being repeated beside each total — where it
   * would say the same six things and mean something different each time.
   */
  it('puts the total and the unread badge on the valuations row', async () => {
    renderLayout();
    const link = await within(sidebar()).findByRole('link', { name: /All valuations/ });
    expect(link.textContent).toContain('979');
    expect(link.textContent).toContain('6');
  });

  it('shows no bucket strip for a client', async () => {
    // A client with three engagements does not need six sub-counts under their
    // own listing; the strip is a worklist, which is an ops idea.
    currentRoles = ['valuation_user'];
    renderLayout();
    expect(within(sidebar()).queryByRole('link', { name: /^Unverified/ })).not.toBeInTheDocument();
  });

  it('stays silent when the count endpoint fails', async () => {
    // A stale session must not put an error banner in the navigation.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    renderLayout();
    const link = await within(sidebar()).findByRole('link', { name: /All valuations/ });
    expect(link.textContent).toBe('All valuations');
  });

  /**
   * R330 (M8). All three badge hooks carried `location.pathname`, so every
   * client-side navigation re-fired all three immediately: clicking through the
   * six sidebar buckets was eighteen requests in a couple of seconds, each one
   * returning what the last one returned. The endpoints sit behind 15s TTL
   * caches server-side, so inside that window the answer provably cannot have
   * changed — see `BADGE_MIN_REFETCH_MS`.
   */
  it('does not re-poll the badges on every navigation', async () => {
    const user = userEvent.setup();
    renderLayout();
    await within(sidebar()).findByRole('link', { name: /All valuations/ });
    await waitFor(() => expect(badgeCalls()).toBe(3));

    // Four navigations onto four distinct paths. Before, each was three more
    // requests; the floor makes them all free.
    for (const label of ['Portfolio', 'Search', 'New valuation', 'Dashboard'] as const) {
      await user.click(await within(sidebar()).findByRole('link', { name: new RegExp(`^${label}$`) }));
    }
    expect(badgeCalls()).toBe(3);
    // Still showing the counts it already had, which is the point — the value
    // is at most one cache TTL old rather than absent.
    expect((await within(sidebar()).findByRole('link', { name: /All valuations/ })).textContent).toContain(
      '979',
    );
  });

  it('polls on a fresh mount, which has never asked', async () => {
    renderLayout();
    await waitFor(() => expect(badgeCalls()).toBe(3));
    // A reload, a sign-in or a first render of the shell must not inherit
    // another instance's clock; the floor is per hook instance.
    renderLayout();
    await waitFor(() => expect(badgeCalls()).toBe(6));
  });
});
