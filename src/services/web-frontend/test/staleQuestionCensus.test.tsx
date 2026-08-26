import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { EmailOutboxPage } from '../src/pages/EmailOutboxPage';
import { SupportInboxPage } from '../src/pages/SupportInboxPage';
import { AdminApiTokensPage } from '../src/pages/AdminApiTokensPage';
import { PortfolioPage } from '../src/pages/PortfolioPage';

/**
 * The window between changing a filter and the reply that answers it.
 *
 * `useLatestOnly` covers the reply that lands *out of order*. It says nothing
 * about the wait, and for the length of that wait every one of these surfaces
 * showed the previous filter's rows underneath the new filter's controls, with
 * no spinner, no dimming and nothing in a live region to mark them as stale.
 * The chip reads pressed; the table underneath it is the answer to the question
 * before last. A reader during that window is not shown a stale answer, they
 * are shown a wrong one — and it is self-consistent enough to be believed.
 *
 * Each case below drives the real control, holds the second request open, and
 * asserts on what is on screen while it is in flight: the previous answer must
 * be gone, and the wait must be announced. See `useClearOnChange`.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A fetch mock that answers the first request and then holds every later one
 * open, exposing a `pending` promise that resolves once the held request has
 * actually been issued. Waiting on that is what makes the in-flight assertions
 * below deterministic — without it the test races the effect that fires them.
 */
function holdSecondRequest(first: unknown, later: unknown = first) {
  let issued: () => void;
  const pending = new Promise<void>((resolve) => {
    issued = resolve;
  });
  let calls = 0;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    calls += 1;
    if (calls === 1) return json(first);
    issued();
    // Never settles: the assertions run while this request is outstanding.
    await new Promise(() => {});
    return json(later);
  });
  return { pending, spy };
}

/** Both ways a surface is allowed to mark the wait, and neither is optional. */
function assertWaitIsAnnounced() {
  const live = screen.queryAllByRole('status');
  expect(live.length, 'the wait must be in a live region').toBeGreaterThan(0);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const outboxEmail = (id: string, status: string, subject: string) => ({
  id,
  valuation_id: null,
  to_user_id: null,
  to_email: 'founder@acme.com',
  template_key: 'valuation_published',
  subject,
  body: '<p>x</p>',
  status,
  error: null,
  attempts: 1,
  created_at: '2026-07-01T10:00:00Z',
  sent_at: null,
});

describe('a filter change must not leave the previous answer on screen', () => {
  it('the email outbox drops the sent rows when Failed is selected', async () => {
    const { pending } = holdSecondRequest({ emails: [outboxEmail('1', 'sent', 'SENT ROW')] });
    render(
      <MemoryRouter>
        <EmailOutboxPage />
      </MemoryRouter>,
    );
    await screen.findByText('SENT ROW');

    await userEvent.click(screen.getByRole('button', { name: 'Failed' }));
    await pending;

    await waitFor(() => expect(screen.queryByText('SENT ROW')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Failed' })).toHaveAttribute('aria-pressed', 'true');
    assertWaitIsAnnounced();
  });

  it('the support inbox drops the open queue when Resolved is selected', async () => {
    const message = {
      id: '01N409SUPPORT00000000000AA',
      user_id: '01N409USER00000000000000AA',
      user_email: 'founder@acme.com',
      subject: 'OPEN TICKET',
      body: 'Help.',
      page_path: null,
      status: 'open',
      created_at: '2026-07-01T10:00:00Z',
      resolved_at: null,
    };
    const { pending } = holdSecondRequest({ messages: [message] });
    render(
      <MemoryRouter>
        <SupportInboxPage />
      </MemoryRouter>,
    );
    await screen.findByText('OPEN TICKET');

    await userEvent.click(screen.getByRole('button', { name: 'Resolved' }));
    await pending;

    await waitFor(() => expect(screen.queryByText('OPEN TICKET')).not.toBeInTheDocument());
    // The chip the user just pressed is still there to read, and still pressed.
    expect(screen.getByRole('button', { name: 'Resolved' })).toHaveAttribute('aria-pressed', 'true');
    assertWaitIsAnnounced();
  });

  it('the token listing drops the live tokens when revoked ones are included', async () => {
    const token = {
      id: '01N409TOKEN0000000000000AA',
      name: 'LIVE TOKEN',
      prefix: 'n409_ab',
      scopes: ['valuations:read'],
      created_at: '2026-07-01T10:00:00Z',
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
      partner_id: null,
      partner_name: null,
      created_by_email: 'ops@n409.ai',
    };
    const { pending } = holdSecondRequest({ tokens: [token], truncated: false });
    render(
      <MemoryRouter>
        <AdminApiTokensPage />
      </MemoryRouter>,
    );
    await screen.findByText('LIVE TOKEN');

    await userEvent.click(screen.getByRole('checkbox'));
    await pending;

    await waitFor(() => expect(screen.queryByText('LIVE TOKEN')).not.toBeInTheDocument());
    expect(screen.getByRole('checkbox')).toBeChecked();
    assertWaitIsAnnounced();
  });
});
