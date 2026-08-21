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

/**
 * The withdrawn list. Default is empty: most of this file is about policies,
 * holds and the log, and a section that always had a row in it would make
 * every "Restore" query in those tests ambiguous.
 */
const RETIRED: { valuations: unknown[]; total: number } = { valuations: [], total: 0 };

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

/** The four GETs the page loads in parallel; writes go to `onWrite`. */
function mockApi(onWrite?: (path: string, init: RequestInit) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if ((init?.method ?? 'GET') !== 'GET') {
      if (onWrite) return onWrite(path, init!);
      return jsonResponse({ result: { archived: 0, skipped_hold: 0 } });
    }
    if (path.includes('/retention/policies')) return jsonResponse({ policies: POLICIES });
    if (path.includes('/retention/holds')) return jsonResponse({ holds: HOLDS });
    if (path.includes('/retention/valuations/retired')) return jsonResponse(RETIRED);
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

  it('names an unconfigured policy table instead of leaving four headers over nothing', async () => {
    // No policies at all means nothing is ever archived or purged, which on a
    // retention screen is a finding — and indistinguishable, as a bare header
    // row, from a table that failed to render.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/retention/policies')) return jsonResponse({ policies: [] });
      if (path.includes('/retention/holds')) return jsonResponse({ holds: [] });
      if (path.includes('/retention/valuations/retired')) return jsonResponse(RETIRED);
      return jsonResponse({ actions: [] });
    });
    renderPage();
    await loaded();

    expect(
      screen.getByText(/No retention policies are configured. Nothing is being archived or purged./),
    ).toBeInTheDocument();
  });

  it('says the log is empty rather than rendering an empty list', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/retention/policies')) return jsonResponse({ policies: POLICIES });
      if (path.includes('/retention/holds')) return jsonResponse({ holds: [] });
      if (path.includes('/retention/valuations/retired')) return jsonResponse(RETIRED);
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
      if (path.includes('/retention/valuations/retired')) return jsonResponse(RETIRED);
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
        if (path.includes('/retention/valuations/retired')) return jsonResponse(RETIRED);
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

/**
 * Undoing an archival from the audit log.
 *
 * `archived_at` had no way back until R90 — R89 made every write to a stamped
 * engagement refuse, so a valuation archived by a policy set to 90 days meaning
 * 900 was frozen for good. The restore lives here, beside the log entry it
 * undoes, because that is where an admin finds out an archival happened.
 *
 * The fixtures above use `data_type: 'valuations'`; the API records the
 * singular `valuation` (it is one of `RETENTION_DATA_TYPES`), which is what the
 * button keys on. These fixtures are therefore their own regression check that
 * the control does not appear against data types with no restore endpoint.
 */
const RESTORE_ACTIONS = [
  {
    id: 'r-latest-archive',
    data_type: 'valuation',
    action: 'archived',
    reference_id: '01JVAL0000000000000000042',
    created_at: '2026-07-05T10:00:00Z',
  },
  {
    id: 'r-already-back',
    data_type: 'valuation',
    action: 'restored',
    reference_id: '01JVAL0000000000000000043',
    created_at: '2026-07-04T10:00:00Z',
  },
  {
    id: 'r-superseded-archive',
    data_type: 'valuation',
    action: 'archived',
    reference_id: '01JVAL0000000000000000043',
    created_at: '2026-07-03T10:00:00Z',
  },
  {
    id: 'r-other-type',
    data_type: 'document',
    action: 'archived',
    reference_id: '01JDOC0000000000000000007',
    created_at: '2026-07-02T10:00:00Z',
  },
];

function mockRestoreApi(onWrite?: (path: string, init: RequestInit) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if ((init?.method ?? 'GET') !== 'GET') {
      if (onWrite) return onWrite(path, init!);
      return jsonResponse({ restored: true });
    }
    if (path.includes('/retention/policies')) return jsonResponse({ policies: POLICIES });
    if (path.includes('/retention/holds')) return jsonResponse({ holds: HOLDS });
    if (path.includes('/retention/valuations/retired')) return jsonResponse(RETIRED);
    if (path.includes('/retention/actions')) return jsonResponse({ actions: RESTORE_ACTIONS });
    throw new Error(`unexpected fetch ${path}`);
  });
}

const logRow = (id: string) => screen.getByText(id).closest('li')!;

describe('AdminRetentionPage — restoring an archived valuation', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('offers restore only against an archival that is still the last word', async () => {
    mockRestoreApi();
    renderPage();
    await loaded();

    const restorable = within(logRow('01JVAL0000000000000000042'));
    expect(restorable.getByRole('button', { name: /^Restore$/ })).toBeInTheDocument();

    // Archived, then restored: offering it again could only produce "not
    // archived", which is not a control, it is a trap.
    const superseded = screen
      .getAllByText('01JVAL0000000000000000043')
      .map((el) => el.closest('li')!)
      .find((li) => li.textContent?.includes('archived'))!;
    expect(within(superseded).queryByRole('button', { name: /^Restore$/ })).not.toBeInTheDocument();

    // A data type with no restore endpoint.
    const other = within(logRow('01JDOC0000000000000000007'));
    expect(other.queryByRole('button', { name: /^Restore$/ })).not.toBeInTheDocument();
  });

  it('POSTs the restore without an acknowledgement and reports it', async () => {
    const writes: Array<{ path: string; body: unknown }> = [];
    mockRestoreApi((path, init) => {
      writes.push({ path, body: JSON.parse(String(init.body)) as unknown });
      return jsonResponse({ restored: true });
    });
    renderPage();
    await loaded();

    await userEvent.click(
      within(logRow('01JVAL0000000000000000042')).getByRole('button', { name: /^Restore$/ }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.path).toContain('/admin/retention/valuations/01JVAL0000000000000000042/restore');
    // The acknowledgement is not sent by default: it is the answer to a
    // question the operator has not been asked yet.
    expect(writes[0]!.body).toEqual({});
    await screen.findByText(/Restored 01JVAL0000000000000000042/);
  });

  it('asks before overriding a restore the sweep would undo, and resends on yes', async () => {
    const writes: unknown[] = [];
    mockRestoreApi((_path, init) => {
      writes.push(JSON.parse(String(init.body)));
      return writes.length === 1
        ? problem(
            409,
            'The retention policy archives valuations after 30 days and this one is older ' +
              'than that, so the next sweep would archive it again. Widen the policy or place a legal ' +
              'hold on it first, or resend with acknowledge_rearchival to restore it anyway.',
          )
        : jsonResponse({ restored: true });
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await loaded();

    await userEvent.click(
      within(logRow('01JVAL0000000000000000042')).getByRole('button', { name: /^Restore$/ }),
    );
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual({ acknowledge_rearchival: true });
    // The operator is shown the reason, not a generic "are you sure".
    expect(confirm.mock.calls[0]![0]).toMatch(/next sweep would archive it again/);
    await screen.findByText(/Restored 01JVAL0000000000000000042/);
  });

  it('sends nothing more when the operator declines', async () => {
    const writes: unknown[] = [];
    mockRestoreApi((_path, init) => {
      writes.push(JSON.parse(String(init.body)));
      return problem(409, 'so the next sweep would archive it again. Widen the policy');
    });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await loaded();

    await userEvent.click(
      within(logRow('01JVAL0000000000000000042')).getByRole('button', { name: /^Restore$/ }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    // Declining is not a failure, so it must not leave an error banner behind.
    expect(screen.queryByText(/Could not restore/)).not.toBeInTheDocument();
    expect(writes).toHaveLength(1);
  });

  it('reports a 409 that is not about re-archival as an error, without asking', async () => {
    // "not archived" means somebody else already restored it. Re-sending with
    // an acknowledgement would not change that, so there is nothing to ask.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockRestoreApi(() => problem(409, 'This engagement is not archived — there is nothing to restore.'));
    renderPage();
    await loaded();

    await userEvent.click(
      within(logRow('01JVAL0000000000000000042')).getByRole('button', { name: /^Restore$/ }),
    );
    await screen.findByText(/there is nothing to restore/);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('reports a failed restore rather than leaving the click silent', async () => {
    mockRestoreApi(() => problem(500, 'database unavailable'));
    renderPage();
    await loaded();

    await userEvent.click(
      within(logRow('01JVAL0000000000000000042')).getByRole('button', { name: /^Restore$/ }),
    );
    await screen.findByText('database unavailable');
  });
});

/**
 * Withdrawing an engagement from this screen.
 *
 * The whole retirement guard family — 86 session writes, the partner API's
 * three, the auditor portal's refusal to re-share, the board flow's refusal to
 * re-mint — was reachable only by waiting out a retention policy until R90:
 * `retireValuations` existed and its only caller was the sample seeder. This
 * form is the action all of that was written for.
 *
 * By id and not from a list, deliberately: no screen offers a live engagement
 * for retirement, and adding one would be adding a delete button to the
 * valuations table.
 */
describe('AdminRetentionPage — withdrawing an engagement', () => {
  beforeEach(() => vi.restoreAllMocks());

  const idField = () => screen.getByPlaceholderText('valuation id');
  const retireButton = () => screen.getByRole('button', { name: /^Retire$/i });

  it('will not fire without an id', async () => {
    mockApi();
    renderPage();
    await loaded();
    expect(retireButton()).toBeDisabled();
    // Whitespace is not an id.
    await userEvent.type(idField(), '   ');
    expect(retireButton()).toBeDisabled();
    await userEvent.type(idField(), '01JVAL777');
    expect(retireButton()).toBeEnabled();
  });

  it('asks first, naming the company rename nobody expects', async () => {
    const writes: unknown[] = [];
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockApi((_path, init) => {
      writes.push(JSON.parse(String(init.body)));
      return jsonResponse({ retired: true, valuation: { company_name: 'Acme, Inc. [retired]' } });
    });
    renderPage();
    await loaded();

    await userEvent.type(idField(), '01JVAL777');
    await userEvent.type(screen.getByPlaceholderText(/client withdrew/), '  duplicate file  ');
    await userEvent.click(retireButton());

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(confirm.mock.calls[0]![0]).toMatch(/\[retired\]/);
    expect(confirm.mock.calls[0]![0]).toMatch(/restore it/i);
    expect(writes[0]).toEqual({ reason: 'duplicate file' });
    // The new name is reported back, not left for the admin to discover.
    await screen.findByText(/Acme, Inc. \[retired\]/);
    await waitFor(() => expect(idField()).toHaveValue(''));
  });

  it('sends no reason at all rather than an empty one', async () => {
    const writes: unknown[] = [];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockApi((_path, init) => {
      writes.push(JSON.parse(String(init.body)));
      return jsonResponse({ retired: true, valuation: { company_name: 'X [retired]' } });
    });
    renderPage();
    await loaded();

    await userEvent.type(idField(), '01JVAL777');
    await userEvent.click(retireButton());
    // The route rejects a blank reason with a 422, so a form that always sent
    // the field would make "no reason" unusable.
    await waitFor(() => expect(writes).toEqual([{}]));
  });

  it('sends nothing when the confirmation is declined', async () => {
    const writes: unknown[] = [];
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    mockApi((_path, init) => {
      writes.push(JSON.parse(String(init.body)));
      return jsonResponse({ retired: true, valuation: { company_name: 'X [retired]' } });
    });
    renderPage();
    await loaded();

    await userEvent.type(idField(), '01JVAL777');
    await userEvent.click(retireButton());
    await waitFor(() => expect(retireButton()).toBeEnabled());
    expect(writes).toEqual([]);
    // Declining is not a failure and must not leave a banner behind.
    expect(screen.queryByText(/Could not retire/)).not.toBeInTheDocument();
  });

  it('surfaces a refusal instead of reading as a retirement that happened', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockApi(() => problem(409, 'This engagement is already retired.'));
    renderPage();
    await loaded();

    await userEvent.type(idField(), '01JVAL777');
    await userEvent.click(retireButton());
    await screen.findByText('This engagement is already retired.');
    // The id stays in the field: the admin is more likely to be fixing a typo
    // than starting over, and clearing it on failure loses what they typed.
    expect(idField()).toHaveValue('01JVAL777');
  });
});

/**
 * The withdrawn list.
 *
 * R90 put the restore control on the audit log, which is a history: newest
 * first, cut at fifty. One sweep archiving forty engagements pushes last
 * week's withdrawal off the end, and the only route back goes with it —
 * silently, because a truncated list looks exactly like a complete one. This
 * section is derived from `archived_at`, so nothing ages out of it.
 */
const RETIRED_ROWS = {
  valuations: [
    {
      id: '01JVAL0000000000000000101',
      number: 4101,
      company_name: 'Halcyon Systems [retired]',
      kind: '409a',
      state: 'review',
      archived_at: '2026-08-01T09:00:00Z',
      retired_reason: 'client withdrew the engagement',
      retired_manually: true,
    },
    {
      id: '01JVAL0000000000000000102',
      number: 4102,
      company_name: 'Old Policy Co [retired]',
      kind: 'fmv',
      state: 'published',
      archived_at: '2026-02-01T09:00:00Z',
      retired_reason: null,
      retired_manually: false,
    },
  ],
  total: 2,
};

function mockWithRetired(rows: unknown = RETIRED_ROWS, onGet?: (path: string) => Response | null) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if ((init?.method ?? 'GET') !== 'GET') return jsonResponse({ restored: true });
    const custom = onGet?.(path);
    if (custom) return custom;
    if (path.includes('/retention/policies')) return jsonResponse({ policies: POLICIES });
    if (path.includes('/retention/holds')) return jsonResponse({ holds: HOLDS });
    if (path.includes('/retention/valuations/retired')) return jsonResponse(rows);
    if (path.includes('/retention/actions')) return jsonResponse({ actions: ACTIONS });
    throw new Error(`unexpected fetch ${path}`);
  });
}

const retiredSection = () => screen.getByText('Withdrawn engagements').closest('section')!;

describe('AdminRetentionPage — the withdrawn engagements section', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('names each engagement and why it went, not just its id', async () => {
    mockWithRetired();
    renderPage();
    await loaded();
    const section = within(retiredSection());

    expect(section.getByText('Halcyon Systems [retired]')).toBeInTheDocument();
    expect(section.getByText('“client withdrew the engagement”')).toBeInTheDocument();
    // A policy archival records no reason, and that absence is the answer
    // rather than missing data.
    expect(section.getByText('retention policy')).toBeInTheDocument();
    expect(section.getAllByRole('button', { name: /^Restore$/ })).toHaveLength(2);
  });

  it('says so plainly when nothing is withdrawn — the vacuity guard', async () => {
    // Everything above asserts a row is on screen, and all of it would pass
    // against a section that ignored the response and always drew two.
    mockWithRetired({ valuations: [], total: 0 });
    renderPage();
    await loaded();
    expect(within(retiredSection()).getByText('No engagement is withdrawn.')).toBeInTheDocument();
    expect(within(retiredSection()).queryByRole('button', { name: /^Restore$/ })).not.toBeInTheDocument();
  });

  it('searches by name and asks the API rather than filtering what it has', async () => {
    const asked: string[] = [];
    mockWithRetired(RETIRED_ROWS, (path) => {
      if (!path.includes('/retention/valuations/retired')) return null;
      asked.push(path);
      return jsonResponse(
        asked.length === 1 ? RETIRED_ROWS : { valuations: [RETIRED_ROWS.valuations[0]], total: 1 },
      );
    });
    renderPage();
    await loaded();

    await userEvent.type(within(retiredSection()).getByLabelText('Search withdrawn engagements'), 'Halcyon');
    await userEvent.click(within(retiredSection()).getByRole('button', { name: 'Search' }));

    // The list is capped server-side, so filtering the page's own copy would
    // only ever search the first fifty — which is the bug this section exists
    // to fix.
    await waitFor(() => expect(asked.at(-1)).toContain('q=Halcyon'));
    await waitFor(() =>
      expect(within(retiredSection()).queryByText('Old Policy Co [retired]')).not.toBeInTheDocument(),
    );
  });

  it('says how many matched when it is showing fewer', async () => {
    mockWithRetired({ valuations: RETIRED_ROWS.valuations, total: 214 });
    renderPage();
    await loaded();
    expect(within(retiredSection()).getByText('showing 2 of 214')).toBeInTheDocument();
  });

  it('admits the audit log is cut, and points at the section that is not', async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      id: `b${i}`,
      data_type: 'valuations',
      action: 'archived',
      reference_id: `old-${i}`,
      created_at: '2026-07-01T10:00:00Z',
    }));
    mockWithRetired(RETIRED_ROWS, (path) =>
      path.includes('/retention/actions') ? jsonResponse({ actions: many }) : null,
    );
    renderPage();
    await loaded();
    expect(screen.getByText(/showing the 50 most recent of 80/)).toBeInTheDocument();
  });

  it('restores from the list, not only from the log', async () => {
    const writes: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url);
      if ((init?.method ?? 'GET') !== 'GET') {
        writes.push(path);
        return jsonResponse({ restored: true });
      }
      if (path.includes('/retention/policies')) return jsonResponse({ policies: POLICIES });
      if (path.includes('/retention/holds')) return jsonResponse({ holds: HOLDS });
      if (path.includes('/retention/valuations/retired')) return jsonResponse(RETIRED_ROWS);
      if (path.includes('/retention/actions')) return jsonResponse({ actions: ACTIONS });
      throw new Error(`unexpected fetch ${path}`);
    });
    renderPage();
    await loaded();

    await userEvent.click(within(retiredSection()).getAllByRole('button', { name: /^Restore$/ })[0]!);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toContain('/retention/valuations/01JVAL0000000000000000101/restore');
  });
});
