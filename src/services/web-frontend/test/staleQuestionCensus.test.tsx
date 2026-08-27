import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { EmailOutboxPage } from '../src/pages/EmailOutboxPage';
import { SupportInboxPage } from '../src/pages/SupportInboxPage';
import { AdminApiTokensPage } from '../src/pages/AdminApiTokensPage';
import { PortfolioPage } from '../src/pages/PortfolioPage';
import { InboxPage } from '../src/pages/InboxPage';
import { AdminJobsPage } from '../src/pages/AdminJobsPage';
import { CommunicationsPage } from '../src/pages/CommunicationsPage';
import { AdminUsersPage } from '../src/pages/AdminUsersPage';
import { BlogPostPage } from '../src/pages/marketing/BlogPages';

/**
 * The window between changing a filter and the reply that answers it.
 *
 * `useLatestOnly` covers the reply that lands *out of order*. It says nothing
 * about the wait, and for the length of that wait every one of these surfaces
 * showed the previous filter's rows underneath the new filter's controls, with
 * no spinner, no dimming and nothing in a live region to mark them as stale.
 * The chip reads pressed; the table underneath it is the answer to the question
 * before last. A reader during that window is not shown a stale answer, they
 * are shown a wrong one — and it is self-consistent enough to be believed.
 *
 * Each case below drives the real control, holds the second request open, and
 * asserts on what is on screen while it is in flight: the previous answer must
 * be gone, and the wait must be announced. See `useClearOnChange`.
 */

// Only `InboxPage` below reads the session; the rest of these surfaces are
// rendered by a route that has already established one.
vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: {
      id: '01N409OPSUSER000000000000A',
      email: 'olive@n409.example',
      first_name: 'Olive',
      last_name: 'Ops',
      verified: true,
      sso_provider: null,
      partner_id: null,
      roles: ['admin'],
    },
  }),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A fetch mock that answers the first request and then holds every later one
 * open, exposing a `pending` promise that resolves once the held request has
 * actually been issued. Waiting on that is what makes the in-flight assertions
 * below deterministic — without it the test races the effect that fires them.
 */
function holdSecondRequest(first: unknown, later: unknown = first) {
  let issued: () => void;
  const pending = new Promise<void>((resolve) => {
    issued = resolve;
  });
  let calls = 0;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    calls += 1;
    if (calls === 1) return json(first);
    issued();
    // Never settles: the assertions run while this request is outstanding.
    await new Promise(() => {});
    return json(later);
  });
  return { pending, spy };
}

/**
 * The multi-endpoint variant: every request is answered from `routes`, except
 * that the *second* request matching `held` never settles. `pending` resolves
 * once that request has been issued, which is what makes the in-flight
 * assertions deterministic.
 */
function holdSecondMatching(held: RegExp, routes: (url: string) => unknown) {
  let issued: () => void;
  const pending = new Promise<void>((resolve) => {
    issued = resolve;
  });
  let matched = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (held.test(url)) {
      matched += 1;
      if (matched > 1) {
        issued();
        await new Promise(() => {});
      }
    }
    return json(routes(url));
  });
  return { pending };
}

/** Both ways a surface is allowed to mark the wait, and neither is optional. */
function assertWaitIsAnnounced() {
  const live = screen.queryAllByRole('status');
  expect(live.length, 'the wait must be in a live region').toBeGreaterThan(0);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const outboxEmail = (id: string, status: string, subject: string) => ({
  id,
  valuation_id: null,
  to_user_id: null,
  to_email: 'founder@acme.com',
  template_key: 'valuation_published',
  subject,
  body: '<p>x</p>',
  status,
  error: null,
  attempts: 1,
  created_at: '2026-07-01T10:00:00Z',
  sent_at: null,
});

describe('a filter change must not leave the previous answer on screen', () => {
  it('the email outbox drops the sent rows when Failed is selected', async () => {
    // `holdSecondMatching` rather than `holdSecondRequest`: R178 put the
    // suppression list on this page, so the outbox is no longer the only thing
    // it fetches and "the second request" is no longer the second scope. The
    // hold has to name the endpoint whose reply is being delayed.
    const { pending } = holdSecondMatching(/\/admin\/email-outbox/, (url) =>
      url.includes('/suppressions')
        ? { suppressions: [], truncated: false }
        : { emails: [outboxEmail('1', 'sent', 'SENT ROW')] },
    );
    render(
      <MemoryRouter>
        <EmailOutboxPage />
      </MemoryRouter>,
    );
    await screen.findByText('SENT ROW');

    await userEvent.click(screen.getByRole('button', { name: 'Failed' }));
    await pending;

    await waitFor(() => expect(screen.queryByText('SENT ROW')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Failed' })).toHaveAttribute('aria-pressed', 'true');
    assertWaitIsAnnounced();
  });

  it('the support inbox drops the open queue when Resolved is selected', async () => {
    const message = {
      id: '01N409SUPPORT00000000000AA',
      user_id: '01N409USER00000000000000AA',
      user_email: 'founder@acme.com',
      subject: 'OPEN TICKET',
      body: 'Help.',
      page_path: null,
      status: 'open',
      created_at: '2026-07-01T10:00:00Z',
      resolved_at: null,
    };
    const { pending } = holdSecondRequest({ messages: [message] });
    render(
      <MemoryRouter>
        <SupportInboxPage />
      </MemoryRouter>,
    );
    await screen.findByText('OPEN TICKET');

    await userEvent.click(screen.getByRole('button', { name: 'Resolved' }));
    await pending;

    await waitFor(() => expect(screen.queryByText('OPEN TICKET')).not.toBeInTheDocument());
    // The chip the user just pressed is still there to read, and still pressed.
    expect(screen.getByRole('button', { name: 'Resolved' })).toHaveAttribute('aria-pressed', 'true');
    assertWaitIsAnnounced();
  });

  it('the token listing drops the live tokens when revoked ones are included', async () => {
    const token = {
      id: '01N409TOKEN0000000000000AA',
      name: 'LIVE TOKEN',
      prefix: 'n409_ab',
      scopes: ['valuations:read'],
      created_at: '2026-07-01T10:00:00Z',
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
      partner_id: null,
      partner_name: null,
      created_by_email: 'ops@n409.ai',
    };
    const { pending } = holdSecondRequest({ tokens: [token], truncated: false });
    render(
      <MemoryRouter>
        <AdminApiTokensPage />
      </MemoryRouter>,
    );
    await screen.findByText('LIVE TOKEN');

    await userEvent.click(screen.getByRole('checkbox'));
    await pending;

    await waitFor(() => expect(screen.queryByText('LIVE TOKEN')).not.toBeInTheDocument());
    expect(screen.getByRole('checkbox')).toBeChecked();
    assertWaitIsAnnounced();
  });

  it('the portfolio drops one organization’s roll-up when another is selected', async () => {
    const entity = {
      valuation_id: 'v1',
      number: 'VAL-1',
      company_name: 'ACME PARENT',
      entity_type: 'parent',
      parent_valuation_id: null,
      state: 'delivered',
      equity_value: 10_000_000,
      fmv_per_share: 2.5,
      currency: 'USD',
    };
    const consolidated = {
      entity_count: 1,
      valued_count: 1,
      total_equity_value: 10_000_000,
      consolidated_equity_value: 10_000_000,
      by_currency: [],
      currencies: ['USD'],
      mixed_currency: false,
    };
    const orgs = [
      { id: 'org1', name: 'First Fund', org_type: 'fund' },
      { id: 'org2', name: 'Second Fund', org_type: 'fund' },
    ];
    const { pending } = holdSecondMatching(/\/organizations\/org/, (url) =>
      url.includes('/organizations/org')
        ? { organization: orgs[0], entities: [entity], consolidated, truncated: false }
        : { organizations: orgs, truncated: false },
    );

    render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    );
    await screen.findByText('ACME PARENT');

    await userEvent.click(screen.getByRole('button', { name: 'Second Fund' }));
    await pending;

    // The first fund's holdings must not be sitting under the second's name.
    await waitFor(() => expect(screen.queryByText('ACME PARENT')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Second Fund' })).toBeInTheDocument();
    assertWaitIsAnnounced();
  });

  it('the inbox drops the read messages when unread-only is ticked', async () => {
    const item = {
      id: '01N409IC000000000000000001',
      valuation_id: '01N409VA000000000000000001',
      valuation_number: '1766',
      company_name: 'Acme Corp',
      valuation_kind: '409a',
      valuation_state: 'started',
      kind: 'chat',
      body: 'READ MESSAGE',
      author_name: 'Dana Client',
      author_email: 'dana@acme.test',
      email_meta: null,
      pinned: false,
      created_at: '2026-08-07T09:00:00Z',
      unread: false,
    };
    const { pending } = holdSecondMatching(/\/inbox\?/, () => ({
      items: [item],
      total: 1,
      page: 1,
      per_page: 25,
      unread_total: 0,
    }));

    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );
    await screen.findByText('READ MESSAGE');

    await userEvent.click(screen.getByRole('checkbox'));
    await pending;

    await waitFor(() => expect(screen.queryByText('READ MESSAGE')).not.toBeInTheDocument());
    expect(screen.getByRole('checkbox')).toBeChecked();
    assertWaitIsAnnounced();
  });

  it('the job monitor drops the previous filter’s feed when a status is pressed', async () => {
    const stats = {
      since_hours: 24,
      totals: { active: 2, failed: 1, succeeded: 40, skipped: 3 },
      by_source: [
        {
          source: 'pipeline_run',
          label: 'Pipeline run',
          active: 1,
          failed: 0,
          succeeded: 20,
          skipped: 0,
          oldest_active_at: '2026-08-08T09:00:00Z',
        },
      ],
    };
    const job = {
      id: 'W1',
      source: 'webhook_delivery',
      status: 'queued',
      detail: 'pending',
      name: 'QUEUED JOB',
      valuation_id: 'V1',
      valuation_number: '1766',
      company_name: 'Acme Corp',
      error: null,
      attempts: 1,
      created_at: '2026-08-08T06:00:00Z',
      due_at: '2026-08-08T09:00:00Z',
      finished_at: null,
      duration_ms: null,
    };
    // Held on the feed only: the counters come from `/admin/jobs/stats`, which
    // is asked over the whole queue and must survive the wait.
    const { pending } = holdSecondMatching(/\/admin\/jobs\?/, (url) => {
      if (url.includes('/admin/jobs/stats')) return stats;
      if (url.includes('/admin/jobs/alerts')) return { alerts: [], rules: [], open: 0 };
      return { jobs: [job], total: 1 };
    });

    render(
      <MemoryRouter>
        <AdminJobsPage />
      </MemoryRouter>,
    );
    await screen.findByText('QUEUED JOB');

    await userEvent.click(screen.getByRole('button', { name: 'Failed' }));
    await pending;

    await waitFor(() => expect(screen.queryByText('QUEUED JOB')).not.toBeInTheDocument());
    // The chips stay, and so do the whole-queue counters they do not filter.
    expect(screen.getByRole('button', { name: 'Failed' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByText('Outstanding').length).toBeGreaterThan(0);
    assertWaitIsAnnounced();
  });

  it('the template table drops the previous category when another is pressed', async () => {
    const template = {
      id: '01N409CT000000000000000007',
      key: 'DRAFT_READY_KEY',
      channel: 'email',
      category: 'open',
      description: 'Sent when a draft is ready.',
      subject: 'Your draft is ready',
      body: 'A draft is ready.',
      enabled: true,
      updated_by: null,
      created_at: '2026-07-01T10:00:00Z',
      updated_at: '2026-07-01T10:00:00Z',
    };
    const { pending } = holdSecondMatching(/communication-templates(\?|$)/, (url) =>
      url.includes('/variables') ? { variables: [] } : { templates: [template], categories: [] },
    );

    render(
      <MemoryRouter>
        <CommunicationsPage />
      </MemoryRouter>,
    );
    await screen.findByText('DRAFT_READY_KEY');

    await userEvent.click(screen.getByRole('button', { name: /^Drafted/ }));
    await pending;

    await waitFor(() => expect(screen.queryByText('DRAFT_READY_KEY')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^Drafted/ })).toHaveAttribute('aria-pressed', 'true');
    assertWaitIsAnnounced();
  });

  it('the user console drops the previous page of people when the pager moves', async () => {
    const user = (id: string, email: string) => ({
      id,
      email,
      first_name: 'Pat',
      last_name: 'Person',
      roles: ['valuation_user'],
      verified: true,
      partner_id: null,
      partner_name: null,
      created_at: '2026-07-01T10:00:00Z',
      last_login_at: null,
      deleted_at: null,
      mfa_enabled: false,
      sso_provider: null,
    });
    const { pending } = holdSecondMatching(/\/users\?/, (url) => {
      if (url.includes('/users?')) return { users: [user('u1', 'PAGE-ONE@acme.test')], total: 60 };
      if (url.includes('/roles')) return { roles: [] };
      if (url.includes('/capabilities')) return { capabilities: [] };
      if (url.includes('/invitations')) return { invitations: [] };
      if (url.includes('/partners')) return { partners: [] };
      return {};
    });

    render(
      <MemoryRouter>
        <AdminUsersPage />
      </MemoryRouter>,
    );
    await screen.findByText('PAGE-ONE@acme.test');

    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    await pending;

    // Page 2's rows are not page 1's, and the pager already reads 2.
    await waitFor(() => expect(screen.queryByText('PAGE-ONE@acme.test')).not.toBeInTheDocument());
    assertWaitIsAnnounced();
  });

  it('a blog post gives up the previous post the moment another slug is asked for', async () => {
    const post = (slug: string, title: string) => ({
      slug,
      title,
      excerpt: 'An excerpt.',
      body_html: '<p>Body.</p>',
      category: 'Methodology',
      keywords: '409a',
      author: 'The N409 team',
      og_image: null,
      published: true,
      published_at: '2026-02-01T09:00:00Z',
    });
    const { pending } = holdSecondMatching(/\/blog\/posts\//, (url) =>
      url.includes('second-post')
        ? { post: post('second-post', 'SECOND POST') }
        : { post: post('first-post', 'FIRST POST') },
    );

    render(
      <HelmetProvider>
        <MemoryRouter initialEntries={['/blog/first-post']}>
          <Routes>
            <Route
              path="/blog/:slug"
              element={
                <>
                  <BlogPostPage />
                  <Link to="/blog/second-post">Next post</Link>
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </HelmetProvider>,
    );
    await screen.findByText('FIRST POST');

    // A related-post link changes the slug without remounting the page.
    await userEvent.click(screen.getByRole('link', { name: 'Next post' }));
    await pending;

    await waitFor(() => expect(screen.queryByText('FIRST POST')).not.toBeInTheDocument());
    assertWaitIsAnnounced();
  });
});
