import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PartnerDetailPage } from '../src/pages/PartnerDetailPage';
import type { PartnerDetail } from '../src/lib/types';

/**
 * The partner console's failure paths and its second states.
 *
 * `PartnerDetailPage.test.tsx` covers the page doing what it is for — the
 * rollups, the saves, the archive. This is the other half: every request on the
 * page refused, both confirms declined, and the three panels' empty and
 * populated alternatives. Four requests fire on mount (the partner, its tokens,
 * its engagements, and nothing else), each into a panel that reports its own
 * failure, so "the page failed" is never the whole answer.
 */

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
  user_count: 1,
  valuation_count: 0,
  valuations_by_group: { open: 1 },
  last_activity_at: null,
  users: [
    {
      id: '01N409USERBOTH0000000000AA',
      email: 'both@vestd.example',
      first_name: 'Pat',
      last_name: 'Admin',
      // Both partner roles and nothing else: removing the user from the firm
      // strips both and leaves them with no role at all, which is the case
      // that has to fall back to `valuation_user`.
      roles: ['partner', 'member'],
    },
    {
      id: '01N409USERPLAIN000000000BB',
      email: 'plain@vestd.example',
      first_name: null,
      last_name: null,
      // No partner role: the PATCH must not carry a `roles` key at all.
      roles: ['investor'],
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detailText: string) =>
  json({ status, title: 'Error', detail: detailText }, status);

interface Route {
  /** Matched against the path with `includes`, in order. */
  when: (path: string, method: string) => boolean;
  reply: () => Response;
}

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

/**
 * A fetch mock whose default is "everything on this page works", with the one
 * request under test swapped out. Written as an ordered list rather than a
 * flag per endpoint because the panels share prefixes — `/partners/:id/tokens`
 * is also `/partners/:id`.
 */
function mockApi(over: Partial<PartnerDetail> = {}, overrides: Route[] = []) {
  const partner = { ...detail, ...over };
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ url: path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const override = overrides.find((r) => r.when(path, method));
    if (override) return override.reply();
    if (path.includes('/saved-view')) return json({ view: { id: 'v1' }, created: true }, 201);
    if (method === 'PATCH' && path.includes('/users/')) return json({ user: {} });
    if (path.includes(`/partners/${PARTNER_ID}/tokens`))
      return method === 'POST'
        ? json({ token: {}, secret: 'n409_live_supersecret' }, 201)
        : json({ tokens: [] });
    if (path.includes(`/partners/${PARTNER_ID}/valuations`))
      return json({ valuations: [], page: 1, per_page: 10, total: 0 });
    if (path.includes(`/partners/${PARTNER_ID}`)) return json({ partner });
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

/** The partner request itself, distinguished from the two that share its prefix. */
const partnerRequest = (path: string, method: string) =>
  method === 'GET' &&
  path.includes(`/partners/${PARTNER_ID}`) &&
  !path.includes('/tokens') &&
  !path.includes('/valuations');

describe('PartnerDetailPage — the page failing to load', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('names a partner that does not exist, rather than blaming the network', async () => {
    mockApi({}, [{ when: partnerRequest, reply: () => problem(404, 'Not found') }]);
    renderPage();

    expect(await screen.findByText('This partner does not exist.')).toBeInTheDocument();
    // The message replaces the page: nothing below it is meaningful without a
    // partner, and a half-rendered console invites a save against nothing.
    expect(screen.queryByRole('button', { name: 'Save branding' })).not.toBeInTheDocument();
  });

  it('reports any other load failure as one', async () => {
    mockApi({}, [{ when: partnerRequest, reply: () => problem(500, 'boom') }]);
    renderPage();

    expect(await screen.findByText('Could not load the partner.')).toBeInTheDocument();
  });
});

describe('PartnerDetailPage — a save the API refuses', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the reason the server gave, above the forms', async () => {
    mockApi({}, [
      {
        when: (path, method) => method === 'PATCH' && path.includes(`/partners/${PARTNER_ID}`),
        reply: () => problem(409, 'That subdomain is taken by another firm.'),
      },
    ]);
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Subdomain'), 'vestd');
    await user.click(screen.getByRole('button', { name: 'Save terms' }));

    expect(await screen.findByText('That subdomain is taken by another firm.')).toBeInTheDocument();
    // The button comes back: the save failed, it did not disappear.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save terms' })).toBeEnabled());
  });

  it('falls back to the form’s own wording when the failure carries none', async () => {
    mockApi({}, [
      {
        when: (path, method) => method === 'PATCH' && path.includes(`/partners/${PARTNER_ID}`),
        reply: () => {
          throw new TypeError('network down');
        },
      },
    ]);
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Brand colour'), '#1f6f54');
    await user.click(screen.getByRole('button', { name: 'Save branding' }));

    expect(await screen.findByText('Could not save the branding.')).toBeInTheDocument();
  });
});

describe('PartnerDetailPage — the archived partner', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('is badged, and offers Restore in place of Archive', async () => {
    const calls = mockApi({ archived_at: '2026-06-01T00:00:00Z' });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Archived')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();

    // Restoring is not destructive, so unlike Archive it asks nothing.
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH');
      expect(patch!.body).toEqual({ archived: false });
    });
  });

  it('sends nothing when the archive confirm is declined', async () => {
    const calls = mockApi();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});

describe('PartnerDetailPage — removing a user from the firm', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('warns that a user with only partner roles is left a regular client user', async () => {
    const calls = mockApi();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('both@vestd.example');
    await user.click(screen.getAllByRole('button', { name: 'Remove from partner' })[0]!);

    expect(confirm.mock.calls[0]![0]).toBe(
      'Remove both@vestd.example from Vestd? Their partner and member roles are removed too — ' +
        'they become a regular client user.',
    );
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/users/'));
      // Stripping both roles would leave a user with none, which is not a state
      // the platform has — they fall back to the plain client role.
      expect(patch!.body).toEqual({ partner_id: null, roles: ['valuation_user'] });
    });
  });

  it('leaves the roles of a user who has no partner role alone', async () => {
    const calls = mockApi();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();

    // Twice: a user with neither name falls back to their address for the
    // display name, above the address itself.
    expect(await screen.findAllByText('plain@vestd.example')).toHaveLength(2);
    await user.click(screen.getAllByRole('button', { name: 'Remove from partner' })[1]!);

    // No roles clause in the question, because none are being removed.
    expect(confirm.mock.calls[0]![0]).toBe('Remove plain@vestd.example from Vestd?');
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/users/'));
      expect(patch!.body).toEqual({ partner_id: null });
    });
  });

  it('sends nothing when the confirm is declined', async () => {
    const calls = mockApi();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('both@vestd.example');
    await user.click(screen.getAllByRole('button', { name: 'Remove from partner' })[0]!);

    expect(calls.some((c) => c.url.includes('/users/'))).toBe(false);
  });

  it('reports a removal the API refuses', async () => {
    mockApi({}, [
      {
        when: (path, method) => method === 'PATCH' && path.includes('/users/'),
        reply: () => problem(403, 'You cannot remove the last administrator of a firm.'),
      },
    ]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('both@vestd.example');
    await user.click(screen.getAllByRole('button', { name: 'Remove from partner' })[0]!);

    expect(
      await screen.findByText('You cannot remove the last administrator of a firm.'),
    ).toBeInTheDocument();
    // Still listed — the failure did not half-apply.
    expect(screen.getByText('both@vestd.example')).toBeInTheDocument();
  });
});

describe('PartnerDetailPage — pinning the firm as a saved view', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('distinguishes a view it created from one that was already there', async () => {
    mockApi({}, [{ when: (path) => path.includes('/saved-view'), reply: () => json({ created: false }) }]);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Pin to saved views' }));
    expect(await screen.findByText('Already pinned — it is in the saved views strip.')).toBeInTheDocument();
  });

  it('reports a pin the API refuses, and lets it be tried again', async () => {
    mockApi({}, [
      {
        when: (path) => path.includes('/saved-view'),
        reply: () => problem(503, 'Saved views are unavailable.'),
      },
    ]);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Pin to saved views' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Saved views are unavailable.');
    // Back to idle rather than stuck on "Pinning…": the whole point of showing
    // the failure is that the admin can act on it.
    expect(screen.getByRole('button', { name: 'Pin to saved views' })).toBeEnabled();
  });
});

describe('PartnerDetailPage — the API token panel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('says so when the tokens will not load', async () => {
    mockApi({}, [
      {
        when: (path, method) => method === 'GET' && path.includes('/tokens'),
        reply: () => problem(500, 'boom'),
      },
    ]);
    renderPage();

    expect(await screen.findByText('Could not load API tokens.')).toBeInTheDocument();
  });

  it('reports a refused issue without clearing the name that was typed', async () => {
    mockApi({}, [
      {
        when: (path, method) => method === 'POST' && path.includes('/tokens'),
        reply: () => problem(409, 'A token by that name already exists.'),
      },
    ]);
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('New token name'), 'Portfolio sync');
    await user.click(screen.getByRole('button', { name: 'Issue token' }));

    expect(await screen.findByText('A token by that name already exists.')).toBeInTheDocument();
    // The secret panel must not appear — nothing was issued.
    expect(screen.queryByText(/Copy the secret/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('New token name')).toHaveValue('Portfolio sync');
  });

  it('shows when a live token was last used, and “Never” when it never was', async () => {
    mockApi({}, [
      {
        when: (path, method) => method === 'GET' && path.includes('/tokens'),
        reply: () =>
          json({
            tokens: [
              {
                id: '01N409TOKEN0000000000000AA',
                name: 'Portfolio sync',
                token_prefix: 'n409_live_ab',
                created_at: '2026-02-01T00:00:00Z',
                last_used_at: '2026-07-04T10:30:00Z',
                revoked_at: null,
              },
              {
                id: '01N409TOKEN0000000000000BB',
                name: 'Never wired up',
                token_prefix: 'n409_live_cd',
                created_at: '2026-02-02T00:00:00Z',
                last_used_at: null,
                revoked_at: null,
              },
              {
                id: '01N409TOKEN0000000000000CC',
                name: 'Retired integration',
                token_prefix: 'n409_live_ef',
                created_at: '2026-01-01T00:00:00Z',
                last_used_at: '2026-03-01T00:00:00Z',
                revoked_at: '2026-04-01T00:00:00Z',
              },
            ],
          }),
      },
    ]);
    renderPage();

    const table = await screen.findByRole('table', { name: 'API tokens' });
    expect(table).toHaveTextContent('Portfolio sync');
    expect(table).toHaveTextContent('Never');
    // A revoked token is not a credential any more, so it is not listed.
    expect(table).not.toHaveTextContent('Retired integration');
  });

  it('reports a revoke the API refuses', async () => {
    mockApi({}, [
      {
        when: (path, method) => method === 'GET' && path.includes('/tokens'),
        reply: () =>
          json({
            tokens: [
              {
                id: '01N409TOKEN0000000000000AA',
                name: 'Portfolio sync',
                token_prefix: 'n409_live_ab',
                created_at: '2026-02-01T00:00:00Z',
                last_used_at: null,
                revoked_at: null,
              },
            ],
          }),
      },
      {
        when: (path, method) => method === 'DELETE' && path.includes('/api-tokens/'),
        reply: () => problem(500, 'boom'),
      },
    ]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('table', { name: 'API tokens' });
    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    expect(await screen.findByText('Could not revoke the token.')).toBeInTheDocument();
  });

  it('sends nothing when the revoke confirm is declined', async () => {
    const calls = mockApi({}, [
      {
        when: (path, method) => method === 'GET' && path.includes('/tokens'),
        reply: () =>
          json({
            tokens: [
              {
                id: '01N409TOKEN0000000000000AA',
                name: 'Portfolio sync',
                token_prefix: 'n409_live_ab',
                created_at: '2026-02-01T00:00:00Z',
                last_used_at: null,
                revoked_at: null,
              },
            ],
          }),
      },
    ]);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('table', { name: 'API tokens' });
    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('PartnerDetailPage — the engagement list', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('says so when the engagements will not load', async () => {
    mockApi({}, [
      {
        when: (path) => path.includes('/valuations?'),
        reply: () => problem(500, 'boom'),
      },
    ]);
    renderPage();

    expect(await screen.findByText('Could not load this partner’s engagements.')).toBeInTheDocument();
  });

  it('says a firm with none has none, rather than showing an empty table', async () => {
    mockApi();
    renderPage();

    expect(await screen.findByText('No engagements yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Partner engagements' })).not.toBeInTheDocument();
    // The queue summary above it agrees: no buckets carry anything.
    expect(screen.getByText('No engagements yet for this firm.')).toBeInTheDocument();
  });
});

describe('PartnerDetailPage — the subdomain in force', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('is shown as the address it resolves to, beside the box', async () => {
    mockApi({ subdomain: 'vestd' });
    renderPage();

    expect(await screen.findByLabelText('Subdomain')).toHaveValue('vestd');
    expect(screen.getByText('.app.n409.local')).toBeInTheDocument();
  });
});
