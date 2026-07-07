import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PartnerDetailPage } from '../src/pages/PartnerDetailPage';
import type { PartnerDetail } from '../src/lib/types';

/** P1 #7 — partner detail: rollups, user management, branding. */

const PARTNER_ID = '01N409PARTNER00000000000AA';

const detail: PartnerDetail = {
  id: PARTNER_ID,
  name: 'Vestd',
  key: 'vestd',
  created_at: '2026-01-15T00:00:00Z',
  archived_at: null,
  brand_color: null,
  logo_url: null,
  user_count: 2,
  valuation_count: 12,
  valuations_by_group: { open: 4, in_review: 2, published: 6 },
  last_activity_at: '2026-07-01T09:00:00Z',
  users: [
    {
      id: '01N409USERPARTNER0000000AA',
      email: 'org-admin@vestd.example',
      first_name: 'Pat',
      last_name: 'Admin',
      roles: ['partner'],
    },
    {
      id: '01N409USERMEMBER00000000BB',
      email: 'member@vestd.example',
      first_name: null,
      last_name: null,
      roles: ['member', 'investor'],
    },
  ],
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi() {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ url: path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'PATCH' && path.includes('/users/')) return jsonResponse({ user: {} });
    if (path.includes(`/partners/${PARTNER_ID}`)) return jsonResponse({ partner: detail });
    throw new Error(`unexpected fetch ${path}`);
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

describe('PartnerDetailPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows rollups, users, and console links', async () => {
    mockApi();
    renderPage();

    expect(await screen.findByRole('heading', { name: /Vestd/ })).toBeInTheDocument();
    // Valuation rollups by state group
    expect(screen.getByText('In review').parentElement?.textContent).toContain('2');
    expect(screen.getByText('Published').parentElement?.textContent).toContain('6');
    // Users of the organisation
    expect(screen.getByText('org-admin@vestd.example')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Manage in users console/ })).toHaveAttribute(
      'href',
      `/admin/users?partner=${PARTNER_ID}`,
    );
  });

  it('removes a user from the org, stripping partner roles', async () => {
    const calls = mockApi();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('org-admin@vestd.example');
    await user.click(screen.getAllByRole('button', { name: 'Remove from partner' })[1]!);

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/users/'));
      expect(patch).toBeTruthy();
      expect(patch!.url).toContain('/users/01N409USERMEMBER00000000BB');
      // 'member' is stripped, the non-partner role survives.
      expect(patch!.body).toEqual({ partner_id: null, roles: ['investor'] });
    });
  });

  it('saves branding via PATCH', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();

    await screen.findByLabelText('Brand colour');
    await user.type(screen.getByLabelText('Brand colour'), '#1f6f54');
    await user.type(screen.getByLabelText('Logo URL'), 'https://vestd.example/logo.png');
    await user.click(screen.getByRole('button', { name: 'Save branding' }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/partners/'));
      expect(patch!.body).toEqual({
        brand_color: '#1f6f54',
        logo_url: 'https://vestd.example/logo.png',
      });
    });
  });

  it('archives from the detail page', async () => {
    const calls = mockApi();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/partners/'));
      expect(patch!.body).toEqual({ archived: true });
    });
  });
});
