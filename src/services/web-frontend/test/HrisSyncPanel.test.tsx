import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('HrisSyncPanel (feature 11)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists providers and imports grants, reporting the result', async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/hris/rippling/pull': () =>
        jsonResponse({ roster_count: 12, grants_found: 8, grants_created: 8, grants_skipped: 0 }),
    });
    render(<HrisSyncPanel valuationId={VAL} onImported={onImported} />);

    expect(await screen.findByText('Rippling')).toBeInTheDocument();
    expect(screen.getByText(/Connected · Acme/)).toBeInTheDocument();
    expect(screen.getAllByText('Not configured on this deployment')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Import now' }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(screen.getByText(/8 grants imported/)).toBeInTheDocument();
  });

  /**
   * The panel set an error on a failed load and then returned a spinner, so
   * the ErrorNote it wrote sat in markup that never rendered. The tab showed
   * a permanent spinner where the provider list should be.
   */
  it('reports a failed provider load instead of spinning forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    render(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);
    expect(await screen.findByText('Could not load HRIS providers.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('offers no connection to a provider this deployment has no keys for', async () => {
    mockApi();
    render(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);
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
    render(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

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
    render(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

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
    render(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Connect Gusto' }));
    expect(await screen.findByText('Could not start the connection.')).toBeInTheDocument();
  });

  it('reports a failed import without claiming grants arrived', async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    mockApi({
      'POST /valuations/01N409VAL000000000000000AA/hris/rippling/pull': () =>
        jsonResponse({ title: 'Unauthorized', detail: 'The Rippling token was revoked.', status: 401 }, 401),
    });
    render(<HrisSyncPanel valuationId={VAL} onImported={onImported} />);

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
    render(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Import now' }));
    expect(await screen.findByText('Sync failed.')).toBeInTheDocument();
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
    render(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

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
    render(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

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
    render(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

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
    render(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

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
    render(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Could not disconnect the provider.')).toBeInTheDocument();
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
    render(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    expect(await screen.findByText('Last error: Refresh token rejected.')).toBeInTheDocument();
    // A revoked link cannot sync, so the row offers reconnection rather than an
    // import button that would fail on every press.
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Rippling' })).toBeInTheDocument();
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
    render(<HrisSyncPanel valuationId={VAL} onImported={vi.fn()} />);

    const badge = await screen.findByText('Connected');
    expect(badge.textContent).toBe('Connected');
  });
});
