import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useEffect, useRef } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { ValuationWorkspace, useWorkspace } from '../src/pages/valuation/ValuationWorkspace';

/**
 * Moving from one engagement straight to another.
 *
 * `/valuations/:id` is one route, so a bridge candidate, a portfolio entity or
 * the back button changes the id *without* tearing the workspace down. Two
 * things follow, and both were wrong.
 *
 * The workspace's own aggregate can have two requests outstanding, and the
 * reply for the engagement the user left can land second. Nothing on screen
 * disagrees with anything else when it does: the company name, the state badge,
 * the counters and the `valuation` object every tab reads all come from that
 * one response, so the whole workspace is consistently about the wrong
 * engagement, under the other one's URL.
 *
 * And the tab below was re-rendered with new props rather than rebuilt, so its
 * own slice loads — forty-odd of them across the tabs and their panels, every
 * one addressed `/valuations/${id}/…` — raced the same way with none of the
 * state they had accumulated for the previous engagement discarded.
 */

const A = '01N409VA000000000000000001';
const B = '01N409VA000000000000000002';

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
      roles: ['admin'],
    },
  }),
}));

vi.mock('../src/lib/realtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useValuationStream: () => ({ viewers: [], commentTick: 0 }) };
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const valuation = (id: string, company: string) => ({
  id,
  number: id === A ? 1766 : 1767,
  kind: '409a',
  state: 'started',
  company_name: company,
  user_id: '01N409OWNER00000000000000A',
  partner_id: null,
  waiting_on_client: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

/** Counts its own mounts, and reports the engagement it was handed. */
const mounts = { count: 0 };
function TabProbe() {
  const { valuation: v } = useWorkspace();
  const seen = useRef(0);
  useEffect(() => {
    mounts.count += 1;
    seen.current += 1;
  }, []);
  return <div data-testid="probe">tab sees {v?.company_name ?? 'nothing'}</div>;
}

function renderAt(deferAggregates: Array<{ id: string; resolve: (body: unknown) => void }> | null) {
  return render(
    <MemoryRouter initialEntries={[`/valuations/${A}`]}>
      <Routes>
        <Route path="/valuations/:id" element={<ValuationWorkspace />}>
          <Route index element={<TabProbe />} />
        </Route>
      </Routes>
      <Link to={`/valuations/${B}`}>Go to the other engagement</Link>
      {deferAggregates ? null : null}
    </MemoryRouter>,
  );
}

function deferAggregate() {
  const pending: Array<{ id: string; resolve: (body: unknown) => void }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    const match = path.match(/\/valuations\/(01N409VA\w+)(?:\?|$)/);
    if (match) {
      return new Promise<Response>((res) =>
        pending.push({ id: match[1]!, resolve: (body) => res(jsonResponse(body)) }),
      );
    }
    return jsonResponse({}, 404);
  });
  return pending;
}

describe('ValuationWorkspace — navigating between engagements', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mounts.count = 0;
  });

  it('shows the engagement in the URL, not the one that replied last', async () => {
    const user = userEvent.setup();
    const pending = deferAggregate();
    renderAt(null);

    await waitFor(() => expect(pending).toHaveLength(1));
    await user.click(screen.getByRole('link', { name: 'Go to the other engagement' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0]!.id).toBe(A);
    expect(pending[1]!.id).toBe(B);

    pending[1]!.resolve({ valuation: valuation(B, 'Second Engagement Ltd'), counters: null });
    await screen.findByText('Second Engagement Ltd');
    pending[0]!.resolve({ valuation: valuation(A, 'First Engagement Inc'), counters: null });

    await waitFor(() => expect(screen.getByText('Second Engagement Ltd')).toBeInTheDocument());
    expect(screen.queryByText('First Engagement Inc')).toBeNull();
  });

  it('does not report the abandoned engagement’s 404 against the one on screen', async () => {
    // A 404 here replaces the whole workspace with "This valuation does not
    // exist or you do not have access to it." — an accusation about an
    // engagement that loaded perfectly well.
    const user = userEvent.setup();
    const pending: Array<{ id: string; resolve: (res: Response) => void }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const match = String(url).match(/\/valuations\/(01N409VA\w+)(?:\?|$)/);
      if (match) return new Promise<Response>((res) => pending.push({ id: match[1]!, resolve: res }));
      return jsonResponse({}, 404);
    });
    renderAt(null);

    await waitFor(() => expect(pending).toHaveLength(1));
    await user.click(screen.getByRole('link', { name: 'Go to the other engagement' }));
    await waitFor(() => expect(pending).toHaveLength(2));

    pending[1]!.resolve(jsonResponse({ valuation: valuation(B, 'Second Engagement Ltd'), counters: null }));
    await screen.findByText('Second Engagement Ltd');
    pending[0]!.resolve(jsonResponse({ detail: 'gone' }, 404));

    await waitFor(() => expect(screen.getByText('Second Engagement Ltd')).toBeInTheDocument());
    expect(screen.queryByText(/does not exist or you do not have access/)).toBeNull();
  });

  it('rebuilds the tab below rather than re-rendering it with a new engagement', async () => {
    // The guard for the whole family: a tab that is torn down cannot have its
    // own slice loads raced, because the late reply writes to state that is
    // already gone. Without the key the probe mounts once and keeps every piece
    // of state it accumulated for the previous engagement.
    const user = userEvent.setup();
    const pending = deferAggregate();
    renderAt(null);

    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!.resolve({ valuation: valuation(A, 'First Engagement Inc'), counters: null });
    await screen.findByText('First Engagement Inc');
    expect(mounts.count).toBe(1);

    await user.click(screen.getByRole('link', { name: 'Go to the other engagement' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!.resolve({ valuation: valuation(B, 'Second Engagement Ltd'), counters: null });

    await screen.findByText('Second Engagement Ltd');
    await waitFor(() => expect(mounts.count).toBe(2));
    expect(screen.getByTestId('probe')).toHaveTextContent('tab sees Second Engagement Ltd');
  });
});
