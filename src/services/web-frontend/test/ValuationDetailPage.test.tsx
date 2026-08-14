import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ValuationDetailPage } from '../src/pages/ValuationDetailPage';
import type { User, Valuation, ValuationEvent } from '../src/lib/types';

/**
 * The overview tab: engagement facts, the role-gated edit form (with its
 * optimistic-lock conflict path), clone/roll-forward, and the audit timeline.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let mockUser: User;
vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

let VALUATION: Valuation;
const reload = vi.fn(async () => {});
vi.mock('../src/pages/valuation/ValuationWorkspace', () => ({
  useWorkspace: () => ({ valuation: VALUATION, reload, commentTick: 0 }),
}));

function valuation(over: Partial<Valuation> = {}): Valuation {
  return {
    id: '01TESTVALUATION0000000000A',
    number: 42,
    kind: '409a',
    state: 'pending',
    company_name: 'Acme Robotics, Inc.',
    service_name: null,
    user_id: '01N409USER00000000000000CL',
    partner_id: null,
    source: 'direct',
    currency: 'USD',
    service_countries: null,
    waiting_on_client: false,
    assigned_reviewer_id: null,
    due_date: '2026-09-30',
    delivery_days: 10,
    paid_status: 'unpaid',
    qsbs_attestation: null,
    version: 7,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...over,
  } as Valuation;
}

const opsUser = { id: 'op', email: 'ops@n409.ai', roles: ['admin'] } as unknown as User;
const clientUser = {
  id: '01N409USER00000000000000CL',
  email: 'c@acme.com',
  roles: ['valuation_user'],
} as unknown as User;
const strangerUser = { id: 'other', email: 'x@y.com', roles: ['investor'] } as unknown as User;

interface Recorded {
  url: string;
  method: string;
  body: unknown;
  headers: Headers;
}

/**
 * One permissive stub for everything the page's children fetch, with hooks for
 * the two calls each test actually cares about.
 */
function stubFetches(
  recorded: Recorded[] = [],
  hooks: { events?: () => Response; patch?: () => Response; clone?: () => Response } = {},
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    recorded.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    });
    if (url.includes('/events')) return (hooks.events ?? (() => jsonResponse({ events: [] })))();
    if (url.includes('/clone')) {
      return (hooks.clone ?? (() => jsonResponse({ valuation: valuation({ id: 'CLONE-1' }) })))();
    }
    if (method === 'PATCH') return (hooks.patch ?? (() => jsonResponse({ ok: true })))();
    return jsonResponse({
      events: [],
      comments: [],
      rounds: [],
      transactions: [],
      payments: [],
      signatures: [],
      options: [],
      links: [],
      organizations: [],
      quote: { configured: false, amount_cents: 0, currency: 'USD', kind: '409a' },
    });
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/valuations/01TESTVALUATION0000000000A']}>
      <Routes>
        <Route path="/valuations/:id" element={<ValuationDetailPage />} />
        <Route path="/valuations/CLONE-1" element={<div>CLONED VALUATION</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const event = (over: Partial<ValuationEvent> = {}): ValuationEvent =>
  ({
    id: `ev-${Math.random().toString(36).slice(2)}`,
    valuation_id: '01TESTVALUATION0000000000A',
    seq: '1',
    type: 'created',
    actor_type: 'user',
    actor_id: 'u1',
    source: null,
    payload: null,
    occurred_at: '2026-06-01T12:00:00Z',
    ...over,
  }) as ValuationEvent;

describe('ValuationDetailPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    reload.mockClear();
    VALUATION = valuation();
    mockUser = opsUser;
  });

  describe('engagement details', () => {
    it('lists the facts an analyst opens the tab for', async () => {
      stubFetches();
      renderPage();

      expect(await screen.findByText('Engagement details')).toBeInTheDocument();
      expect(screen.getByText('USD')).toBeInTheDocument();
      expect(screen.getByText('10 days')).toBeInTheDocument();
      expect(screen.getByText('Unpaid')).toBeInTheDocument();
    });

    it('distinguishes a partner-paid engagement from a client-paid one', async () => {
      VALUATION = valuation({ paid_status: 'paid_by_partner' });
      stubFetches();
      const { unmount } = renderPage();
      expect((await screen.findByText('Payment')).parentElement).toHaveTextContent('Paid by partner');
      unmount();

      VALUATION = valuation({ paid_status: 'paid' });
      renderPage();
      const payment = await screen.findByText('Payment');
      expect(payment.parentElement).toHaveTextContent(/^PaymentPaid$/);
    });

    it('renders an unanswered QSBS attestation as unanswered, not as "No"', async () => {
      stubFetches();
      renderPage();
      const qsbs = await screen.findByText('QSBS attestation');
      expect(qsbs.parentElement).toHaveTextContent('—');
    });

    it('answers the QSBS attestation once the client has', async () => {
      VALUATION = valuation({ qsbs_attestation: true });
      stubFetches();
      renderPage();
      const qsbs = await screen.findByText('QSBS attestation');
      expect(qsbs.parentElement).toHaveTextContent('Yes');
    });

    it('keeps the source and reviewer fields to ops', async () => {
      mockUser = clientUser;
      stubFetches();
      renderPage();

      await screen.findByText('Engagement details');
      expect(screen.queryByText('Source')).not.toBeInTheDocument();
      expect(screen.queryByText('Reviewer')).not.toBeInTheDocument();
    });
  });

  describe('the activity timeline', () => {
    it('says nothing has happened only when nothing has', async () => {
      stubFetches();
      renderPage();
      expect(await screen.findByText('No activity yet.')).toBeInTheDocument();
    });

    it('spells out a state transition', async () => {
      stubFetches([], {
        events: () =>
          jsonResponse({
            events: [event({ type: 'state_changed', payload: { from: 'pending', to: 'started' } })],
          }),
      });
      renderPage();
      expect(await screen.findByText('pending → started')).toBeInTheDocument();
    });

    it('says which way a review decision went', async () => {
      stubFetches([], {
        events: () =>
          jsonResponse({
            events: [
              event({
                type: 'review_decision',
                payload: { decision: 'approve', from: 'review', to: 'reviewed' },
              }),
              event({
                type: 'review_decision',
                payload: { decision: 'request_changes', from: 'review', to: 'drafted' },
              }),
            ],
          }),
      });
      renderPage();
      expect(await screen.findByText(/Approved · review → reviewed/)).toBeInTheDocument();
      expect(screen.getByText(/Changes requested · review → drafted/)).toBeInTheDocument();
    });

    it('names the field an overwrite touched', async () => {
      stubFetches([], {
        events: () =>
          jsonResponse({
            events: [
              event({ type: 'overwrite_applied', payload: { field_key: 'discounts.dlom' } }),
              event({ type: 'overwrite_reverted', payload: { field_key: 'wacc.beta' } }),
            ],
          }),
      });
      renderPage();
      expect(await screen.findByText('discounts.dlom')).toBeInTheDocument();
      expect(screen.getByText('wacc.beta')).toBeInTheDocument();
    });

    it('reports a failed load instead of claiming there is no activity', async () => {
      stubFetches([], {
        events: () => jsonResponse({ title: 'Forbidden', detail: 'Not your engagement.' }, 403),
      });
      renderPage();

      expect(await screen.findByText('Not your engagement.')).toBeInTheDocument();
      expect(screen.queryByText('No activity yet.')).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  describe('the edit form', () => {
    it('is absent entirely for someone with nothing to edit', async () => {
      mockUser = strangerUser;
      stubFetches();
      renderPage();

      await screen.findByText('Engagement details');
      expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    });

    it('offers a client their two fields and not the ops-only state', async () => {
      mockUser = clientUser;
      stubFetches();
      renderPage();

      expect(await screen.findByLabelText('Company name')).toBeInTheDocument();
      expect(screen.getByLabelText('Service name')).toBeInTheDocument();
      expect(screen.queryByLabelText('State')).not.toBeInTheDocument();
    });

    it('patches only what changed, guarded by the version it rendered from', async () => {
      const calls: Recorded[] = [];
      stubFetches(calls);
      renderPage();

      const name = await screen.findByLabelText('Company name');
      await userEvent.clear(name);
      await userEvent.type(name, '  Acme Robotics Holdings  ');
      await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(screen.getByText('Changes saved.')).toBeInTheDocument());
      const patch = calls.find((c) => c.method === 'PATCH')!;
      // Trimmed, and the untouched service name is not in the payload at all.
      expect(patch.body).toEqual({ company_name: 'Acme Robotics Holdings' });
      expect(patch.headers.get('if-match')).toBe('"7"');
      expect(reload).toHaveBeenCalled();
    });

    it('sends a cleared service name as null rather than an empty string', async () => {
      VALUATION = valuation({ service_name: '409A FY26' });
      const calls: Recorded[] = [];
      stubFetches(calls);
      renderPage();

      await userEvent.clear(await screen.findByLabelText('Service name'));
      await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(screen.getByText('Changes saved.')).toBeInTheDocument());
      expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ service_name: null });
    });

    it('records a state change ops picked from the audit-trailed dropdown', async () => {
      const calls: Recorded[] = [];
      stubFetches(calls);
      renderPage();

      await userEvent.selectOptions(await screen.findByLabelText('State'), 'started');
      await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(screen.getByText('Changes saved.')).toBeInTheDocument());
      expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ state: 'started' });
    });

    it('confirms a no-op save without troubling the API', async () => {
      const calls: Recorded[] = [];
      stubFetches(calls);
      renderPage();

      await userEvent.click(await screen.findByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(screen.getByText('Changes saved.')).toBeInTheDocument());
      expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    });

    it('reloads the page on a conflict so the analyst retypes against what landed', async () => {
      const calls: Recorded[] = [];
      stubFetches(calls, {
        patch: () =>
          jsonResponse({ title: 'Conflict', detail: 'Rae saved this 30 seconds ago.', status: 409 }, 409),
      });
      renderPage();

      const name = await screen.findByLabelText('Company name');
      await userEvent.type(name, ' Ltd');
      await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Rae saved this 30 seconds ago.');
      expect(screen.queryByText('Changes saved.')).not.toBeInTheDocument();
      // The reload is what makes the conflict recoverable rather than a dead end.
      expect(reload).toHaveBeenCalled();
    });

    it('explains a conflict the server did not narrate', async () => {
      stubFetches([], { patch: () => jsonResponse({ status: 409 }, 409) });
      renderPage();

      await userEvent.type(await screen.findByLabelText('Company name'), ' Ltd');
      await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/Someone else changed this valuation/i);
    });

    it('surfaces an ordinary rejected save', async () => {
      stubFetches([], {
        patch: () => jsonResponse({ title: 'Unprocessable', detail: 'Company name is too long.' }, 422),
      });
      renderPage();

      await userEvent.type(await screen.findByLabelText('Company name'), ' Ltd');
      await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Company name is too long.');
      expect(reload).not.toHaveBeenCalled();
    });

    /**
     * R30 — a disabled button with no message reads as a broken save on the one
     * form whose job is renaming, so the rule says which box is empty.
     */
    it('will not save a blank company name, and says which box is empty', async () => {
      const calls: Recorded[] = [];
      stubFetches(calls);
      renderPage();

      await userEvent.clear(await screen.findByLabelText('Company name'));
      await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      expect(await screen.findByText('Company name is required.')).toBeInTheDocument();
      expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    });
  });

  describe('clone and roll-forward', () => {
    it('opens the copy it just made', async () => {
      const calls: Recorded[] = [];
      stubFetches(calls);
      renderPage();

      await userEvent.click(await screen.findByRole('button', { name: /^clone$/i }));

      expect(await screen.findByText('CLONED VALUATION')).toBeInTheDocument();
      expect(calls.find((c) => c.url.includes('/clone'))!.body).toEqual({ roll_forward: false });
    });

    it('rolls forward under the same endpoint with the flag set', async () => {
      const calls: Recorded[] = [];
      stubFetches(calls);
      renderPage();

      await userEvent.click(await screen.findByRole('button', { name: /roll forward/i }));

      expect(await screen.findByText('CLONED VALUATION')).toBeInTheDocument();
      expect(calls.find((c) => c.url.includes('/clone'))!.body).toEqual({ roll_forward: true });
    });

    it('stays put and explains itself when the clone is refused', async () => {
      stubFetches([], {
        clone: () =>
          jsonResponse({ title: 'Forbidden', detail: 'A published valuation cannot be cloned.' }, 403),
      });
      renderPage();

      await userEvent.click(await screen.findByRole('button', { name: /^clone$/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('A published valuation cannot be cloned.');
      expect(screen.queryByText('CLONED VALUATION')).not.toBeInTheDocument();
    });
  });
});
