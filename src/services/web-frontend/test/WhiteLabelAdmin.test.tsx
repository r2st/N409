import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PartnerDetailPage } from '../src/pages/PartnerDetailPage';

/** Improvement 8 — branding preview + email template editor in partner admin. */

const PARTNER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const partner = {
  id: PARTNER_ID,
  name: 'Bridge Advisors',
  key: 'bridge-advisors',
  created_at: '2026-06-01T00:00:00Z',
  archived_at: null,
  brand_color: '#1f6f54',
  logo_url: 'https://cdn.example.com/bridge.png',
  email_templates: {
    draft_ready: {
      subject: 'Your draft from {{partner_name}}',
      body: 'Draft for {{company_name}} is ready.',
    },
  },
  user_count: 2,
  valuation_count: 5,
  valuations_by_group: { open: 2, published: 3 },
  last_activity_at: null,
  users: [],
};

function mockApi() {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ partner }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/admin/partners/${PARTNER_ID}`]}>
      <Routes>
        <Route path="/admin/partners/:id" element={<PartnerDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PartnerDetailPage white-label admin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a live branding preview and the branded login URL', async () => {
    mockApi();
    renderPage();

    const preview = await screen.findByTestId('branding-preview');
    expect(preview).toHaveTextContent('Bridge Advisors');
    expect(screen.getByText('/partner/bridge-advisors/login')).toBeInTheDocument();

    // the preview follows the unsaved form colour
    const accent = preview.querySelector('[aria-hidden]');
    expect(accent).toHaveStyle({ backgroundColor: '#1f6f54' });
  });

  it('loads existing template overrides and marks them customized', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByDisplayValue('Your draft from {{partner_name}}')).toBeInTheDocument();
    expect(screen.getByText('Customized')).toBeInTheDocument();
  });

  it('saves only complete subject+body pairs', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId('branding-preview');
    // fill only the subject of another template — it must be dropped on save
    await user.type(screen.getByLabelText('Valuation started subject'), 'Half-filled subject');
    await user.click(screen.getByRole('button', { name: 'Save email templates' }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(patch!.body).toEqual({
        email_templates: {
          draft_ready: {
            subject: 'Your draft from {{partner_name}}',
            body: 'Draft for {{company_name}} is ready.',
          },
        },
      });
    });
  });
});
