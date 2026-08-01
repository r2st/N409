import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClientIntakePage } from '../src/pages/ClientIntakePage';

/**
 * The client intake form. Everything asserted here is something a prospect —
 * not signed in, sent a link by their valuation firm — would notice going
 * wrong: the token never leaving the fragment, typing being written back
 * without a Save button, submission being refused while required answers are
 * missing, and the page wearing the firm's brand rather than ours.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const FIRM = {
  tenant_id: '01N409FIRM0000000000000AA',
  name: 'Meridian Valuation',
  tagline: 'Independent valuations',
  accent: '#12936f',
  accent_dark: '#43cca0',
  accent_fg: '#ffffff',
  accent_dark_fg: '#08251c',
  logo_url: null,
  logo_dark_url: null,
  favicon_url: null,
  support_email: 'clients@meridian.test',
  white_label: true,
};

const SECTIONS = [
  {
    key: 'company',
    title: 'Company information',
    description: 'Tell us about the company being valued.',
    fields: [
      { key: 'legal_name', label: 'Legal company name', type: 'text', required: true },
      { key: 'employee_count', label: 'Number of employees', type: 'number', required: false },
      { key: 'business_description', label: 'Business description', type: 'textarea', required: true },
    ],
  },
  {
    key: 'legal',
    title: 'Legal & governance',
    description: 'Charter documents and anything affecting value.',
    fields: [
      { key: 'has_articles', label: 'Articles of incorporation available?', type: 'boolean', required: true },
    ],
  },
];

const completion = (answered: number, ready = false) => ({
  sections: [
    {
      key: 'company',
      title: 'Company information',
      requiredTotal: 2,
      requiredAnswered: Math.min(answered, 2),
      answeredTotal: answered,
      fieldTotal: 3,
      complete: answered >= 2,
    },
    {
      key: 'legal',
      title: 'Legal & governance',
      requiredTotal: 1,
      requiredAnswered: answered > 2 ? 1 : 0,
      answeredTotal: answered > 2 ? 1 : 0,
      fieldTotal: 1,
      complete: answered > 2,
    },
  ],
  requiredTotal: 3,
  requiredAnswered: answered,
  percentComplete: Math.round((answered / 3) * 100),
  ready,
});

interface PortalOverrides {
  answers?: Record<string, unknown>;
  can_edit?: boolean;
  status?: string;
  submitted_at?: string | null;
  ready?: boolean;
  answered?: number;
}

function portalBody(o: PortalOverrides = {}) {
  return {
    firm: FIRM,
    client_name: 'Northwind Robotics',
    sections: SECTIONS,
    answers: o.answers ?? {},
    completion: completion(o.answered ?? 0, o.ready ?? false),
    status: o.status ?? 'sent',
    can_edit: o.can_edit ?? true,
    submitted_at: o.submitted_at ?? null,
    expires_at: '2026-09-01T00:00:00Z',
  };
}

interface Call {
  path: string;
  body: Record<string, unknown>;
}

/** Mocks the three portal endpoints and records every request body. */
function mockPortal(opts: { portal?: PortalOverrides; portalStatus?: number; submitStatus?: number } = {}) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path, body });

    if (path.endsWith('/intake/portal')) {
      return opts.portalStatus
        ? jsonResponse({ detail: 'This intake link is invalid, expired, or withdrawn' }, opts.portalStatus)
        : jsonResponse(portalBody(opts.portal));
    }
    if (path.endsWith('/portal/answers')) {
      const answers = body.answers as Record<string, unknown>;
      return jsonResponse({ answers, completion: completion(Object.keys(answers).length) });
    }
    if (path.endsWith('/portal/submit')) {
      return opts.submitStatus
        ? jsonResponse({ detail: 'Complete all required fields before submitting' }, opts.submitStatus)
        : jsonResponse({ submitted_at: '2026-08-01T10:00:00Z', completion: completion(3, true) });
    }
    throw new Error(`unexpected fetch ${path}`);
  });
  return calls;
}

beforeEach(() => {
  window.location.hash = '#token=intake-token-abc';
  // jsdom has no layout, so its scrollTo logs a "not implemented" error on
  // every step change. The page only uses it to return to the top of the form.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('ClientIntakePage', () => {
  it('opens the form with the firm’s brand and the client’s name', async () => {
    mockPortal();
    render(<ClientIntakePage />);

    expect(await screen.findByText('Welcome, Northwind Robotics')).toBeInTheDocument();
    // The firm's identity, not ours — this page is the firm's front door.
    expect(screen.getAllByText('Meridian Valuation').length).toBeGreaterThan(0);
    expect(screen.getByText('Independent valuations')).toBeInTheDocument();
    expect(screen.queryByText('N409')).not.toBeInTheDocument();
  });

  it('sends the token in the body, never in the URL', async () => {
    const calls = mockPortal();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    const open = calls[0]!;
    // A token in the query string lands in access logs and the Referer header.
    expect(open.path).toBe('/api/v1/intake/portal');
    expect(open.path).not.toContain('intake-token-abc');
    expect(open.body.token).toBe('intake-token-abc');
  });

  it('refuses to start when the link carries no token', async () => {
    window.location.hash = '';
    const calls = mockPortal();
    render(<ClientIntakePage />);

    expect(await screen.findByText('This link isn’t available')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('explains a dead link without naming the firm behind it', async () => {
    mockPortal({ portalStatus: 401 });
    render(<ClientIntakePage />);

    expect(await screen.findByText('This link isn’t available')).toBeInTheDocument();
    expect(screen.getByText(/invalid, expired, or withdrawn/)).toBeInTheDocument();
    // A token that doesn't resolve tells us nothing about who issued it, and
    // guessing would let anyone probe which firm a stolen link belonged to.
    expect(screen.queryByText('Meridian Valuation')).not.toBeInTheDocument();
  });

  it('writes answers back without a save button, sending only what changed', async () => {
    const calls = mockPortal();
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    await user.type(screen.getByLabelText('Legal company name *'), 'Northwind Robotics, Inc.');

    const save = await waitFor(
      () => {
        const found = calls.find((c) => c.path.endsWith('/portal/answers'));
        expect(found).toBeTruthy();
        return found!;
      },
      { timeout: 3000 },
    );
    // Only the touched key: a save must not re-post — or resurrect — fields the
    // client never opened.
    expect(save.body.answers).toEqual({ legal_name: 'Northwind Robotics, Inc.' });
    expect(save.body.token).toBe('intake-token-abc');
    expect(await screen.findByText('All answers saved')).toBeInTheDocument();
  });

  it('flushes pending answers before moving on rather than after a pause', async () => {
    const calls = mockPortal();
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    await user.type(screen.getByLabelText('Number of employees'), '42');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/portal/answers'))).toBe(true));
    const save = calls.find((c) => c.path.endsWith('/portal/answers'))!;
    expect(save.body.answers).toEqual({ employee_count: 42 });
    expect(await screen.findByRole('heading', { name: 'Legal & governance' })).toBeInTheDocument();
  });

  it('keeps the client’s typing when a save fails', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/intake/portal')) return jsonResponse(portalBody());
      if (path.endsWith('/portal/answers')) {
        attempts += 1;
        if (attempts === 1) return jsonResponse({ detail: 'Network hiccup' }, 503);
        const answers = (JSON.parse(String(init!.body)) as { answers: Record<string, unknown> }).answers;
        return jsonResponse({ answers, completion: completion(1) });
      }
      throw new Error(`unexpected fetch ${path}`);
    });

    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');
    const input = screen.getByLabelText('Legal company name *');
    await user.type(input, 'Halcyon');

    expect(await screen.findByText('Network hiccup')).toBeInTheDocument();
    // The value stays on screen and the key stays queued, so the next edit
    // retries it instead of silently dropping what they typed.
    expect(input).toHaveValue('Halcyon');
    await user.type(input, ' Bio');
    await waitFor(() => expect(screen.getByText('All answers saved')).toBeInTheDocument(), { timeout: 3000 });
  });

  it('blocks submission while required answers are missing, and says how many', async () => {
    mockPortal({ portal: { answered: 1 } });
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    await user.click(screen.getByRole('button', { name: 'Review & submit' }));

    expect(screen.getByRole('button', { name: /Submit to Meridian Valuation/ })).toBeDisabled();
    expect(screen.getByText(/2 required answers still needed/)).toBeInTheDocument();
  });

  it('shows a review of every answer before submitting, and marks the gaps', async () => {
    mockPortal({
      portal: { answers: { legal_name: 'Northwind Robotics, Inc.', has_articles: true }, answered: 2 },
    });
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    await user.click(screen.getByRole('button', { name: 'Review & submit' }));

    expect(screen.getByText('Northwind Robotics, Inc.')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    // A required blank has to look different from an optional one.
    const description = screen.getByText('Business description').closest('div')!;
    expect(within(description).getByText('required')).toBeInTheDocument();
    expect(within(description).getByText('Not answered')).toBeInTheDocument();
  });

  it('confirms a completed submission and stops accepting changes', async () => {
    const calls = mockPortal({ portal: { answered: 3, ready: true } });
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    await user.click(screen.getByRole('button', { name: 'Review & submit' }));
    await user.click(screen.getByRole('button', { name: /Submit to Meridian Valuation/ }));

    expect(await screen.findByText('Thank you — that’s everything')).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/portal/submit'))).toBe(true);
    expect(screen.queryByRole('button', { name: /Submit to/ })).not.toBeInTheDocument();
  });

  it('reopens a submitted link read-only rather than as an empty form', async () => {
    mockPortal({
      portal: {
        status: 'submitted',
        can_edit: false,
        submitted_at: '2026-07-20T09:00:00Z',
        answers: { legal_name: 'Northwind Robotics, Inc.' },
        answered: 3,
        ready: true,
      },
    });
    render(<ClientIntakePage />);

    expect(await screen.findByText('Thank you — that’s everything')).toBeInTheDocument();
    expect(screen.getByText('Northwind Robotics, Inc.')).toBeInTheDocument();
  });

  it('disables the fields on a link that lapsed mid-form', async () => {
    mockPortal({ portal: { status: 'expired', can_edit: false } });
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    expect(screen.getByText(/no longer accepting changes/)).toBeInTheDocument();
    expect(screen.getByLabelText('Legal company name *')).toBeDisabled();
  });

  it('surfaces a rejected submission instead of appearing to succeed', async () => {
    mockPortal({ portal: { answered: 3, ready: true }, submitStatus: 422 });
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    await user.click(screen.getByRole('button', { name: 'Review & submit' }));
    await user.click(screen.getByRole('button', { name: /Submit to Meridian Valuation/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Complete all required fields');
    expect(screen.queryByText('Thank you — that’s everything')).not.toBeInTheDocument();
  });

  it('reports progress to assistive technology, not just visually', async () => {
    mockPortal({ portal: { answered: 2 } });
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    const bar = screen.getByRole('progressbar', { name: 'Intake completion' });
    expect(bar).toHaveAttribute('aria-valuenow', '67');
  });
});
