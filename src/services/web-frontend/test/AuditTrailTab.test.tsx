import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { AuditTrailTab } from '../src/pages/valuation/AuditTrailTab';
import type { Valuation } from '../src/lib/types';

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'review',
  company_name: 'Acme',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const PARAMS_ENTRY = {
  id: '01JAUDITAAAAAAAAAAAAAAAAAA',
  seq: '2',
  type: 'params_updated',
  label: 'Methodology parameters changed',
  category: 'methodology',
  severity: 'critical' as const,
  visibility: 'internal',
  actor_type: 'human',
  actor_id: 'u2',
  source: 'api',
  changes: [{ field: 'dlom', from: '0.20', to: '0.22' }],
  summary: 'DLOM: 0.20 → 0.22',
  occurred_at: '2026-07-02T10:00:00Z',
};

const CREATED_ENTRY = {
  id: '01JAUDITBBBBBBBBBBBBBBBBBB',
  seq: '1',
  type: 'valuation_created',
  label: 'Valuation created',
  category: 'lifecycle',
  severity: 'notice' as const,
  visibility: 'client',
  actor_type: 'human',
  actor_id: 'u1',
  source: 'api',
  changes: [],
  summary: '',
  occurred_at: '2026-07-01T09:00:00Z',
};

const RESPONSE = {
  entries: [PARAMS_ENTRY, CREATED_ENTRY],
  summary: {
    total: 2,
    by_category: { methodology: 1, lifecycle: 1 },
    by_severity: { critical: 1, notice: 1 },
    critical_changes: 1,
    changed_fields: ['dlom'],
    first_at: '2026-07-01T09:00:00Z',
    last_at: '2026-07-02T10:00:00Z',
  },
  page: 1,
  per_page: 25,
  total: 2,
  includes_internal: true,
  truncated: false,
};

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/audit-trail']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/audit-trail" element={<AuditTrailTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Every URL fetch has been called with, in order. */
const requestedUrls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((call) => String(call[0]));

describe('AuditTrailTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the roll-up summary', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(RESPONSE));
    renderTab();

    const summary = await screen.findByTestId('audit-summary');
    expect(summary).toHaveTextContent('Recorded events');
    expect(summary).toHaveTextContent('Value-moving');
    expect(summary).toHaveTextContent('Fields changed');
  });

  it('lists each event with its label, severity and category', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(RESPONSE));
    renderTab();

    const entries = await screen.findByTestId('audit-entries');
    expect(entries).toHaveTextContent('Methodology parameters changed');
    expect(entries).toHaveTextContent('critical');
    expect(entries).toHaveTextContent('methodology');
    expect(entries).toHaveTextContent('Valuation created');
  });

  it('shows the before and after of each field change', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(RESPONSE));
    renderTab();

    const changes = await screen.findByTestId('change-list');
    expect(changes).toHaveTextContent('dlom');
    expect(changes).toHaveTextContent('0.20');
    expect(changes).toHaveTextContent('0.22');
  });

  it('renders no change table for an event that changed nothing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ ...RESPONSE, entries: [CREATED_ENTRY], total: 1 }),
    );
    renderTab();

    await screen.findByTestId('audit-entries');
    expect(screen.queryByTestId('change-list')).not.toBeInTheDocument();
  });

  it('tells a client that internal events are excluded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ...RESPONSE, includes_internal: false }));
    renderTab();
    expect(await screen.findByText(/Internal analyst working notes/)).toBeInTheDocument();
  });

  it('does not show that notice to ops', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(RESPONSE));
    renderTab();
    await screen.findByTestId('audit-entries');
    expect(screen.queryByText(/Internal analyst working notes/)).not.toBeInTheDocument();
  });

  it('warns when the trail was truncated', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ...RESPONSE, truncated: true }));
    renderTab();
    expect(await screen.findByText(/oldest events are omitted/)).toBeInTheDocument();
  });

  it('sends the chosen category filter to the API and resets to page 1', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(RESPONSE));
    renderTab();
    await screen.findByTestId('audit-entries');

    await userEvent.selectOptions(screen.getByLabelText(/Category/), 'methodology');

    await waitFor(() => {
      const last = requestedUrls(spy).at(-1)!;
      expect(last).toContain('category=methodology');
      expect(last).toContain('page=1');
    });
  });

  it('sends the chosen severity filter to the API', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(RESPONSE));
    renderTab();
    await screen.findByTestId('audit-entries');

    await userEvent.selectOptions(screen.getByLabelText(/Severity/), 'critical');

    await waitFor(() => {
      expect(requestedUrls(spy).at(-1)!).toContain('severity=critical');
    });
  });

  it('hides pagination when everything fits on one page', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(RESPONSE));
    renderTab();
    await screen.findByTestId('audit-entries');
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });

  it('pages forward when there is more than one page', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ...RESPONSE, total: 60 }));
    renderTab();
    await screen.findByTestId('audit-entries');

    const next = screen.getByRole('button', { name: 'Next' });
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(next);

    await waitFor(() => {
      expect(requestedUrls(spy).at(-1)!).toContain('page=2');
    });
  });

  it('shows an empty state when no events match', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ...RESPONSE, entries: [], total: 0 }));
    renderTab();
    expect(await screen.findByText(/No events match these filters/)).toBeInTheDocument();
  });

  it('surfaces API errors', async () => {
    // `setNotFoundHandler` sends a title and no detail, so this used to assert
    // that the reader was shown the words "Not Found" — the RFC 9457 reason
    // phrase, which the spec asks to be identical on every occurrence and is
    // therefore the one string in the body that is not about their request.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ title: 'Not Found', status: 404 }, 404));
    renderTab();
    const note = await screen.findByRole('alert');
    expect(note).not.toHaveTextContent('Not Found');
    expect(note).toHaveTextContent(/404/);
    expect(note).toHaveTextContent(/fault on our side/i);
  });

  it('offers a CSV download of the change log', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(RESPONSE));
    renderTab();
    await screen.findByTestId('audit-entries');
    expect(screen.getByRole('button', { name: /Download change log/ })).toBeInTheDocument();
  });
  /*
   * `apiDownload` fetches the file itself — the endpoint is bearer-
   * authenticated, so there is no `<a href>` and no browser failure UI behind
   * the button — and it threw into `.catch(() => {})`. A click that fails then
   * leaves the page byte-identical to the one before it, which is also what a
   * dead button looks like.
   */
  it('says so when the CSV export fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('audit-trail.csv')) return jsonResponse({ detail: 'nope' }, 503);
      return jsonResponse(RESPONSE);
    });
    const user = userEvent.setup();
    renderTab();
    await screen.findByTestId('audit-entries');

    await user.click(screen.getByRole('button', { name: /Download change log/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/download did not start/i);
  });

  it('says nothing when the export succeeds', async () => {
    // The other half — the message must be earned, not permanent.
    //
    // jsdom implements neither `URL.createObjectURL` nor `revokeObjectURL`, and
    // `apiDownload` calls both on the *success* path — so without these stubs a
    // successful download throws exactly where a failed one does and this test
    // would pass against a component that never distinguished them.
    // Assigned rather than spied: jsdom does not define these at all, and
    // `vi.spyOn` refuses a property that does not exist.
    Object.assign(URL, { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('audit-trail.csv'))
        return new Response('a,b\n1,2', { status: 200, headers: { 'content-type': 'text/csv' } });
      return jsonResponse(RESPONSE);
    });
    const user = userEvent.setup();
    renderTab();
    await screen.findByTestId('audit-entries');

    await user.click(screen.getByRole('button', { name: /Download change log/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Download change log/ })).not.toBeDisabled(),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  /**
   * A file that stopped short and looked complete.
   *
   * The route has set `x-export-truncated` on this download since the cap was
   * given a voice, and `apiDownload` has returned it — but `useDownload` did
   * not expose it, so the value died in the hook. The screen's own truncation
   * banner ("warns when the trail was truncated", above) reads `data.truncated`
   * from the JSON view and says nothing about the file, and the two caps are
   * not the same event: the filters that fit the view can still overflow the
   * export. So a change log missing its oldest entries — the end that answers
   * "when did this first move" — downloaded with nothing to distinguish it from
   * the whole history.
   */
  it('says so when the downloaded change log was capped', async () => {
    Object.assign(URL, { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('audit-trail.csv'))
        return new Response('a,b\n1,2', {
          status: 200,
          headers: { 'content-type': 'text/csv', 'x-export-truncated': 'true' },
        });
      // The JSON view is *not* truncated: this must be the file's own notice,
      // not the banner that was already there.
      return jsonResponse({ ...RESPONSE, truncated: false });
    });
    const user = userEvent.setup();
    renderTab();
    await screen.findByTestId('audit-entries');

    await user.click(screen.getByRole('button', { name: /Download change log/ }));
    expect(await screen.findByText(/oldest entries are missing/i)).toBeInTheDocument();
  });

  it('says nothing about a cap when the download was complete', async () => {
    // The other half: the notice has to be earned by the header.
    Object.assign(URL, { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('audit-trail.csv'))
        return new Response('a,b\n1,2', {
          status: 200,
          headers: { 'content-type': 'text/csv', 'x-export-truncated': 'false' },
        });
      return jsonResponse({ ...RESPONSE, truncated: false });
    });
    const user = userEvent.setup();
    renderTab();
    await screen.findByTestId('audit-entries');

    await user.click(screen.getByRole('button', { name: /Download change log/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Download change log/ })).not.toBeDisabled(),
    );
    expect(screen.queryByText(/oldest entries are missing/i)).toBeNull();
  });

  /**
   * The name the file lands under.
   *
   * This button used to run on a second, private fetch-and-anchor helper that
   * read no headers at all, so `content-disposition` was decided by the server
   * and then thrown away. The route names the file after the company; the
   * component's own guess is only a fallback for a response that says nothing.
   */
  it('saves the change log under the name the server chose', async () => {
    Object.assign(URL, { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} });
    const saved: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download);
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('audit-trail.csv'))
        return new Response('a,b\n1,2', {
          status: 200,
          headers: {
            'content-type': 'text/csv',
            'content-disposition':
              'attachment; filename="change-log-_ngstr_m Robotics.csv"; filename*=UTF-8\'\'change-log-%C3%85ngstr%C3%B6m%20Robotics.csv',
          },
        });
      return jsonResponse(RESPONSE);
    });
    const user = userEvent.setup();
    renderTab();
    await screen.findByTestId('audit-entries');

    await user.click(screen.getByRole('button', { name: /Download change log/ }));
    await waitFor(() => expect(saved).toHaveLength(1));
    // Not the ASCII half, which is the same name with its letters removed.
    expect(saved[0]).toBe('change-log-Ångström Robotics.csv');
    click.mockRestore();
  });
});
