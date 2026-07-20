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
    connection: { status: 'connected', external_company_name: 'Acme', sync_frequency: 'manual', last_synced_at: null, last_error: null },
  },
  { provider: 'gusto', label: 'Gusto', configured: false, connection: null },
  { provider: 'deel', label: 'Deel', configured: false, connection: null },
];

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
});
