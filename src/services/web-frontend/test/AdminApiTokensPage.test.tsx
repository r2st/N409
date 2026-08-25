import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminApiTokensPage } from '../src/pages/AdminApiTokensPage';

const NOW = new Date('2026-07-01T12:00:00Z');

const TOKENS = [
  {
    id: '01JTOKEN0000000000000000001',
    partner_id: 'p-ledgy',
    partner_name: 'Ledgy',
    partner_key: 'ledgy',
    created_by: 'u1',
    created_by_email: 'ops@ledgy.example',
    created_by_name: 'Dana Ops',
    name: 'nightly sync',
    token_prefix: 'n409_ab12',
    created_at: '2026-06-01T10:00:00Z',
    // Used yesterday — comfortably live.
    last_used_at: '2026-06-30T10:00:00Z',
    revoked_at: null,
  },
  {
    id: '01JTOKEN0000000000000000002',
    partner_id: 'p-vestd',
    partner_name: null,
    partner_key: 'vestd',
    created_by: 'u2',
    created_by_email: null,
    created_by_name: null,
    name: 'decommissioned webhook',
    token_prefix: 'n409_cd34',
    created_at: '2025-01-01T10:00:00Z',
    // Never used since it was issued eighteen months ago.
    last_used_at: null,
    revoked_at: null,
  },
  {
    id: '01JTOKEN0000000000000000003',
    partner_id: null,
    partner_name: null,
    partner_key: null,
    created_by: 'u3',
    created_by_email: 'analyst@n409.example',
    created_by_name: null,
    name: 'personal scratch',
    token_prefix: 'n409_ef56',
    created_at: '2026-05-01T10:00:00Z',
    last_used_at: '2026-06-29T10:00:00Z',
    revoked_at: null,
  },
  {
    id: '01JTOKEN0000000000000000004',
    partner_id: 'p-ledgy',
    partner_name: 'Ledgy',
    partner_key: 'ledgy',
    created_by: 'u1',
    created_by_email: 'ops@ledgy.example',
    created_by_name: 'Dana Ops',
    name: 'retired key',
    token_prefix: 'n409_gh78',
    created_at: '2025-06-01T10:00:00Z',
    last_used_at: '2025-09-01T10:00:00Z',
    revoked_at: '2025-10-01T10:00:00Z',
  },
];

const LISTING = {
  tokens: TOKENS.filter((t) => t.revoked_at === null),
  total: 3,
  live: 3,
  dormant: 1,
  dormant_after_days: 90,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Error', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

/** Records every GET path so a case can assert on the `revoked=true` filter. */
function mockApi(onWrite?: (path: string, init: RequestInit) => Response) {
  const gets: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if ((init?.method ?? 'GET') !== 'GET') {
      if (onWrite) return onWrite(path, init!);
      return jsonResponse({ ok: true });
    }
    gets.push(path);
    return jsonResponse(path.includes('revoked=true') ? { ...LISTING, tokens: TOKENS, total: 4 } : LISTING);
  });
  return { spy, gets };
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <AdminApiTokensPage />
    </MemoryRouter>,
  );

const rowFor = (name: string) => screen.getByText(name).closest('tr')!;

describe('AdminApiTokensPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('summarises the estate before listing it', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table', { name: /API tokens/i });

    expect(screen.getByText('Live tokens').parentElement).toHaveTextContent('3');
    // The dormancy window is named, not implied — "dormant" means nothing
    // without the threshold it was measured against.
    expect(screen.getByText('Dormant (90d)')).toBeInTheDocument();
  });

  it('excludes revoked tokens until they are asked for', async () => {
    const { gets } = mockApi();
    renderPage();
    await screen.findByRole('table', { name: /API tokens/i });

    expect(gets[0]).toBe('/api/v1/admin/api-tokens');
    expect(screen.queryByText('retired key')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: /Include revoked/i }));
    await screen.findByText('retired key');
    expect(gets[1]).toBe('/api/v1/admin/api-tokens?revoked=true');
    expect(rowFor('retired key')).toHaveTextContent(/revoked/i);
  });

  it('marks a credential nobody has used as dormant', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table', { name: /API tokens/i });

    // Issued eighteen months ago and never used: the case the page exists for.
    const dormant = within(rowFor('decommissioned webhook')).getByText('Never');
    expect(dormant.className).toContain('amber');

    // Used yesterday — not dormant, and shown with its timestamp.
    const live = rowFor('nightly sync');
    expect(within(live).queryByText('Never')).not.toBeInTheDocument();
    expect(live.querySelector('.text-amber-700')).toBeNull();
  });

  it('links a firm credential to its partner and labels a personal one', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table', { name: /API tokens/i });

    expect(within(rowFor('nightly sync')).getByRole('link', { name: 'Ledgy' })).toHaveAttribute(
      'href',
      '/admin/partners/p-ledgy',
    );
    // Falls back to the partner key when the firm has no display name.
    expect(within(rowFor('decommissioned webhook')).getByRole('link', { name: 'vestd' })).toBeInTheDocument();
    // A personal token is nobody's firm credential — labelled, never linked.
    const personal = rowFor('personal scratch');
    expect(within(personal).getByText('Personal')).toBeInTheDocument();
    expect(within(personal).queryByRole('link')).toBeNull();
  });

  it('shows only the secret prefix, never a usable credential', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table', { name: /API tokens/i });
    expect(rowFor('nightly sync')).toHaveTextContent('n409_ab12…');
  });

  it('names the issuer, falling back to the email and then to a dash', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table', { name: /API tokens/i });

    expect(rowFor('nightly sync')).toHaveTextContent('Dana Ops');
    expect(rowFor('nightly sync')).toHaveTextContent('ops@ledgy.example');
    expect(rowFor('personal scratch')).toHaveTextContent('analyst@n409.example');
    expect(rowFor('decommissioned webhook')).toHaveTextContent('—');
  });

  it('offers revoke on firm credentials only', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table', { name: /API tokens/i });

    expect(within(rowFor('nightly sync')).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    // Nobody but the owner may revoke a personal token, so the control is absent
    // rather than present-and-failing.
    expect(within(rowFor('personal scratch')).queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('names the token and its holder in the confirm, and revokes only on assent', async () => {
    const writes: string[] = [];
    mockApi((path, init) => {
      writes.push(`${init.method} ${path}`);
      return jsonResponse({ ok: true });
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await screen.findByRole('table', { name: /API tokens/i });

    await userEvent.click(within(rowFor('nightly sync')).getByRole('button', { name: 'Revoke' }));
    expect(confirm.mock.calls[0]![0]).toContain('nightly sync');
    expect(confirm.mock.calls[0]![0]).toContain('Ledgy');
    expect(writes).toHaveLength(0);

    confirm.mockReturnValue(true);
    await userEvent.click(within(rowFor('nightly sync')).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(writes).toEqual([`DELETE /api/v1/api-tokens/${TOKENS[0]!.id}`]));
  });

  it('surfaces a refused revoke while keeping the listing on screen', async () => {
    mockApi(() => problem(403, 'only the issuing firm may revoke this token'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await screen.findByRole('table', { name: /API tokens/i });

    await userEvent.click(within(rowFor('nightly sync')).getByRole('button', { name: 'Revoke' }));
    await screen.findByText('only the issuing firm may revoke this token');
    // A failed action must not blank the inventory it was taken from.
    expect(screen.getByRole('table', { name: /API tokens/i })).toBeInTheDocument();
  });

  it('explains a 403 on the listing as an administrator-only screen', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(problem(403, 'Forbidden'));
    renderPage();
    await screen.findByText(/administrator-only/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('falls back to a plain message on any other load failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    renderPage();
    await screen.findByText(/Could not load the token listing/i);
  });

  it('offers an empty state when nothing on the platform holds credentials', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ tokens: [], total: 0, live: 0, dormant: 0, dormant_after_days: 90 }),
    );
    renderPage();
    await screen.findByText(/No tokens issued/i);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('refetches on demand', async () => {
    const { gets } = mockApi();
    renderPage();
    await screen.findByRole('table', { name: /API tokens/i });
    expect(gets).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: /Refresh/i }));
    await waitFor(() => expect(gets).toHaveLength(2));
  });
});

/**
 * The "Include revoked" checkbox with two listings in flight.
 *
 * Ticking and unticking issues two requests to two different addresses, and
 * nothing orders the replies. What the stale one produces is the wrong answer
 * to the only question this page exists to answer — which credentials still
 * have access — with a checkbox above it asserting the opposite.
 */
describe('AdminApiTokensPage — the listing that replies late', () => {
  beforeEach(() => vi.restoreAllMocks());

  function deferListings() {
    const pending: Array<{ url: string; resolve: (body: unknown, status?: number) => void }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      return new Promise<Response>((res) =>
        pending.push({ url: path, resolve: (body, status = 200) => res(jsonResponse(body, status)) }),
      );
    });
    return pending;
  }

  const listing = (tokens: typeof TOKENS) => ({ ...LISTING, tokens, total: tokens.length });

  it('shows the listing the checkbox is asking for, not the one that replied last', async () => {
    const user = userEvent.setup();
    const pending = deferListings();
    renderPage();

    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!.resolve(listing(TOKENS.filter((t) => t.revoked_at === null)));
    await screen.findByText('nightly sync');

    await user.click(screen.getByLabelText('Include revoked'));
    await waitFor(() => expect(pending).toHaveLength(2));
    await user.click(screen.getByLabelText('Include revoked'));
    await waitFor(() => expect(pending).toHaveLength(3));

    expect(pending[1]!.url).toContain('revoked=true');
    expect(pending[2]!.url).not.toContain('revoked=true');

    // The unticked listing lands first; the ticked one — the box the admin has
    // already cleared — lands on top of it.
    pending[2]!.resolve(listing(TOKENS.filter((t) => t.revoked_at === null)));
    await screen.findByText('nightly sync');
    pending[1]!.resolve(listing(TOKENS));

    await waitFor(() => expect(screen.getByText('nightly sync')).toBeInTheDocument());
    const revoked = TOKENS.find((t) => t.revoked_at !== null)!;
    expect(screen.queryByText(revoked.name)).toBeNull();
  });

  it('does not report the abandoned listing’s refusal', async () => {
    const user = userEvent.setup();
    const pending = deferListings();
    renderPage();

    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!.resolve(listing(TOKENS.filter((t) => t.revoked_at === null)));
    await screen.findByText('nightly sync');

    await user.click(screen.getByLabelText('Include revoked'));
    await waitFor(() => expect(pending).toHaveLength(2));
    await user.click(screen.getByLabelText('Include revoked'));
    await waitFor(() => expect(pending).toHaveLength(3));

    pending[2]!.resolve(listing(TOKENS.filter((t) => t.revoked_at === null)));
    await screen.findByText('nightly sync');
    pending[1]!.resolve({ status: 403 }, 403);

    await waitFor(() => expect(screen.getByText('nightly sync')).toBeInTheDocument());
    expect(screen.queryByText(/administrator-only|Could not load the token listing/)).toBeNull();
  });
});
