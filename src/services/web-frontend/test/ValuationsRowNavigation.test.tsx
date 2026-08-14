import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ValuationsPage } from '../src/pages/ValuationsPage';

/**
 * Opening a valuation from the worklist, and the controls that sit inside a
 * clickable row without opening it.
 *
 * Both layouts make the whole row a click target — a `<tr onClick>` in the
 * table, a `<div onClick>` on the card below `md`. Everything interactive
 * *inside* that target therefore has to stop the event from reaching it: the
 * selection checkbox, the company-name link, and the quick-action links. Those
 * `stopPropagation` calls are invisible when they work and expensive when they
 * do not — ticking a checkbox would navigate away from the list and take the
 * rest of the selection with it, which is the exact operation (select several,
 * then bulk-apply) the checkbox exists for.
 *
 * jsdom applies no media queries, so both layouts are mounted at once and each
 * is addressed through its own container rather than by viewport.
 */

const OPS_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const VAL_A = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const VAL_B = '01BX5ZZKBKACTAV9WEVGEMMVS0';

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

const row = (id: string, company: string) => ({
  id,
  number: '1001',
  workflow_id: null,
  kind: '409a',
  state: 'completed',
  waiting_on_client: false,
  company_name: company,
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
});

function mockApi() {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.includes('/valuations/counts')) {
      return jsonResponse({
        counts: { all: 2, open: 0, in_review: 0, drafted: 0, published: 0, closed: 2 },
      });
    }
    if (path.includes('/valuations/export')) {
      return new Response(new Blob(['id\r\n']), {
        status: 200,
        headers: {
          'content-type': 'application/vnd.ms-excel',
          'content-disposition': 'attachment; filename="sel.xlsx"',
        },
      });
    }
    if (path.includes('/users/options')) return jsonResponse({ options: [] });
    if (path.includes('/partners')) return jsonResponse({ partners: [] });
    if (path.includes('/valuations?')) {
      return jsonResponse({
        valuations: [row(VAL_A, 'Acme Corp'), row(VAL_B, 'Beta LLC')],
        page: 1,
        per_page: 25,
        total: 2,
      });
    }
    return jsonResponse({});
  });
  return calls;
}

/** Renders the page under a router that prints wherever it was sent. */
function Here() {
  const { pathname } = useLocation();
  return <div data-testid="where">{pathname}</div>;
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/valuations']}>
      <Here />
      <Routes>
        <Route path="/valuations" element={<ValuationsPage />} />
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>,
  );
}

const where = () => screen.getByTestId('where').textContent;

/** The desktop table, and the card list that replaces it below `md`. */
const table = () => screen.getByRole('table');
const cards = () => screen.getByRole('list', { name: 'Valuations' });

const awaitRows = () => screen.findByRole('table');

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ValuationsPage — opening a valuation from the table', () => {
  it('opens the valuation when the row itself is clicked', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await awaitRows();

    await user.click(within(table()).getByText('Acme Corp').closest('tr')!);
    expect(where()).toBe(`/valuations/${VAL_A}`);
  });

  it('opens it from the name, which is the keyboard-reachable way in', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await awaitRows();

    await user.click(within(table()).getByRole('link', { name: 'Beta LLC' }));
    expect(where()).toBe(`/valuations/${VAL_B}`);
  });

  /**
   * The whole point of the checkbox cell's `stopPropagation`. Without it,
   * selecting a row navigates away from the worklist — and the selection the
   * operator was building goes with it.
   */
  it('selects a row without opening it', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await awaitRows();

    await user.click(within(table()).getByLabelText('Select Acme Corp'));

    expect(where()).toBe('/valuations');
    expect(within(table()).getByLabelText('Select Acme Corp')).toBeChecked();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('keeps building the selection across rows', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await awaitRows();

    await user.click(within(table()).getByLabelText('Select Acme Corp'));
    await user.click(within(table()).getByLabelText('Select Beta LLC'));

    expect(where()).toBe('/valuations');
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  /** A quick action jumps to its own tab, not to the overview behind it. */
  it.each([
    ['Documents of Acme Corp', 'documents'],
    ['Report of Acme Corp', 'report'],
  ])('%s opens that tab rather than the row', async (label, tab) => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await awaitRows();

    await user.click(within(table()).getByRole('link', { name: label }));
    expect(where()).toBe(`/valuations/${VAL_A}/${tab}`);
  });
});

describe('ValuationsPage — opening a valuation from the card list', () => {
  it('opens the valuation when the card is tapped', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await awaitRows();

    await user.click(within(cards()).getByText('Acme Corp').closest('li')!.firstElementChild!);
    expect(where()).toBe(`/valuations/${VAL_A}`);
  });

  it('opens it from the name link on the card', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await awaitRows();

    await user.click(within(cards()).getByRole('link', { name: 'Beta LLC' }));
    expect(where()).toBe(`/valuations/${VAL_B}`);
  });

  it('selects a card without opening it', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await awaitRows();

    await user.click(within(cards()).getByLabelText('Select Acme Corp'));

    expect(where()).toBe('/valuations');
    expect(within(cards()).getByLabelText('Select Acme Corp')).toBeChecked();
  });

  /** One selection, two layouts — the checkbox in each reflects the other. */
  it('shares the selection between the two layouts', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await awaitRows();

    await user.click(within(table()).getByLabelText('Select Beta LLC'));
    expect(within(cards()).getByLabelText('Select Beta LLC')).toBeChecked();

    await user.click(within(cards()).getByLabelText('Select Beta LLC'));
    expect(within(table()).getByLabelText('Select Beta LLC')).not.toBeChecked();
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });
});

describe('ValuationsPage — the header actions', () => {
  it.each([
    ['Compare', '/valuations/compare'],
    ['+ New valuation', '/valuations/new'],
  ])('%s goes to %s', async (label, path) => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await awaitRows();

    await user.click(screen.getByRole('button', { name: label }));
    expect(where()).toBe(path);
  });

  /** Excel is the auditor's format — the one export that must foot. */
  it('exports the checked rows as Excel', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:test');
    globalThis.URL.revokeObjectURL = vi.fn();
    renderPage();
    await awaitRows();

    await user.click(within(table()).getByLabelText('Select Acme Corp'));
    await user.click(screen.getByRole('button', { name: 'Export selected Excel' }));

    await waitFor(() => {
      const dl = calls.find((c) => c.includes('/valuations/export'));
      expect(dl).toBeTruthy();
      expect(decodeURIComponent(dl!)).toContain(`ids=${VAL_A}`);
      expect(dl!).toContain('format=xlsx');
    });
  });
});
