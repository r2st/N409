import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapTableSyncPanel } from '../src/components/valuation/CapTableSyncPanel';

const VAL_ID = '01N409VAL000000000000000AA';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const providers = [
  {
    provider: 'carta',
    label: 'Carta',
    configured: true,
    connection: {
      status: 'connected',
      external_company_name: 'Acme Inc',
      sync_frequency: 'manual',
      last_synced_at: null,
      last_error: null,
    },
  },
  { provider: 'pulley', label: 'Pulley', configured: false, connection: null },
];

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
      { security_class: 'Series A', status: 'changed', changes: [{ field: 'shares', from: 2000000, to: 2500000 }] },
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

describe('CapTableSyncPanel (feature 4)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists providers with their connection state', async () => {
    mockApi();
    render(<CapTableSyncPanel valuationId={VAL_ID} onApplied={() => {}} />);
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
    render(<CapTableSyncPanel valuationId={VAL_ID} onApplied={onApplied} />);

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByTestId('sync-conflicts')).toBeInTheDocument();
    expect(screen.getByText(/1 changed · 1 added/)).toBeInTheDocument();
    expect(screen.getByText('Series A')).toBeInTheDocument();

    applied = true;
    await user.click(screen.getByRole('button', { name: 'Apply provider data' }));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });
});
