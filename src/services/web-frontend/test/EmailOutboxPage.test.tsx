import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { EmailOutboxPage } from '../src/pages/EmailOutboxPage';
import type { OutboxEmail } from '../src/lib/types';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const emails: OutboxEmail[] = [
  {
    id: '01N409EMAIL0000000000000AA',
    valuation_id: '01N409VAL000000000000000AA',
    to_user_id: null,
    to_email: 'founder@acme.com',
    template_key: 'valuation_published',
    subject: 'Your 409A valuation is ready',
    body: '<p>Ready.</p>',
    status: 'sent',
    error: null,
    attempts: 1,
    created_at: '2026-07-01T10:00:00Z',
    sent_at: '2026-07-01T10:00:05Z',
  },
  {
    id: '01N409EMAIL0000000000000BB',
    valuation_id: null,
    to_user_id: null,
    to_email: 'cfo@zebra.com',
    template_key: 'review_started',
    subject: 'Your valuation is in review',
    body: '<p>In review.</p>',
    status: 'failed',
    error: 'SMTP connect timeout',
    attempts: 3,
    created_at: '2026-07-02T09:00:00Z',
    sent_at: null,
  },
];

function mockApi(items: OutboxEmail[] = emails) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    if (path.includes('/admin/email-outbox')) {
      const status = new URL(path, 'http://test').searchParams.get('status');
      return jsonResponse({ emails: status ? items.filter((e) => e.status === status) : items });
    }
    throw new Error(`unexpected fetch ${path}`);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <EmailOutboxPage />
    </MemoryRouter>,
  );
}

describe('EmailOutboxPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lists outbox emails with status, attempts, and errors', async () => {
    mockApi();
    renderPage();

    expect(await screen.findByText('founder@acme.com')).toBeInTheDocument();
    expect(screen.getByText('valuation_published')).toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'Email outbox' });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Sent');
    expect(rows[2]).toHaveTextContent('Failed');
    expect(rows[2]).toHaveTextContent('SMTP connect timeout');
    expect(rows[2]).toHaveTextContent('3');

    // Valuation-linked emails offer a drill-through to the engagement.
    expect(screen.getByRole('link', { name: 'View valuation →' })).toHaveAttribute(
      'href',
      '/valuations/01N409VAL000000000000000AA',
    );
  });

  it('filters by status via the chips', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockApi();
    renderPage();
    await screen.findByText('founder@acme.com');

    await user.click(screen.getByRole('button', { name: 'Failed' }));

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([url]) => String(url).includes('/admin/email-outbox?status=failed')),
      ).toBe(true);
      expect(screen.queryByText('founder@acme.com')).not.toBeInTheDocument();
      expect(screen.getByText('cfo@zebra.com')).toBeInTheDocument();
    });
  });

  /**
   * The regression this page carried since migration 0163: `status` records
   * what the platform did with a message, and the page rendered it as though
   * it recorded what became of the message. A hard bounce arrives *after* a
   * successful hand-off to the relay, so the row stays `status: 'sent'` for
   * ever — and the operator who came to this page to ask "why did the client
   * not get this" was shown a green Sent badge.
   */
  it('shows a bounce on a message the relay accepted, not Sent', async () => {
    mockApi([
      {
        ...emails[0]!,
        status: 'sent',
        delivery_state: 'bounced',
        bounced_at: '2026-07-01T10:00:30Z',
        bounce_kind: 'hard',
        bounce_detail: '550 5.1.1 unknown recipient',
      },
    ]);
    renderPage();

    const row = (await screen.findByText('founder@acme.com')).closest('tr')!;
    expect(within(row).getByText('Bounced')).toBeInTheDocument();
    expect(within(row).queryByText('Sent')).not.toBeInTheDocument();
    // The kind decides what happens next — hard ends the retry ladder and
    // suppresses the address — so it is named, not merely coloured red.
    expect(row).toHaveTextContent('hard bounce');
    expect(row).toHaveTextContent('550 5.1.1 unknown recipient');
  });

  it('distinguishes a complaint from an ordinary bounce', async () => {
    mockApi([
      {
        ...emails[0]!,
        status: 'sent',
        delivery_state: 'complained',
        delivered_at: '2026-07-01T10:00:20Z',
        bounced_at: '2026-07-03T08:00:00Z',
        bounce_kind: 'complaint',
      },
    ]);
    renderPage();

    // Delivered *and* complained: the complaint is the fact to act on, so it
    // is what the badge says.
    const row = (await screen.findByText('founder@acme.com')).closest('tr')!;
    expect(within(row).getByText('Complained')).toBeInTheDocument();
    expect(within(row).queryByText('Delivered')).not.toBeInTheDocument();
  });

  it('reports delivery and opens alongside the send time', async () => {
    mockApi([
      {
        ...emails[0]!,
        status: 'sent',
        delivery_state: 'opened',
        delivered_at: '2026-07-01T10:00:20Z',
        first_opened_at: '2026-07-01T11:30:00Z',
        last_opened_at: '2026-07-02T09:00:00Z',
        open_count: 3,
      },
    ]);
    renderPage();

    const row = (await screen.findByText('founder@acme.com')).closest('tr')!;
    expect(within(row).getByText('Opened')).toBeInTheDocument();
    expect(row).toHaveTextContent('Delivered');
    expect(row).toHaveTextContent('Opened 3×');
  });

  /**
   * Zero opens is not the same claim as "nobody read it" — the count is a floor
   * that image blockers push down — so an unfetched pixel says nothing at all
   * rather than printing a zero that reads as a finding.
   */
  it('says nothing about opens when the pixel was never fetched', async () => {
    mockApi([
      { ...emails[0]!, delivery_state: 'delivered', delivered_at: '2026-07-01T10:00:20Z', open_count: 0 },
    ]);
    renderPage();

    const row = (await screen.findByText('founder@acme.com')).closest('tr')!;
    expect(row).not.toHaveTextContent(/Opened/);
  });

  /**
   * A response cached from a build older than the derivation carries no
   * `delivery_state`. The platform status is still a true thing to say about
   * the message, so the badge says it rather than rendering nothing.
   */
  it('falls back to the platform status when the server sent no delivery state', async () => {
    mockApi([{ ...emails[0]!, status: 'queued', delivery_state: undefined }]);
    renderPage();

    const row = (await screen.findByText('founder@acme.com')).closest('tr')!;
    expect(within(row).getByText('Queued')).toBeInTheDocument();
  });

  it('shows an ops-only note on 403', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ title: 'Forbidden', status: 403 }, 403),
    );
    renderPage();
    expect(await screen.findByText('The email outbox is operations-only.')).toBeInTheDocument();
  });
});
