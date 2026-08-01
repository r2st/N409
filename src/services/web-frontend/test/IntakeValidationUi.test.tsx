import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClientIntakePage } from '../src/pages/ClientIntakePage';

/**
 * Data-validation warnings on the client intake form.
 *
 * What a prospect must experience: a figure that cannot be right is called out
 * while they are still looking at it and stops the submit; a figure that is
 * merely unusual is raised as a question and stops nothing. Both come from the
 * rules the server sent with the schema, so this also pins that a client on an
 * older API sees no warnings rather than a broken form.
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
    key: 'financials',
    title: 'Financials',
    description: 'High-level financial position.',
    fields: [
      {
        key: 'last_fy_revenue',
        label: 'Last fiscal-year revenue',
        type: 'number',
        required: true,
        rules: { min: 0 },
      },
      {
        key: 'cash_on_hand',
        label: 'Cash on hand',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'monthly_burn',
        label: 'Monthly net burn',
        type: 'number',
        required: false,
        rules: { min: 0 },
      },
      {
        key: 'incorporation_date',
        label: 'Date of incorporation',
        type: 'date',
        required: false,
        rules: { notFuture: true, minDate: '1900-01-01' },
      },
    ],
  },
];

const CROSS_RULES = [
  {
    key: 'burn_exceeds_cash',
    field: 'monthly_burn',
    severity: 'warning' as const,
    left: 'monthly_burn',
    op: 'gt' as const,
    right: 'cash_on_hand',
    message: 'Monthly burn is greater than cash on hand — that is under one month of runway.',
  },
];

const completion = (ready: boolean) => ({
  sections: [
    {
      key: 'financials',
      title: 'Financials',
      requiredTotal: 1,
      requiredAnswered: ready ? 1 : 0,
      answeredTotal: ready ? 1 : 0,
      fieldTotal: 4,
      complete: ready,
    },
  ],
  requiredTotal: 1,
  requiredAnswered: ready ? 1 : 0,
  percentComplete: ready ? 100 : 0,
  ready,
});

function mockPortal(opts: { answers?: Record<string, unknown>; ready?: boolean; withRules?: boolean } = {}) {
  const withRules = opts.withRules ?? true;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (path.endsWith('/intake/portal')) {
      return jsonResponse({
        firm: FIRM,
        client_name: 'Northwind Robotics',
        sections: SECTIONS,
        ...(withRules ? { cross_rules: CROSS_RULES } : {}),
        answers: opts.answers ?? {},
        completion: completion(opts.ready ?? false),
        status: 'sent',
        can_edit: true,
        submitted_at: null,
        expires_at: '2026-09-01T00:00:00Z',
      });
    }
    if (path.endsWith('/portal/answers')) {
      const answers = body.answers as Record<string, unknown>;
      return jsonResponse({ answers, completion: completion(opts.ready ?? false) });
    }
    if (path.endsWith('/portal/submit')) {
      return jsonResponse({ submitted_at: '2026-08-01T10:00:00Z', completion: completion(true) });
    }
    throw new Error(`unexpected fetch ${path}`);
  });
}

beforeEach(() => {
  window.location.hash = '#token=intake-token-abc';
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('intake validation warnings', () => {
  it('flags a negative revenue figure as the client types it', async () => {
    mockPortal();
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    await user.type(screen.getByLabelText('Last fiscal-year revenue *'), '-5000');

    expect(await screen.findAllByText('Last fiscal-year revenue cannot be negative.')).not.toHaveLength(0);
  });

  it('says nothing while the field is still empty', async () => {
    mockPortal();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    // An unfinished form is not a wrong one.
    expect(screen.queryByTestId('validation-summary')).not.toBeInTheDocument();
  });

  it('rejects a date in the future', async () => {
    mockPortal({ answers: { incorporation_date: '2099-01-01' } });
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    expect(await screen.findAllByText('Date of incorporation cannot be in the future.')).not.toHaveLength(0);
  });

  it('raises an unusual-but-possible answer as a warning, not an error', async () => {
    mockPortal({ answers: { cash_on_hand: 50_000, monthly_burn: 90_000 }, ready: true });
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    const summary = await screen.findByTestId('validation-summary');
    expect(summary).toHaveTextContent('1 answer looks unusual');
    expect(summary).toHaveTextContent('under one month of runway');
    // The client is asked, not stopped.
    expect(summary).not.toHaveTextContent('needs fixing');
  });

  it('blocks submission on an impossible answer and allows it on an unusual one', async () => {
    mockPortal({ answers: { last_fy_revenue: -1, cash_on_hand: 10 }, ready: true });
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    await user.click(screen.getByRole('button', { name: 'Review answers' }));
    const submit = await screen.findByRole('button', { name: /Submit to Meridian Valuation/ });
    expect(submit).toBeDisabled();
    expect(await screen.findByText('1 answer needs fixing before you can submit.')).toBeInTheDocument();
  });

  it('lets a merely-unusual form through to submit', async () => {
    mockPortal({ answers: { last_fy_revenue: 0, cash_on_hand: 50_000, monthly_burn: 90_000 }, ready: true });
    const user = userEvent.setup();
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    await user.click(screen.getByRole('button', { name: 'Review answers' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Submit to Meridian Valuation/ })).toBeEnabled(),
    );
  });

  it('degrades to no warnings when the API sends no rules', async () => {
    // An older valuation service omits cross_rules entirely. The form must
    // still work — field rules keep applying, cross-field ones simply do not.
    mockPortal({ answers: { cash_on_hand: 50_000, monthly_burn: 90_000 }, withRules: false });
    render(<ClientIntakePage />);
    await screen.findByText('Welcome, Northwind Robotics');

    expect(screen.queryByText(/under one month of runway/)).not.toBeInTheDocument();
  });
});
