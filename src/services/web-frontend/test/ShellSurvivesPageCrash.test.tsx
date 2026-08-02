import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppLayout } from '../src/components/AppLayout';
import { MarketingLayout } from '../src/components/MarketingLayout';

/**
 * A render error on one page must not cost the user the shell around it.
 *
 * AppLayout already records why the *Suspense* boundary was moved down out of
 * App.tsx — sitting above the router, one lazy chunk fetch "tore the whole
 * shell down and put a spinner on an empty screen: sidebar gone, heading gone".
 * The error boundary was left behind by that move, with the same problem one
 * step worse: a throw anywhere in any page replaced the entire workspace with
 * an error card. Sidebar, all ~30 nav links, and the sign-out button, gone —
 * the only control left being "Reload".
 *
 * Two properties, and the second is the one that is easy to miss: a boundary
 * that has caught an error stays caught, so without a reset the error card
 * outlives the route that produced it and the preserved navigation is useless.
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

function Boom(): never {
  throw new Error('this page exploded');
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React logs the caught error; the boundary logs it again on purpose.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify({ unread_count: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  localStorage.clear();
});

afterEach(() => {
  consoleError.mockRestore();
  vi.restoreAllMocks();
});

function renderApp(initial = '/broken') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/broken" element={<Boom />} />
          <Route path="/dashboard" element={<h1>Dashboard body</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('AppLayout keeps the shell when a page throws', () => {
  it('shows the error where the page was', () => {
    renderApp();
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
  });

  it('leaves the navigation standing', () => {
    renderApp();
    // The whole point: there is still somewhere to go.
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dashboard/ })).toBeInTheDocument();
  });

  it('leaves the sign-out button standing', () => {
    renderApp();
    // Being unable to sign out of a crashed workspace is the worst version of
    // this, especially on a shared machine.
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('keeps the skip link and the main landmark', () => {
    renderApp();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument();
    expect(document.getElementById('main-content')).not.toBeNull();
  });

  it('reports the error rather than losing it', () => {
    renderApp();
    const logged = consoleError.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('this page exploded');
  });

  it('clears the error when the user navigates away', async () => {
    renderApp();
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: /Dashboard/ }));

    // Without the remount key the boundary stays caught and the error card
    // survives the navigation, making the preserved nav pointless.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Dashboard body' })).toBeInTheDocument();
  });

  it('does not swallow a healthy page', () => {
    renderApp('/dashboard');
    expect(screen.getByRole('heading', { name: 'Dashboard body' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('MarketingLayout keeps its chrome when a page throws', () => {
  const renderMarketing = (initial = '/broken') =>
    render(
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route element={<MarketingLayout />}>
            <Route path="/broken" element={<Boom />} />
            <Route path="/pricing" element={<h1>Pricing body</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

  it('keeps the header navigation', () => {
    renderMarketing();
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByRole('navigation', { name: 'Marketing' })).toBeInTheDocument();
  });

  it('clears the error when the user navigates away', async () => {
    renderMarketing();
    // "Pricing" also appears in the footer; take the one in the header nav.
    const header = screen.getByRole('navigation', { name: 'Marketing' });
    await userEvent.click(within(header).getByRole('link', { name: 'Pricing' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Pricing body' })).toBeInTheDocument();
  });
});
