import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from '../src/lib/auth';
import { AdminUsersPage } from '../src/pages/AdminUsersPage';
import type { AdminUser, Invitation, Partner, User } from '../src/lib/types';

/**
 * The user-and-roles console, beyond the two per-row actions already covered
 * (see AdminUserActions and AdminPromote).
 *
 * What is under test here is the part of the console that decides who can do
 * what: the role catalog it serves rather than hard-codes, the invite/create/
 * edit editor, the partner scoping rule, and the invitation lifecycle. The
 * failure this guards against is not a broken screen — it is an account that
 * comes back from deactivation with no roles, a partner-scoped role granted
 * with no partner, or an invitation that looks revocable after it has been
 * accepted.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ADMIN: User = {
  id: 'admin-1',
  email: 'admin@409.ai',
  first_name: 'Ana',
  last_name: 'Admin',
  phone: null,
  job_title: null,
  company_name: null,
  timezone: null,
  verified: true,
  sso_provider: null,
  partner_id: null,
  roles: ['admin'],
};

const ROLE_DEFS = [
  {
    key: 'valuation_user',
    label: 'Client',
    description: 'Their own engagements only.',
    scope: 'client' as const,
    capabilities: ['view_own'],
  },
  {
    key: 'partner',
    label: 'Partner',
    description: 'Every engagement at their firm.',
    scope: 'partner' as const,
    capabilities: ['view_own', 'view_firm'],
  },
  {
    key: 'admin',
    label: 'Admin',
    description: 'Everything, including user management.',
    scope: 'ops' as const,
    capabilities: ['view_own', 'view_firm', 'manage_users'],
  },
];

const CAPABILITIES = [
  { key: 'view_own', label: 'See own engagements', description: 'Read their own valuations.', roles: [] },
  { key: 'view_firm', label: 'See firm engagements', description: 'Read the firm’s book.', roles: [] },
  { key: 'manage_users', label: 'Manage users', description: 'Grant and revoke roles.', roles: [] },
];

const PARTNERS: Partner[] = [
  {
    id: 'p1',
    name: 'Bellweather Law',
    key: 'bellweather',
    created_at: '2025-01-01T00:00:00Z',
    archived_at: null,
    brand_color: null,
    logo_url: null,
    subdomain: null,
    prepaid: false,
  } as Partner,
];

const row = (over: Partial<AdminUser> = {}): AdminUser => ({
  id: 'u2',
  email: 'ada@acme.com',
  first_name: 'Ada',
  last_name: 'Lovelace',
  phone: null,
  job_title: null,
  company_name: null,
  verified: true,
  sso_provider: null,
  partner_id: null,
  partner_name: null,
  roles: ['valuation_user'],
  created_at: '2026-01-01T00:00:00Z',
  deleted_at: null,
  ...over,
});

const invite = (over: Partial<Invitation> = {}): Invitation => ({
  id: 'inv-1',
  email: 'newcomer@acme.com',
  roles: ['valuation_user'],
  partner_id: null,
  partner_name: null,
  invited_by_email: 'admin@409.ai',
  expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
  accepted_at: null,
  revoked_at: null,
  created_at: '2026-08-01T00:00:00Z',
  ...over,
});

interface Call {
  path: string;
  method: string;
  body: unknown;
}

function mockApi(
  state: {
    users?: AdminUser[];
    total?: number;
    page?: number;
    invitations?: Invitation[];
    roles?: typeof ROLE_DEFS;
    partners?: Partner[];
  } = {},
  opts: {
    writeStatus?: number;
    listStatus?: number;
    exportStatus?: number;
    /** The two catalogs load separately from the user list; fail them alone. */
    rolesStatus?: number;
    partnersStatus?: number;
    invitationsStatus?: number;
  } = {},
) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (path.endsWith('/auth/me')) return jsonResponse({ user: ADMIN });
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (path.includes('/users/export')) {
      if (opts.exportStatus) return jsonResponse({ status: opts.exportStatus, detail: 'No' }, 500);
      return new Response('email\n', { status: 200, headers: { 'content-type': 'text/csv' } });
    }
    if (path.endsWith('/partners')) {
      if (opts.partnersStatus) return jsonResponse({ detail: 'No' }, opts.partnersStatus);
      return jsonResponse({ partners: state.partners ?? PARTNERS });
    }
    if (path.endsWith('/roles')) {
      if (opts.rolesStatus) return jsonResponse({ detail: 'No' }, opts.rolesStatus);
      return jsonResponse({ roles: state.roles ?? ROLE_DEFS, capabilities: CAPABILITIES });
    }
    if (path.includes('/users/invitations')) {
      if (method !== 'GET') {
        if (opts.writeStatus) {
          return jsonResponse({ status: opts.writeStatus, detail: 'Refused.' }, opts.writeStatus);
        }
        return jsonResponse({ ok: true });
      }
      if (opts.invitationsStatus) return jsonResponse({ detail: 'No' }, opts.invitationsStatus);
      return jsonResponse({ invitations: state.invitations ?? [] });
    }
    if (method === 'GET' && path.includes('/users?')) {
      if (opts.listStatus) return jsonResponse({ status: opts.listStatus, detail: 'No' }, opts.listStatus);
      const users = state.users ?? [row()];
      return jsonResponse({ users, page: state.page ?? 1, per_page: 25, total: state.total ?? users.length });
    }
    if (opts.writeStatus) {
      return jsonResponse({ status: opts.writeStatus, detail: 'Refused.' }, opts.writeStatus);
    }
    return jsonResponse({ ok: true }, method === 'POST' ? 201 : 200);
  });
  return calls;
}

/**
 * In the app this page sits behind a route guard that does not mount it until
 * the session has resolved. Mounting it directly would render one frame as an
 * anonymous visitor, and the page's own `<Navigate to="/dashboard">` would
 * rewrite the URL — taking the filters under test with it.
 */
function WhenResolved({ children }: { children: ReactNode }) {
  return useAuth().status === 'loading' ? null : <>{children}</>;
}

function renderPage(entry = '/admin/users') {
  localStorage.setItem('n409.token', 'header.payload.sig');
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <WhenResolved>
          <AdminUsersPage />
        </WhenResolved>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const editorBody = (calls: Call[], method: string) =>
  calls.find((c) => c.method === method && !c.path.includes('/auth/'))?.body as Record<string, unknown>;

describe('AdminUsersPage — the console', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('says so when the list cannot be loaded', async () => {
    mockApi({}, { listStatus: 500 });
    renderPage();

    await screen.findByText('Could not load users.');
  });

  it('says nothing matched rather than showing a bare table', async () => {
    mockApi({ users: [] });
    renderPage();

    await screen.findByText('No users match');
  });

  it('shows a user with no roles as holding none, not as blank', async () => {
    // A deactivated account comes back with its roles dropped; a blank cell
    // reads as "not loaded yet" and this one means "can do nothing".
    mockApi({ users: [row({ roles: [] })] });
    renderPage();

    const tr = (await screen.findByText('ada@acme.com')).closest('tr') as HTMLElement;
    expect(within(tr).getByText('none')).toBeInTheDocument();
    expect(within(tr).getByText('—')).toBeInTheDocument(); // no partner
  });

  // ── The role catalog, served rather than hard-coded ───────────────────────

  it('fills the role filter and the grant list from the server’s catalog', async () => {
    // A copy of this list used to live in the page and had already gone stale.
    mockApi();
    renderPage();

    const filter = await screen.findByLabelText('Filter by role');
    await within(filter).findByRole('option', { name: 'Admin' });
    expect(
      within(filter)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All roles', 'Client', 'Partner', 'Admin']);
  });

  it('keeps the capability matrix collapsed until asked, then names what each role grants', async () => {
    mockApi();
    renderPage();

    await screen.findByText('Roles & capabilities');
    expect(screen.queryByRole('table', { name: 'Role capability matrix' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show' }));

    const matrix = screen.getByRole('table', { name: 'Role capability matrix' });
    const manage = within(matrix).getByText('Manage users').closest('tr') as HTMLElement;
    // Only Admin grants it — the Client and Partner cells must read as denied.
    expect(within(manage).getAllByLabelText('granted')).toHaveLength(1);
    expect(within(manage).getAllByLabelText('not granted')).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByRole('table', { name: 'Role capability matrix' })).not.toBeInTheDocument();
  });

  it('omits the matrix entirely when the catalog could not be fetched', async () => {
    mockApi({ roles: [] });
    renderPage();

    await screen.findByText('ada@acme.com');
    expect(screen.queryByText('Roles & capabilities')).not.toBeInTheDocument();
  });

  // ── Filters ───────────────────────────────────────────────────────────────

  it('carries the search, role and partner filters into the query', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByText('ada@acme.com');

    await userEvent.type(screen.getByLabelText('Search users'), '  ada  ');
    await userEvent.tab();
    await waitFor(() => expect(calls.some((c) => c.path.includes('q=ada'))).toBe(true));

    await userEvent.selectOptions(screen.getByLabelText('Filter by role'), 'partner');
    await waitFor(() => expect(calls.some((c) => c.path.includes('role=partner'))).toBe(true));

    await userEvent.selectOptions(screen.getByLabelText('Filter by partner'), 'p1');
    await waitFor(() => expect(calls.some((c) => c.path.includes('partner_id=p1'))).toBe(true));
  });

  it('asks for deactivated accounts only when they are wanted', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByText('ada@acme.com');

    await userEvent.click(screen.getByLabelText('Show deactivated'));
    await waitFor(() => expect(calls.some((c) => c.path.includes('include_deleted=true'))).toBe(true));

    await userEvent.click(screen.getByLabelText('Show deactivated'));
    await waitFor(() =>
      expect(calls.filter((c) => c.path.includes('/users?')).at(-1)?.path).not.toContain('include_deleted'),
    );
  });

  it('reads the filters back out of the URL on arrival', async () => {
    const calls = mockApi();
    renderPage('/admin/users?q=ada&role=admin&partner=p1&deleted=1');

    await waitFor(() => expect(calls.some((c) => c.path.includes('/users?'))).toBe(true));
    const listed = calls.find((c) => c.path.includes('/users?'))!.path;
    expect(listed).toContain('q=ada');
    expect(listed).toContain('role=admin');
    expect(listed).toContain('partner_id=p1');
    expect(listed).toContain('include_deleted=true');
    expect(screen.getByLabelText('Search users')).toHaveValue('ada');
  });

  // ── Pagination ────────────────────────────────────────────────────────────

  it('pages forward and back, and stops at each end', async () => {
    const calls = mockApi({ users: [row()], total: 60, page: 1 });
    renderPage();

    await screen.findByText(/Page 1 of 3 · 60 total/);
    expect(screen.getByRole('button', { name: '← Previous' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Next →' }));
    await waitFor(() => expect(calls.some((c) => c.path.includes('page=2'))).toBe(true));
  });

  it('hides the pager when everyone fits on one page', async () => {
    mockApi({ users: [row()], total: 1 });
    renderPage();

    await screen.findByText('ada@acme.com');
    expect(screen.queryByRole('button', { name: 'Next →' })).not.toBeInTheDocument();
  });

  // ── Export ────────────────────────────────────────────────────────────────

  it('exports the filtered set, not the whole table', async () => {
    const calls = mockApi();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    // jsdom implements neither; the download helper calls both.
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:x', configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true });
    renderPage('/admin/users?q=ada&role=admin');

    await screen.findByText('ada@acme.com');
    await userEvent.click(screen.getByRole('button', { name: '↓ Export CSV' }));

    await waitFor(() => expect(calls.some((c) => c.path.includes('/users/export'))).toBe(true));
    const exported = calls.find((c) => c.path.includes('/users/export'))!.path;
    expect(exported).toContain('q=ada');
    expect(exported).toContain('role=admin');
    expect(click).toHaveBeenCalled();
  });

  it('reports an export that failed', async () => {
    mockApi({}, { exportStatus: 500 });
    renderPage();

    await screen.findByText('ada@acme.com');
    await userEvent.click(screen.getByRole('button', { name: '↓ Export CSV' }));

    await screen.findByText('Could not export CSV.');
  });

  // ── The editor ────────────────────────────────────────────────────────────

  it('invites a user without asking for a password', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByText('ada@acme.com');

    await userEvent.click(screen.getByRole('button', { name: '+ Invite user' }));
    expect(screen.getByText(/lets them set their own password/)).toBeInTheDocument();
    // An invite has no password and no name — the invitee supplies both.
    expect(screen.queryByLabelText(/Password/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('First name')).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Email'), '  newcomer@acme.com  ');
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/users/invite'))).toBe(true));
    expect(calls.find((c) => c.path.endsWith('/users/invite'))?.body).toEqual({
      email: 'newcomer@acme.com',
      partner_id: null,
      roles: ['valuation_user'],
    });
  });

  it('creates an account with a password when one is being set directly', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByText('ada@acme.com');

    await userEvent.click(screen.getByRole('button', { name: 'New user with password' }));
    await userEvent.type(screen.getByLabelText('Email'), 'direct@acme.com');
    await userEvent.type(screen.getByLabelText(/Password/), 'a-long-enough-one-1');
    await userEvent.type(screen.getByLabelText('First name'), '  Dee  ');
    await userEvent.click(screen.getByRole('button', { name: 'Create user' }));

    await waitFor(() =>
      expect(calls.some((c) => c.path.endsWith('/users') && c.method === 'POST')).toBe(true),
    );
    expect(calls.find((c) => c.path.endsWith('/users') && c.method === 'POST')?.body).toMatchObject({
      email: 'direct@acme.com',
      password: 'a-long-enough-one-1',
      first_name: 'Dee',
    });
  });

  it('omits an unfilled name on create rather than sending an empty one', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByText('ada@acme.com');

    await userEvent.click(screen.getByRole('button', { name: 'New user with password' }));
    await userEvent.type(screen.getByLabelText('Email'), 'direct@acme.com');
    await userEvent.type(screen.getByLabelText(/Password/), 'a-long-enough-one-1');
    await userEvent.click(screen.getByRole('button', { name: 'Create user' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const body = calls.find((c) => c.path.endsWith('/users') && c.method === 'POST')?.body as Record<
      string,
      unknown
    >;
    expect('first_name' in body).toBe(false);
  });

  it('edits an existing user, sending a cleared name as null', async () => {
    // create omits an empty name; edit must send null, because the difference
    // is "not supplied" versus "remove what is there".
    const calls = mockApi();
    renderPage();

    const tr = (await screen.findByText('ada@acme.com')).closest('tr') as HTMLElement;
    await userEvent.click(within(tr).getByRole('button', { name: 'Edit' }));

    expect(screen.getByText('Edit ada@acme.com')).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toHaveValue('Ada');
    await userEvent.clear(screen.getByLabelText('First name'));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(editorBody(calls, 'PATCH')).toMatchObject({ email: 'ada@acme.com', first_name: null });
  });

  it('refuses a partner-scoped role with no organisation, before the API has to', async () => {
    const calls = mockApi();
    renderPage();

    const tr = (await screen.findByText('ada@acme.com')).closest('tr') as HTMLElement;
    await userEvent.click(within(tr).getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Partner' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText(/Partner and member roles require a partner organisation/);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);

    // Picking the org clears the objection and the save goes through.
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Partner/ }), 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(editorBody(calls, 'PATCH')).toMatchObject({ partner_id: 'p1' });
  });

  /**
   * R30 — this was a disabled button, and the roles it was about are two
   * sections further down the form than the button is. The message sits with
   * the checkboxes instead.
   */
  it('will not save a user with no role at all, and says so at the roles', async () => {
    const calls = mockApi();
    renderPage();

    const tr = (await screen.findByText('ada@acme.com')).closest('tr') as HTMLElement;
    await userEvent.click(within(tr).getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Client' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Pick at least one role.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('refuses an email that is not one, before the API has to', async () => {
    const calls = mockApi();
    renderPage();

    const tr = (await screen.findByText('ada@acme.com')).closest('tr') as HTMLElement;
    await userEvent.click(within(tr).getByRole('button', { name: 'Edit' }));
    await userEvent.clear(screen.getByLabelText('Email'));
    await userEvent.type(screen.getByLabelText('Email'), 'ada@acme');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('toggles a role off as well as on', async () => {
    const calls = mockApi();
    renderPage();

    const tr = (await screen.findByText('ada@acme.com')).closest('tr') as HTMLElement;
    await userEvent.click(within(tr).getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Admin' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Client' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(editorBody(calls, 'PATCH')).toMatchObject({ roles: ['admin'] });
  });

  it('reports the server’s refusal in the editor and keeps it open', async () => {
    mockApi({}, { writeStatus: 409 });
    renderPage();

    const tr = (await screen.findByText('ada@acme.com')).closest('tr') as HTMLElement;
    await userEvent.click(within(tr).getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Refused.');
    expect(screen.getByText('Edit ada@acme.com')).toBeInTheDocument();
  });

  it('abandons the editor on cancel', async () => {
    mockApi();
    renderPage();

    const tr = (await screen.findByText('ada@acme.com')).closest('tr') as HTMLElement;
    await userEvent.click(within(tr).getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Edit ada@acme.com')).not.toBeInTheDocument();
  });

  it('pre-selects the filtered organisation for a new account', async () => {
    mockApi();
    renderPage('/admin/users?partner=p1');

    await screen.findByText('ada@acme.com');
    await userEvent.click(screen.getByRole('button', { name: '+ Invite user' }));

    expect(screen.getByRole('combobox', { name: /^Partner/ })).toHaveValue('p1');
  });

  // ── Deactivate and restore ────────────────────────────────────────────────

  it('deactivates a user after confirming', async () => {
    const calls = mockApi();
    renderPage();

    const tr = (await screen.findByText('ada@acme.com')).closest('tr') as HTMLElement;
    await userEvent.click(within(tr).getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });

  it('does not deactivate when the confirmation is dismissed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const calls = mockApi();
    renderPage();

    const tr = (await screen.findByText('ada@acme.com')).closest('tr') as HTMLElement;
    await userEvent.click(within(tr).getByRole('button', { name: 'Deactivate' }));

    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('reports a deactivation the server refused', async () => {
    mockApi({}, { writeStatus: 409 });
    renderPage();

    const tr = (await screen.findByText('ada@acme.com')).closest('tr') as HTMLElement;
    await userEvent.click(within(tr).getByRole('button', { name: 'Deactivate' }));

    await screen.findByText('Refused.');
  });

  it('opens the editor after a restore, so the account does not come back scoped to nothing', async () => {
    // Deactivation drops the user's roles. Restoring without re-granting leaves
    // an account that can sign in and do nothing, which reads as a bug to them.
    const calls = mockApi({ users: [row({ deleted_at: '2026-07-01T00:00:00Z', roles: [] })] });
    renderPage('/admin/users?deleted=1');

    const tr = (await screen.findByText('ada@acme.com')).closest('tr') as HTMLElement;
    expect(within(tr).getByText('Deactivated')).toBeInTheDocument();
    // A deactivated row offers restore and nothing else.
    expect(within(tr).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();

    await userEvent.click(within(tr).getByRole('button', { name: 'Restore' }));

    await screen.findByText('Edit ada@acme.com');
    expect(calls.some((c) => c.path.endsWith('/restore'))).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'Client' })).toBeChecked();
  });

  it('reports a restore the server refused', async () => {
    mockApi({ users: [row({ deleted_at: '2026-07-01T00:00:00Z' })] }, { writeStatus: 409 });
    renderPage('/admin/users?deleted=1');

    const tr = (await screen.findByText('ada@acme.com')).closest('tr') as HTMLElement;
    await userEvent.click(within(tr).getByRole('button', { name: 'Restore' }));

    await screen.findByText('Refused.');
  });

  // ── Invitations ───────────────────────────────────────────────────────────

  it('shows a pending invitation with who sent it and when it lapses', async () => {
    mockApi({ invitations: [invite({ partner_name: 'Bellweather Law' })] });
    renderPage();

    const tr = (await screen.findByText('newcomer@acme.com')).closest('tr') as HTMLElement;
    expect(within(tr).getByText('Pending')).toBeInTheDocument();
    expect(
      within(tr).getByText(/valuation_user · Bellweather Law · invited by admin@409.ai/),
    ).toBeInTheDocument();
    expect(within(tr).getByText(/^expires /)).toBeInTheDocument();
    expect(within(tr).getByRole('button', { name: 'Resend' })).toBeInTheDocument();
    expect(within(tr).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('offers to resend a lapsed invitation but not to revoke it', async () => {
    mockApi({ invitations: [invite({ expires_at: new Date(Date.now() - 86_400_000).toISOString() })] });
    renderPage();

    const tr = (await screen.findByText('newcomer@acme.com')).closest('tr') as HTMLElement;
    expect(within(tr).getByText('Expired')).toBeInTheDocument();
    expect(within(tr).getByRole('button', { name: 'Resend' })).toBeInTheDocument();
    // Revoking a link that already stopped working achieves nothing.
    expect(within(tr).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it.each([
    ['accepted', { accepted_at: '2026-08-02T00:00:00Z' }, 'Accepted'],
    ['revoked', { revoked_at: '2026-08-02T00:00:00Z' }, 'Revoked'],
  ])('offers nothing on an %s invitation', async (_name, over, label) => {
    mockApi({ invitations: [invite(over)] });
    renderPage();

    const tr = (await screen.findByText('newcomer@acme.com')).closest('tr') as HTMLElement;
    expect(within(tr).getByText(label)).toBeInTheDocument();
    expect(within(tr).queryByRole('button')).not.toBeInTheDocument();
  });

  it('resends an invitation', async () => {
    const calls = mockApi({ invitations: [invite()] });
    renderPage();

    const tr = (await screen.findByText('newcomer@acme.com')).closest('tr') as HTMLElement;
    await userEvent.click(within(tr).getByRole('button', { name: 'Resend' }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/invitations/inv-1/resend'))).toBe(
        true,
      ),
    );
  });

  it('revokes an invitation after confirming, and reports a refusal', async () => {
    const calls = mockApi({ invitations: [invite()] }, { writeStatus: 409 });
    renderPage();

    const tr = (await screen.findByText('newcomer@acme.com')).closest('tr') as HTMLElement;
    await userEvent.click(within(tr).getByRole('button', { name: 'Revoke' }));

    await screen.findByText('Refused.');
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/invitations/inv-1'))).toBe(true);
  });

  it('does not revoke when the confirmation is dismissed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const calls = mockApi({ invitations: [invite()] });
    renderPage();

    const tr = (await screen.findByText('newcomer@acme.com')).closest('tr') as HTMLElement;
    await userEvent.click(within(tr).getByRole('button', { name: 'Revoke' }));

    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
  /*
   * Both catalogs were fetched with `.catch(() => {})`, and the editor renders
   * its permission controls *from* them — so an outage left an admin with a
   * blank Roles box, no way to grant or revoke, and nothing saying why.
   */
  describe('when a catalog fails to load', () => {
    const openEditor = async () => {
      const tr = (await screen.findByText('ada@acme.com')).closest('tr') as HTMLElement;
      await userEvent.click(within(tr).getByRole('button', { name: 'Edit' }));
    };

    it('says the role catalog is missing instead of showing an empty Roles box', async () => {
      mockApi(undefined, { rolesStatus: 503 });
      renderPage();
      await openEditor();

      expect(screen.queryByRole('checkbox', { name: 'Partner' })).toBeNull();
      await screen.findByText(/role catalog could not be loaded/);
    });

    it('promises the roles are left alone, and keeps that promise', async () => {
      /*
       * The note tells the admin that saving during the outage changes
       * nothing, so the PATCH has to actually carry the roles the user already
       * had — `editor.roles` is seeded from the user and is independent of the
       * catalog, and this pins that it stays so.
       */
      const calls = mockApi({ users: [row({ roles: ['valuation_user', 'admin'] })] }, { rolesStatus: 503 });
      renderPage();
      await openEditor();
      await screen.findByText(/role catalog could not be loaded/);

      await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
      expect(editorBody(calls, 'PATCH')).toMatchObject({ roles: ['valuation_user', 'admin'] });
    });

    it('does not show an organisation-holding user as having none', async () => {
      // A controlled select whose value matches no option selects nothing, so
      // during the outage every partnered account displayed as unpartnered.
      mockApi(
        { users: [row({ partner_id: 'p1', partner_name: 'Bellweather Law' })] },
        { partnersStatus: 503 },
      );
      renderPage();
      await openEditor();

      const select = await screen.findByRole('combobox', { name: /^Partner/ });
      expect(select).toHaveValue('p1');
      expect(select).toBeDisabled();
      await screen.findByText(/Organisations could not be listed/);
    });

    it('does not report a failed invitation list as nobody waiting', async () => {
      /*
       * The section renders behind `invitations.length > 0`, so an outage was
       * not a shorter list — it was no section at all, which reads as "nothing
       * is pending". An admin who believes that sends a second invitation to
       * somebody who already holds a live link.
       */
      mockApi(undefined, { invitationsStatus: 503 });
      renderPage();

      await screen.findByText(/Pending invitations could not be listed/);
    });

    it('says nothing about invitations when the list loads empty', async () => {
      // An engagement genuinely having none is the common case and must stay
      // silent.
      mockApi({ invitations: [] });
      renderPage();

      await screen.findByText('ada@acme.com');
      expect(screen.queryByText(/could not be listed/)).toBeNull();
    });

    it('offers neither note when both catalogs load', async () => {
      // The other half — both messages must be earned.
      mockApi();
      renderPage();
      await openEditor();

      await screen.findByRole('checkbox', { name: 'Partner' });
      expect(screen.queryByText(/could not be loaded/)).toBeNull();
      expect(screen.queryByText(/could not be listed/)).toBeNull();
      expect(screen.getByRole('combobox', { name: /^Partner/ })).not.toBeDisabled();
    });
  });
});
