import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { AdminSsoPage } from '../src/pages/AdminSsoPage';

const CONFIG = {
  enabled: true,
  idp_entity_id: 'https://idp.example.com/entity',
  idp_sso_url: 'https://idp.example.com/sso',
  idp_cert: 'MIIBIjANBg…',
  sp_entity_id: null,
  allowed_domain: 'corp.com',
  default_role: 'valuation_user',
};

const TOKENS = [
  {
    id: 'tok-active',
    label: 'Okta provisioning',
    created_at: '2026-06-01T10:00:00Z',
    last_used_at: '2026-07-01T10:00:00Z',
    revoked_at: null,
  },
  {
    id: 'tok-revoked',
    label: null,
    created_at: '2026-01-01T10:00:00Z',
    last_used_at: null,
    revoked_at: '2026-02-01T10:00:00Z',
  },
];

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Error', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

function mockApi(
  options: {
    config?: unknown;
    tokens?: unknown[];
    onWrite?: (path: string, init: RequestInit) => Response;
  } = {},
) {
  const { config = CONFIG, tokens = TOKENS, onWrite } = options;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if ((init?.method ?? 'GET') !== 'GET') {
      if (onWrite) return onWrite(path, init!);
      return jsonResponse({ config, secret: 'scim_live_abc123' });
    }
    if (path.includes('/admin/sso/saml')) return jsonResponse({ config });
    if (path.includes('/admin/sso/scim-tokens')) return jsonResponse({ tokens });
    throw new Error(`unexpected fetch ${path}`);
  });
}

const renderPage = () =>
  render(
    // The SCIM mint asks the signed-in account whether it has a password to
    // confirm (round 359), so the page needs the auth context.
    <AuthProvider>
      <MemoryRouter>
        <AdminSsoPage />
      </MemoryRouter>
    </AuthProvider>,
  );

const loaded = () => screen.findByRole('button', { name: /Save SAML config/i });

describe('AdminSsoPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('seeds the SAML form from the stored configuration', async () => {
    mockApi();
    renderPage();
    await loaded();

    expect(screen.getByDisplayValue('https://idp.example.com/sso')).toBeInTheDocument();
    expect(screen.getByDisplayValue('MIIBIjANBg…')).toBeInTheDocument();
    expect(screen.getByDisplayValue('corp.com')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Enabled/i })).toBeChecked();
  });

  it('renders an unconfigured tenant as a blank, disabled form rather than an error', async () => {
    // The first administrator to open this page has no config yet; a null
    // payload is the normal case, not a failure.
    mockApi({ config: null, tokens: [] });
    renderPage();
    await loaded();

    expect(screen.getByRole('checkbox', { name: /Enabled/i })).not.toBeChecked();
    expect(screen.getByLabelText(/^IdP SSO URL/)).toHaveValue('');
    expect(screen.getByText(/No SCIM tokens yet/i)).toBeInTheDocument();
  });

  it('reports a failed load rather than spinning forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    renderPage();
    await screen.findByText(/Could not load SSO settings/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('PUTs the config, nulling blank fields, and confirms the save', async () => {
    let body: Record<string, unknown> | null = null;
    mockApi({
      config: null,
      tokens: [],
      onWrite: (_path, init) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ config: { ...CONFIG, allowed_domain: 'newco.com' } });
      },
    });
    renderPage();
    await loaded();

    await userEvent.click(screen.getByRole('checkbox', { name: /Enabled/i }));
    await userEvent.type(screen.getByLabelText(/^Allowed email domain/), 'newco.com');
    await userEvent.click(screen.getByRole('button', { name: /Save SAML config/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.enabled).toBe(true);
    expect(body!.allowed_domain).toBe('newco.com');
    // An empty string here would be stored as a configured-but-blank endpoint.
    expect(body!.idp_sso_url).toBeNull();
    expect(body!.sp_entity_id).toBeNull();
    expect(body!.default_role).toBe('valuation_user');

    await screen.findByText('SAML configuration saved.');
    // The form re-seeds from what the server actually stored, not from the draft.
    expect(screen.getByDisplayValue('newco.com')).toBeInTheDocument();
  });

  it('surfaces a refused save and does not claim success', async () => {
    mockApi({ onWrite: () => problem(422, 'idp_cert is not valid base64') });
    renderPage();
    await loaded();

    await userEvent.click(screen.getByRole('button', { name: /Save SAML config/i }));
    await screen.findByText('idp_cert is not valid base64');
    expect(screen.queryByText('SAML configuration saved.')).not.toBeInTheDocument();
  });

  it('shows a minted SCIM secret once, with the base URL needed to use it', async () => {
    mockApi({ onWrite: () => jsonResponse({ secret: 'scim_live_9f2c' }, 201) });
    renderPage();
    await loaded();

    await userEvent.type(screen.getByLabelText('Your current password'), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: /New token/i }));
    await screen.findByText('scim_live_9f2c');
    expect(screen.getByText(/won't be shown again/i)).toBeInTheDocument();
    expect(screen.getByText('/scim/v2')).toBeInTheDocument();
  });

  /**
   * The password in front of the SCIM bearer (round 359, methodology M4).
   *
   * This page's own docstring calls a SCIM token a standing grant to create and
   * deactivate users, and the mint had no prompt of any kind — while the
   * personal API key on the settings page, which can do strictly less, has had
   * one since R262.
   */
  it('will not mint a SCIM token until the current password is given', async () => {
    const fetchSpy = mockApi({ onWrite: () => jsonResponse({ secret: 'scim_live_9f2c' }, 201) });
    renderPage();
    await loaded();

    expect(screen.getByRole('button', { name: /New token/i })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Your current password'), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: /New token/i }));

    await screen.findByText('scim_live_9f2c');
    // The prompt has to reach the wire, not merely appear.
    const post = fetchSpy.mock.calls.find(
      ([url, init]) => String(url).includes('scim-tokens') && init?.method === 'POST',
    );
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ current_password: 'hunter2' });
  });

  it('reports a refused mint instead of leaving the button apparently inert', async () => {
    mockApi({ onWrite: () => problem(403, 'SSO is not licensed for this tenant') });
    renderPage();
    await loaded();

    await userEvent.type(screen.getByLabelText('Your current password'), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: /New token/i }));
    await screen.findByText('SSO is not licensed for this tenant');
  });

  it('offers revoke only on a live token and labels an unnamed one', async () => {
    mockApi();
    renderPage();
    await screen.findByText('Okta provisioning');

    const live = screen.getByText('Okta provisioning').closest('tr')!;
    expect(live).toHaveTextContent('Active');
    expect(within(live).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();

    const revoked = screen.getByText('SCIM token').closest('tr')!;
    expect(revoked).toHaveTextContent('Revoked');
    expect(within(revoked).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('revokes a token by id', async () => {
    const writes: string[] = [];
    mockApi({
      onWrite: (path, init) => {
        writes.push(`${init.method} ${path}`);
        return jsonResponse({ ok: true });
      },
    });
    renderPage();
    await screen.findByText('Okta provisioning');

    const live = screen.getByText('Okta provisioning').closest('tr')!;
    await userEvent.click(within(live).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(writes).toEqual(['DELETE /api/v1/admin/sso/scim-tokens/tok-active']));
  });

  it('reports a refused revoke rather than leaving a live credential looking retired', async () => {
    // Regression: the revoke path had no catch, so a refused DELETE left the
    // row reading "Active" with no explanation — and an operator who believes
    // a credential is dead stops watching it.
    mockApi({ onWrite: () => problem(409, 'token is in use by an active SCIM sync') });
    renderPage();
    await screen.findByText('Okta provisioning');

    const live = screen.getByText('Okta provisioning').closest('tr')!;
    await userEvent.click(within(live).getByRole('button', { name: 'Revoke' }));
    await screen.findByText('token is in use by an active SCIM sync');
  });

  it('links to the SP metadata the IdP needs', async () => {
    mockApi();
    renderPage();
    await loaded();
    expect(screen.getByRole('link', { name: /SP metadata XML/i })).toHaveAttribute(
      'href',
      '/api/v1/auth/saml/metadata',
    );
  });

  it('disables the submit while the save is in flight', async () => {
    let release: (() => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url);
      if ((init?.method ?? 'GET') !== 'GET') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return jsonResponse({ config: CONFIG });
      }
      if (path.includes('/admin/sso/saml')) return jsonResponse({ config: CONFIG });
      return jsonResponse({ tokens: TOKENS });
    });
    renderPage();
    await loaded();

    await userEvent.click(screen.getByRole('button', { name: /Save SAML config/i }));
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
    release!();
    await waitFor(() => expect(screen.getByRole('button', { name: /Save SAML config/i })).toBeEnabled());
  });
});
