import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ValuationsPage } from '../src/pages/ValuationsPage';

/**
 * The partner-scoped listing (design §4.4, P2-19).
 *
 * The scope was always a supported filter; what was missing was any sign of it
 * on the page. A listing scoped to one firm that looks identical to the
 * listing of everything is how an operator concludes a firm has four
 * engagements in total, and the tab counts above it read as platform totals.
 */

const PARTNER_ID = '01N409PARTNER00000000000AA';

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
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

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const BUCKETS = [
  { key: 'all', label: 'All' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'published', label: 'Published' },
];

const PARTNERS = [
  { id: PARTNER_ID, name: 'Vestd', key: 'vestd', archived_at: null },
  { id: '01N409PARTNER00000000000BB', name: 'Carta', key: 'carta', archived_at: null },
];

function mockApi() {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.includes('/valuations/counts')) {
      return jsonResponse({ counts: { all: 12, in_progress: 2, published: 6 }, buckets: BUCKETS });
    }
    if (path.includes('/users/options')) return jsonResponse({ options: [] });
    if (path.includes('/partners')) return jsonResponse({ partners: PARTNERS });
    if (path.includes('/valuations?')) {
      return jsonResponse({ valuations: [], page: 1, per_page: 25, total: 0 });
    }
    return jsonResponse({});
  });
  return calls;
}

const renderPage = (entry = '/valuations') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <ValuationsPage />
    </MemoryRouter>,
  );

describe('ValuationsPage partner scope', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('names the firm the listing is scoped to', async () => {
    mockApi();
    renderPage(`/valuations?partner_id=${PARTNER_ID}`);
    // Scoped by the banner, not just by the partner dropdown further down the
    // page — the dropdown is a control, and a control does not tell you what
    // the counts above it are counting.
    const banner = await screen.findByText(/cover this firm only/);
    expect(banner).toHaveTextContent('Scoped to Vestd');
  });

  it('scopes the counts request too, not only the rows', async () => {
    // A scoped listing under platform-wide tab counts is a page that
    // contradicts itself.
    const calls = mockApi();
    renderPage(`/valuations?partner_id=${PARTNER_ID}`);
    await screen.findByText(/cover this firm only/);
    expect(
      calls.some((c) => c.includes('/valuations/counts') && c.includes(`partner_id=${PARTNER_ID}`)),
    ).toBe(true);
  });

  it('offers a way back to the firm page and a way out of the scope', async () => {
    const user = userEvent.setup();
    const calls = mockApi();
    renderPage(`/valuations?partner_id=${PARTNER_ID}`);
    await screen.findByText(/cover this firm only/);

    expect(screen.getByRole('link', { name: 'Firm page' })).toHaveAttribute(
      'href',
      `/admin/partners/${PARTNER_ID}`,
    );

    await user.click(screen.getByRole('button', { name: 'Clear scope' }));
    await waitFor(() => expect(screen.queryByText(/cover this firm only/)).not.toBeInTheDocument());
    const last = calls.filter((c) => c.includes('/valuations?')).at(-1)!;
    expect(last).not.toContain('partner_id');
  });

  it('shows nothing when the listing is not scoped', async () => {
    mockApi();
    renderPage('/valuations');
    await screen.findAllByRole('tab');
    expect(screen.queryByText(/cover this firm only/)).not.toBeInTheDocument();
  });

  it('stays quiet for a partner id that matches no firm the caller can see', async () => {
    // Rendering "Scoped to undefined" would be worse than rendering nothing.
    mockApi();
    renderPage('/valuations?partner_id=01N409PARTNERUNKNOWN00001');
    await screen.findAllByRole('tab');
    expect(screen.queryByText(/cover this firm only/)).not.toBeInTheDocument();
  });
});
