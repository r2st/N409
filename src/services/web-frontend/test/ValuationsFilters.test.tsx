import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ValuationsPage } from '../src/pages/ValuationsPage';

/**
 * The worklist's filter bar, its multi-column sort, its exports and its pager.
 *
 * Every one of these writes to the URL — which is what makes a worklist view
 * shareable, and what makes a wrong write silently wrong: the operator sends a
 * link, the recipient sees a different set of engagements, and nothing on
 * either screen says so. These assert the query string the page actually sends,
 * not just that something re-rendered.
 */

const OPS_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const REVIEWER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const PARTNER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FC1';
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

interface Options {
  /** Total the list endpoint reports, so the pager can be exercised. */
  total?: number;
  /** Rows returned; `[]` drives the empty state. */
  rows?: Array<ReturnType<typeof row>>;
  /** Fail the list load. */
  listStatus?: number;
  /** Fail the export download. */
  exportStatus?: number;
}

function mockApi(opts: Options = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    calls.push({ url: path, method: init?.method ?? 'GET' });
    if (path.includes('/valuations/counts')) {
      return jsonResponse({ counts: { all: 2, open: 0, in_review: 0, drafted: 0, published: 0, closed: 2 } });
    }
    if (path.includes('/valuations/export')) {
      if (opts.exportStatus) return jsonResponse({ status: opts.exportStatus }, opts.exportStatus);
      return new Response(new Blob(['id\r\n']), {
        status: 200,
        headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="v.csv"' },
      });
    }
    if (path.includes('/users/options')) {
      return jsonResponse({
        options: [{ id: REVIEWER_ID, first_name: 'Rita', last_name: 'Reviewer', email: 'rita@n409.example' }],
      });
    }
    if (path.includes('/partners')) {
      return jsonResponse({ partners: [{ id: PARTNER_ID, name: 'Wilson Sonsini', slug: 'wsgr' }] });
    }
    if (path.includes('/valuations?')) {
      if (opts.listStatus) return jsonResponse({ status: opts.listStatus }, opts.listStatus);
      const rows = opts.rows ?? [row(VAL_A, 'Acme Corp'), row(VAL_B, 'Beta LLC')];
      return jsonResponse({ valuations: rows, page: 1, per_page: 25, total: opts.total ?? rows.length });
    }
    return jsonResponse({});
  });
  return calls;
}

function renderPage(entry = '/valuations') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ValuationsPage />
    </MemoryRouter>,
  );
}

/** The query the list endpoint was last called with. */
function lastListQuery(calls: Array<{ url: string }>): URLSearchParams {
  const last = calls.filter((c) => c.url.includes('/valuations?')).at(-1)!;
  return new URLSearchParams(last.url.split('?')[1]);
}

describe('ValuationsPage — filter bar', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends each dropdown filter as its own query parameter', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText('Acme Corp');

    await user.selectOptions(screen.getByLabelText('Filter by state'), 'review');
    await waitFor(() => expect(lastListQuery(calls).get('state')).toBe('review'));

    await user.selectOptions(screen.getByLabelText('Filter by kind'), '409a');
    await waitFor(() => expect(lastListQuery(calls).get('kind')).toBe('409a'));

    await user.selectOptions(screen.getByLabelText('Filter by source'), 'referral');
    await waitFor(() => expect(lastListQuery(calls).get('source')).toBe('referral'));

    // …and all three together, because they narrow rather than replace.
    const q = lastListQuery(calls);
    expect([q.get('state'), q.get('kind'), q.get('source')]).toEqual(['review', '409a', 'referral']);
  });

  it('filters by reviewer and partner from the options the server serves', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText('Acme Corp');

    await user.selectOptions(await screen.findByLabelText('Filter by reviewer'), REVIEWER_ID);
    await waitFor(() => expect(lastListQuery(calls).get('reviewer_id')).toBe(REVIEWER_ID));
    expect(
      within(screen.getByLabelText('Filter by reviewer')).getByText('Rita Reviewer'),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Filter by partner'), PARTNER_ID);
    await waitFor(() => expect(lastListQuery(calls).get('partner_id')).toBe(PARTNER_ID));
    expect(
      within(screen.getByLabelText('Filter by partner')).getByText('Wilson Sonsini'),
    ).toBeInTheDocument();
  });

  it('sends both ends of the created and due date ranges', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText('Acme Corp');

    await user.type(screen.getByLabelText('Created from'), '2026-01-01');
    await user.type(screen.getByLabelText('Created to'), '2026-06-30');
    await user.type(screen.getByLabelText('Due from'), '2026-07-01');
    await user.type(screen.getByLabelText('Due to'), '2026-12-31');

    await waitFor(() => {
      const q = lastListQuery(calls);
      expect(q.get('created_from')).toBe('2026-01-01');
      expect(q.get('created_to')).toBe('2026-06-30');
      expect(q.get('due_from')).toBe('2026-07-01');
      expect(q.get('due_to')).toBe('2026-12-31');
    });
  });

  it('sends unread-only as a flag, and drops it again when unchecked', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText('Acme Corp');

    const box = screen.getByRole('checkbox', { name: /Unread only/ });
    await user.click(box);
    await waitFor(() => expect(lastListQuery(calls).get('unread')).toBe('true'));

    await user.click(box);
    // An empty value must remove the key rather than send `unread=`, which the
    // server would read as a present-but-blank filter.
    await waitFor(() => expect(lastListQuery(calls).has('unread')).toBe(false));
  });

  it('searches on blur without waiting for a submit', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText('Acme Corp');

    await user.type(screen.getByLabelText('Search'), '  Acme  ');
    await user.tab();
    // Trimmed: a trailing space pasted from a spreadsheet is not part of the term.
    await waitFor(() => expect(lastListQuery(calls).get('q')).toBe('Acme'));
  });

  it('searches on Enter, which is how the box is actually used', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText('Acme Corp');

    await user.type(screen.getByLabelText('Search'), 'Beta{Enter}');
    await waitFor(() => expect(lastListQuery(calls).get('q')).toBe('Beta'));
  });

  it('offers no clear-filters control until something is filtered', async () => {
    mockApi();
    renderPage();
    await screen.findAllByText('Acme Corp');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  /**
   * The tab and the sort are not filters: clearing "state = review" while
   * standing in the In-review tab must not also throw away the tab, or the
   * operator lands back on the full firm-wide list they had navigated out of.
   */
  it('clears the filters but keeps the tab and the sort', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage('/valuations?bucket=in_review&sort=created_at:desc&state=review&q=acme');
    await screen.findAllByText('Acme Corp');

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));

    await waitFor(() => {
      const q = lastListQuery(calls);
      expect(q.get('bucket')).toBe('in_review');
      expect(q.get('sort')).toBe('created_at:desc');
      expect(q.has('state')).toBe(false);
      expect(q.has('q')).toBe(false);
    });
    expect(screen.getByLabelText('Search')).toHaveValue('');
  });

  it('returns to the first page whenever a filter changes', async () => {
    const calls = mockApi({ total: 60 });
    const user = userEvent.setup();
    renderPage('/valuations?page=3');
    await screen.findAllByText('Acme Corp');

    await user.selectOptions(screen.getByLabelText('Filter by state'), 'review');
    // Page 3 of the old result set is not page 3 of the new one, and is often
    // past its end — the operator would see an empty list of matching rows.
    await waitFor(() => expect(lastListQuery(calls).get('page')).toBe('1'));
  });
});

describe('ValuationsPage — sorting', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('cycles a column ascending, descending, then off', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText('Acme Corp');
    // Re-queried each time: the reload blanks `data`, which unmounts the table
    // and its headers, so a reference held across a click is detached.
    const header = () => screen.getByRole('button', { name: 'Sort by Company' });

    await user.click(header());
    await waitFor(() => expect(lastListQuery(calls).get('sort')).toBe('company_name:asc'));

    await user.click(await screen.findByRole('button', { name: 'Sort by Company' }));
    await waitFor(() => expect(lastListQuery(calls).get('sort')).toBe('company_name:desc'));

    await user.click(await screen.findByRole('button', { name: 'Sort by Company' }));
    await waitFor(() => expect(lastListQuery(calls).has('sort')).toBe(false));
    expect(header()).toHaveTextContent(/^Company$/);
  });

  it('shows the direction arrow, and a priority number once a second column joins', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText('Acme Corp');

    await user.click(screen.getByRole('button', { name: 'Sort by Company' }));
    // One column sorted — a bare arrow, because there is no priority to state.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sort by Company' })).toHaveTextContent(/^Company↑$/),
    );

    // The newly clicked column becomes primary, so Company falls to second —
    // and once there is a priority to state, the button's own name states it,
    // because `aria-sort` has no vocabulary for "second key".
    await user.click(screen.getByRole('button', { name: 'Sort by Due' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sort by Due, sort priority 1 of 2' })).toHaveTextContent(
        /^Due↑1$/,
      ),
    );
    expect(screen.getByRole('button', { name: 'Sort by Company, sort priority 2 of 2' })).toHaveTextContent(
      /^Company↑2$/,
    );
  });

  // The sort state was carried by two glyphs and a digit inside a span, and the
  // button's fixed `aria-label` replaced them in the accessible name. So a
  // screen reader announced what the control *does* and never what the list is
  // ordered by — on the platform's primary index of every engagement. An arrow
  // character is not a status.
  it('reports each column’s sort state on the header itself', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText('Acme Corp');

    const header = (name: string) => screen.getByRole('columnheader', { name: new RegExp(`^${name}`) });

    // Nothing sorted: every sortable column says so explicitly. `none` rather
    // than an absent attribute — absent means "not sortable", which is a
    // different claim and the one the unsorted columns would have made.
    expect(header('Company')).toHaveAttribute('aria-sort', 'none');

    await user.click(screen.getByRole('button', { name: 'Sort by Company' }));
    await waitFor(() => expect(header('Company')).toHaveAttribute('aria-sort', 'ascending'));
    // The other columns stay 'none' — the attribute is per column, and a stale
    // 'ascending' left on a neighbour would name the wrong ordering.
    expect(header('Kind')).toHaveAttribute('aria-sort', 'none');

    await user.click(screen.getByRole('button', { name: 'Sort by Company' }));
    await waitFor(() => expect(header('Company')).toHaveAttribute('aria-sort', 'descending'));

    // Cycled off: back to 'none', not left describing an order no longer applied.
    await user.click(screen.getByRole('button', { name: 'Sort by Company' }));
    await waitFor(() => expect(header('Company')).toHaveAttribute('aria-sort', 'none'));
  });

  it('hides the arrow glyphs from assistive technology', async () => {
    // They are a second rendering of `aria-sort` now, not the only one. Left
    // exposed they are announced as "upwards arrow" beside the real state, or
    // as a bare digit that reads as part of the column name.
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText('Acme Corp');

    await user.click(screen.getByRole('button', { name: 'Sort by Company' }));
    const button = await screen.findByRole('button', { name: 'Sort by Company' });
    await waitFor(() => expect(button).toHaveTextContent(/^Company↑$/));
    const glyph = button.querySelector('span');
    expect(glyph).not.toBeNull();
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
  });

  it('reads a sort out of the URL onto the header, not only onto the arrow', async () => {
    mockApi();
    renderPage('/valuations?sort=due_date:desc');
    await screen.findAllByText('Acme Corp');
    expect(screen.getByRole('columnheader', { name: /^Due/ })).toHaveAttribute('aria-sort', 'descending');
  });

  it('returns to the first page when the sort changes', async () => {
    const calls = mockApi({ total: 60 });
    const user = userEvent.setup();
    renderPage('/valuations?page=2');
    await screen.findAllByText('Acme Corp');

    await user.click(screen.getByRole('button', { name: 'Sort by Created' }));
    await waitFor(() => expect(lastListQuery(calls).get('page')).toBe('1'));
  });

  it('reads a sort written into the URL by a shared link', async () => {
    mockApi();
    renderPage('/valuations?sort=due_date:desc');
    await screen.findAllByText('Acme Corp');
    expect(screen.getByRole('button', { name: 'Sort by Due' })).toHaveTextContent(/^Due↓$/);
  });
});

describe('ValuationsPage — exports', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // apiDownload drives an <a download> click through a blob URL.
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:test');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it.each([
    ['Export CSV', 'csv'],
    ['Export PDF', 'pdf'],
    ['Export Excel', 'xlsx'],
  ])('%s downloads the filtered set in that format', async (button, format) => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage('/valuations?bucket=in_review&state=review&sort=created_at:desc');
    await screen.findAllByText('Acme Corp');

    await user.click(screen.getByRole('button', { name: button }));

    await waitFor(() => {
      const dl = calls.find((c) => c.url.includes('/valuations/export'));
      expect(dl).toBeTruthy();
      const q = new URLSearchParams(dl!.url.split('?')[1]);
      // The export is of what is on screen: same filters, same tab, same order.
      expect(q.get('format')).toBe(format);
      expect(q.get('state')).toBe('review');
      expect(q.get('bucket')).toBe('in_review');
      expect(q.get('sort')).toBe('created_at:desc');
    });
  });

  it('reports a failed export instead of leaving the click unanswered', async () => {
    mockApi({ exportStatus: 500 });
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText('Acme Corp');

    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText('Export failed.')).toBeInTheDocument();
    // The list itself is untouched — only the download failed.
    expect(screen.getAllByText('Acme Corp').length).toBeGreaterThan(0);
  });
});

describe('ValuationsPage — pagination and empty states', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('offers no pager when everything fits on one page', async () => {
    mockApi({ total: 2 });
    renderPage();
    await screen.findAllByText('Acme Corp');
    expect(screen.queryByRole('button', { name: '← Previous' })).toBeNull();
  });

  it('walks forward and back, and disables the end it is standing on', async () => {
    const calls = mockApi({ total: 60 });
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText('Acme Corp');

    expect(screen.getByText(/Page 1 of 3 · 60 total/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '← Previous' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Next →' }));
    await waitFor(() => expect(lastListQuery(calls).get('page')).toBe('2'));

    await user.click(screen.getByRole('button', { name: '← Previous' }));
    await waitFor(() => expect(lastListQuery(calls).get('page')).toBe('1'));
  });

  it('stops at the last page', async () => {
    mockApi({ total: 60 });
    renderPage('/valuations?page=3');
    await screen.findAllByText('Acme Corp');
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
  });

  it('reads a page number the URL cannot mean as page one', async () => {
    const calls = mockApi({ total: 60 });
    renderPage('/valuations?page=notanumber');
    await screen.findAllByText('Acme Corp');
    expect(lastListQuery(calls).get('page')).toBe('1');
  });

  /**
   * "No valuations yet" invites a first engagement; "nothing matches" says the
   * list is filtered. Showing the onboarding invitation to an operator whose
   * filter simply excluded everything is how a populated firm looks empty.
   */
  it('distinguishes an empty firm from an over-narrow filter', async () => {
    mockApi({ rows: [], total: 0 });
    renderPage();
    expect(await screen.findByText('No valuations yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Start your first valuation/ })).toBeInTheDocument();
  });

  it('says nothing matches when a filter is what emptied the list', async () => {
    mockApi({ rows: [], total: 0 });
    renderPage('/valuations?state=review');
    expect(await screen.findByText('Nothing matches these filters')).toBeInTheDocument();
    expect(screen.getByText('Try clearing a filter.')).toBeInTheDocument();
  });

  it('says nothing matches when only a tab is narrowing it', async () => {
    mockApi({ rows: [], total: 0 });
    renderPage('/valuations?bucket=in_review');
    expect(await screen.findByText('Nothing matches these filters')).toBeInTheDocument();
  });

  it('reports a failed load rather than rendering an empty worklist', async () => {
    mockApi({ listStatus: 500 });
    renderPage();
    expect(await screen.findByText('Could not load valuations.')).toBeInTheDocument();
    expect(screen.queryByText('No valuations yet')).toBeNull();
  });
});

describe('ValuationsPage — bulk failures', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('names the first failure when a batch only partly applies', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/valuations/bulk-action')) {
        return jsonResponse({
          results: [
            { id: VAL_A, ok: true, state: 'review' },
            { id: VAL_B, ok: false, error: 'Valuation is published' },
          ],
          succeeded: 1,
          failed: 1,
        });
      }
      if (path.includes('/valuations/counts')) return jsonResponse({ counts: { all: 2 } });
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
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByLabelText('Select all on page'));
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByText('1 succeeded, 1 failed (Valuation is published).')).toBeInTheDocument();
  });

  it('reports a refused batch and leaves the selection in place to retry', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/valuations/bulk-action')) {
        return jsonResponse({ status: 403, detail: 'You cannot change these valuations' }, 403);
      }
      if (path.includes('/valuations/counts')) return jsonResponse({ counts: { all: 1 } });
      if (path.includes('/users/options')) return jsonResponse({ options: [] });
      if (path.includes('/partners')) return jsonResponse({ partners: [] });
      if (path.includes('/valuations?')) {
        return jsonResponse({ valuations: [row(VAL_A, 'Acme Corp')], page: 1, per_page: 25, total: 1 });
      }
      return jsonResponse({});
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByLabelText('Select all on page'));
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByText('You cannot change these valuations')).toBeInTheDocument();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('assigns a named reviewer, not only "unassign"', async () => {
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url);
      if (path.includes('/valuations/bulk-action')) {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ results: [{ id: VAL_A, ok: true }], succeeded: 1, failed: 0 });
      }
      if (path.includes('/valuations/counts')) return jsonResponse({ counts: { all: 1 } });
      if (path.includes('/users/options')) {
        return jsonResponse({
          options: [{ id: REVIEWER_ID, first_name: 'Rita', last_name: 'Reviewer', email: 'r@n409.example' }],
        });
      }
      if (path.includes('/partners')) return jsonResponse({ partners: [] });
      if (path.includes('/valuations?')) {
        return jsonResponse({ valuations: [row(VAL_A, 'Acme Corp')], page: 1, per_page: 25, total: 1 });
      }
      return jsonResponse({});
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByLabelText('Select all on page'));
    await user.selectOptions(screen.getByLabelText('Bulk action'), 'assign_reviewer');
    await user.selectOptions(await screen.findByLabelText('Bulk reviewer'), REVIEWER_ID);
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(bodies).toEqual([
        { action: 'assign_reviewer', valuation_ids: [VAL_A], params: { reviewer_id: REVIEWER_ID } },
      ]),
    );
  });

  it('reports a failed export of the checked rows on the bulk bar, not the page', async () => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:test');
    globalThis.URL.revokeObjectURL = vi.fn();
    mockApi({ exportStatus: 502 });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByLabelText('Select all on page'));
    await user.click(screen.getByRole('button', { name: 'Export selected PDF' }));

    expect(await screen.findByText('Export of selected valuations failed.')).toBeInTheDocument();
    expect(screen.queryByText('Export failed.')).toBeNull();
  });

  it('clears the selection, and the bulk bar with it', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByLabelText('Select all on page'));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText('2 selected')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  });
});
