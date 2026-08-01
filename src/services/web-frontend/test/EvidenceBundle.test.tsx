import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ValuationDetailPage } from '../src/pages/ValuationDetailPage';
import type { User, Valuation } from '../src/lib/types';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let mockUser: User;
vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

const VALUATION = {
  id: '01TESTVALUATION0000000000A',
  number: 42,
  kind: '409a',
  state: 'pending',
  company_name: 'Acme Robotics, Inc.',
  service_name: null,
  user_id: '01N409USER00000000000000CL',
  partner_id: null,
  currency: 'USD',
  waiting_on_client: false,
  paid_status: 'paid',
  qsbs_attestation: null,
  created_at: '2026-06-01T00:00:00Z',
} as unknown as Valuation;

vi.mock('../src/pages/valuation/ValuationWorkspace', () => ({
  useWorkspace: () => ({ valuation: VALUATION, reload: async () => {} }),
}));

const opsUser = {
  id: '01N409USER00000000000000OP',
  email: 'ops@example.com',
  roles: ['admin'],
} as unknown as User;
const clientUser = {
  id: '01N409USER00000000000000CL',
  email: 'c@example.com',
  roles: ['valuation_user'],
} as unknown as User;

/** Everything the detail page's children fetch, in one permissive stub. */
function stubPageFetches(onBundle?: (init?: RequestInit) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes('/evidence-bundle')) {
      if (onBundle) return onBundle(init);
      return new Response(new Blob(['PK']), {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="evidence-bundle-42-2026-07-07.zip"',
        },
      });
    }
    return jsonResponse({
      events: [],
      comments: [],
      rounds: [],
      transactions: [],
      payments: [],
      signatures: [],
      options: [],
      quote: { configured: false, amount_cents: 0, currency: 'USD', kind: '409a' },
    });
  });
}

describe('Export Evidence Bundle button', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // jsdom lacks createObjectURL — apiDownload needs both.
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
  });

  it('renders for ops and POSTs to the evidence-bundle endpoint', async () => {
    mockUser = opsUser;
    const fetchSpy = stubPageFetches();
    render(
      <MemoryRouter>
        <ValuationDetailPage />
      </MemoryRouter>,
    );

    const button = await screen.findByRole('button', { name: /export evidence bundle/i });
    await userEvent.click(button);

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([input]) => String(input).includes('/evidence-bundle'));
      expect(call).toBeTruthy();
      expect(call![0]).toBe(`/api/v1/valuations/${VALUATION.id}/evidence-bundle`);
      expect((call![1] as RequestInit).method).toBe('POST');
    });
  });

  it('is hidden from clients', async () => {
    mockUser = clientUser;
    stubPageFetches();
    render(
      <MemoryRouter>
        <ValuationDetailPage />
      </MemoryRouter>,
    );
    // Page renders (clone is available to everyone)…
    await screen.findByRole('button', { name: /^clone$/i });
    // …but the ops-only export is absent.
    expect(screen.queryByRole('button', { name: /export evidence bundle/i })).toBeNull();
  });

  it('surfaces an error when the export fails', async () => {
    mockUser = opsUser;
    stubPageFetches(() =>
      jsonResponse({ title: 'Forbidden', detail: 'Evidence bundles are operations-only' }, 403),
    );
    render(
      <MemoryRouter>
        <ValuationDetailPage />
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole('button', { name: /export evidence bundle/i }));
    await screen.findByText(/operations-only/i);
  });
});
