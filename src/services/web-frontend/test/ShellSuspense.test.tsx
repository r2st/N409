import { describe, expect, it, vi, beforeEach } from 'vitest';
import { lazy } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { AppLayout } from '../src/components/AppLayout';
import { ValuationWorkspace } from '../src/pages/valuation/ValuationWorkspace';
import type { User, Valuation } from '../src/lib/types';

/**
 * Every page is a lazy chunk. These pin where the resulting suspension is
 * caught: inside the shell, not above it. Hoisting the boundary back to the
 * router would tear the sidebar and the workspace tab strip off the screen for
 * the length of a chunk fetch — a regression that is invisible on a warm cache
 * and obvious on a cold one.
 */

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const user: User = {
  id: 'me-1',
  email: 'ops@409.ai',
  first_name: 'Olive',
  last_name: 'Ops',
  phone: null,
  job_title: null,
  company_name: null,
  timezone: null,
  verified: true,
  sso_provider: null,
  partner_id: null,
  roles: ['admin'],
};

const valuation = {
  id: '01N409VAL000000000000000AA',
  user_id: 'me-1',
  company_name: 'Acme Robotics',
  kind: '409a',
  state: 'started',
  waiting_on_client: false,
  created_at: '2026-06-01T00:00:00Z',
  due_date: null,
} as unknown as Valuation;

/** A chunk that never arrives, so the fallback stays up for the assertion. */
const NeverLoads = lazy(() => new Promise<never>(() => {}));

describe('app shell keeps its furniture while a page chunk loads', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/notifications/unread-count')) return jsonResponse({ unread_count: 0 });
      return jsonResponse({});
    });
    localStorage.setItem('n409.token', 'header.payload.sig');
  });

  it('renders the sidebar and its nav alongside the page placeholder', async () => {
    render(
      <MemoryRouter initialEntries={['/valuations']}>
        <AuthProvider>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/valuations" element={<NeverLoads />} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    // The nav is what would vanish under a router-level boundary.
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Dashboard' }).length).toBeGreaterThan(0));
    expect(screen.getAllByRole('link', { name: 'Settings' }).length).toBeGreaterThan(0);
    expect(screen.getByText('Loading page…')).toBeInTheDocument();
  });
});

describe('valuation workspace keeps its header and tabs while a tab loads', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/valuations/')) return jsonResponse({ valuation });
      return jsonResponse({});
    });
    localStorage.setItem('n409.token', 'header.payload.sig');
  });

  it('shows a workspace placeholder before the aggregate arrives', async () => {
    let release: ((v: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith('/auth/me')) return jsonResponse({ user });
      if (path.includes('/valuations/')) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return jsonResponse({});
    });

    render(
      <MemoryRouter initialEntries={['/valuations/01N409VAL000000000000000AA']}>
        <AuthProvider>
          <Routes>
            <Route path="/valuations/:id" element={<ValuationWorkspace />}>
              <Route index element={<div>Overview</div>} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText('Loading valuation…')).toBeInTheDocument();
    release!(jsonResponse({ valuation }));
    await waitFor(() => expect(screen.getByText('Acme Robotics')).toBeInTheDocument());
    expect(screen.queryByText('Loading valuation…')).toBeNull();
  });

  it('keeps the tab strip on screen while a tab chunk is pending', async () => {
    render(
      <MemoryRouter initialEntries={['/valuations/01N409VAL000000000000000AA/documents']}>
        <AuthProvider>
          <Routes>
            <Route path="/valuations/:id" element={<ValuationWorkspace />}>
              <Route path="documents" element={<NeverLoads />} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Acme Robotics')).toBeInTheDocument());
    // The tab the analyst just clicked is still there to click again.
    expect(screen.getByRole('link', { name: 'Documents' })).toBeInTheDocument();
    expect(screen.getByText('Loading tab…')).toBeInTheDocument();
  });
});
