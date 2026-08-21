import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useWorkspace, ValuationWorkspace } from '../src/pages/valuation/ValuationWorkspace';

/**
 * A withdrawn engagement, across the whole workspace.
 *
 * R89 stopped the writes and put a banner on the Overview tab — which is where
 * the problem was noticed and not where it lives. The workspace has
 * twenty-five tabs behind one header, and the other twenty-four said nothing:
 * a client could open Intake, fill in a questionnaire, and learn from a 409 on
 * save that the firm had withdrawn the work. An analyst could retype a set of
 * parameters. Someone could upload a document and be told after the transfer.
 *
 * So the banner is the shell's now, rendered above the outlet, and `retired`
 * rides the workspace context so a tab can close a control without going back
 * to `archived_at` for it. The two assertions that matter are that the banner
 * is on a tab other than Overview, and that a live engagement gets none of it.
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

// The workspace opens an SSE stream; jsdom has no EventSource, and presence is
// not what is under test.
vi.mock('../src/lib/realtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useValuationStream: () => ({ viewers: [], commentTick: 0 }) };
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ID = '01N409VA000000000000000009';

const VALUATION = (over: Record<string, unknown> = {}) => ({
  id: ID,
  number: 4210,
  kind: '409a',
  state: 'review',
  company_name: 'Withdrawn Co',
  user_id: '01N409OWNER00000000000000A',
  partner_id: null,
  currency: 'USD',
  waiting_on_client: false,
  archived_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

function mockApi(valuation: Record<string, unknown>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url).includes(`/valuations/${ID}`)) return jsonResponse({ valuation });
    return jsonResponse({}, 404);
  });
}

/**
 * A stand-in tab.
 *
 * The real tabs are lazy chunks with their own fetches, and none of that is
 * what is being asked here — the question is whether the shell states the
 * condition and passes it down, whichever tab is mounted. So the outlet renders
 * a tab that does nothing but report what it was handed.
 */
function ProbeTab() {
  const { retired } = useWorkspace();
  return <div data-testid="probe">{retired ? 'tab-sees-retired' : 'tab-sees-live'}</div>;
}

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[`/valuations/${ID}${path}`]}>
      <Routes>
        <Route path="/valuations/:id" element={<ValuationWorkspace />}>
          <Route path="params" element={<ProbeTab />} />
          <Route index element={<ProbeTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

describe('the workspace shell and a retired engagement', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    ROLES.current = ['admin'];
  });

  it('states the condition once, above whichever tab is open', async () => {
    mockApi(VALUATION({ archived_at: '2026-08-01T00:00:00Z' }));
    renderAt('/params');
    // Found by its own text, not by `role="status"`: the loading skeleton this
    // replaces is also a status region, so querying by role races the load and
    // asserts against "Loading valuation…".
    const banner = (await screen.findByText(/This engagement has been retired/i)).closest('section')!;
    expect(banner).toHaveAttribute('role', 'status');
    // The three facts a reader cannot work out for themselves: it is readable,
    // the closure is not this tab's, and there is a way back — through an
    // admin. The last one is R90's: telling a firm their work is gone when it
    // is one admin action from being back is a worse failure than saying
    // nothing.
    expect(banner).toHaveTextContent(/still be read/i);
    expect(banner).toHaveTextContent(/on every tab/i);
    expect(banner).toHaveTextContent(/administrator can restore it/i);
  });

  it('is on the Overview tab too — R89 put it there and it stays there', async () => {
    mockApi(VALUATION({ archived_at: '2026-08-01T00:00:00Z' }));
    renderAt('');
    expect(await screen.findByText(/This engagement has been retired/i)).toBeInTheDocument();
  });

  it('hands the condition to the tab, so a tab can close its own controls', async () => {
    mockApi(VALUATION({ archived_at: '2026-08-01T00:00:00Z' }));
    renderAt('/params');
    expect(await screen.findByTestId('probe')).toHaveTextContent('tab-sees-retired');
  });

  // The vacuity guard. Everything above is an assertion that something is
  // present, and all of it would pass just as well against a shell that always
  // showed the banner.
  it('says nothing at all for a live engagement', async () => {
    mockApi(VALUATION());
    renderAt('/params');
    expect(await screen.findByTestId('probe')).toHaveTextContent('tab-sees-live');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/has been retired/i)).not.toBeInTheDocument();
  });

  // The engagement is still legible: the header, the tab strip and the tab
  // itself are all rendered. A banner that replaced the workspace would make
  // the page useless for the only thing it is still for.
  it('still renders the workspace around it', async () => {
    mockApi(VALUATION({ archived_at: '2026-08-01T00:00:00Z' }));
    renderAt('/params');
    await screen.findByText(/This engagement has been retired/i);
    expect(screen.getByText('Withdrawn Co')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Params' })).toBeInTheDocument();
    expect(screen.getByTestId('probe')).toBeInTheDocument();
  });
});
