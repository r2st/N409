import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppLayout } from '../src/components/AppLayout';
import { usePoll } from '../src/lib/usePoll';

/**
 * Polls stop while the tab is hidden, and catch up when it comes back (R338, M8).
 *
 * The badges and the job monitor are the two surfaces a user parks and walks
 * away from, and both kept firing at full rate in a window that had been behind
 * another one all afternoon. Each request costs a JWT verification, the
 * principal join every authenticated route makes and a rate-limit charge, none
 * of which the server-side TTL caches absorb.
 */

const OPS_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

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
      roles: ['admin'],
    },
  }),
}));

/** Put the tab in a state and fire the event the browser fires with it. */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('usePoll', () => {
  it('ticks on its interval while the tab is visible', () => {
    const tick = vi.fn();
    renderHook(() => usePoll(tick, 1_000));

    act(() => void vi.advanceTimersByTime(3_500));
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('stops entirely while the tab is hidden', () => {
    const tick = vi.fn();
    renderHook(() => usePoll(tick, 1_000));

    setVisibility('hidden');
    act(() => void vi.advanceTimersByTime(60_000));
    // Sixty intervals' worth of wall clock, and not one request.
    expect(tick).toHaveBeenCalledTimes(0);
  });

  it('polls immediately on return, rather than waiting out another interval', () => {
    const tick = vi.fn();
    renderHook(() => usePoll(tick, 1_000));

    setVisibility('hidden');
    act(() => void vi.advanceTimersByTime(60_000));
    setVisibility('visible');
    // The reader is looking at figures a minute old: they are refreshed now,
    // which is sooner than the timer alone would have managed.
    expect(tick).toHaveBeenCalledTimes(1);

    act(() => void vi.advanceTimersByTime(1_000));
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('does not re-ask on a return inside the interval', () => {
    const tick = vi.fn();
    renderHook(() => usePoll(tick, 10_000));

    setVisibility('hidden');
    act(() => void vi.advanceTimersByTime(500));
    setVisibility('visible');
    expect(tick).toHaveBeenCalledTimes(0);
  });

  it('calls the latest closure without restarting the clock', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ fn }) => usePoll(fn, 1_000), {
      initialProps: { fn: first },
    });

    act(() => void vi.advanceTimersByTime(900));
    rerender({ fn: second });
    // The old clock is still running — a filter change used to reset it, so a
    // user changing filters faster than the period never saw a poll at all.
    act(() => void vi.advanceTimersByTime(200));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(0);
  });

  it('stops when disabled and on unmount', () => {
    const tick = vi.fn();
    const { unmount } = renderHook(() => usePoll(tick, 1_000, true));
    act(() => void vi.advanceTimersByTime(1_000));
    expect(tick).toHaveBeenCalledTimes(1);

    unmount();
    act(() => void vi.advanceTimersByTime(10_000));
    expect(tick).toHaveBeenCalledTimes(1);
  });
});

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** Requests to the three nav-badge endpoints. */
const badgeCalls = () =>
  vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([url]) => /unread-count|valuations\/counts/.test(String(url))).length;

describe('the navigation badges', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/valuations/counts')) return jsonResponse({ counts: { all: 1 } });
      if (path.includes('/inbox/unread-count')) return jsonResponse({ unread_threads: 0 });
      return jsonResponse({ unread_count: 0 });
    });
  });

  it('stop polling in a backgrounded tab and refresh when it comes back', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/dashboard" element={<div>dash</div>} />
            <Route path="*" element={<div>page</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('dash');
    await waitFor(() => expect(badgeCalls()).toBeGreaterThan(0));
    const onMount = badgeCalls();

    setVisibility('hidden');
    // Ten minutes of a tab nobody is looking at: ten polls of three endpoints
    // before this change, and none now.
    act(() => void vi.advanceTimersByTime(10 * 60_000));
    expect(badgeCalls()).toBe(onMount);

    setVisibility('visible');
    await waitFor(() => expect(badgeCalls()).toBeGreaterThan(onMount));
  });
});
