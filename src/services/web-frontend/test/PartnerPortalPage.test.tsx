import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PartnerPortalPage } from '../src/pages/PartnerPortalPage';
import type { ApiToken, PartnerBranding, User, Valuation } from '../src/lib/types';

/**
 * The partner portal (M3 feature 12) — a partner organisation's home page.
 *
 * Two halves that answer to different permissions, which is what the tests are
 * about. The portfolio is server-scoped and shown to anyone in the org; the API
 * tokens (feature 14) are for org admins only, and the mint form is the one
 * place in the product that shows a secret exactly once. A token that renders
 * for a member, or a mint failure that clears the screen instead of saying what
 * happened, is the kind of thing this page fails at quietly.
 */

let mockUser: User;
vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

const PARTNER_ID = '01N409PARTNER00000000000AA';

const makeUser = (over: Partial<User> = {}): User =>
  ({
    id: 'u-partner',
    email: 'admin@vestd.example',
    partner_id: PARTNER_ID,
    roles: ['partner'],
    ...over,
  }) as unknown as User;

const makeValuation = (over: Partial<Valuation> = {}): Valuation =>
  ({
    id: '01N409VALUATION000000000AA',
    company_name: 'Portfolio One',
    kind: '409a',
    state: 'published',
    created_at: '2026-03-01T00:00:00Z',
    ...over,
  }) as unknown as Valuation;

const makeToken = (over: Partial<ApiToken> = {}): ApiToken =>
  ({
    id: '01N409TOKEN0000000000000AA',
    name: 'CRM integration',
    token_prefix: 'n409_live_ab',
    created_at: '2026-02-01T00:00:00Z',
    last_used_at: null,
    revoked_at: null,
    ...over,
  }) as unknown as ApiToken;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Request failed', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

interface ServerOptions {
  valuations?: Valuation[];
  partner?: PartnerBranding | null;
  tokens?: ApiToken[];
  /** `METHOD /path-fragment` → the response to answer it with. */
  fail?: Record<string, Response | (() => Response)>;
}

/**
 * A stand-in server that records every request.
 *
 * The token list is read from a mutable array rather than a fixed response so a
 * test can assert that the page reloads it after a mint or a revoke — the whole
 * point of `loadTokens` being called again is that the table is not stale.
 */
function mockServer(options: ServerOptions = {}) {
  const calls: Call[] = [];
  const tokens = [...(options.tokens ?? [])];

  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input).replace('/api/v1', '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path, body });

    for (const [key, response] of Object.entries(options.fail ?? {})) {
      const [failMethod, fragment] = key.split(' ');
      if (method === failMethod && path.includes(fragment!)) {
        return typeof response === 'function' ? response() : response.clone();
      }
    }

    if (path.startsWith('/valuations')) return json({ valuations: options.valuations ?? [] });
    if (path === '/partners/mine') {
      return options.partner === undefined
        ? problem(404, 'No partner')
        : json({ partner: options.partner });
    }
    if (method === 'POST' && path.endsWith('/tokens')) {
      const minted = makeToken({ id: `tok-${tokens.length}`, name: String(body?.name) });
      tokens.push(minted);
      return json({ token: minted, secret: 'n409_live_abcdef0123456789' }, 201);
    }
    if (method === 'DELETE' && path.startsWith('/api-tokens/')) {
      const id = path.split('/').pop();
      const found = tokens.findIndex((t) => t.id === id);
      if (found >= 0) tokens.splice(found, 1);
      return json({});
    }
    if (path.endsWith('/tokens')) return json({ tokens });
    return json({});
  });

  return { calls, fetchSpy, tokens };
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <PartnerPortalPage />
    </MemoryRouter>,
  );

/** The token table has rendered once a row for `name` is on screen. */
const tokenRow = async (name: string) => (await screen.findByText(name)).closest('tr')!;

describe('PartnerPortalPage — portfolio', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUser = makeUser();
  });

  it('shows the organisation’s own name and branding once it loads', async () => {
    mockServer({
      partner: {
        id: PARTNER_ID,
        name: 'Vestd',
        brand_color: '#123456',
        logo_url: 'https://cdn.example/logo.png',
      } as unknown as PartnerBranding,
    });
    renderPage();

    expect(await screen.findByRole('heading', { name: /Vestd/, level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Vestd logo' })).toHaveAttribute(
      'src',
      'https://cdn.example/logo.png',
    );
  });

  it('falls back to a generic title when the org has no branding on file', async () => {
    mockServer({ partner: null, valuations: [makeValuation()] });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Your portfolio', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /logo/ })).not.toBeInTheDocument();
  });

  /**
   * The branding request failing is not a page failure — the portfolio below is
   * what the partner came for, and a 404 on `/partners/mine` is what a partner
   * with no branding row gets.
   */
  it('still renders the portfolio when the branding lookup fails', async () => {
    mockServer({ valuations: [makeValuation({ company_name: 'Still Here' })] });
    renderPage();

    expect(await screen.findByText('Still Here')).toBeInTheDocument();
    expect(screen.queryByText('Could not load your portfolio.')).not.toBeInTheDocument();
  });

  it('summarises the portfolio and lists the most recent engagements', async () => {
    mockServer({
      partner: null,
      valuations: [
        makeValuation({ id: 'v1', company_name: 'Alpha', state: 'published' }),
        makeValuation({ id: 'v2', company_name: 'Beta', state: 'review' }),
        makeValuation({ id: 'v3', company_name: 'Gamma', state: 'started' }),
      ],
    });
    renderPage();

    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Gamma')).toBeInTheDocument();
    // Each engagement links to its own workspace, not to the list.
    expect(screen.getByRole('link', { name: /Alpha/ })).toHaveAttribute('href', '/valuations/v1');
  });

  /**
   * The list request asks for 100 per page. A default page size here would show
   * a partner a subset of their portfolio and label it "Total".
   */
  it('asks for the whole portfolio rather than one default page', async () => {
    const { calls } = mockServer({ partner: null, valuations: [makeValuation()] });
    renderPage();
    await screen.findByText('Portfolio One');

    expect(calls.some((c) => c.path === '/valuations?per_page=100')).toBe(true);
  });

  it('shows only the first eight engagements, with a way to the rest', async () => {
    mockServer({
      partner: null,
      valuations: Array.from({ length: 12 }, (_, i) =>
        makeValuation({ id: `v${i}`, company_name: `Company ${i}` }),
      ),
    });
    renderPage();

    await screen.findByText('Company 0');
    expect(screen.getByText('Company 7')).toBeInTheDocument();
    expect(screen.queryByText('Company 8')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View all/ })).toHaveAttribute('href', '/valuations');
  });

  it('offers a way to start one rather than an empty page', async () => {
    mockServer({ partner: null, valuations: [] });
    renderPage();

    expect(await screen.findByText('No valuations in your portfolio yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Start one for a client/ })).toHaveAttribute(
      'href',
      '/valuations/new',
    );
  });

  /**
   * A failed portfolio load has to say so. The spinner is rendered on
   * `!valuations && !error`, so an error that did not set `error` would leave a
   * spinner turning forever — which reads as "still loading" and never resolves.
   */
  it('says the portfolio could not be loaded instead of spinning forever', async () => {
    mockServer({ partner: null, fail: { 'GET /valuations': problem(500, 'boom') } });
    renderPage();

    expect(await screen.findByText('Could not load your portfolio.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });
});

describe('PartnerPortalPage — API tokens', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUser = makeUser();
  });

  /**
   * Minting is an org-admin action. A member of a partner organisation carries
   * `partner_id` too, so scoping this on the id alone would have shown the mint
   * form — and the token list — to every member of the org.
   */
  it('hides the token section from a member who is not an org admin', async () => {
    const { calls } = mockServer({ partner: null, valuations: [makeValuation()], tokens: [makeToken()] });
    mockUser = makeUser({ roles: ['member'] });
    renderPage();

    await screen.findByText('Portfolio One');
    expect(screen.queryByRole('heading', { name: 'API tokens' })).not.toBeInTheDocument();
    // And it does not go looking for them either.
    expect(calls.some((c) => c.path.endsWith('/tokens'))).toBe(false);
  });

  it('hides the token section from a partner user with no organisation', async () => {
    mockServer({ partner: null, valuations: [makeValuation()] });
    mockUser = makeUser({ partner_id: null });
    renderPage();

    await screen.findByText('Portfolio One');
    expect(screen.queryByRole('heading', { name: 'API tokens' })).not.toBeInTheDocument();
  });

  it('lists the organisation’s tokens with their prefix and last use', async () => {
    mockServer({
      partner: null,
      tokens: [
        makeToken({ name: 'CRM integration', last_used_at: '2026-05-04T10:00:00Z' }),
        makeToken({ id: 'tok-2', name: 'Never used', last_used_at: null }),
      ],
    });
    renderPage();

    const row = await tokenRow('CRM integration');
    expect(within(row).getByText('n409_live_ab…')).toBeInTheDocument();
    // A token that has never been called says so, rather than showing a blank
    // cell that reads as "we lost the record".
    expect(within(await tokenRow('Never used')).getByText('Never')).toBeInTheDocument();
  });

  it('says so plainly when the organisation has no tokens yet', async () => {
    mockServer({ partner: null, tokens: [] });
    renderPage();

    expect(await screen.findByText('No tokens yet.')).toBeInTheDocument();
  });

  it('reports a token list it could not load', async () => {
    mockServer({ partner: null, fail: { 'GET /tokens': problem(500, 'boom') } });
    renderPage();

    expect(await screen.findByText('Could not load API tokens.')).toBeInTheDocument();
  });

  it('will not submit an empty or whitespace-only token name', async () => {
    mockServer({ partner: null, tokens: [] });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('No tokens yet.');
    const submit = screen.getByRole('button', { name: 'Create token' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('Token name'), '   ');
    expect(submit).toBeDisabled();
  });

  /**
   * The secret is returned once and never again. It has to be on screen, said
   * to be un-retrievable, and the name trimmed before it is sent — a token
   * called `" CRM "` is a token nobody can find again.
   */
  it('shows the minted secret once and says it cannot be retrieved again', async () => {
    const { calls } = mockServer({ partner: null, tokens: [] });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('No tokens yet.');
    await user.type(screen.getByLabelText('Token name'), '  CRM integration  ');
    await user.click(screen.getByRole('button', { name: 'Create token' }));

    expect(await screen.findByText(/Token “CRM integration” created/)).toBeInTheDocument();
    expect(screen.getByText(/shown once and cannot be retrieved again/)).toBeInTheDocument();
    expect(screen.getByText('n409_live_abcdef0123456789')).toBeInTheDocument();

    const post = calls.find((c) => c.method === 'POST' && c.path.endsWith('/tokens'));
    expect(post?.body?.name).toBe('CRM integration');
  });

  it('clears the name and reloads the list after a mint', async () => {
    mockServer({ partner: null, tokens: [] });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('No tokens yet.');
    await user.type(screen.getByLabelText('Token name'), 'CRM integration');
    await user.click(screen.getByRole('button', { name: 'Create token' }));

    // The new token appears in the table, and the form is ready for the next.
    expect(await tokenRow('CRM integration')).toBeInTheDocument();
    expect(screen.getByLabelText('Token name')).toHaveValue('');
  });

  it('copies the secret to the clipboard on request', async () => {
    mockServer({ partner: null, tokens: [] });
    const user = userEvent.setup();
    // After `setup()`, which installs a clipboard stub of its own — defining
    // this first would hand the assertion a spy the page never reaches.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage();

    await screen.findByText('No tokens yet.');
    await user.type(screen.getByLabelText('Token name'), 'CRM');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    await screen.findByText(/Token “CRM” created/);
    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledWith('n409_live_abcdef0123456789');
  });

  /**
   * A rejected mint must say why and leave the typed name alone. Clearing the
   * field on failure is how a partner retypes the same name and gets the same
   * 409 without ever reading it.
   */
  it('keeps the name and reports the server’s reason when the mint is rejected', async () => {
    mockServer({
      partner: null,
      tokens: [],
      fail: { 'POST /tokens': problem(409, 'A token with that name already exists') },
    });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('No tokens yet.');
    await user.type(screen.getByLabelText('Token name'), 'CRM integration');
    await user.click(screen.getByRole('button', { name: 'Create token' }));

    expect(await screen.findByText('A token with that name already exists')).toBeInTheDocument();
    expect(screen.getByLabelText('Token name')).toHaveValue('CRM integration');
  });

  it('re-enables the form after a failed mint', async () => {
    mockServer({ partner: null, tokens: [], fail: { 'POST /tokens': problem(500, 'boom') } });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('No tokens yet.');
    await user.type(screen.getByLabelText('Token name'), 'CRM');
    await user.click(screen.getByRole('button', { name: 'Create token' }));

    await screen.findByText('boom');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create token' })).not.toBeDisabled(),
    );
  });

  /** Revoking is destructive and irreversible, so it asks first. */
  it('does not revoke a token when the confirmation is declined', async () => {
    const { calls } = mockServer({ partner: null, tokens: [makeToken()] });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderPage();

    await tokenRow('CRM integration');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(screen.getByText('CRM integration')).toBeInTheDocument();
  });

  it('revokes a token once confirmed and reloads the list', async () => {
    const { calls } = mockServer({ partner: null, tokens: [makeToken()] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();

    await tokenRow('CRM integration');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    expect(confirm).toHaveBeenCalledWith(
      'Revoke "CRM integration"? Integrations using it will stop working.',
    );
    expect(calls.some((c) => c.method === 'DELETE' && c.path.includes('/api-tokens/'))).toBe(true);
    expect(await screen.findByText('No tokens yet.')).toBeInTheDocument();
  });

  it('reports a revoke the server refused', async () => {
    mockServer({
      partner: null,
      tokens: [makeToken()],
      fail: { 'DELETE /api-tokens': problem(500, 'boom') },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();

    await tokenRow('CRM integration');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    expect(await screen.findByText('Could not revoke the token.')).toBeInTheDocument();
    // The token is still listed — the failure did not half-apply.
    expect(screen.getByText('CRM integration')).toBeInTheDocument();
  });

  /** An already-revoked token is history, not an action. */
  it('shows a revoked token as revoked, with no button to revoke it again', async () => {
    mockServer({
      partner: null,
      tokens: [makeToken({ name: 'Retired', revoked_at: '2026-04-01T00:00:00Z' })],
    });
    renderPage();

    const row = await tokenRow('Retired');
    expect(within(row).getByText('Revoked')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });
});
