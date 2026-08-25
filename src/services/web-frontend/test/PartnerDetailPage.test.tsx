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
  subdomain: null,
  prepaid: false,
  cc_emails: [],
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

const TOKENS = [
  {
    id: '01N409TOKEN0000000000000AA',
    name: 'Portfolio sync',
    token_prefix: 'n409_live_ab',
    created_at: '2026-02-01T00:00:00Z',
    last_used_at: null,
    revoked_at: null,
  },
  {
    id: '01N409TOKEN0000000000000BB',
    name: 'Retired integration',
    token_prefix: 'n409_live_cd',
    created_at: '2026-01-01T00:00:00Z',
    last_used_at: '2026-03-01T00:00:00Z',
    revoked_at: '2026-04-01T00:00:00Z',
  },
];

const VALUATIONS = [
  {
    id: '01N409VALUATION000000000AA',
    number: '1766',
    company_name: 'Portfolio One',
    kind: '409a',
    state: 'published',
    created_at: '2026-05-01T00:00:00Z',
  },
];

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi(over: Partial<PartnerDetail> = {}, savedView?: { created: boolean }) {
  const partner = { ...detail, ...over };
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ url: path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.includes('/saved-view')) {
      return jsonResponse(
        { view: { id: 'v1', name: partner.name }, created: savedView?.created ?? true },
        savedView?.created === false ? 200 : 201,
      );
    }
    if (method === 'PATCH' && path.includes('/users/')) return jsonResponse({ user: {} });
    if (path.includes(`/partners/${PARTNER_ID}/tokens`)) {
      return method === 'POST'
        ? jsonResponse({ token: {}, secret: 'n409_live_supersecret' }, 201)
        : jsonResponse({ tokens: TOKENS });
    }
    if (path.includes(`/partners/${PARTNER_ID}/valuations`))
      return jsonResponse({ valuations: VALUATIONS, page: 1, per_page: 10, total: VALUATIONS.length });
    if (path.includes(`/partners/${PARTNER_ID}`)) return jsonResponse({ partner });
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
    // Valuation rollups by state group. Matched on the stat-card label element
    // specifically: "Published" is also a state badge on the engagement list
    // further down, which arrives from a second request — a bare getByText
    // races that request rather than testing anything.
    const statLabel = (text: string) =>
      screen.getAllByText(text).find((el) => el.className.includes('overline'))!;
    expect(statLabel('In review').parentElement?.textContent).toContain('2');
    expect(statLabel('Published').parentElement?.textContent).toContain('6');
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

  describe('address & commercial terms', () => {
    it('saves the subdomain and the shared mailbox together', async () => {
      const calls = mockApi();
      const user = userEvent.setup();
      renderPage();

      await user.type(await screen.findByLabelText('Subdomain'), 'vestd');
      await user.type(screen.getByLabelText('CC addresses'), '409a@vestd.com\nfilings@vestd.com');
      await user.click(screen.getByRole('button', { name: 'Save terms' }));

      await waitFor(() => {
        const patch = calls.find(
          (c) => c.method === 'PATCH' && (c.body as Record<string, unknown>)?.subdomain !== undefined,
        );
        expect(patch!.body).toEqual({
          subdomain: 'vestd',
          cc_emails: ['409a@vestd.com', 'filings@vestd.com'],
        });
      });
    });

    it('drops the empty entry a trailing newline leaves behind', async () => {
      const calls = mockApi();
      const user = userEvent.setup();
      renderPage();

      await user.type(await screen.findByLabelText('CC addresses'), '409a@vestd.com\n');
      await user.click(screen.getByRole('button', { name: 'Save terms' }));

      await waitFor(() => {
        const patch = calls.find(
          (c) => c.method === 'PATCH' && (c.body as Record<string, unknown>)?.cc_emails !== undefined,
        );
        expect((patch!.body as { cc_emails: string[] }).cc_emails).toEqual(['409a@vestd.com']);
      });
    });

    it('saves prepaid on the toggle rather than waiting for a Save press', async () => {
      // Prepaid changes what a client is shown at checkout; a toggle that only
      // takes effect when you remember to press Save is how that goes wrong.
      const calls = mockApi();
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('checkbox'));
      await waitFor(() => {
        const patch = calls.find(
          (c) => c.method === 'PATCH' && (c.body as Record<string, unknown>)?.prepaid !== undefined,
        );
        expect(patch!.body).toEqual({ prepaid: true });
      });
    });
  });

  describe('API tokens', () => {
    it('lists live tokens and hides revoked ones', async () => {
      mockApi();
      renderPage();
      expect(await screen.findByText('Portfolio sync')).toBeInTheDocument();
      expect(screen.queryByText('Retired integration')).toBeNull();
    });

    it('calls out a token that has never been used', async () => {
      // Usually it means the integration was never wired up, not that it is idle.
      mockApi();
      renderPage();
      expect(await screen.findByText('Never')).toBeInTheDocument();
    });

    it('shows the secret once, on issue, and keeps it until dismissed', async () => {
      mockApi();
      const user = userEvent.setup();
      renderPage();

      await user.type(await screen.findByLabelText('New token name'), 'Portfolio sync');
      await user.click(screen.getByRole('button', { name: 'Issue token' }));

      expect(await screen.findByText('n409_live_supersecret')).toBeInTheDocument();
      expect(screen.getByText(/only time it can be read/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /I have copied it/i }));
      expect(screen.queryByText('n409_live_supersecret')).toBeNull();
    });

    /**
     * R31 — the rule used to live in a disabled button. It now submits and
     * names the box, and still posts nothing.
     */
    it('refuses to issue an unnamed token, and says which box', async () => {
      const calls = mockApi();
      renderPage();
      await screen.findByText('Portfolio sync');

      await userEvent.click(screen.getByRole('button', { name: 'Issue token' }));

      expect(await screen.findByText('Token name is required.')).toBeInTheDocument();
      expect(calls.find((c) => c.method === 'POST')).toBeUndefined();
    });
  });

  /**
   * R31 — inline validation for the two settings forms on this page.
   *
   * Both are restatements of what the PATCH route already enforces. The
   * subdomain box carried no constraint at all and the brand colour carried a
   * `pattern` attribute the browser stops honouring on a `noValidate` form, so
   * both shapes reached the server and came back as a 422 with the admin's
   * page already scrolled away from the box that caused it.
   */
  describe('commercial terms and branding validation', () => {
    it('refuses a subdomain DNS will not serve', async () => {
      const calls = mockApi();
      renderPage();
      await screen.findByLabelText('Subdomain');

      await userEvent.type(screen.getByLabelText('Subdomain'), 'acme_corp');
      await userEvent.click(screen.getByRole('button', { name: 'Save terms' }));

      expect(
        await screen.findByText(
          'A subdomain is 3–63 characters of a–z, 0–9 and hyphens, not starting or ending with one.',
        ),
      ).toBeInTheDocument();
      expect(calls.find((c) => c.method === 'PATCH')).toBeUndefined();
    });

    it('refuses a subdomain that ends in a hyphen', async () => {
      const calls = mockApi();
      renderPage();
      await screen.findByLabelText('Subdomain');

      await userEvent.type(screen.getByLabelText('Subdomain'), 'acme-');
      await userEvent.click(screen.getByRole('button', { name: 'Save terms' }));

      expect(
        await screen.findByText(
          'A subdomain is 3–63 characters of a–z, 0–9 and hyphens, not starting or ending with one.',
        ),
      ).toBeInTheDocument();
      expect(calls.find((c) => c.method === 'PATCH')).toBeUndefined();
    });

    /**
     * The route lower-cases and trims before checking, so the form has to as
     * well — rejecting "Acme " here when the PATCH would have taken it is a
     * rule the platform does not actually have.
     */
    it('accepts a subdomain the route would have normalised', async () => {
      const calls = mockApi();
      renderPage();
      await screen.findByLabelText('Subdomain');

      await userEvent.type(screen.getByLabelText('Subdomain'), 'Acme');
      await userEvent.click(screen.getByRole('button', { name: 'Save terms' }));

      await waitFor(() => {
        const patch = calls.find((c) => c.method === 'PATCH');
        expect(patch).toBeTruthy();
        expect((patch!.body as { subdomain: string }).subdomain).toBe('Acme');
      });
    });

    /** Blank keeps the firm on the platform's own address — still legal. */
    it('keeps a blank subdomain legal and sends it as null', async () => {
      const calls = mockApi();
      renderPage();
      await screen.findByLabelText('Subdomain');

      await userEvent.click(screen.getByRole('button', { name: 'Save terms' }));

      await waitFor(() => {
        const patch = calls.find((c) => c.method === 'PATCH');
        expect(patch).toBeTruthy();
        expect(patch!.body).toEqual({ subdomain: null, cc_emails: [] });
      });
    });

    it('names the CC address that is not an address', async () => {
      const calls = mockApi();
      renderPage();
      await screen.findByLabelText('CC addresses');

      await userEvent.type(screen.getByLabelText('CC addresses'), 'filings@yourfirm.com\nnot-an-address');
      await userEvent.click(screen.getByRole('button', { name: 'Save terms' }));

      expect(await screen.findByText('“not-an-address” is not an email address.')).toBeInTheDocument();
      expect(calls.find((c) => c.method === 'PATCH')).toBeUndefined();
    });

    it('refuses more CC addresses than the route accepts', async () => {
      const calls = mockApi();
      renderPage();
      await screen.findByLabelText('CC addresses');

      const many = Array.from({ length: 11 }, (_, i) => `ops${i}@firm.com`).join('\n');
      await userEvent.type(screen.getByLabelText('CC addresses'), many);
      await userEvent.click(screen.getByRole('button', { name: 'Save terms' }));

      expect(
        await screen.findByText('At most 10 CC addresses — this is a mailing list, not a mailshot.'),
      ).toBeInTheDocument();
      expect(calls.find((c) => c.method === 'PATCH')).toBeUndefined();
    });

    it('refuses a brand colour that is not six hex digits', async () => {
      const calls = mockApi();
      renderPage();
      await screen.findByLabelText('Brand colour');

      await userEvent.type(screen.getByLabelText('Brand colour'), 'forest green');
      await userEvent.click(screen.getByRole('button', { name: 'Save branding' }));

      expect(await screen.findByText('Use a six-digit hex colour, e.g. #1f6f54.')).toBeInTheDocument();
      expect(calls.find((c) => c.method === 'PATCH')).toBeUndefined();
    });

    it('refuses a logo that is not a URL', async () => {
      const calls = mockApi();
      renderPage();
      await screen.findByLabelText('Logo URL');

      await userEvent.type(screen.getByLabelText('Logo URL'), 'logo.png');
      await userEvent.click(screen.getByRole('button', { name: 'Save branding' }));

      expect(await screen.findByText('Enter a full URL, starting with https://.')).toBeInTheDocument();
      expect(calls.find((c) => c.method === 'PATCH')).toBeUndefined();
    });

    /** Blank clears the override back to the platform's own look. */
    it('keeps both branding boxes optional', async () => {
      const calls = mockApi();
      renderPage();
      await screen.findByLabelText('Brand colour');

      await userEvent.click(screen.getByRole('button', { name: 'Save branding' }));

      await waitFor(() => {
        const patch = calls.find((c) => c.method === 'PATCH');
        expect(patch).toBeTruthy();
        expect(patch!.body).toEqual({ brand_color: null, logo_url: null });
      });
    });

    it('accepts a well-formed colour and logo together', async () => {
      const calls = mockApi();
      renderPage();
      await screen.findByLabelText('Brand colour');

      await userEvent.type(screen.getByLabelText('Brand colour'), '#1f6f54');
      await userEvent.type(screen.getByLabelText('Logo URL'), 'https://cdn.example.com/logo.png');
      await userEvent.click(screen.getByRole('button', { name: 'Save branding' }));

      await waitFor(() => {
        const patch = calls.find((c) => c.method === 'PATCH');
        expect(patch).toBeTruthy();
        expect(patch!.body).toEqual({
          brand_color: '#1f6f54',
          logo_url: 'https://cdn.example.com/logo.png',
        });
      });
    });

    /**
     * The message stays hidden until the box has been left once — validating on
     * every keystroke tells an admin their colour is wrong while they are still
     * typing the first hex digit.
     */
    it('holds the message back until the box is blurred', async () => {
      mockApi();
      renderPage();
      await screen.findByLabelText('Brand colour');

      await userEvent.type(screen.getByLabelText('Brand colour'), '#1f');
      expect(screen.queryByText('Use a six-digit hex colour, e.g. #1f6f54.')).not.toBeInTheDocument();

      await userEvent.tab();
      expect(await screen.findByText('Use a six-digit hex colour, e.g. #1f6f54.')).toBeInTheDocument();
    });
  });

  describe('engagements', () => {
    it("lists the firm's engagements", async () => {
      mockApi();
      renderPage();
      expect(await screen.findByText('Portfolio One')).toBeInTheDocument();
      expect(screen.getByText('#1766')).toBeInTheDocument();
    });
  });

  /**
   * The saved entry point (design §4.4). The gap was not that a firm's
   * engagements were unreachable — it was that reaching them meant picking the
   * firm out of a dropdown on a listing of everything, with no counts of its
   * own on the way in.
   */
  describe('partner-scoped entry point', () => {
    const BUCKETS = {
      all: 12,
      incomplete: 4,
      unverified: 0,
      in_progress: 2,
      waiting_on_client: 3,
      drafted: 0,
      published: 6,
      unread: 1,
      ignored: 0,
    };

    it('carries the firm’s own bucket counts, each a way into the scoped listing', async () => {
      mockApi({ valuations_by_bucket: BUCKETS });
      renderPage();
      const chip = await screen.findByRole('link', { name: /In progress/ });
      expect(chip).toHaveAttribute('href', `/valuations?partner_id=${PARTNER_ID}&bucket=in_progress`);
      expect(chip).toHaveTextContent('2');
      expect(screen.getByRole('link', { name: /Waiting on client/ })).toHaveTextContent('3');
    });

    it('drops the empty buckets — this is a summary, not the tab strip', async () => {
      // Nine tiles of which four read zero buries the ones that do not. The
      // listing itself still shows all nine, because there the tabs are
      // controls rather than a summary.
      mockApi({ valuations_by_bucket: BUCKETS });
      renderPage();
      await screen.findByRole('link', { name: /In progress/ });
      expect(screen.queryByRole('link', { name: /Unverified/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /Drafted/ })).not.toBeInTheDocument();
    });

    it('links to the whole scoped listing with the firm’s total', async () => {
      mockApi({ valuations_by_bucket: BUCKETS });
      renderPage();
      const link = await screen.findByRole('link', { name: /Open the full listing \(12\)/ });
      expect(link).toHaveAttribute('href', `/valuations?partner_id=${PARTNER_ID}`);
    });

    it('renders without the counts rather than blanking the page', async () => {
      mockApi({ valuations_by_bucket: undefined });
      renderPage();
      expect(await screen.findByText(/No engagements yet for this firm/)).toBeInTheDocument();
    });

    it('pins the firm’s listing as a shared saved view', async () => {
      const calls = mockApi({ valuations_by_bucket: BUCKETS });
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Pin to saved views' }));

      await waitFor(() =>
        expect(
          calls.some((c) => c.method === 'POST' && c.url.endsWith(`/partners/${PARTNER_ID}/saved-view`)),
        ).toBe(true),
      );
      expect(await screen.findByText(/is now in the saved views/)).toBeInTheDocument();
    });

    it('says so plainly when the firm is already pinned', async () => {
      mockApi({ valuations_by_bucket: BUCKETS }, { created: false });
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Pin to saved views' }));
      expect(await screen.findByText(/Already pinned/)).toBeInTheDocument();
    });
  });
});

/**
 * The pager with two pages outstanding.
 *
 * "Next" twice puts two page loads in flight, and nothing orders their replies.
 * The stale one repaints the earlier page's engagements beneath a pager that
 * says the later number — and because the pager reads its own state rather than
 * the response, nothing on screen disagrees with anything else.
 */
describe('PartnerDetailPage — the engagement pager', () => {
  beforeEach(() => vi.restoreAllMocks());

  const engagement = (id: string, company: string) => ({
    id,
    number: '2001',
    company_name: company,
    kind: '409a',
    state: 'published',
    created_at: '2026-07-01T00:00:00Z',
  });

  function deferValuationPages() {
    const pending: Array<{ url: string; resolve: (body: unknown, status?: number) => void }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes(`/partners/${PARTNER_ID}/valuations`)) {
        return new Promise<Response>((res) =>
          pending.push({ url: path, resolve: (body, status = 200) => res(jsonResponse(body, status)) }),
        );
      }
      if (path.includes(`/partners/${PARTNER_ID}/tokens`)) return jsonResponse({ tokens: [] });
      if (path.includes(`/partners/${PARTNER_ID}`)) return jsonResponse({ partner: detail });
      return jsonResponse({});
    });
    return pending;
  }

  const page = (company: string) => ({
    valuations: [engagement('01N409VALUATION0000000AA1', company)],
    total: 30,
  });

  it('lists the page the pager is showing, not the page that replied last', async () => {
    const user = userEvent.setup();
    const pending = deferValuationPages();
    renderPage();

    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!.resolve(page('Page One Co'));
    await screen.findByText('Page One Co');

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(pending).toHaveLength(3));

    expect(pending[1]!.url).toContain('page=2');
    expect(pending[2]!.url).toContain('page=3');

    pending[2]!.resolve(page('Page Three Co'));
    await screen.findByText('Page Three Co');
    pending[1]!.resolve(page('Page Two Co'));

    await waitFor(() => expect(screen.getByText('Page Three Co')).toBeInTheDocument());
    expect(screen.queryByText('Page Two Co')).toBeNull();
    expect(screen.getByText(/Page 3 of/)).toBeInTheDocument();
  });

  it('does not report a failure the abandoned page ran into', async () => {
    const user = userEvent.setup();
    const pending = deferValuationPages();
    renderPage();

    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!.resolve(page('Page One Co'));
    await screen.findByText('Page One Co');

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(pending).toHaveLength(3));

    pending[2]!.resolve(page('Page Three Co'));
    await screen.findByText('Page Three Co');
    pending[1]!.resolve({ detail: 'gone' }, 500);

    await waitFor(() => expect(screen.getByText('Page Three Co')).toBeInTheDocument());
    expect(screen.queryByText(/Could not load this partner/)).toBeNull();
  });
});
