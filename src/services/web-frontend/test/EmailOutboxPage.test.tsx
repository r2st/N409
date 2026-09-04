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
    body_length: 14,
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
    body_length: 18,
    status: 'failed',
    error: 'SMTP connect timeout',
    attempts: 3,
    created_at: '2026-07-02T09:00:00Z',
    sent_at: null,
  },
];

/** R191: the window's counts and its derived rates, served beside the table. */
const DELIVERY_STATS = {
  totals: {
    window_days: 30,
    total: 10,
    queued: 1,
    sent: 8,
    failed: 1,
    skipped: 0,
    delivered: 6,
    bounced: 1,
    complained: 0,
    opened: 3,
    suppressed_addresses: 2,
  },
  rates: { delivered: 0.75, bounced: 0.125, opened: 0.5, send_failure: 0.1 },
  by_template: [{ template_key: 'valuation_published', total: 6, delivered: 5, bounced: 1, failed: 0 }],
};

const DELIVERY_EVENTS = {
  events: [
    {
      id: 'E1',
      kind: 'bounced',
      occurred_at: '2026-07-02T09:05:00Z',
      received_at: '2026-07-02T09:05:10Z',
      source: 'webhook:postmark',
      bounce_kind: 'hard',
      detail: '550 no such user',
    },
  ],
};

function mockApi(items: OutboxEmail[] = emails, overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    for (const [fragment, body] of Object.entries(overrides)) {
      if (path.includes(fragment)) return jsonResponse(body);
    }
    if (path.includes('/admin/email/delivery-stats')) return jsonResponse(DELIVERY_STATS);
    if (path.includes('/admin/email/suppressions'))
      return jsonResponse({ suppressions: [], truncated: false });
    if (path.includes('/delivery-events')) return jsonResponse(DELIVERY_EVENTS);
    if (path.includes('/admin/outbox/retry')) return jsonResponse({ attempted: 1, sent: 1 });
    if (path.includes('/admin/email-outbox')) {
      const status = new URL(path, 'http://test').searchParams.get('status');
      return jsonResponse({ emails: status ? items.filter((e) => e.status === status) : items });
    }
    throw new Error(`unexpected fetch ${path}`);
  });
  return Object.assign(spy, { calls });
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

    const table = screen.getByRole('table', { name: 'Email outbox' });
    // Scoped: R191 put a per-template breakdown on the page, so a template key
    // now appears in two tables and a bare `getByText` matches both.
    expect(within(table).getByText('valuation_published')).toBeInTheDocument();
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

describe('EmailOutboxPage — the endpoints that had no caller (R191)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('draws the window rates with the sample behind each one', async () => {
    mockApi();
    renderPage();
    const stats = await screen.findByLabelText('Delivery statistics');
    expect(within(stats).getByText('75.0%')).toBeInTheDocument();
    // A rate with no denominator is a number nobody can weigh.
    expect(within(stats).getByText('6 of 8 handed to the relay')).toBeInTheDocument();
    expect(within(stats).getByText('10.0%')).toBeInTheDocument();
  });

  it('renders a rate the server declined to derive as "—", never 0%', async () => {
    // Below the sample floor the route sends null on purpose: a dashboard
    // reporting "0% delivered" off two messages sends somebody to investigate
    // an outage that is not happening.
    mockApi(emails, {
      '/admin/email/delivery-stats': {
        ...DELIVERY_STATS,
        rates: { delivered: null, bounced: null, opened: null, send_failure: null },
      },
    });
    renderPage();
    const stats = await screen.findByLabelText('Delivery statistics');
    expect(within(stats).getAllByText('—').length).toBeGreaterThan(0);
    expect(within(stats).queryByText('0.0%')).not.toBeInTheDocument();
  });

  it('keeps a statistics outage out of the table', async () => {
    // The two halves answer different questions and fail independently: a
    // stats outage must not blank the outbox, and it must not pass silently
    // either.
    mockApi(emails, { '/admin/email/delivery-stats': { nonsense: true } });
    renderPage();
    expect(await screen.findByText(/shape this page cannot read/)).toBeInTheDocument();
    expect(screen.getByText('founder@acme.com')).toBeInTheDocument();
  });

  it('fetches one message’s delivery trail only when it is opened', async () => {
    const user = userEvent.setup();
    const spy = mockApi();
    renderPage();
    await screen.findByText('cfo@zebra.com');
    expect(spy.calls.some((c) => c.includes('/delivery-events'))).toBe(false);

    await user.click(screen.getAllByRole('button', { name: 'Delivery trail' })[1]!);
    expect(await screen.findByText('bounced')).toBeInTheDocument();
    // The provider's own words, and whose word it is — a pixel fetch and a
    // provider webhook are not equally good evidence.
    expect(screen.getByText(/webhook:postmark/)).toBeInTheDocument();
    expect(screen.getByText(/550 no such user/)).toBeInTheDocument();
  });

  it('does not read an unreadable trail as an empty one', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/delivery-events')) return jsonResponse({ status: 500 }, 500);
      if (path.includes('/admin/email/delivery-stats')) return jsonResponse(DELIVERY_STATS);
      if (path.includes('/admin/email/suppressions'))
        return jsonResponse({ suppressions: [], truncated: false });
      return jsonResponse({ emails });
    });
    renderPage();
    await screen.findByText('cfo@zebra.com');
    await user.click(screen.getAllByRole('button', { name: 'Delivery trail' })[0]!);
    expect(await screen.findByText('Could not load the delivery trail.')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing reported back yet/)).not.toBeInTheDocument();
  });

  it('runs the retry sweep and announces what it did', async () => {
    const user = userEvent.setup();
    const spy = mockApi();
    renderPage();
    await screen.findByLabelText('Delivery statistics');
    await user.click(screen.getByRole('button', { name: 'Retry failed now' }));
    await waitFor(() => expect(spy.calls.some((c) => c === 'POST /api/v1/admin/outbox/retry')).toBe(true));
    // "attempted 4, sent 4" and "attempted 4, sent 0" leave the table looking
    // identical for the seconds before the states settle.
    expect(await screen.findByText('Retried 1 message — 1 sent.')).toBeInTheDocument();
  });

  /*
   * R414 (M5): `retired` is the sweep giving up on a message for good, and the
   * note read `attempted` and `sent` only — so the one pass an operator most
   * needs to hear about announced itself as an ordinary retry, or (when the
   * retirement ran and the claim came back empty) as nothing having happened
   * at all.
   */
  it('names the messages the sweep gave up on for good', async () => {
    const user = userEvent.setup();
    mockApi(emails, { '/admin/outbox/retry': { attempted: 2, sent: 1, failed: 1, retired: 3 } });
    renderPage();
    await screen.findByLabelText('Delivery statistics');
    await user.click(screen.getByRole('button', { name: 'Retry failed now' }));
    const note = await screen.findByText(/Retried 2 messages/);
    expect(note.textContent).toContain('1 sent');
    expect(note.textContent).toContain('3 messages had spent every attempt');
    expect(note.textContent).toContain('will never send');
  });

  it('does not report a pass that retired messages as nothing having happened', async () => {
    const user = userEvent.setup();
    mockApi(emails, { '/admin/outbox/retry': { attempted: 0, sent: 0, failed: 0, retired: 1 } });
    renderPage();
    await screen.findByLabelText('Delivery statistics');
    await user.click(screen.getByRole('button', { name: 'Retry failed now' }));
    const note = await screen.findByText(/Nothing was left to retry/);
    expect(note.textContent).toContain('1 message had spent every attempt');
    expect(screen.queryByText(/Nothing was eligible for retry/)).not.toBeInTheDocument();
  });

  it('still reports an empty pass as an empty pass when nothing was retired', async () => {
    const user = userEvent.setup();
    mockApi(emails, { '/admin/outbox/retry': { attempted: 0, sent: 0, failed: 0, retired: 0 } });
    renderPage();
    await screen.findByLabelText('Delivery statistics');
    await user.click(screen.getByRole('button', { name: 'Retry failed now' }));
    expect(await screen.findByText('Nothing was eligible for retry.')).toBeInTheDocument();
  });

  // A build that predates the field must not render `undefined` into the note.
  it('reads an older build\'s response without inventing a retirement', async () => {
    const user = userEvent.setup();
    mockApi(emails, { '/admin/outbox/retry': { attempted: 1, sent: 1 } });
    renderPage();
    await screen.findByLabelText('Delivery statistics');
    await user.click(screen.getByRole('button', { name: 'Retry failed now' }));
    expect(await screen.findByText('Retried 1 message — 1 sent.')).toBeInTheDocument();
  });

  it('explains the retry button instead of leaving it dead when nothing failed', async () => {
    mockApi(emails, {
      '/admin/email/delivery-stats': {
        ...DELIVERY_STATS,
        totals: { ...DELIVERY_STATS.totals, failed: 0 },
      },
    });
    renderPage();
    await screen.findByLabelText('Delivery statistics');
    const button = screen.getByRole('button', { name: 'Retry failed now' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'No failed messages in the last 30 days.');
  });
});
