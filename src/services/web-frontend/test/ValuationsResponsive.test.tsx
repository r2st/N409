import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ValuationsPage } from '../src/pages/ValuationsPage';

/**
 * Improvement 7 — mobile-responsive valuation list. Below md the table is
 * replaced by a card list (`md:hidden` vs `hidden md:block`); jsdom does not
 * apply media queries, so these tests assert the responsive classes and that
 * the card view is fully functional (selection included).
 */

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
  }),
}));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    if (path.includes('/valuations/counts')) {
      return jsonResponse({ counts: { all: 1, open: 1, in_review: 0, drafted: 0, published: 0, closed: 0 } });
    }
    if (path.includes('/users/options')) return jsonResponse({ options: [] });
    if (path.includes('/partners')) return jsonResponse({ partners: [] });
    if (path.includes('/valuations?')) {
      return jsonResponse({
        valuations: [
          {
            id: VAL_A,
            number: '1001',
            workflow_id: null,
            kind: '409a',
            state: 'started',
            waiting_on_client: true,
            company_name: 'Pocket Rocket Inc',
            service_name: null,
            user_id: OPS_ID,
            partner_id: null,
            source: null,
            currency: 'USD',
            service_countries: [],
            paid_status: 'unpaid',
            qsbs_attestation: null,
            delivery_days: null,
            assigned_reviewer_id: null,
            created_at: '2026-07-01T00:00:00Z',
            due_date: '2026-07-15T00:00:00Z',
            published_at: null,
          },
        ],
        page: 1,
        per_page: 25,
        total: 1,
      });
    }
    return jsonResponse({});
  });
}

describe('ValuationsPage responsive layout', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a mobile card list hidden at md+, and a table hidden below md', async () => {
    mockApi();
    render(
      <MemoryRouter>
        <ValuationsPage />
      </MemoryRouter>,
    );

    const cards = await screen.findByRole('list', { name: 'Valuations' });
    expect(cards.className).toContain('md:hidden');
    const table = screen.getByRole('table');
    const tableWrap = table.parentElement!;
    expect(tableWrap.className).toContain('hidden');
    expect(tableWrap.className).toContain('md:block');
    // wide tables scroll inside their container instead of the page
    expect(tableWrap.className).toContain('overflow-x-auto');
  });

  it('cards carry the key facts and stay selectable for bulk actions', async () => {
    mockApi();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ValuationsPage />
      </MemoryRouter>,
    );

    const cards = await screen.findByRole('list', { name: 'Valuations' });
    expect(cards).toHaveTextContent('Pocket Rocket Inc');
    expect(cards).toHaveTextContent('#1001');
    expect(cards).toHaveTextContent('Waiting on client');
    expect(cards).toHaveTextContent('Unpaid');

    // selecting from the card view drives the same bulk bar
    const checkboxes = screen.getAllByLabelText('Select Pocket Rocket Inc');
    expect(checkboxes.length).toBe(2); // card + table variants
    await user.click(checkboxes[0]!);
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  /**
   * Below md the table is hidden entirely, so this list is the only way into a
   * valuation on a phone. It was a `<div onClick>` — not focusable, no key
   * binding — which left the whole worklist unreachable without a pointer.
   */
  it('opens a valuation from the card list without a pointer', async () => {
    mockApi();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ValuationsPage />
      </MemoryRouter>,
    );

    const cards = await screen.findByRole('list', { name: 'Valuations' });
    const link = within(cards).getByRole('link', { name: 'Pocket Rocket Inc' });
    expect(link).toHaveAttribute('href', `/valuations/${VAL_A}`);

    // Reachable by tabbing — an anchor with an href is in the tab order, which
    // is the whole point; a <div onClick> never is.
    await user.tab();
    while (document.activeElement !== link && document.activeElement !== document.body) {
      await user.tab();
    }
    expect(link).toHaveFocus();
  });

  it('mobile drawer nav gets a scroll container (AppLayout)', async () => {
    // The ops nav is ~19 items; the drawer must scroll on a 375×667 viewport.
    const { AppLayout } = await import('../src/components/AppLayout');
    mockApi();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AppLayout />
      </MemoryRouter>,
    );
    await user.click(screen.getByLabelText('Toggle navigation'));
    const drawer = document.querySelector('.lg\\:hidden.fixed');
    expect(drawer).not.toBeNull();
    expect(drawer!.className).toContain('overflow-y-auto');
    expect(drawer!.className).toContain('max-h-');
  });
});
