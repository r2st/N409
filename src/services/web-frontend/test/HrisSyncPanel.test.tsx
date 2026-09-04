import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { HrisSyncPanel } from '../src/components/valuation/HrisSyncPanel';

const VAL = '01N409VAL000000000000000AA';
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const providers = [
  {
    provider: 'rippling',
    label: 'Rippling',
    configured: true,
    connection: {
      status: 'connected',
      external_company_name: 'Acme',
      sync_frequency: 'manual',
      last_synced_at: null,
      last_error: null,
    },
  },
  { provider: 'gusto', label: 'Gusto', configured: false, connection: null },
  { provider: 'deel', label: 'Deel', configured: false, connection: null },
];

/** The same deployment, with Gusto's OAuth keys configured. */
const withGustoKeys = providers.map((p) => (p.provider === 'gusto' ? { ...p, configured: true } : p));

function mockApi(overrides: Partial<Record<string, () => Response>> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const method = init?.method ?? 'GET';
    const key = `${method} ${String(url).replace(/^.*\/api\/v1/, '')}`;
    for (const [pattern, r] of Object.entries(overrides)) if (key.includes(pattern)) return r!();
    if (key.includes(`GET /valuations/${VAL}/hris`)) return jsonResponse({ providers });
    throw new Error(`unexpected fetch ${key}`);
  });
}

/**
 * The panel now reads the OAuth callback's result out of the URL
 * (`?hris=…&provider=…`), so it needs a router the way `AccountingConnect`
 * always has. Wrapped here rather than at twenty call sites, with the entry as
 * a parameter so the callback cases can land on one.
 */
function renderPanel(ui: ReactElement, initialEntry = '/') {
  return render(<MemoryRouter initialEntries={[initialEntry]}>{ui}</MemoryRouter>);
}

describe('HrisSyncPanel (feature 11)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists providers and imports grants, reporting the result', async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/hris/rippling/pull': () =>
        jsonResponse({ roster_count: 12, grants_found: 8, grants_created: 8, grants_skipped: 0 }),
    });
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={onImported} />);

    expect(await screen.findByText('Rippling')).toBeInTheDocument();
    expect(screen.getByText(/Connected · Acme/)).toBeInTheDocument();
    expect(screen.getAllByText('Not configured on this deployment')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Import now' }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(screen.getByText(/8 grants imported/)).toBeInTheDocument();
  });

  /**
   * A record the importer refused is a short roster, and a short roster nobody
   * is told about reads as a complete one (round 201, M6).
   *
   * The server drops a provider grant it cannot store — an options count past
   * the column, a negative strike, an external id longer than the unique index
   * takes — so that one malformed record cannot end the whole import. That is
   * only defensible if the drop is said out loud here: "Synced 12 employees ·
   * 6 grants imported" is otherwise a sentence that omits the two an auditor
   * would go looking for.
   */
  /** The cap-table panel's twin — see its note. R401, methodology M11. */
  it('says so when the engagement was retired and nothing is syncing', async () => {
    mockApi({
      [`GET /valuations/${VAL}/hris`]: () =>
        jsonResponse({ providers, scheduled: false, unscheduled_reason: 'retired' }),
    });
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={() => {}} />);
    await screen.findByText(/scheduled syncing is paused/i);
    expect(screen.getByRole('status')).toHaveTextContent(/has been retired/i);
    expect(screen.getByText('Rippling')).toBeInTheDocument();
  });

  it('says nothing of the sort while the engagement is live', async () => {
    // Non-vacuity: same providers, same card, and an older server sends
    // neither field.
    mockApi();
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={() => {}} />);
    await screen.findByText('Rippling');
    expect(screen.queryByText(/scheduled syncing is paused/i)).not.toBeInTheDocument();
  });

  it('says how many grants the provider sent that could not be stored', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/hris/rippling/pull': () =>
        jsonResponse({
          roster_count: 12,
          grants_found: 6,
          grants_created: 6,
          grants_skipped: 0,
          grants_rejected: 2,
        }),
    });
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Import now' }));
    expect(await screen.findByText(/2 grants were skipped/)).toBeInTheDocument();
  });

  it('names the employee and the reason for a rejected grant, not just the count', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/hris/rippling/pull': () =>
        jsonResponse({
          roster_count: 12,
          grants_found: 6,
          grants_created: 5,
          grants_skipped: 0,
          grants_rejected: 1,
          grants_rejected_detail: [
            { employee: 'Ada Lovelace', external_id: 'g-1', reason: 'exercise price is negative or implausibly large' },
          ],
          grants_rejected_detail_truncated: false,
        }),
    });
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Import now' }));
    expect(
      await screen.findByText(/Ada Lovelace \(exercise price is negative or implausibly large\)/),
    ).toBeInTheDocument();
  });

  it('folds the remainder into a count once the named examples run out', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/hris/rippling/pull': () =>
        jsonResponse({
          roster_count: 12,
          grants_found: 6,
          grants_created: 1,
          grants_skipped: 0,
          grants_rejected: 5,
          grants_rejected_detail: [
            { employee: 'Ada Lovelace', external_id: 'g-1', reason: 'no usable grant date' },
            { employee: 'Grace Hopper', external_id: 'g-2', reason: 'option count is out of range' },
            { employee: 'Hedy Lamarr', external_id: 'g-3', reason: 'no option count on the record, or zero' },
          ],
          grants_rejected_detail_truncated: false,
        }),
    });
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Import now' }));
    expect(await screen.findByText(/, and 2 more\. Check these records in the provider\./)).toBeInTheDocument();
  });

  it('says nothing about rejected grants when the provider sent none', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/hris/rippling/pull': () =>
        jsonResponse({
          roster_count: 12,
          grants_found: 8,
          grants_created: 8,
          grants_skipped: 0,
          grants_rejected: 0,
        }),
    });
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Import now' }));
    expect(await screen.findByText(/8 grants imported/)).toBeInTheDocument();
    expect(screen.queryByText(/skipped/)).not.toBeInTheDocument();
  });

  /**
   * The panel set an error on a failed load and then returned a spinner, so
   * the ErrorNote it wrote sat in markup that never rendered. The tab showed
   * a permanent spinner where the provider list should be.
   */
  it('reports a failed provider load instead of spinning forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);
    expect(await screen.findByText('Could not load HRIS providers.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('offers no connection to a provider this deployment has no keys for', async () => {
    mockApi();
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);
    // Pressing it could only ever fail at the OAuth handoff, so it is refused
    // here with the reason next to it.
    expect(await screen.findByRole('button', { name: 'Connect Gusto' })).toBeDisabled();
  });

  it('sends the analyst to the provider’s own consent screen to connect', async () => {
    const user = userEvent.setup();
    // jsdom implements no navigation, so a plain object stands in and the
    // assignment the OAuth handoff makes becomes observable.
    const original = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      value: { href: '' },
      writable: true,
      configurable: true,
    });
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/hris/gusto/connect': () =>
        jsonResponse({ authorize_url: 'https://api.gusto.com/oauth/authorize?state=abc' }),
      'GET /valuations/01N409VAL000000000000000AA/hris': () => jsonResponse({ providers: withGustoKeys }),
    });
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Connect Gusto' }));
    await waitFor(() => expect(window.location.href).toBe('https://api.gusto.com/oauth/authorize?state=abc'));
    if (original) Object.defineProperty(window, 'location', original);
  });

  it('reports a connection handoff the provider refused', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/hris/gusto/connect': () =>
        jsonResponse({ title: 'Bad Gateway', detail: 'Gusto declined the handshake.', status: 502 }, 502),
      'GET /valuations/01N409VAL000000000000000AA/hris': () => jsonResponse({ providers: withGustoKeys }),
    });
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Connect Gusto' }));
    expect(await screen.findByText('Gusto declined the handshake.')).toBeInTheDocument();
    // The button comes back — a failed handoff that leaves it disabled reads as
    // a connection in progress that will never finish.
    expect(screen.getByRole('button', { name: 'Connect Gusto' })).toBeEnabled();
  });

  it('falls back to its own wording when the handoff fails without a problem document', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/hris/gusto/connect': () => {
        throw new TypeError('network down');
      },
      'GET /valuations/01N409VAL000000000000000AA/hris': () => jsonResponse({ providers: withGustoKeys }),
    });
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Connect Gusto' }));
    expect(await screen.findByText(/Could not start the connection\./)).toBeInTheDocument();
  });

  it('reports a failed import without claiming grants arrived', async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/hris/rippling/pull': () =>
        jsonResponse({ title: 'Unauthorized', detail: 'The Rippling token was revoked.', status: 401 }, 401),
    });
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={onImported} />);

    await user.click(await screen.findByRole('button', { name: 'Import now' }));
    expect(await screen.findByText('The Rippling token was revoked.')).toBeInTheDocument();
    expect(onImported).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Import now' })).toBeEnabled();
  });

  it('falls back to its own wording when an import fails without a problem document', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/hris/rippling/pull': () => {
        throw new TypeError('network down');
      },
    });
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Import now' }));
    // Names what was being done, not the verb alone: "Sync failed." stood for
    // this pull and for the cap-table pull one panel over, and the object of
    // the sentence is the only part that told the two apart (R374, M19).
    expect(
      await screen.findByText(/roster and grants could not be pulled from this provider/i),
    ).toBeInTheDocument();
  });

  it('changes the cadence and reloads on the answer', async () => {
    const user = userEvent.setup();
    let frequency = 'manual';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const key = `${init?.method ?? 'GET'} ${String(url).replace(/^.*\/api\/v1/, '')}`;
      if (key.endsWith('/hris/rippling/frequency')) {
        frequency = JSON.parse(String(init!.body)).frequency;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({
        providers: providers.map((p) =>
          p.provider === 'rippling'
            ? { ...p, connection: { ...p.connection!, sync_frequency: frequency } }
            : p,
        ),
      });
    });
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    const cadence = await screen.findByLabelText('Rippling sync frequency');
    await user.selectOptions(cadence, 'weekly');
    // Reloaded rather than assumed: the cadence the server stored is the one
    // the scheduler will actually run on.
    await waitFor(() => expect(screen.getByLabelText('Rippling sync frequency')).toHaveValue('weekly'));
  });

  it('reports a cadence the server would not take', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/hris/rippling/frequency': () =>
        jsonResponse({ title: 'Forbidden', detail: 'Daily sync needs a paid plan.', status: 403 }, 403),
    });
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    await user.selectOptions(await screen.findByLabelText('Rippling sync frequency'), 'daily');
    expect(await screen.findByText('Daily sync needs a paid plan.')).toBeInTheDocument();
  });

  it('disconnects a provider and drops it back to not connected', async () => {
    const user = userEvent.setup();
    let connected = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'DELETE') {
        connected = false;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({
        providers: providers.map((p) =>
          p.provider === 'rippling' ? { ...p, connection: connected ? p.connection : null } : p,
        ),
      });
    });
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('button', { name: 'Connect Rippling' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import now' })).not.toBeInTheDocument();
  });

  /**
   * The one call of the four that swallowed its failure: the rejection went
   * nowhere, the row stayed connected, and the analyst was left to conclude the
   * button does nothing.
   */
  it('reports a disconnect the server refused', async () => {
    const user = userEvent.setup();
    mockApi({
      'DELETE /valuations/01N409VAL000000000000000AA/hris/rippling': () =>
        jsonResponse({ title: 'Conflict', detail: 'A sync is still running.', status: 409 }, 409),
    });
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('A sync is still running.')).toBeInTheDocument();
    // Still connected, because it still is.
    expect(screen.getByRole('button', { name: 'Import now' })).toBeInTheDocument();
  });

  it('falls back to its own wording when a disconnect fails without a problem document', async () => {
    const user = userEvent.setup();
    mockApi({
      'DELETE /valuations/01N409VAL000000000000000AA/hris/rippling': () => {
        throw new TypeError('network down');
      },
    });
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText(/Could not disconnect the provider\./)).toBeInTheDocument();
  });

  it('surfaces the provider’s last error, and treats a revoked link as disconnected', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        providers: [
          {
            provider: 'rippling',
            label: 'Rippling',
            configured: true,
            connection: {
              status: 'revoked',
              external_company_name: 'Acme',
              sync_frequency: 'daily',
              last_synced_at: '2026-07-01T00:00:00Z',
              last_error: 'Refresh token rejected.',
            },
          },
        ],
      }),
    );
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    expect(await screen.findByText('Last error: Refresh token rejected.')).toBeInTheDocument();
    // A revoked link cannot sync, so the row offers reconnection rather than an
    // import button that would fail on every press.
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Rippling' })).toBeInTheDocument();
  });

  it('draws a failing connection as failing, not as connected (R252)', async () => {
    // The card used to show the green "Connected" pill and the cadence select
    // still reading Daily above one line of small red text — for a connection
    // whose scheduled sync had stopped. R252 stops it on purpose when the
    // provider has ended the authorisation, so the pill has to be able to say
    // so and the card has to offer the reconnect the message asks for.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        providers: [
          {
            provider: 'rippling',
            label: 'Rippling',
            configured: true,
            connection: {
              status: 'error',
              external_company_name: 'Acme',
              sync_frequency: 'daily',
              last_synced_at: '2026-07-01T00:00:00Z',
              last_error: 'Rippling no longer accepts the stored authorisation — reconnect Rippling.',
              next_sync_at: null,
              reconnect_required: true,
            },
          },
        ],
      }),
    );
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    expect(await screen.findByText(/Not syncing · Acme/)).toBeInTheDocument();
    expect(screen.queryByText(/Connected · Acme/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect Rippling' })).toBeInTheDocument();
    // Still a live connection: importing by hand and changing the cadence are
    // both things a person may want to do from here.
    expect(screen.getByRole('button', { name: 'Import now' })).toBeInTheDocument();
    /*
     * R262. This fixture is `sync_frequency: 'daily'` on a stopped connection,
     * which is the state round 261 created deliberately: the cadence is what
     * the reconnect will start from, and until then nothing is scheduled.
     * Nothing on the card said so, so the dropdown read "Daily" beside a pill
     * reading "Not syncing" and the analyst who had just set it was left to
     * work out which one was true.
     */
    expect(
      screen.getByText(/Auto-sync is saved, but nothing is scheduled until this connection is reconnected/),
    ).toBeInTheDocument();
  });

  it('says a failure that retries itself is retrying, and does not ask for a reconnect (R256)', async () => {
    /**
     * R252 made `error` two states — an authorisation the provider has ended,
     * which is never retried, and a provider that was briefly unwell, which is
     * retried on a backoff and needs nobody. The card drew both as "Not
     * syncing" with a Reconnect button beside it, so a 503 at three in the
     * morning read as an integration somebody has to go and repair.
     */
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        providers: [
          {
            provider: 'rippling',
            label: 'Rippling',
            configured: true,
            connection: {
              status: 'error',
              external_company_name: 'Acme',
              sync_frequency: 'daily',
              last_synced_at: '2026-07-01T00:00:00Z',
              last_error: 'Rippling roster fetch failed (503)',
              next_sync_at: '2026-07-02T00:15:00Z',
              reconnect_required: false,
            },
          },
        ],
      }),
    );
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    expect(await screen.findByText(/Sync failing · retrying · Acme/)).toBeInTheDocument();
    expect(screen.queryByText(/Not syncing/)).not.toBeInTheDocument();
    // The promise the backoff is actually making, in front of the person who
    // would otherwise go and redo an authorisation that is working.
    expect(screen.getByText(/Retrying automatically — next attempt/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect Rippling' })).not.toBeInTheDocument();
    // Nothing about it stops a person syncing by hand in the meantime.
    expect(screen.getByRole('button', { name: 'Import now' })).toBeInTheDocument();
    // And the cadence on this one *is* running, so it must not be told it is not.
    expect(screen.queryByText(/nothing is scheduled/)).not.toBeInTheDocument();
  });

  it('asks for a reconnect when the failure is one no retry can clear (R256)', async () => {
    // A `manual` connection has no `next_sync_at` in either state, which is why
    // the row carries the answer rather than the panel inferring one.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        providers: [
          {
            provider: 'rippling',
            label: 'Rippling',
            configured: true,
            connection: {
              status: 'error',
              external_company_name: 'Acme',
              sync_frequency: 'manual',
              last_synced_at: '2026-07-01T00:00:00Z',
              last_error: 'Rippling no longer accepts the stored authorisation — reconnect Rippling.',
              next_sync_at: null,
              reconnect_required: true,
            },
          },
        ],
      }),
    );
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    expect(await screen.findByText(/Not syncing · Acme/)).toBeInTheDocument();
    expect(screen.queryByText(/Retrying automatically/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect Rippling' })).toBeInTheDocument();
  });

  it('shows a connection with no company name without a dangling separator', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        providers: [
          {
            provider: 'deel',
            label: 'Deel',
            configured: true,
            connection: {
              status: 'connected',
              external_company_name: null,
              sync_frequency: 'manual',
              last_synced_at: null,
              last_error: null,
            },
          },
        ],
      }),
    );
    renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    const badge = await screen.findByText('Connected');
    expect(badge.textContent).toBe('Connected');
  });
  /**
   * The other half of the OAuth hop, which this panel did not have at all.
   *
   * `/api/v1/hris/callback` redirects back here with `?hris=…` and
   * `?provider=…`; nothing read either. So the two ways the hop fails — the
   * reader pressing Cancel on Rippling's consent screen, and a token exchange
   * that did not work — returned to a panel that looked exactly as it had
   * before they left. The list refetches, finds no connection, and draws the
   * same Connect button: no wrong claim, and no answer either.
   */
  describe('the OAuth callback outcome in the URL', () => {
    it('says a cancelled connection was cancelled, and that nothing was connected', async () => {
      mockApi();
      renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />, '/?hris=denied&provider=gusto');
      const note = await screen.findByRole('alert');
      expect(note).toHaveTextContent(/Connection to Gusto was cancelled/);
      expect(note).toHaveTextContent(/nothing was connected/);
    });

    it('names the retirement rather than offering the button again', async () => {
      // The engagement was withdrawn while the reader was on the consent
      // screen — see the callback's own guard. Not a failure they can retry.
      mockApi();
      renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />, '/?hris=retired&provider=deel');
      const note = await screen.findByRole('alert');
      expect(note).toHaveTextContent(/This engagement was retired while you were connecting to Deel/);
      expect(note).not.toHaveTextContent(/Press Connect to try again/);
    });

    it('does not claim nothing was connected when the provider granted access', async () => {
      /*
       * R382, methodology M5. `unstored` is the callback's word for the one
       * outcome that is neither a success nor a refusal: the exchange returned,
       * so the provider minted an access token and a refresh token against this
       * deployment's OAuth app, and the write that stores them failed. It used
       * to arrive as `error`, whose sentence is "nothing was connected — press
       * Connect to try again" — false about a third party's standing access to
       * the client's payroll, on the one screen whose job is to say what was
       * just granted, and an instruction that mints a second grant.
       */
      mockApi();
      renderPanel(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />, '/?hris=unstored&provider=gusto');
      const note = await screen.findByRole('alert');
      expect(note).toHaveTextContent(/Gusto granted access/);
      expect(note).not.toHaveTextContent(/nothing was connected/);
      // The remedy is to revoke, not to retry.
      expect(note).not.toHaveTextContent(/Press Connect to try again/);
      expect(note).toHaveTextContent(/revoke/);
    });

    it('will not print a provider name the server did not send', async () => {
      mockApi();
      renderPanel(
        <HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />,
        '/?hris=error&provider=__proto__',
      );
      const note = await screen.findByRole('alert');
      expect(note).toHaveTextContent(/Connecting to the provider failed/);
    });
  });
});
