import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppLayout } from '../src/components/AppLayout';
import { ValuationsPage } from '../src/pages/ValuationsPage';

/** Final-status §4.3 gap sweep — collapsible nav groups, unread markers UI. */

const OPS_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const VAL_A = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({
    status: 'authenticated',
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
    logout: vi.fn(),
  }),
}));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi(valuations: unknown[] = []) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.includes('/notifications/unread-count')) return jsonResponse({ unread_count: 0 });
    if (path.includes('/valuations/counts')) {
      return jsonResponse({ counts: { all: 1, open: 1, in_review: 0, drafted: 0, published: 0, closed: 0 } });
    }
    if (path.includes('/users/options')) return jsonResponse({ options: [] });
    if (path.includes('/partners')) return jsonResponse({ partners: [] });
    if (path.includes('/valuations?')) {
      return jsonResponse({ valuations, page: 1, per_page: 25, total: valuations.length });
    }
    return jsonResponse({});
  });
  return calls;
}

const row = {
  id: VAL_A,
  number: '1001',
  workflow_id: null,
  kind: '409a',
  state: 'started',
  waiting_on_client: false,
  company_name: 'Dotted Co',
  service_name: null,
  user_id: OPS_ID,
  partner_id: null,
  source: null,
  currency: 'USD',
  service_countries: [],
  paid_status: 'paid',
  qsbs_attestation: null,
  delivery_days: null,
  assigned_reviewer_id: null,
  created_at: '2026-07-01T00:00:00Z',
  due_date: null,
  published_at: null,
  unread: true,
};

describe('collapsible nav groups (§3.3 #1)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('ops sections collapse, persist, and re-expand', async () => {
    mockApi();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AppLayout />
      </MemoryRouter>,
    );

    // both group headers render for a user-admin ops user (desktop + drawer nav share markup)
    const [opsToggle] = screen.getAllByRole('button', { name: 'Operations' });
    expect(screen.getAllByRole('link', { name: 'Review tasks' }).length).toBeGreaterThan(0);

    await user.click(opsToggle!);
    expect(screen.queryAllByRole('link', { name: 'Review tasks' })).toHaveLength(0);
    expect(localStorage.getItem('n409.nav.operations')).toBe('closed');
    // Administration group is independent
    expect(screen.getAllByRole('link', { name: 'Users & roles' }).length).toBeGreaterThan(0);

    await user.click(screen.getAllByRole('button', { name: 'Operations' })[0]!);
    expect(screen.getAllByRole('link', { name: 'Review tasks' }).length).toBeGreaterThan(0);
    expect(localStorage.getItem('n409.nav.operations')).toBe('open');
  });
});

describe('unread markers (gap 4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the unread dot on rows and cards', async () => {
    mockApi([row]);
    render(
      <MemoryRouter>
        <ValuationsPage />
      </MemoryRouter>,
    );
    await screen.findAllByText('Dotted Co');
    // one dot in the table row, one in the mobile card
    expect(screen.getAllByLabelText('Unread activity')).toHaveLength(2);
  });

  it('the Unread-only toggle drives the unread=true query param', async () => {
    const calls = mockApi([row]);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ValuationsPage />
      </MemoryRouter>,
    );
    await screen.findAllByText('Dotted Co');
    await user.click(screen.getByLabelText('Unread only'));
    expect(calls.some((u) => u.includes('unread=true'))).toBe(true);
  });
});
