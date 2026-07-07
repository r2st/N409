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

function mockApi() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    if (path.includes('/admin/email-outbox')) {
      const status = new URL(path, 'http://test').searchParams.get('status');
      return jsonResponse({ emails: status ? emails.filter((e) => e.status === status) : emails });
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

  it('shows an ops-only note on 403', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ title: 'Forbidden', status: 403 }, 403),
    );
    renderPage();
    expect(await screen.findByText('The email outbox is operations-only.')).toBeInTheDocument();
  });
});
