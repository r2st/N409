import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PortfolioPage } from '../src/pages/PortfolioPage';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const org = { id: 'org1', name: 'Acme Holdings', entity_type: 'holding_company' };

const detail = {
  organization: org,
  entities: [
    {
      valuation_id: 'v1',
      number: 'VAL-1',
      company_name: 'Acme Parent',
      entity_type: 'parent',
      parent_valuation_id: null,
      state: 'delivered',
      equity_value: 10_000_000,
      fmv_per_share: 2.5,
      currency: 'USD',
    },
  ],
  consolidated: {
    entity_count: 1,
    valued_count: 1,
    total_equity_value: 10_000_000,
    consolidated_equity_value: 10_000_000,
    by_currency: [
      {
        currency: 'USD',
        entity_count: 1,
        valued_count: 1,
        total_equity_value: 10_000_000,
        consolidated_equity_value: 10_000_000,
      },
    ],
    currencies: ['USD'],
    mixed_currency: false,
  },
};

const mixedDetail = {
  organization: org,
  entities: [
    ...detail.entities,
    {
      valuation_id: 'v2',
      number: 'VAL-2',
      company_name: 'Acme Europe',
      entity_type: 'portfolio_company',
      parent_valuation_id: null,
      state: 'delivered',
      equity_value: 5_000_000,
      fmv_per_share: 1.5,
      currency: 'EUR',
    },
  ],
  consolidated: {
    entity_count: 2,
    valued_count: 2,
    total_equity_value: null,
    consolidated_equity_value: null,
    by_currency: [
      {
        currency: 'USD',
        entity_count: 1,
        valued_count: 1,
        total_equity_value: 10_000_000,
        consolidated_equity_value: 10_000_000,
      },
      {
        currency: 'EUR',
        entity_count: 1,
        valued_count: 1,
        total_equity_value: 5_000_000,
        consolidated_equity_value: 5_000_000,
      },
    ],
    currencies: ['USD', 'EUR'],
    mixed_currency: true,
  },
};

function mockApi(overrides: Partial<Record<string, () => Response>> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const method = init?.method ?? 'GET';
    const key = `${method} ${String(url).replace(/^.*\/api\/v1/, '')}`;
    for (const [pattern, responder] of Object.entries(overrides)) {
      if (key.includes(pattern)) return responder!();
    }
    if (key === 'GET /organizations') return jsonResponse({ organizations: [org] });
    if (key === 'GET /organizations/org1') return jsonResponse(detail);
    throw new Error(`unexpected fetch ${key}`);
  });
}

describe('PortfolioPage (feature 6)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists organizations and shows the consolidated roll-up', async () => {
    mockApi();
    render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Acme Holdings')).toBeInTheDocument();
    // Consolidated metrics + member entity.
    await waitFor(() => expect(screen.getByText('Acme Parent')).toBeInTheDocument());
    expect(screen.getAllByText(/\$10,000,000/).length).toBeGreaterThan(0);
  });

  it('breaks the roll-up out per currency instead of summing across them', async () => {
    mockApi({ 'GET /organizations/org1': () => jsonResponse(mixedDetail) });
    render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    );
    // No single total is claimed...
    expect(await screen.findByText('Mixed currencies')).toBeInTheDocument();
    expect(screen.queryByText(/\$15,000,000/)).not.toBeInTheDocument();
    // ...and each currency reports its own.
    await waitFor(() => expect(screen.getByText('Equity by currency')).toBeInTheDocument());
    expect(screen.getAllByText(/\$10,000,000/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/€5,000,000/).length).toBeGreaterThan(0);
  });

  it('says which subsidiaries the consolidated figure did not eliminate', async () => {
    // The label reads "Subsidiaries excluded". A subsidiary whose parent is not
    // in the roll-up is *not* excluded — counting it is the only honest answer,
    // and a figure that is right for a reason the label denies is the shape a
    // reader cannot check. So the page names them.
    const unanchored = {
      ...detail,
      consolidated: {
        ...detail.consolidated,
        unanchored_subsidiaries: [{ valuation_id: 'v9', company_name: 'Acme Sub Ltd' }],
      },
    };
    mockApi({ 'GET /organizations/org1': () => jsonResponse(unanchored) });
    render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Acme Sub Ltd is marked a subsidiary/)).toBeInTheDocument();
    expect(screen.getByText('Consolidated subsidiaries excluded')).toBeInTheDocument();
  });

  it('says nothing about anchoring when every subsidiary has its parent', async () => {
    mockApi();
    render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Acme Holdings')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Subsidiaries excluded')).toBeInTheDocument());
    expect(screen.queryByText(/marked a subsidiary/)).not.toBeInTheDocument();
  });

  it('shows an empty state with no organizations', async () => {
    mockApi({ 'GET /organizations': () => jsonResponse({ organizations: [] }) });
    render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('No organizations yet')).toBeInTheDocument();
  });
});

/** Creating an organization — the form at the top of the page. */
describe('PortfolioPage — creating an organization', () => {
  beforeEach(() => vi.restoreAllMocks());

  const renderPage = () =>
    render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    );

  it('creates the organization and selects it', async () => {
    const user = userEvent.setup();
    let posted: Record<string, unknown> | undefined;
    let created = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const key = String(url).replace(/^.*\/api\/v1/, '');
      if ((init?.method ?? 'GET') === 'POST') {
        posted = JSON.parse(String(init?.body));
        created = true;
        return jsonResponse({ organization: { ...org, id: 'org2', name: 'Beta Fund' } }, 201);
      }
      if (key === '/organizations')
        return jsonResponse({
          organizations: created ? [org, { ...org, id: 'org2', name: 'Beta Fund' }] : [org],
        });
      return jsonResponse({ ...detail, organization: { ...org, id: 'org2', name: 'Beta Fund' } });
    });

    renderPage();
    await user.type(await screen.findByPlaceholderText('Acme Holdings'), '  Beta Fund  ');
    await user.selectOptions(screen.getByLabelText('Organization type'), 'fund');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    // Trimmed on the way out — a name with padding is the same organization.
    await waitFor(() => expect(posted).toEqual({ name: 'Beta Fund', entity_type: 'fund' }));
    expect(await screen.findByRole('button', { name: 'Beta Fund' })).toBeInTheDocument();
  });

  it('clears the box so the next name does not start with the last one', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'POST')
        return jsonResponse({ organization: { ...org, id: 'org2' } }, 201);
      if (String(url).endsWith('/organizations')) return jsonResponse({ organizations: [org] });
      return jsonResponse(detail);
    });

    renderPage();
    const box = await screen.findByPlaceholderText('Acme Holdings');
    await user.type(box, 'Beta Fund');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('says why the organization could not be created', async () => {
    const user = userEvent.setup();
    mockApi({ 'POST /organizations': () => jsonResponse({ detail: 'That name is taken.' }, 409) });

    renderPage();
    await user.type(await screen.findByPlaceholderText('Acme Holdings'), 'Acme Holdings');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('That name is taken.')).toBeInTheDocument();
  });

  it('falls back to a plain message when the failure carries none', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /organizations': () => {
        throw new Error('offline');
      },
    });

    renderPage();
    await user.type(await screen.findByPlaceholderText('Acme Holdings'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Could not create the organization.')).toBeInTheDocument();
  });

  /** A name that is only spaces is not a name. */
  it('will not submit a blank or whitespace-only name', async () => {
    const user = userEvent.setup();
    mockApi();

    renderPage();
    await screen.findByPlaceholderText('Acme Holdings');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Acme Holdings'), '   ');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('switches the roll-up when another organization is picked', async () => {
    const user = userEvent.setup();
    const beta = { ...org, id: 'org2', name: 'Beta Fund' };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const key = String(url).replace(/^.*\/api\/v1/, '');
      if (key === '/organizations') return jsonResponse({ organizations: [org, beta] });
      if (key === '/organizations/org2') return jsonResponse({ ...mixedDetail, organization: beta });
      return jsonResponse(detail);
    });

    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Beta Fund' }));

    expect(await screen.findByText('Mixed currencies')).toBeInTheDocument();
  });

  it('says so when an organization cannot be opened', async () => {
    const user = userEvent.setup();
    const beta = { ...org, id: 'org2', name: 'Beta Fund' };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const key = String(url).replace(/^.*\/api\/v1/, '');
      if (key === '/organizations') return jsonResponse({ organizations: [org, beta] });
      if (key === '/organizations/org2') return jsonResponse({ detail: 'gone' }, 404);
      return jsonResponse(detail);
    });

    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Beta Fund' }));

    expect(await screen.findByText('Could not load the organization.')).toBeInTheDocument();
  });
});
