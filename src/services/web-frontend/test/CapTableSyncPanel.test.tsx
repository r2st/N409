import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CapTableSyncPanel } from '../src/components/valuation/CapTableSyncPanel';

const VAL_ID = '01N409VAL000000000000000AA';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const CARTA = {
  provider: 'carta',
  label: 'Carta',
  configured: true,
  connection: {
    status: 'connected',
    external_company_name: 'Acme Inc',
    sync_frequency: 'manual',
    last_synced_at: null,
    last_error: null,
    next_sync_at: null,
    reconnect_required: false,
  },
};
/** No keys on this deployment, so it can only ever be listed. */
const PULLEY = { provider: 'pulley', label: 'Pulley', configured: false, connection: null };

const providers = [CARTA, PULLEY];

/** Pulley configured but never connected — the branch that offers "Connect Pulley". */
const pulleyConnectable = [CARTA, { ...PULLEY, configured: true }];

const conflictOutcome = {
  applied: false,
  class_count: 3,
  external_company_name: 'Acme Inc',
  validation: { valid: true },
  diff: {
    has_conflicts: true,
    added: 1,
    removed: 0,
    changed: 1,
    conflicts: [
      {
        security_class: 'Series A',
        status: 'changed',
        changes: [{ field: 'shares', from: 2000000, to: 2500000 }],
      },
      { security_class: 'Series B', status: 'added', changes: [] },
    ],
  },
};

function mockApi(overrides: Partial<Record<string, () => Response>> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const method = init?.method ?? 'GET';
    const key = `${method} ${String(url).replace(/^.*\/api\/v1/, '')}`;
    for (const [pattern, responder] of Object.entries(overrides)) {
      if (key.includes(pattern)) return responder!();
    }
    if (key.includes(`GET /valuations/${VAL_ID}/cap-table/sync`)) return jsonResponse({ providers });
    throw new Error(`unexpected fetch ${key}`);
  });
}

/**
 * The panel now reads the OAuth callback's result out of the URL
 * (`?sync=…&provider=…`), so it needs a router the way `AccountingConnect`
 * always has. Wrapped here rather than at twenty call sites, with the entry as
 * a parameter so the callback cases can land on one.
 */
function renderPanel(ui: ReactElement, initialEntry = '/') {
  return render(<MemoryRouter initialEntries={[initialEntry]}>{ui}</MemoryRouter>);
}

describe('CapTableSyncPanel (feature 4)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists providers with their connection state', async () => {
    mockApi();
    renderPanel(<CapTableSyncPanel valuationId={VAL_ID} onApplied={() => {}} />);
    expect(await screen.findByText('Carta')).toBeInTheDocument();
    expect(screen.getByText(/Connected · Acme Inc/)).toBeInTheDocument();
    expect(screen.getByText('Not configured on this deployment')).toBeInTheDocument();
  });

  it('previews conflicts on a sync and can apply them', async () => {
    const user = userEvent.setup();
    const onApplied = vi.fn();
    let applied = false;
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/cap-table/sync/carta/pull': () => {
        if (applied) return jsonResponse({ ...conflictOutcome, applied: true });
        return jsonResponse(conflictOutcome);
      },
    });
    renderPanel(<CapTableSyncPanel valuationId={VAL_ID} onApplied={onApplied} />);

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByTestId('sync-conflicts')).toBeInTheDocument();
    expect(screen.getByText(/1 changed · 1 added/)).toBeInTheDocument();
    expect(screen.getByText('Series A')).toBeInTheDocument();

    applied = true;
    await user.click(screen.getByRole('button', { name: 'Apply provider data' }));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  /*
   * A cap table may hold one class name on two rows (`duplicate_class` is a
   * warning, and a provider returning one row per certificate produces the
   * shape by construction), so the diff names a class twice whenever one of
   * those rows is added or removed. Keyed by class name, React reconciled the
   * two onto each other and drew one row — under a summary line counting two —
   * on the screen an analyst reads before overwriting the table on file.
   */
  it('draws a row per conflict when two of them name the same class', async () => {
    const user = userEvent.setup();
    const repeated = {
      ...conflictOutcome,
      diff: {
        has_conflicts: true,
        added: 0,
        removed: 1,
        changed: 1,
        conflicts: [
          {
            security_class: 'Series A',
            status: 'changed',
            changes: [{ field: 'shares', from: 100000, to: 120000 }],
          },
          { security_class: 'Series A', status: 'removed', changes: [] },
        ],
      },
    };
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/cap-table/sync/carta/pull': () => jsonResponse(repeated),
    });
    // React draws both rows on a first mount and warns; it is the *next*
    // render of the list that reconciles them onto one another. The warning is
    // the defect stated at the point it happens, so it is what this asserts —
    // React's own words for it are that the behaviour is unsupported.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPanel(<CapTableSyncPanel valuationId={VAL_ID} onApplied={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    const table = await screen.findByTestId('sync-conflicts');
    expect(screen.getByText(/1 changed · 0 added · 1 removed/)).toBeInTheDocument();
    expect(within(table).getAllByRole('rowheader', { name: 'Series A' })).toHaveLength(2);
    expect(within(table).getByText('removed')).toBeInTheDocument();
    expect(consoleError.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(
      /two children with the same key/,
    );
  });

  /**
   * The panel set an error on a failed load and then returned a spinner, so
   * the ErrorNote it wrote sat in markup that never rendered.
   */
  it('reports a failed provider load instead of spinning forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    renderPanel(<CapTableSyncPanel valuationId={VAL_ID} onApplied={vi.fn()} />);
    expect(await screen.findByText('Could not load sync providers.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('sends the analyst to the provider’s own consent screen to connect', async () => {
    const user = userEvent.setup();
    // jsdom implements no navigation, so a plain object stands in and the
    // assignment the OAuth handoff makes becomes observable.
    const original = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', { value: { href: '' }, writable: true, configurable: true });
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/cap-table/sync/pulley/connect': () =>
        jsonResponse({ authorize_url: 'https://app.pulley.com/oauth/authorize?state=xyz' }),
      'GET /valuations/01N409VAL000000000000000AA/cap-table/sync': () =>
        jsonResponse({ providers: pulleyConnectable }),
    });
    renderPanel(<CapTableSyncPanel valuationId={VAL_ID} onApplied={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Connect Pulley' }));
    await waitFor(() =>
      expect(window.location.href).toBe('https://app.pulley.com/oauth/authorize?state=xyz'),
    );
    if (original) Object.defineProperty(window, 'location', original);
  });

  /**
   * A refused handoff left the button disabled with no explanation — the
   * analyst could neither retry nor learn why. The error is reported and the
   * button becomes clickable again.
   */
  it('reports a refused connection and re-enables the button', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/cap-table/sync/pulley/connect': () =>
        jsonResponse({ title: 'Bad Gateway', detail: 'Pulley declined the handshake.', status: 502 }, 502),
      'GET /valuations/01N409VAL000000000000000AA/cap-table/sync': () =>
        jsonResponse({ providers: pulleyConnectable }),
    });
    renderPanel(<CapTableSyncPanel valuationId={VAL_ID} onApplied={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Connect Pulley' }));
    expect(await screen.findByText('Pulley declined the handshake.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Pulley' })).toBeEnabled();
  });

  it('never offers to connect a provider this deployment has no keys for', async () => {
    mockApi();
    renderPanel(<CapTableSyncPanel valuationId={VAL_ID} onApplied={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Connect Pulley' })).toBeDisabled();
  });

  it('sets a periodic cadence and re-reads the connection it changed', async () => {
    const user = userEvent.setup();
    let frequency = 'manual';
    const sent: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const key = `${init?.method ?? 'GET'} ${String(url).replace(/^.*\/api\/v1/, '')}`;
      if (key.includes('/cap-table/sync/carta/frequency')) {
        const body = JSON.parse(String(init?.body)) as { frequency: string };
        sent.push(body);
        frequency = body.frequency;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({
        providers: [{ ...CARTA, connection: { ...CARTA.connection, sync_frequency: frequency } }, PULLEY],
      });
    });
    renderPanel(<CapTableSyncPanel valuationId={VAL_ID} onApplied={vi.fn()} />);

    const select = await screen.findByLabelText('Carta sync frequency');
    await user.selectOptions(select, 'weekly');
    await waitFor(() => expect(sent).toEqual([{ frequency: 'weekly' }]));
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('weekly'));
  });

  it('says why a cadence change was refused rather than silently keeping the old one', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/cap-table/sync/carta/frequency': () =>
        jsonResponse({ title: 'Conflict', detail: 'Daily sync needs a paid plan.', status: 409 }, 409),
    });
    renderPanel(<CapTableSyncPanel valuationId={VAL_ID} onApplied={vi.fn()} />);

    await user.selectOptions(await screen.findByLabelText('Carta sync frequency'), 'daily');
    expect(await screen.findByText('Daily sync needs a paid plan.')).toBeInTheDocument();
    // The panel is loaded, so the error belongs inline — not in place of the list.
    expect(screen.getByTestId('cap-table-sync')).toBeInTheDocument();
  });

  it('drops the connection and re-reads the providers on disconnect', async () => {
    const user = userEvent.setup();
    let connected = true;
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${String(url).replace(/^.*\/api\/v1/, '')}`);
      if (method === 'DELETE') {
        connected = false;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({
        providers: [{ ...CARTA, connection: connected ? CARTA.connection : null }, PULLEY],
      });
    });
    renderPanel(<CapTableSyncPanel valuationId={VAL_ID} onApplied={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('button', { name: 'Connect Carta' })).toBeInTheDocument();
    expect(calls).toContain(`DELETE /valuations/${VAL_ID}/cap-table/sync/carta`);
  });

  it('surfaces the provider’s last error against the connection that carries it', async () => {
    mockApi({
      'GET /valuations/01N409VAL000000000000000AA/cap-table/sync': () =>
        jsonResponse({
          providers: [
            {
              ...CARTA,
              connection: { ...CARTA.connection, status: 'error', last_error: 'Token expired' },
            },
            PULLEY,
          ],
        }),
    });
    renderPanel(<CapTableSyncPanel valuationId={VAL_ID} onApplied={vi.fn()} />);
    expect(await screen.findByText(/Last error: Token expired/)).toBeInTheDocument();
  });

  it('separates a failure that retries itself from one that needs a person (R256)', async () => {
    /**
     * The same two states as the HRIS panel, drawn from the same helper. R252
     * made `error` mean either "the provider was briefly unwell, retrying on a
     * backoff" or "the authorisation has ended and nothing will retry it", and
     * the card said "Not syncing · Reconnect" to both.
     */
    mockApi({
      'GET /valuations/01N409VAL000000000000000AA/cap-table/sync': () =>
        jsonResponse({
          providers: [
            {
              ...CARTA,
              connection: {
                ...CARTA.connection,
                status: 'error',
                sync_frequency: 'daily',
                last_error: 'Carta cap table fetch failed (503)',
                next_sync_at: '2026-07-02T00:15:00Z',
                reconnect_required: false,
              },
            },
            PULLEY,
          ],
        }),
    });
    renderPanel(<CapTableSyncPanel valuationId={VAL_ID} onApplied={vi.fn()} />);

    expect(await screen.findByText(/Sync failing · retrying · Acme Inc/)).toBeInTheDocument();
    expect(screen.getByText(/Retrying automatically — next attempt/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect Carta' })).not.toBeInTheDocument();
    // This one's cadence *is* running, so it must not be told it is not.
    expect(screen.queryByText(/nothing is scheduled/)).not.toBeInTheDocument();
  });

  it('asks for a reconnect when no retry can clear the failure (R256)', async () => {
    mockApi({
      'GET /valuations/01N409VAL000000000000000AA/cap-table/sync': () =>
        jsonResponse({
          providers: [
            {
              ...CARTA,
              connection: {
                ...CARTA.connection,
                status: 'error',
                // Scheduled, not manual: R262's note is about a cadence that
                // is set and will not run, and CARTA's default is `manual`.
                sync_frequency: 'daily',
                last_error: 'Carta no longer accepts the stored authorisation — reconnect Carta.',
                reconnect_required: true,
              },
            },
            PULLEY,
          ],
        }),
    });
    renderPanel(<CapTableSyncPanel valuationId={VAL_ID} onApplied={vi.fn()} />);

    expect(await screen.findByText(/Not syncing · Acme Inc/)).toBeInTheDocument();
    expect(screen.queryByText(/Retrying automatically/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect Carta' })).toBeInTheDocument();
    /*
     * R262. Round 261 stopped `setSyncFrequency` restarting a schedule the
     * provider has ended, and the card went on showing the cadence dropdown
     * with no hint that setting it schedules nothing. Said in one place for
     * both panels — see `cadenceNote`.
     */
    expect(
      screen.getByText(/Auto-sync is saved, but nothing is scheduled until this connection is reconnected/),
    ).toBeInTheDocument();
  });

  /**
   * A revoked grant still has a connection record. Treating it as connected
   * would offer "Sync now" against a token the provider no longer honours.
   */
  it('treats a revoked grant as not connected', async () => {
    mockApi({
      'GET /valuations/01N409VAL000000000000000AA/cap-table/sync': () =>
        jsonResponse({
          providers: [{ ...CARTA, connection: { ...CARTA.connection, status: 'revoked' } }, PULLEY],
        }),
    });
    renderPanel(<CapTableSyncPanel valuationId={VAL_ID} onApplied={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Connect Carta' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });

  it('reports a failed pull and leaves the cap table on file alone', async () => {
    const user = userEvent.setup();
    const onApplied = vi.fn();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/cap-table/sync/carta/pull': () =>
        jsonResponse({ title: 'Bad Gateway', detail: 'Carta returned no cap table.', status: 502 }, 502),
    });
    renderPanel(<CapTableSyncPanel valuationId={VAL_ID} onApplied={onApplied} />);

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('Carta returned no cap table.')).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sync-conflicts')).not.toBeInTheDocument();
    // The button is released, so the analyst can retry once the provider recovers.
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled();
  });

  it('dismisses a conflict preview without touching the cap table', async () => {
    const user = userEvent.setup();
    const onApplied = vi.fn();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/cap-table/sync/carta/pull': () =>
        jsonResponse(conflictOutcome),
    });
    renderPanel(<CapTableSyncPanel valuationId={VAL_ID} onApplied={onApplied} />);

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    await user.click(await screen.findByRole('button', { name: 'Keep current' }));
    await waitFor(() => expect(screen.queryByTestId('sync-conflicts')).not.toBeInTheDocument());
    expect(onApplied).not.toHaveBeenCalled();
  });

  /**
   * A removed class has no value on the provider side, and a textual field
   * (a class name, a preference type) is not a number to be grouped.
   */
  it('renders an absent value as a dash and a textual one verbatim', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/cap-table/sync/carta/pull': () =>
        jsonResponse({
          ...conflictOutcome,
          diff: {
            ...conflictOutcome.diff,
            conflicts: [
              {
                security_class: 'Series Seed',
                status: 'removed',
                changes: [
                  { field: 'shares', from: 1500000, to: null },
                  { field: 'preference_type', from: 'non-participating', to: 'participating' },
                ],
              },
            ],
          },
        }),
    });
    renderPanel(<CapTableSyncPanel valuationId={VAL_ID} onApplied={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    const row = (await screen.findByText('Series Seed')).closest('tr')!;
    expect(row).toHaveTextContent('shares: 1,500,000 → —');
    expect(row).toHaveTextContent('preference_type: non-participating → participating');
  });
  /**
   * The other half of the OAuth hop, which this panel did not have at all.
   *
   * `/api/v1/cap-table-sync/callback` redirects back here with `?sync=…` and
   * `?provider=…`; nothing read either. So the two ways the hop fails —
   * the reader pressing Cancel on Carta's consent screen, and a token exchange
   * that did not work — returned to a panel that looked exactly as it had
   * before they left. The list refetches, finds no connection, and draws the
   * same Connect button: no wrong claim, and no answer either.
   */
  describe('the OAuth callback outcome in the URL', () => {
    it('says a cancelled connection was cancelled, and that nothing was connected', async () => {
      mockApi();
      renderPanel(
        <CapTableSyncPanel valuationId={VAL_ID} onApplied={vi.fn()} />,
        '/?sync=denied&provider=carta',
      );
      const note = await screen.findByRole('alert');
      expect(note).toHaveTextContent(/Connection to Carta was cancelled/);
      expect(note).toHaveTextContent(/nothing was connected/);
    });

    it('names the retirement rather than offering the button again', async () => {
      // The engagement was withdrawn while the reader was on the consent
      // screen — see the callback's own guard. Not a failure they can retry.
      mockApi();
      renderPanel(
        <CapTableSyncPanel valuationId={VAL_ID} onApplied={vi.fn()} />,
        '/?sync=retired&provider=carta',
      );
      const note = await screen.findByRole('alert');
      expect(note).toHaveTextContent(/This engagement was retired while you were connecting to Carta/);
      expect(note).not.toHaveTextContent(/Press Connect to try again/);
    });

    it('says a success out loud, in the success voice', async () => {
      mockApi();
      renderPanel(
        <CapTableSyncPanel valuationId={VAL_ID} onApplied={vi.fn()} />,
        '/?sync=connected&provider=pulley',
      );
      expect(await screen.findByRole('status')).toHaveTextContent(/Connected to Pulley/);
    });

    it('will not print a provider name the server did not send', async () => {
      // `?provider=` rides in on a URL anyone can compose and send to a
      // signed-in analyst, and the sentence it lands in is this workspace's own
      // voice on the tab holding the client's cap table.
      mockApi();
      renderPanel(
        <CapTableSyncPanel valuationId={VAL_ID} onApplied={vi.fn()} />,
        '/?sync=denied&provider=Carta.%20Call%201-800-555-0100%20to%20restore%20access',
      );
      const note = await screen.findByRole('alert');
      expect(note).toHaveTextContent(/Connection to the provider was cancelled/);
      expect(note).not.toHaveTextContent(/1-800/);
    });

    it('keeps the answer when the provider list itself failed to load', async () => {
      // The failed-load branch is a LoadError with a Retry button, which would
      // otherwise be the whole response to "did my connection work?".
      mockApi({
        'GET /valuations/01N409VAL000000000000000AA/cap-table/sync': () => new Response('', { status: 500 }),
      });
      renderPanel(
        <CapTableSyncPanel valuationId={VAL_ID} onApplied={vi.fn()} />,
        '/?sync=error&provider=carta',
      );
      expect(await screen.findByText(/Connecting to Carta failed/)).toBeInTheDocument();
    });
  });
});
