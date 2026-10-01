import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PartnerDetailPage } from '../src/pages/PartnerDetailPage';

/** Improvement 8 — branding preview + email template editor in partner admin. */

vi.mock('../src/lib/auth', async () => ({
  useAuth: () => ({ status: 'authenticated', user: { id: 'u1', roles: ['admin'] } }),
}));

const PARTNER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const partner = {
  id: PARTNER_ID,
  name: 'Bridge Advisors',
  key: 'bridge-advisors',
  created_at: '2026-06-01T00:00:00Z',
  archived_at: null,
  brand_color: '#1f6f54',
  logo_url: 'https://cdn.example.com/bridge.png',
  // The firm has gone live and named itself; the preview has to show what the
  // login page will actually render, which is both of those.
  brand_name: 'Bridge Valuation Advisors LLP',
  white_label_enabled: true,
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
    // The firm's public name, not the ops channel label beside it.
    expect(preview).toHaveTextContent('Bridge Valuation Advisors LLP');
    expect(screen.getByText('/partner/bridge-advisors/login')).toBeInTheDocument();

    // the preview follows the unsaved form colour
    const accent = preview.querySelector('[aria-hidden]');
    expect(accent).toHaveStyle({ backgroundColor: '#1f6f54' });
  });

  /**
   * The login page resolves its brand like every other surface: platform
   * branding until the firm turns white label on. A preview that drew the
   * staged colour and mark regardless was a preview of a page nobody would see,
   * shown to the one person deciding whether the brand was ready.
   */
  it('previews the platform brand while white label is still off', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ partner: { ...partner, white_label_enabled: false } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    renderPage();

    const preview = await screen.findByTestId('branding-preview');
    expect(preview).toHaveTextContent('DoAide 409A');
    expect(preview).not.toHaveTextContent('Bridge Valuation Advisors LLP');
    expect(preview.querySelector('img')).toBeNull();
    expect(screen.getByText(/White label is off/)).toBeInTheDocument();
  });

  it('loads existing template overrides and marks them customized', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByDisplayValue('Your draft from {{partner_name}}')).toBeInTheDocument();
    expect(screen.getByText('Customized')).toBeInTheDocument();
  });

  /**
   * R31 — a half-filled row used to be dropped on the way out: the admin
   * pressed Save, the page reloaded, and their subject was simply gone with
   * nothing saying it had been discarded. The pair is now a rule, and the rule
   * is stated on the row it belongs to.
   */
  it('refuses a subject with no body, instead of dropping it', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId('branding-preview');
    await user.type(screen.getByLabelText('Valuation started subject'), 'Half-filled subject');
    await user.click(screen.getByRole('button', { name: 'Save email templates' }));

    expect(await screen.findByText('Add a body — a subject on its own is not saved.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')).toBeUndefined();
  });

  it('refuses a body with no subject', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId('branding-preview');
    await user.type(screen.getByLabelText('Valuation started body'), 'Body with nothing above it');
    await user.click(screen.getByRole('button', { name: 'Save email templates' }));

    expect(await screen.findByText('Add a subject — a body on its own is not saved.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')).toBeUndefined();
  });

  /**
   * The message arrives on submit, when focus is on the Save button rather than
   * on either box — so being reachable from the controls via aria-describedby
   * is not the same as being announced.
   */
  it('announces the pair message rather than only painting it', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId('branding-preview');
    await user.type(screen.getByLabelText('Valuation started subject'), 'Half-filled subject');
    await user.click(screen.getByRole('button', { name: 'Save email templates' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Add a body — a subject on its own is not saved.');
  });

  /**
   * The message is about the pair, so it is wired to both boxes rather than
   * announced against whichever one happened to be typed in.
   */
  it('points both boxes of the row at the one message', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId('branding-preview');
    await user.type(screen.getByLabelText('Valuation started subject'), 'Half-filled subject');
    await user.click(screen.getByRole('button', { name: 'Save email templates' }));

    const message = await screen.findByText('Add a body — a subject on its own is not saved.');
    const describedBy = message.getAttribute('id')!;
    expect(screen.getByLabelText('Valuation started subject')).toHaveAttribute(
      'aria-describedby',
      describedBy,
    );
    expect(screen.getByLabelText('Valuation started body')).toHaveAttribute('aria-describedby', describedBy);
  });

  /**
   * A row left entirely blank is still the "use the platform default" case and
   * is still dropped — that is not a half-filled row, it is an absent one.
   */
  it('saves the complete pairs and drops the rows left blank', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId('branding-preview');
    // No placeholder braces in the typed text: userEvent reads `{` as the start
    // of a key descriptor, and escaping it here would test the escaping.
    await user.type(screen.getByLabelText('Valuation started subject'), 'We have started');
    await user.type(screen.getByLabelText('Valuation started body'), 'Work is under way.');
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
          valuation_started: {
            subject: 'We have started',
            body: 'Work is under way.',
          },
        },
      });
    });
  });

  /** Nothing typed at all is the untouched page — it saves what was loaded. */
  it('saves the untouched page without complaint', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId('branding-preview');
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
