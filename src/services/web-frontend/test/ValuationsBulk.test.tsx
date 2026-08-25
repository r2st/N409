import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ValuationsPage } from '../src/pages/ValuationsPage';

/** Improvement 5 — checkbox selection + bulk action dropdown + bulk export. */

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

function mockApi(opts: { rosterStatus?: number } = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ url: path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.includes('/valuations/counts')) {
      return jsonResponse({ counts: { all: 2, open: 0, in_review: 0, drafted: 0, published: 0, closed: 2 } });
    }
    if (path.includes('/valuations/bulk-action')) {
      return jsonResponse({
        results: [
          { id: VAL_A, ok: true, state: 'review' },
          { id: VAL_B, ok: true, state: 'review' },
        ],
        succeeded: 2,
        failed: 0,
      });
    }
    if (path.includes('/valuations/export')) {
      return new Response(new Blob(['id\r\n']), {
        status: 200,
        headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="sel.csv"' },
      });
    }
    if (path.includes('/users/options')) {
      // The roster loads separately; failing it alone is the case under test.
      if (opts.rosterStatus) return jsonResponse({ detail: 'No' }, opts.rosterStatus);
      return jsonResponse({ options: [] });
    }
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

function renderPage() {
  return render(
    <MemoryRouter>
      <ValuationsPage />
    </MemoryRouter>,
  );
}

describe('ValuationsPage bulk operations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the bulk-action contract for a batch status change', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click((await screen.findAllByLabelText('Select Acme Corp'))[0]!);
    await user.click(screen.getAllByLabelText('Select Beta LLC')[0]!);
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    // default action is "Set state"; pick the target state and apply
    await user.selectOptions(screen.getByLabelText('Bulk target state'), 'review');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/valuations/bulk-action'));
      expect(post).toBeTruthy();
      expect(post!.body).toEqual({
        action: 'set_state',
        valuation_ids: [VAL_A, VAL_B],
        params: { state: 'review' },
      });
    });
    expect(await screen.findByText('Applied to 2 valuations.')).toBeInTheDocument();
  });

  it('sends reviewer assignment through params', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click((await screen.findAllByLabelText('Select Acme Corp'))[0]!);
    await user.selectOptions(screen.getByLabelText('Bulk action'), 'assign_reviewer');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/valuations/bulk-action'));
      expect(post!.body).toEqual({
        action: 'assign_reviewer',
        valuation_ids: [VAL_A],
        params: { reviewer_id: null },
      });
    });
  });

  it('select-all toggles every row on the page', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByLabelText('Select all on page'));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Select all on page'));
    expect(screen.queryByText('2 selected')).not.toBeInTheDocument();
  });

  it('exports exactly the checked rows via the ids filter', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    // apiDownload drives an <a download> click through a blob URL
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:test');
    globalThis.URL.revokeObjectURL = vi.fn();
    renderPage();

    await user.click((await screen.findAllByLabelText('Select Acme Corp'))[0]!);
    await user.click(screen.getByRole('button', { name: 'Export selected CSV' }));

    await waitFor(() => {
      const dl = calls.find((c) => c.url.includes('/valuations/export'));
      expect(dl).toBeTruthy();
      expect(decodeURIComponent(dl!.url)).toContain(`ids=${VAL_A}`);
      expect(dl!.url).toContain('format=csv');
    });
  });
  /*
   * `/users/options` was loaded with `.catch(() => {})`, so a failure left the
   * roster at `[]` — indistinguishable from a firm with no reviewers, which is
   * what the test above deliberately exercises. The bulk bar acts on that
   * difference: `assign_reviewer` sends `bulkReviewer.trim() || null`, and
   * `null` means *unassign*. With no options to pick, a control labelled
   * "Assign reviewer" applied a bulk unassignment across every selected
   * engagement, and the only thing that had gone wrong was an unreported GET.
   */
  describe('when the reviewer roster fails to load', () => {
    it('will not turn a bulk assign into a bulk unassign', async () => {
      const calls = mockApi({ rosterStatus: 503 });
      const user = userEvent.setup();
      renderPage();

      await user.click((await screen.findAllByLabelText('Select Acme Corp'))[0]!);
      await user.selectOptions(screen.getByLabelText('Bulk action'), 'assign_reviewer');

      expect(screen.getByLabelText('Bulk reviewer')).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
      await screen.findByText(/reviewer list could not be loaded/);
      expect(calls.some((c) => c.url.includes('/valuations/bulk-action'))).toBe(false);
    });

    it('leaves the bulk actions that do not read the roster alone', async () => {
      // The roster is missing, not the whole bar: setting state in bulk never
      // consulted it and must stay usable.
      const calls = mockApi({ rosterStatus: 503 });
      const user = userEvent.setup();
      renderPage();

      await user.click((await screen.findAllByLabelText('Select Acme Corp'))[0]!);
      await user.selectOptions(screen.getByLabelText('Bulk action'), 'set_state');
      await user.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => expect(calls.some((c) => c.url.includes('/valuations/bulk-action'))).toBe(true));
    });

    it('says nothing and blocks nothing when the roster loads empty', async () => {
      /*
       * The other half, and the one that keeps this from being a blanket ban:
       * a firm really can have no reviewers yet, and "Unassign" is then a
       * legitimate thing to apply. A 200 with an empty list must behave exactly
       * as it did before.
       */
      mockApi();
      const user = userEvent.setup();
      renderPage();

      await user.click((await screen.findAllByLabelText('Select Acme Corp'))[0]!);
      await user.selectOptions(screen.getByLabelText('Bulk action'), 'assign_reviewer');

      expect(screen.getByLabelText('Bulk reviewer')).not.toBeDisabled();
      expect(screen.getByRole('button', { name: 'Apply' })).not.toBeDisabled();
      expect(screen.queryByText(/could not be loaded/)).toBeNull();
    });
  });
});
