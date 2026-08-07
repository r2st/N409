import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { IntakeLinksPanel } from '../src/components/IntakeLinksPanel';

/**
 * The firm's side of client intake.
 *
 * The property that matters most is the one the server can't fix afterwards:
 * the intake URL exists in the response to exactly one request, because only a
 * hash is stored. So the callout that shows it has to survive a re-render and
 * say why it can't be shown again. Beyond that, this is a roster — status,
 * progress, and reading what came back.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const completion = (percent: number) => ({
  sections: [],
  requiredTotal: 8,
  requiredAnswered: Math.round((percent / 100) * 8),
  percentComplete: percent,
  ready: percent === 100,
});

const LINKS = [
  {
    id: '01N409LINK000000000000AA',
    client_name: 'Northwind Robotics',
    client_email: 'founder@northwind.test',
    label: null,
    expires_at: '2026-09-01T00:00:00Z',
    created_at: '2026-07-15T00:00:00Z',
    revoked_at: null,
    last_accessed_at: '2026-07-16T00:00:00Z',
    access_count: 3,
    submitted_at: null,
    valuation_id: null,
    status: 'in_progress',
    completion: completion(50),
  },
  {
    id: '01N409LINK000000000000BB',
    client_name: 'Halcyon Bio',
    client_email: null,
    label: null,
    expires_at: '2026-08-20T00:00:00Z',
    created_at: '2026-07-01T00:00:00Z',
    revoked_at: null,
    last_accessed_at: '2026-07-10T00:00:00Z',
    access_count: 6,
    submitted_at: '2026-07-12T00:00:00Z',
    valuation_id: null,
    status: 'submitted',
    completion: completion(100),
  },
];

const DETAIL = {
  link: LINKS[1],
  answers: { legal_name: 'Halcyon Bio, Inc.', has_articles: true, employee_count: 42 },
  sections: [
    {
      key: 'company',
      title: 'Company information',
      description: 'Tell us about the company being valued.',
      fields: [
        { key: 'legal_name', label: 'Legal company name', type: 'text', required: true },
        { key: 'employee_count', label: 'Number of employees', type: 'number', required: false },
        { key: 'industry', label: 'Industry / sector', type: 'text', required: true },
      ],
    },
  ],
};

/** The panel links out to the engagement it creates, so it needs a router. */
const renderPanel = (partnerId?: string) =>
  render(
    <MemoryRouter>
      <IntakeLinksPanel partnerId={partnerId} />
    </MemoryRouter>,
  );

/** jsdom's navigator.clipboard is a getter-only property, so it is replaced. */
function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

const CONVERTED_VALUATION_ID = '01N409VAL00000000000000AA';

function mockApi(
  opts: { createStatus?: number; listStatus?: number; convertStatus?: number; convertDetail?: string } = {},
) {
  const calls: Call[] = [];
  // Conversion is once-only server-side, and the roster reflects it on the next
  // read — so does this stub, or the "Open engagement" affordance would be
  // testing a render the real flow never produces.
  let convertedLink = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });

    if (method === 'POST' && path.includes('/convert')) {
      if (opts.convertStatus) {
        return jsonResponse(
          { detail: opts.convertDetail ?? 'This intake has already been converted into a valuation' },
          opts.convertStatus,
        );
      }
      convertedLink = true;
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { company_name?: string }) : {};
      return jsonResponse(
        {
          valuation: {
            id: CONVERTED_VALUATION_ID,
            company_name: body.company_name ?? 'Halcyon Bio',
          },
          link: { ...LINKS[1], status: 'converted', valuation_id: CONVERTED_VALUATION_ID },
        },
        201,
      );
    }
    if (method === 'POST' && path.includes('/firm/intake-links')) {
      return opts.createStatus
        ? jsonResponse({ detail: 'Client intake is for firm accounts' }, opts.createStatus)
        : jsonResponse(
            {
              link: { ...LINKS[0], id: '01N409LINK000000000000CC', client_name: 'Acme Corp' },
              token: 'raw-token-value',
              url: 'https://app.test/intake#token=raw-token-value',
            },
            201,
          );
    }
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (/\/firm\/intake-links\/[^?]+/.test(path)) return jsonResponse(DETAIL);
    if (path.includes('/firm/intake-links')) {
      if (opts.listStatus) return jsonResponse({ title: 'no' }, opts.listStatus);
      const rows = convertedLink
        ? [LINKS[0], { ...LINKS[1], status: 'converted', valuation_id: CONVERTED_VALUATION_ID }]
        : LINKS;
      return jsonResponse({ links: rows });
    }
    throw new Error(`unexpected fetch ${path}`);
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IntakeLinksPanel', () => {
  it('lists prospects with their status and how far they got', async () => {
    mockApi();
    renderPanel();

    expect(await screen.findByText('Northwind Robotics')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('Submitted')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('shows a new link once, and says why it cannot be shown again', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Northwind Robotics');

    await user.click(screen.getByRole('button', { name: 'New intake link' }));
    await user.type(screen.getByLabelText(/Client name/), 'Acme Corp');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(await screen.findByText('https://app.test/intake#token=raw-token-value')).toBeInTheDocument();
    expect(screen.getByText(/store only a hash/)).toBeInTheDocument();
    // The raw token is the credential; it must not linger anywhere the firm
    // could mistake for a durable record of it.
    expect(screen.getByText('Link ready for Acme Corp')).toBeInTheDocument();
  });

  it('copies the link to the clipboard and confirms it', async () => {
    mockApi();
    const writeText = vi.fn().mockResolvedValue(undefined);
    // After setup(): userEvent installs its own clipboard stub, which would
    // otherwise swallow the write the component makes.
    const user = userEvent.setup();
    stubClipboard(writeText);
    renderPanel();
    await screen.findByText('Northwind Robotics');

    await user.click(screen.getByRole('button', { name: 'New intake link' }));
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByText(/Link ready/);
    await user.click(screen.getByRole('button', { name: 'Copy link' }));

    expect(writeText).toHaveBeenCalledWith('https://app.test/intake#token=raw-token-value');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('keeps the URL on screen when the clipboard refuses', async () => {
    mockApi();
    const user = userEvent.setup();
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    renderPanel();
    await screen.findByText('Northwind Robotics');

    await user.click(screen.getByRole('button', { name: 'New intake link' }));
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByText(/Link ready/);
    await user.click(screen.getByRole('button', { name: 'Copy link' }));

    // A refused clipboard is a nicety failing, not the flow failing — the URL
    // is still selectable on screen.
    expect(screen.getByText('https://app.test/intake#token=raw-token-value')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
  });

  it('offers withdrawal only while a link is still live', async () => {
    mockApi();
    renderPanel();
    await screen.findByText('Northwind Robotics');

    const live = screen.getByText('Northwind Robotics').closest('tr')!;
    expect(within(live).getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();

    // Withdrawing a submitted link would suggest the answers could be taken
    // back, which they can't — the firm already has them.
    const done = screen.getByText('Halcyon Bio').closest('tr')!;
    expect(within(done).queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
  });

  it('withdraws a link and reloads the roster', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Northwind Robotics');

    const live = screen.getByText('Northwind Robotics').closest('tr')!;
    await user.click(within(live).getByRole('button', { name: 'Withdraw' }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.path.includes('01N409LINK000000000000AA'))).toBe(
        true,
      ),
    );
    expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(1);
  });

  it('opens what a client sent, labelled by the questions they were asked', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Halcyon Bio');

    const row = screen.getByText('Halcyon Bio').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'View' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Halcyon Bio, Inc.')).toBeInTheDocument();
    expect(within(dialog).getByText('42')).toBeInTheDocument();
    // A question the client skipped reads as a gap, not as an absent row.
    const industry = within(dialog).getByText('Industry / sector').closest('div')!;
    expect(within(industry).getByText('—')).toBeInTheDocument();
  });

  it('scopes every request to the firm an ops user opened', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPanel('01N409FIRM0000000000000AA');
    await screen.findByText('Northwind Robotics');

    await user.click(screen.getByRole('button', { name: 'New intake link' }));
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByText(/Link ready/);

    // Ops belong to no firm, so an unscoped request would 400 — or worse, land
    // on the wrong tenant.
    for (const call of calls) {
      expect(call.path).toContain('partner_id=01N409FIRM0000000000000AA');
    }
  });

  it('explains a refusal rather than showing an empty roster', async () => {
    mockApi({ listStatus: 403 });
    renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent('available to firm accounts');
  });
});

/**
 * Conversion — the step the questionnaire is collected *for*.
 *
 * The server side of this shipped a round before the UI did, so the `converted`
 * status was styled and labelled by a panel with no way to produce it: a firm
 * could read the answers and then had to retype every one of them into a new
 * valuation by hand. These pin the control that closes that.
 */
describe('IntakeLinksPanel — converting an intake', () => {
  it('offers Convert only on a submitted link', async () => {
    mockApi();
    renderPanel();
    await screen.findByText('Halcyon Bio');

    const submitted = screen.getByText('Halcyon Bio').closest('tr')!;
    expect(within(submitted).getByRole('button', { name: 'Convert' })).toBeInTheDocument();

    // Half-answered: there is nothing settled to build an engagement from, and
    // the server refuses it — so the button must not be there to press.
    const partial = screen.getByText('Northwind Robotics').closest('tr')!;
    expect(within(partial).queryByRole('button', { name: 'Convert' })).not.toBeInTheDocument();
  });

  it('pre-fills the company name from the legal name the client typed', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Halcyon Bio');

    const row = screen.getByText('Halcyon Bio').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Convert' }));

    const dialog = await screen.findByRole('dialog');
    // Not 'Halcyon Bio' — the name the firm addressed the link to — but the
    // charter name the client gave, which is what the engagement should carry.
    expect(within(dialog).getByLabelText(/Company name/)).toHaveValue('Halcyon Bio, Inc.');
  });

  it('creates the engagement with the firm’s chosen name and type', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Halcyon Bio');

    const row = screen.getByText('Halcyon Bio').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Convert' }));
    const dialog = await screen.findByRole('dialog');

    const name = within(dialog).getByLabelText(/Company name/);
    await user.clear(name);
    await user.type(name, 'Halcyon Biosciences Ltd');
    await user.selectOptions(within(dialog).getByLabelText(/Valuation type/), '718');
    await user.click(within(dialog).getByRole('button', { name: 'Create engagement' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const convert = calls.find((c) => c.method === 'POST' && c.path.includes('/convert'));
    expect(convert?.path).toContain('01N409LINK000000000000BB');
    expect(convert?.body).toEqual({ kind: '718', company_name: 'Halcyon Biosciences Ltd' });
  });

  it('points at the engagement it just created, and reloads the roster', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Halcyon Bio');
    const before = calls.filter((c) => c.method === 'GET').length;

    const row = screen.getByText('Halcyon Bio').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Convert' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create engagement' }));

    const open = await screen.findByRole('link', { name: 'Open the engagement' });
    expect(open).toHaveAttribute('href', '/valuations/01N409VAL00000000000000AA');
    expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(before);

    // And the row itself now carries the status the panel could never produce.
    const converted = (await screen.findAllByText('Converted'))[0]!.closest('tr')!;
    expect(within(converted).getByRole('link', { name: 'Open engagement' })).toHaveAttribute(
      'href',
      '/valuations/01N409VAL00000000000000AA',
    );
    expect(within(converted).queryByRole('button', { name: 'Convert' })).not.toBeInTheDocument();
  });

  it('keeps the modal open and explains a refusal', async () => {
    mockApi({ convertStatus: 409 });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Halcyon Bio');

    const row = screen.getByText('Halcyon Bio').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Convert' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create engagement' }));

    // Behind the modal is where the panel-level error note renders, so a
    // failure reported there reads as a button that did nothing at all.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already been converted');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('scopes conversion to the firm an ops user opened', async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPanel('01N409FIRM0000000000000AA');
    await screen.findByText('Halcyon Bio');

    const row = screen.getByText('Halcyon Bio').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Convert' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create engagement' }));

    await waitFor(() => expect(calls.some((c) => c.path.includes('/convert'))).toBe(true));
    for (const call of calls) expect(call.path).toContain('partner_id=01N409FIRM0000000000000AA');
  });
});
