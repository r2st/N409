import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminRetentionPage } from '../src/pages/AdminRetentionPage';

const POLICIES = [
  { data_type: 'valuations', archive_after_days: 365, retention_days: 2555, enabled: true },
  { data_type: 'documents', archive_after_days: null, retention_days: null, enabled: false },
];

const HOLDS = [
  {
    id: 'h-active',
    scope: 'valuation',
    reference_id: '01JVAL0000000000000000001',
    reason: 'IRS audit 2026',
    active: true,
    placed_at: '2026-06-01T00:00:00Z',
  },
  {
    id: 'h-released',
    scope: 'global',
    reference_id: null,
    reason: 'litigation hold, lifted',
    active: false,
    placed_at: '2026-01-01T00:00:00Z',
  },
];

const ACTIONS = [
  {
    id: 'a1',
    data_type: 'valuations',
    action: 'archived',
    reference_id: '01JVAL0000000000000000009',
    created_at: '2026-07-01T10:00:00Z',
  },
  {
    id: 'a2',
    data_type: 'documents',
    action: 'skipped_hold',
    reference_id: '01JDOC0000000000000000001',
    created_at: '2026-07-01T10:00:01Z',
  },
];

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Error', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

/** The three GETs the page loads in parallel; writes go to `onWrite`. */
function mockApi(onWrite?: (path: string, init: RequestInit) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if ((init?.method ?? 'GET') !== 'GET') {
      if (onWrite) return onWrite(path, init!);
      return jsonResponse({ result: { archived: 0, skipped_hold: 0 } });
    }
    if (path.includes('/retention/policies')) return jsonResponse({ policies: POLICIES });
    if (path.includes('/retention/holds')) return jsonResponse({ holds: HOLDS });
    if (path.includes('/retention/actions')) return jsonResponse({ actions: ACTIONS });
    throw new Error(`unexpected fetch ${path}`);
  });
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <AdminRetentionPage />
    </MemoryRouter>,
  );

/** The policies table repeats each data type in the audit log below, so a row
 * is identified by being the one that carries the editable windows. */
const policyRow = (dataType: string) =>
  screen
    .getAllByText(dataType)
    .map((el) => el.closest('tr'))
    .find((tr) => tr?.querySelector('input[type="number"]'))!;

const loaded = () => screen.findByRole('button', { name: /Run archival sweep/i });

describe('AdminRetentionPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists each policy with its windows, showing an unset window as blank not zero', async () => {
    mockApi();
    renderPage();
    await loaded();

    const configured = within(policyRow('valuations'));
    expect(configured.getByDisplayValue('365')).toBeInTheDocument();
    expect(configured.getByDisplayValue('2555')).toBeInTheDocument();
    expect(configured.getByRole('checkbox')).toBeChecked();

    // A null window means "never" — rendering it as 0 would read as "archive
    // immediately", the opposite of what is stored.
    const unset = within(policyRow('documents'));
    const inputs = unset.getAllByRole('spinbutton');
    expect(inputs[0]).toHaveValue(null);
    expect(inputs[1]).toHaveValue(null);
    expect(unset.getByRole('checkbox')).not.toBeChecked();
  });

  it('reports a failed load rather than spinning forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    renderPage();
    await screen.findByText(/Could not load retention settings/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('PUTs an edited policy under its data type', async () => {
    const writes: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
    mockApi((path, init) => {
      writes.push({
        path,
        method: init.method ?? 'GET',
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return jsonResponse({ ok: true });
    });
    renderPage();
    await loaded();

    const row = within(policyRow('valuations'));
    const archiveAfter = row.getByDisplayValue('365');
    await userEvent.clear(archiveAfter);
    await userEvent.type(archiveAfter, '180');
    await userEvent.click(row.getByRole('button', { name: /^Save the .* retention policy$/ }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.method).toBe('PUT');
    expect(writes[0]!.path).toContain('/admin/retention/policies/valuations');
    expect(writes[0]!.body).toEqual({
      archive_after_days: 180,
      retention_days: 2555,
      enabled: true,
    });
  });

  it('clears a window back to null when the field is emptied', async () => {
    const writes: Array<Record<string, unknown>> = [];
    mockApi((_path, init) => {
      writes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return jsonResponse({ ok: true });
    });
    renderPage();
    await loaded();

    const row = within(policyRow('valuations'));
    await userEvent.clear(row.getByDisplayValue('2555'));
    await userEvent.click(row.getByRole('checkbox'));
    await userEvent.click(row.getByRole('button', { name: /^Save the .* retention policy$/ }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.retention_days).toBeNull();
    expect(writes[0]!.enabled).toBe(false);
  });

  it('surfaces a refused policy save', async () => {
    mockApi(() => problem(422, 'retention must exceed the archive window'));
    renderPage();
    await loaded();

    await userEvent.click(
      within(policyRow('valuations')).getByRole('button', { name: /^Save the .* retention policy$/ }),
    );
    await screen.findByText('retention must exceed the archive window');
    // The table survives — the error is a banner, not a replacement.
    expect(policyRow('documents')).toBeInTheDocument();
  });

  it('places a hold with the trimmed reason and resets the form', async () => {
    const writes: Array<Record<string, unknown>> = [];
    mockApi((_path, init) => {
      writes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return jsonResponse({ ok: true }, 201);
    });
    renderPage();
    await loaded();

    await userEvent.type(screen.getByPlaceholderText('valuation / user id'), ' 01JVAL999 ');
    await userEvent.type(screen.getByPlaceholderText(/IRS audit/), '  SEC inquiry  ');
    await userEvent.click(screen.getByRole('button', { name: /Place hold/i }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!).toEqual({
      scope: 'valuation',
      reference_id: '01JVAL999',
      reason: 'SEC inquiry',
    });
    await waitFor(() => expect(screen.getByPlaceholderText(/IRS audit/)).toHaveValue(''));
  });

  it('drops the reference field entirely for a global hold and sends a null id', async () => {
    const writes: Array<Record<string, unknown>> = [];
    mockApi((_path, init) => {
      writes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return jsonResponse({ ok: true }, 201);
    });
    renderPage();
    await loaded();

    // Typing a reference then switching to global must not smuggle it through:
    // a global hold that carries a valuation id would be silently narrowed.
    await userEvent.type(screen.getByPlaceholderText('valuation / user id'), '01JVAL999');
    await userEvent.selectOptions(screen.getByLabelText('Hold scope'), 'global');
    expect(screen.queryByPlaceholderText('valuation / user id')).not.toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText(/IRS audit/), 'company-wide');
    await userEvent.click(screen.getByRole('button', { name: /Place hold/i }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!).toEqual({ scope: 'global', reference_id: null, reason: 'company-wide' });
  });

  it('sends a null reference when the field is left blank on a scoped hold', async () => {
    const writes: Array<Record<string, unknown>> = [];
    mockApi((_path, init) => {
      writes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return jsonResponse({ ok: true }, 201);
    });
    renderPage();
    await loaded();

    await userEvent.selectOptions(screen.getByLabelText('Hold scope'), 'user');
    await userEvent.type(screen.getByPlaceholderText(/IRS audit/), 'no id to hand');
    await userEvent.click(screen.getByRole('button', { name: /Place hold/i }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!).toEqual({ scope: 'user', reference_id: null, reason: 'no id to hand' });
  });

  it('will not place a hold without a reason', async () => {
    mockApi();
    renderPage();
    await loaded();

    expect(screen.getByRole('button', { name: /Place hold/i })).toBeDisabled();
    // Whitespace is not a reason.
    await userEvent.type(screen.getByPlaceholderText(/IRS audit/), '   ');
    expect(screen.getByRole('button', { name: /Place hold/i })).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/IRS audit/), 'audit');
    expect(screen.getByRole('button', { name: /Place hold/i })).toBeEnabled();
  });

  it('surfaces a refused hold', async () => {
    mockApi(() => problem(404, 'no such valuation'));
    renderPage();
    await loaded();

    await userEvent.type(screen.getByPlaceholderText(/IRS audit/), 'audit');
    await userEvent.click(screen.getByRole('button', { name: /Place hold/i }));
    await screen.findByText('no such valuation');
  });

  it('offers release only on an active hold', async () => {
    mockApi();
    renderPage();
    await screen.findByText('IRS audit 2026');

    const active = screen.getByText('IRS audit 2026').closest('tr')!;
    expect(within(active).getByRole('button', { name: 'Release' })).toBeInTheDocument();
    expect(active).toHaveTextContent('Active');
    // The scope and its reference are both legible on the row.
    expect(active).toHaveTextContent('valuation · 01JVAL0000000000000000001');

    const released = screen.getByText('litigation hold, lifted').closest('tr')!;
    expect(within(released).queryByRole('button', { name: 'Release' })).not.toBeInTheDocument();
    expect(released).toHaveTextContent('Released');
  });

  it('releases a hold by id', async () => {
    const writes: string[] = [];
    mockApi((path, init) => {
      writes.push(`${init.method} ${path}`);
      return jsonResponse({ ok: true });
    });
    renderPage();
    await screen.findByText('IRS audit 2026');

    const active = screen.getByText('IRS audit 2026').closest('tr')!;
    await userEvent.click(within(active).getByRole('button', { name: 'Release' }));
    await waitFor(() => expect(writes).toEqual(['POST /api/v1/admin/retention/holds/h-active/release']));
  });

  it('reports a refused release instead of dropping it on the floor', async () => {
    // Regression: the release path had no catch at all, so a rejected release
    // left the hold in place with nothing on screen to say so.
    mockApi(() => problem(409, 'hold is enforced by a court order'));
    renderPage();
    await screen.findByText('IRS audit 2026');

    const active = screen.getByText('IRS audit 2026').closest('tr')!;
    await userEvent.click(within(active).getByRole('button', { name: 'Release' }));
    await screen.findByText('hold is enforced by a court order');
  });

  it('reports the sweep result', async () => {
    mockApi(() => jsonResponse({ result: { archived: 12, skipped_hold: 3 } }));
    renderPage();
    await loaded();

    await userEvent.click(screen.getByRole('button', { name: /Run archival sweep/i }));
    await screen.findByText('Sweep complete: 12 archived, 3 held.');
  });

  it('reports a failed sweep rather than reading as a no-op success', async () => {
    // Regression: the sweep path had no catch either — a failed sweep looked
    // exactly like a sweep that found nothing to archive.
    mockApi(() => problem(503, 'archival storage unavailable'));
    renderPage();
    await loaded();

    await userEvent.click(screen.getByRole('button', { name: /Run archival sweep/i }));
    await screen.findByText('archival storage unavailable');
    expect(screen.queryByText(/Sweep complete/)).not.toBeInTheDocument();
  });

  it('renders the audit log, distinguishing an archive from a skip', async () => {
    mockApi();
    renderPage();
    await screen.findByText('archived');

    const skipped = screen.getByText('skipped_hold');
    expect(skipped).toBeInTheDocument();
    // The two are styled apart: a skip is the one an auditor has to explain.
    expect(skipped.className).toContain('amber');
    expect(screen.getByText('archived').className).not.toContain('amber');
  });

  it('says the log is empty rather than rendering an empty list', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/retention/policies')) return jsonResponse({ policies: POLICIES });
      if (path.includes('/retention/holds')) return jsonResponse({ holds: [] });
      return jsonResponse({ actions: [] });
    });
    renderPage();
    await screen.findByText(/No retention actions recorded yet/i);
  });

  it('caps the audit log at fifty entries so one sweep cannot flood the page', async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      id: `a${i}`,
      data_type: 'valuations',
      action: 'archived',
      reference_id: `ref-${i}`,
      created_at: '2026-07-01T10:00:00Z',
    }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/retention/policies')) return jsonResponse({ policies: POLICIES });
      if (path.includes('/retention/holds')) return jsonResponse({ holds: [] });
      return jsonResponse({ actions: many });
    });
    renderPage();
    await screen.findByText('ref-0');
    expect(screen.getAllByText('archived')).toHaveLength(50);
    expect(screen.queryByText('ref-50')).not.toBeInTheDocument();
  });

  /**
   * Every action on this page is a write followed by a full three-endpoint
   * reload, and none of them used to render anything in between. A click that
   * produces no visible change reads as a click that did not land, so the
   * honest response is to click again — which on this screen means running the
   * platform-wide archival sweep twice, or releasing a legal hold that the
   * operator believed was still held.
   */
  describe('while a write is in flight', () => {
    /**
     * Holds every write open until `release()` is called, so the in-flight
     * frame can actually be asserted on rather than raced against.
     */
    function gatedWrites() {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      let writes = 0;
      // Not `mockApi`: its write hook is synchronous and so cannot hold a
      // request open, which is the entire mechanism under test here.
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const path = String(url);
        if ((init?.method ?? 'GET') !== 'GET') {
          writes += 1;
          await gate;
          return jsonResponse({ result: { archived: 1, skipped_hold: 0 } });
        }
        if (path.includes('/retention/policies')) return jsonResponse({ policies: POLICIES });
        if (path.includes('/retention/holds')) return jsonResponse({ holds: HOLDS });
        return jsonResponse({ actions: ACTIONS });
      });
      return { release: () => open(), writeCount: () => writes };
    }

    it('says the sweep is running and refuses to start a second one', async () => {
      const { release, writeCount } = gatedWrites();
      renderPage();
      await loaded();

      await userEvent.click(screen.getByRole('button', { name: /Run archival sweep/i }));
      const running = await screen.findByRole('button', { name: /Running sweep…/i });
      expect(running).toBeDisabled();

      // The whole point: a second press during the sweep must not reach the API.
      await userEvent.click(running);
      expect(writeCount()).toBe(1);

      release();
      await screen.findByRole('button', { name: /Run archival sweep/i });
    });

    it('names the row being saved and leaves the other rows alone', async () => {
      const { release } = gatedWrites();
      renderPage();
      await loaded();

      await userEvent.click(
        within(policyRow('valuations')).getByRole('button', { name: /Save the valuations/i }),
      );
      expect(within(policyRow('valuations')).getByText('Saving…')).toBeInTheDocument();
      // The sibling row still reads "Save" — only the pressed control goes
      // quiet — but it is disabled, because the write it would race with is
      // going to reload the table underneath it.
      const sibling = within(policyRow('documents')).getByRole('button', { name: /Save the documents/i });
      expect(sibling).toHaveTextContent('Save');
      expect(sibling).toBeDisabled();

      release();
      await waitFor(() => expect(within(policyRow('valuations')).getByText('Save')).toBeInTheDocument());
    });

    it('says a hold is being placed', async () => {
      const { release } = gatedWrites();
      renderPage();
      await loaded();

      await userEvent.type(screen.getByPlaceholderText(/IRS audit 2026/i), 'SEC inquiry');
      await userEvent.click(screen.getByRole('button', { name: /^Place hold$/i }));
      expect(await screen.findByRole('button', { name: /Placing…/i })).toBeDisabled();

      release();
      await screen.findByRole('button', { name: /^Place hold$/i });
    });

    it('says a hold is being released, and only that hold', async () => {
      const { release, writeCount } = gatedWrites();
      renderPage();
      await loaded();

      const releaseButton = screen.getByRole('button', { name: /^Release$/i });
      await userEvent.click(releaseButton);
      const releasing = await screen.findByRole('button', { name: /Releasing…/i });
      expect(releasing).toBeDisabled();
      // Releasing a legal hold is the click on this page least safe to repeat.
      await userEvent.click(releasing);
      expect(writeCount()).toBe(1);

      release();
      await screen.findByRole('button', { name: /^Release$/i });
    });
  });
});
