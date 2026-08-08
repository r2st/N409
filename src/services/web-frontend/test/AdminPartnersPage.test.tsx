import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminPartnersPage } from '../src/pages/AdminPartnersPage';
import type { Partner } from '../src/lib/types';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const partners: Partner[] = [
  {
    id: '01N409PARTNER00000000000AA',
    name: 'Vestd',
    key: 'vestd',
    created_at: '2026-01-15T00:00:00Z',
    archived_at: null,
    brand_color: null,
    logo_url: null,
    subdomain: null,
    prepaid: false,
    cc_emails: [],
    user_count: 3,
    valuation_count: 12,
  },
  {
    id: '01N409PARTNER00000000000BB',
    name: 'Carta',
    key: 'carta',
    created_at: '2026-02-20T00:00:00Z',
    archived_at: null,
    brand_color: null,
    logo_url: null,
    subdomain: null,
    prepaid: false,
    cc_emails: [],
    user_count: 0,
    valuation_count: 0,
  },
];

function mockApi(
  overrides: Record<string, (init?: RequestInit) => Response> = {},
  list: Partner[] = partners,
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    for (const [needle, handler] of Object.entries(overrides)) {
      if (path.includes(needle) && (init?.method ?? 'GET') !== 'GET') return handler(init);
    }
    if (path.includes('/partners')) return jsonResponse({ partners: list });
    throw new Error(`unexpected fetch ${path}`);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminPartnersPage />
    </MemoryRouter>,
  );
}

describe('AdminPartnersPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lists partners with rollup counts and drill-throughs', async () => {
    const fetchSpy = mockApi();
    renderPage();

    expect(await screen.findByText('Vestd')).toBeInTheDocument();
    expect(screen.getByText('vestd')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // The console asks for archived partners too.
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('include_archived=true');

    // Partner names link into the detail page.
    expect(screen.getByRole('link', { name: 'Vestd' })).toHaveAttribute(
      'href',
      '/admin/partners/01N409PARTNER00000000000AA',
    );
    // Non-zero valuation counts link into the filtered worklist.
    const link = screen.getByRole('link', { name: '12' });
    expect(link).toHaveAttribute('href', '/valuations?partner_id=01N409PARTNER00000000000AA');
    // Zero counts render as plain text.
    expect(screen.queryByRole('link', { name: '0' })).not.toBeInTheDocument();
  });

  it('creates a partner via POST', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockApi({
      '/partners': () =>
        jsonResponse({ partner: { ...partners[1], id: 'new', name: 'Ledgy', key: 'ledgy' } }, 201),
    });
    renderPage();

    await user.click(await screen.findByRole('button', { name: '+ New partner' }));
    await user.type(screen.getByLabelText('Partner name'), 'Ledgy');
    await user.type(screen.getByLabelText('Partner key'), 'ledgy');
    await user.click(screen.getByRole('button', { name: 'Create partner' }));

    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(postCall).toBeTruthy();
      expect(JSON.parse(String((postCall![1] as RequestInit).body))).toEqual({
        name: 'Ledgy',
        key: 'ledgy',
      });
    });
  });

  it('renames a partner via PATCH', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockApi({
      '/partners/01N409PARTNER00000000000AA': () =>
        jsonResponse({ partner: { ...partners[0], name: 'Vestd Ltd' } }),
    });
    renderPage();

    await screen.findByText('Vestd');
    await user.click(screen.getAllByRole('button', { name: 'Rename' })[0]!);
    const input = screen.getByLabelText('Rename Vestd');
    await user.clear(input);
    await user.type(input, 'Vestd Ltd');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patchCall = fetchSpy.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall).toBeTruthy();
      expect(String(patchCall![0])).toContain('/partners/01N409PARTNER00000000000AA');
      expect(JSON.parse(String((patchCall![1] as RequestInit).body))).toEqual({ name: 'Vestd Ltd' });
    });
  });

  it('archives a partner via PATCH {archived: true}', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchSpy = mockApi({
      '/partners/01N409PARTNER00000000000AA': () =>
        jsonResponse({ partner: { ...partners[0], archived_at: '2026-07-07T00:00:00Z' } }),
    });
    renderPage();

    await screen.findByText('Vestd');
    await user.click(screen.getAllByRole('button', { name: 'Archive' })[0]!);

    await waitFor(() => {
      const patchCall = fetchSpy.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall).toBeTruthy();
      expect(JSON.parse(String((patchCall![1] as RequestInit).body))).toEqual({ archived: true });
    });
  });

  it('hides archived partners until the toggle is on, then offers Restore', async () => {
    const user = userEvent.setup();
    const archived: Partner = { ...partners[1]!, archived_at: '2026-06-01T00:00:00Z' };
    const fetchSpy = mockApi({}, [partners[0]!, archived]);
    renderPage();

    await screen.findByText('Vestd');
    expect(screen.queryByText('Carta')).not.toBeInTheDocument();

    await user.click(screen.getByLabelText(/Show archived/));
    expect(await screen.findByText('Carta')).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();

    fetchSpy.mockClear();
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => {
      const patchCall = fetchSpy.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(JSON.parse(String((patchCall![1] as RequestInit).body))).toEqual({ archived: false });
    });
  });

  it('shows an admin-only note on 403', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ title: 'Forbidden', status: 403 }, 403),
    );
    renderPage();
    expect(await screen.findByText('Partner management is admin-only.')).toBeInTheDocument();
  });
});
