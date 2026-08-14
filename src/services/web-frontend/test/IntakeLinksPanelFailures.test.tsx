import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { IntakeLinksPanel } from '../src/components/IntakeLinksPanel';

/**
 * What the intake roster does when a request fails, and what it renders for a
 * row it does not fully recognise.
 *
 * Four endpoints back this panel and each can fail on its own; the message a
 * firm sees has to say which one did, because the remedies are different — a
 * 403 is "this account is not a firm account", a failed withdraw leaves a live
 * link out in the world, and a failed convert must not read as a no-op button.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Error', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

const completion = (percent: number) => ({
  sections: [],
  requiredTotal: 8,
  requiredAnswered: Math.round((percent / 100) * 8),
  percentComplete: percent,
  ready: percent === 100,
});

const SUBMITTED = {
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
};

/** Only `sent`/`in_progress` links offer Withdraw. */
const IN_PROGRESS = {
  ...SUBMITTED,
  id: '01N409LINK000000000000AA',
  status: 'in_progress',
  submitted_at: null,
  completion: completion(50),
};

const DETAIL = {
  link: SUBMITTED,
  answers: { legal_name: 'Halcyon Bio, Inc.', has_articles: false, employee_count: 42 },
  sections: [
    {
      key: 'company',
      title: 'Company information',
      description: '',
      fields: [
        { key: 'legal_name', label: 'Legal company name', type: 'text', required: true },
        { key: 'has_articles', label: 'Articles available?', type: 'boolean', required: true },
        { key: 'employee_count', label: 'Number of employees', type: 'number', required: false },
      ],
    },
  ],
};

const renderPanel = (partnerId?: string) =>
  render(
    <MemoryRouter>
      <IntakeLinksPanel partnerId={partnerId} />
    </MemoryRouter>,
  );

interface Failures {
  list?: number;
  create?: number;
  revoke?: number;
  detail?: number;
  convert?: number;
}

/** Routes all four endpoints; anything named in `fail` answers with that status. */
function mockApi(fail: Failures = {}, links: unknown[] = [SUBMITTED], detail: unknown = DETAIL) {
  const paths: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    paths.push(`${method} ${path}`);

    if (method === 'POST' && path.includes('/convert')) {
      return fail.convert
        ? problem(fail.convert, 'This intake has already been converted.')
        : jsonResponse({ valuation: { id: '01N409VAL00000000000000AA', company_name: 'X' } }, 201);
    }
    if (method === 'POST') {
      return fail.create
        ? problem(fail.create, 'Your plan does not include client intake.')
        : jsonResponse(
            { url: 'https://n409.test/intake/abc', link: { ...SUBMITTED, client_name: null } },
            201,
          );
    }
    if (method === 'DELETE') {
      return fail.revoke ? problem(fail.revoke, 'gone') : new Response(null, { status: 204 });
    }
    // A GET for one link's detail, or the roster.
    if (/\/firm\/intake-links\/[^/?]+/.test(path)) {
      return fail.detail ? problem(fail.detail, 'gone') : jsonResponse(detail);
    }
    return fail.list ? problem(fail.list, 'nope') : jsonResponse({ links });
  });
  return { spy, paths };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IntakeLinksPanel — the roster cannot be read', () => {
  it('names the account type on a 403 rather than blaming the network', () => {
    // The only remedy for this one is "this is not a firm account", and a
    // generic failure sends the reader to check their connection instead.
    mockApi({ list: 403 });
    renderPanel();
    return expect(screen.findByText('Client intake is available to firm accounts.')).resolves.toBeTruthy();
  });

  it('falls back to a general message for any other failure', async () => {
    mockApi({ list: 500 });
    renderPanel();
    expect(await screen.findByText('Could not load intake links.')).toBeInTheDocument();
  });
});

describe('IntakeLinksPanel — a row it does not fully recognise', () => {
  it('renders an unknown status with its own name and the neutral style', async () => {
    // Statuses are added server-side; a build that has not shipped yet must
    // show the value rather than an empty badge or a crash.
    mockApi({}, [{ ...SUBMITTED, status: 'escheated', client_name: null, client_email: null }]);
    renderPanel();
    expect(await screen.findByText('escheated')).toBeInTheDocument();
    expect(screen.getByText('Unnamed prospect')).toBeInTheDocument();
  });
});

describe('IntakeLinksPanel — each write that can fail', () => {
  it('says the create failed and keeps what was typed', async () => {
    mockApi({ create: 402 });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'New intake link' }));
    const name = screen.getByLabelText(/Client name/i);
    await userEvent.type(name, 'Northwind');
    await userEvent.click(screen.getByRole('button', { name: /Create/i }));

    expect(await screen.findByText('Your plan does not include client intake.')).toBeInTheDocument();
    // The form stays open with the entry in it — a failed create is a retry.
    expect(name).toHaveValue('Northwind');
  });

  it('says the withdraw failed, because the link is still live if it did', async () => {
    mockApi({ revoke: 500 }, [IN_PROGRESS]);
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));
    expect(await screen.findByText('Could not withdraw that link.')).toBeInTheDocument();
  });

  it('says the submission could not be opened', async () => {
    mockApi({ detail: 500 });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'View' }));
    expect(await screen.findByText('Could not load that submission.')).toBeInTheDocument();
  });

  it('says so when the submission behind a convert cannot be read', async () => {
    // Convert reads the answers first to pre-fill the name, so this fails
    // before the modal opens — the button must not look like it did nothing.
    mockApi({ detail: 500 });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Convert' }));
    expect(await screen.findByText('Could not load that submission.')).toBeInTheDocument();
    expect(screen.queryByText('Convert to an engagement')).not.toBeInTheDocument();
  });

  it('keeps a failed conversion inside the modal, where the button is', async () => {
    // The panel-level note renders behind the modal, so a failure shown there
    // is a button that silently did nothing.
    mockApi({ convert: 409 });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Convert' }));
    await screen.findByText('Convert to an engagement');
    await userEvent.click(screen.getByRole('button', { name: 'Create engagement' }));

    expect(await screen.findByText('This intake has already been converted.')).toBeInTheDocument();
    // Still open, so the firm can see which intake it was.
    expect(screen.getByText('Convert to an engagement')).toBeInTheDocument();
  });
});

describe('IntakeLinksPanel — pre-filling the conversion', () => {
  it('prefers the legal name the client typed', async () => {
    mockApi();
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Convert' }));
    expect(await screen.findByDisplayValue('Halcyon Bio, Inc.')).toBeInTheDocument();
  });

  it('falls back to the name the firm addressed the link to', async () => {
    mockApi({}, [SUBMITTED], { ...DETAIL, answers: { legal_name: 42 } });
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Convert' }));
    expect(await screen.findByDisplayValue('Halcyon Bio')).toBeInTheDocument();
  });

  it('leaves the field empty when neither is available, so the server names it', async () => {
    mockApi({}, [{ ...SUBMITTED, client_name: null }], { ...DETAIL, answers: {} });
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Convert' }));
    await screen.findByText('Convert to an engagement');
    expect(screen.getByLabelText(/Company name/i)).toHaveValue('');
  });
});

describe('IntakeLinksPanel — reading the answers back', () => {
  it('renders each answer type as the firm would write it', async () => {
    mockApi();
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'View' }));
    expect(await screen.findByText('Halcyon Bio, Inc.')).toBeInTheDocument();
    // A false boolean is an answer, not a blank.
    expect(screen.getByText('No')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('renders an unanswered field as a dash', async () => {
    mockApi({}, [SUBMITTED], { ...DETAIL, answers: { legal_name: '', has_articles: null } });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'View' }));
    await waitFor(() => {
      expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('IntakeLinksPanel — partner scoping', () => {
  it('carries the partner onto every request, joining the query string correctly', async () => {
    const { paths } = mockApi({}, [IN_PROGRESS]);
    renderPanel('01N409PARTNER0000000000AA');

    await userEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));
    await waitFor(() => {
      expect(paths.some((p) => p.startsWith('DELETE'))).toBe(true);
    });
    for (const p of paths) {
      expect(p).toContain('partner_id=01N409PARTNER0000000000AA');
      // One separator, and it is a `?` because none of these paths carry a query.
      expect(p.split('?')).toHaveLength(2);
    }
  });
});
