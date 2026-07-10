import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CommunicationsPage } from '../src/pages/CommunicationsPage';
import type { AutoEmail, CommunicationTemplate } from '../src/lib/types';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const templates: CommunicationTemplate[] = [
  {
    id: '01N409CT000000000000000001',
    key: 'draft_ready',
    channel: 'email',
    description: 'Sent when a draft is ready.',
    subject: 'Your draft {{kind_label}} valuation is ready',
    body: 'A draft for {{company_name}} is ready.',
    enabled: true,
    updated_by: null,
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-01T10:00:00Z',
  },
  {
    id: '01N409CT000000000000000008',
    key: 'sms_payment_reminder',
    channel: 'sms',
    description: 'Payment reminder text.',
    subject: '',
    body: '{{company_name}}: payment pending.',
    enabled: false,
    updated_by: null,
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-01T10:00:00Z',
  },
];

const autoEmails: AutoEmail[] = [
  {
    id: '01N409AE000000000000000001',
    name: 'payment_reminder_1',
    channel: 'email',
    trigger_state: 'started',
    condition: 'unpaid',
    delay_hours: 72,
    repeat_hours: null,
    max_sends: 1,
    template_key: 'payment_reminder',
    enabled: true,
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-01T10:00:00Z',
  },
];

function mockApi() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.includes('/admin/communication-templates') && !init?.method) {
      return jsonResponse({ templates });
    }
    if (path.includes('/admin/auto-emails/run')) {
      return jsonResponse({ queued: 2, skipped: 1 });
    }
    if (path.includes('/admin/auto-emails') && !init?.method) {
      return jsonResponse({ auto_emails: autoEmails });
    }
    throw new Error(`unexpected fetch ${path} ${init?.method ?? 'GET'}`);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <CommunicationsPage />
    </MemoryRouter>,
  );
}

describe('CommunicationsPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lists templates with channel and enabled state', async () => {
    mockApi();
    renderPage();

    expect(await screen.findByText('draft_ready')).toBeInTheDocument();
    expect(screen.getByText('sms_payment_reminder')).toBeInTheDocument();
    expect(screen.getByText('SMS')).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  it('shows auto email campaigns with schedule summary on the Auto emails tab', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await screen.findByText('draft_ready');

    await user.click(screen.getByRole('button', { name: 'Auto emails' }));

    expect(await screen.findByText('payment_reminder_1')).toBeInTheDocument();
    expect(screen.getByText('after 72h')).toBeInTheDocument();
    expect(screen.getByText('Unpaid')).toBeInTheDocument();
  });

  it('runs the drip scan on demand and reports the result', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await screen.findByText('draft_ready');

    await user.click(screen.getByRole('button', { name: 'Auto emails' }));
    await screen.findByText('payment_reminder_1');
    await user.click(screen.getByRole('button', { name: 'Run scan now' }));

    expect(await screen.findByText('Scan complete — 2 queued, 1 skipped.')).toBeInTheDocument();
  });

  it('shows an ops-only note on 403', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ title: 'Forbidden', status: 403 }, 403),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Communication settings are operations-only.')).toBeInTheDocument();
    });
  });
});
