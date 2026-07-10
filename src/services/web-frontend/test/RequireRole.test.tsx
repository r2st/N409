import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import type { User } from '../src/lib/types';

/** P1 #5 — role-based route guarding + role-aware landing. */

const baseUser: User = {
  id: '01N409USER000000000000000A',
  email: 'someone@example.com',
  first_name: 'Sam',
  last_name: 'One',
  phone: null,
  job_title: null,
  company_name: null,
  timezone: null,
  verified: true,
  sso_provider: null,
  partner_id: null,
  roles: ['valuation_user'],
};

let mockUser: User = baseUser;

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: mockUser,
    login: vi.fn(),
    register: vi.fn(),
    adoptToken: vi.fn(),
    logout: vi.fn(),
  }),
}));

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** Enough API surface for the pages these routes land on. */
function mockApi() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    if (path.includes('/notifications/unread-count')) return jsonResponse({ unread_count: 0 });
    if (path.includes('/tasks')) return jsonResponse({ tasks: [], total: 0 });
    if (path.includes('/reviews')) return jsonResponse({ reviews: [], total: 0 });
    if (path.includes('/users/options')) return jsonResponse({ options: [] });
    if (path.includes('/valuations')) return jsonResponse({ valuations: [], page: 1, per_page: 100, total: 0 });
    if (path.includes('/tokens')) return jsonResponse({ tokens: [] });
    return jsonResponse({});
  });
}

function renderAt(path: string, user: User) {
  mockUser = user;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('role-based routing (RequireRole)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockApi();
  });

  it('shows Access denied to a client opening an admin route', async () => {
    renderAt('/admin/users', { ...baseUser, roles: ['valuation_user'] });
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to the dashboard/i })).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });

  it('shows Access denied to a client opening an ops route', async () => {
    renderAt('/tasks', { ...baseUser, roles: ['valuation_user'] });
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
  });

  it('lets an ops reviewer open /tasks but not the user-admin console', async () => {
    renderAt('/tasks', { ...baseUser, roles: ['reviewer'] });
    expect(await screen.findByRole('heading', { name: 'Review tasks' })).toBeInTheDocument();

    renderAt('/admin/users', { ...baseUser, roles: ['reviewer'] });
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
  });

  it('lands partners on the partner portal from "/"', async () => {
    renderAt('/', {
      ...baseUser,
      roles: ['partner'],
      partner_id: '01N409PARTNER00000000000AA',
    });
    expect(await screen.findByText('Your portfolio')).toBeInTheDocument();
  });

  it('keeps non-partners out of the partner portal', async () => {
    renderAt('/partner', { ...baseUser, roles: ['valuation_user'] });
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
  });
});
