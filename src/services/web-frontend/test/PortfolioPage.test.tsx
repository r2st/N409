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

  it('names an entity whose conclusion is not an equity value at all', async () => {
    /*
     * An IFRS 2 memo belongs to the group and concludes a total share-based
     * payment *expense*, which the server now keeps out of every total. The
     * figure is positive, so a roll-up that had quietly included it looked
     * ordinary — and one that now excludes it looks equally ordinary. The
     * difference has to be on the page, naming the entity and what it actually
     * concluded, or the reader cannot tell this from an engagement nobody has
     * valued yet.
     */
    const nonEquity = {
      ...detail,
      consolidated: {
        ...detail.consolidated,
        non_equity_entities: [
          {
            valuation_id: 'v8',
            company_name: 'Acme UK Ltd',
            kind: 'ifrs2',
            figure: 'Total expense',
          },
        ],
      },
    };
    mockApi({ 'GET /organizations/org1': () => jsonResponse(nonEquity) });
    render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    );
    // The caption is the deliverable's own wording, folded into the sentence.
    expect(
      await screen.findByText(/Acme UK Ltd concluded total expense, not an equity value/),
    ).toBeInTheDocument();
  });

  /*
   * The banner above the table already says an IFRS 2 memo's figure is not an
   * equity value. The table below it went on printing that same figure under a
   * column headed "Equity value", and an EMI row's restricted AMV under one
   * headed "FMV/share" — the second of which is the number a board must not
   * adopt as a §409A price. The heading cannot vary per row, so the caption
   * rides on the row.
   */
  describe('figures printed under a heading that may not describe them', () => {
    const withKinds = {
      ...detail,
      entities: [
        {
          ...detail.entities[0]!,
          equity_figure: { caption: 'Concluded equity value', is_default: true },
          per_share_figure: { caption: 'Concluded FMV per share', is_default: true },
        },
        {
          valuation_id: 'v8',
          number: 'VAL-8',
          company_name: 'Acme UK Ltd',
          entity_type: 'subsidiary',
          parent_valuation_id: 'v1',
          state: 'delivered',
          equity_value: 420_000,
          fmv_per_share: null,
          currency: 'USD',
          equity_figure: { caption: 'Total expense', is_default: false },
          per_share_figure: { caption: null, is_default: false },
        },
        {
          valuation_id: 'v7',
          number: 'VAL-7',
          company_name: 'Acme EMI Ltd',
          entity_type: 'portfolio_company',
          parent_valuation_id: null,
          state: 'delivered',
          equity_value: 3_000_000,
          fmv_per_share: 1.25,
          currency: 'USD',
          equity_figure: { caption: 'Concluded equity value', is_default: true },
          per_share_figure: { caption: 'Actual market value (AMV) per share', is_default: false },
        },
      ],
    };

    const renderWith = async (body: unknown) => {
      mockApi({ 'GET /organizations/org1': () => jsonResponse(body) });
      render(
        <MemoryRouter>
          <PortfolioPage />
        </MemoryRouter>,
      );
      await screen.findByText('Acme Holdings');
    };

    it('captions a figure that is not what its column heading says', async () => {
      await renderWith(withKinds);
      await waitFor(() => expect(screen.getByText('Acme UK Ltd')).toBeInTheDocument());
      // The figure is still shown — it is a real conclusion of a real
      // engagement — but no longer as an equity value.
      expect(screen.getByText('$420,000')).toBeInTheDocument();
      expect(screen.getByText('Total expense')).toBeInTheDocument();
      // And the restricted AMV says which of the two per-share figures it is.
      expect(screen.getByText('$1.2500')).toBeInTheDocument();
      expect(screen.getByText('Actual market value (AMV) per share')).toBeInTheDocument();
    });

    it('leaves a 409A row uncaptioned — the heading already says it', async () => {
      await renderWith(withKinds);
      await waitFor(() => expect(screen.getByText('Acme Parent')).toBeInTheDocument());
      expect(screen.queryByText('Concluded equity value')).not.toBeInTheDocument();
      expect(screen.queryByText('Concluded FMV per share')).not.toBeInTheDocument();
    });

    it('omits a figure the kind never concluded rather than blanking it', async () => {
      // `caption: null` means there is no such figure, which is a different
      // statement from "the column is empty". A QSBS attestation concludes
      // neither, so nothing is printed even if a figure arrives beside it.
      await renderWith({
        ...detail,
        entities: [
          {
            ...detail.entities[0]!,
            company_name: 'Acme QSBS Co',
            equity_value: 999,
            fmv_per_share: 9.99,
            equity_figure: { caption: null, is_default: false },
            per_share_figure: { caption: null, is_default: false },
          },
        ],
      });
      await waitFor(() => expect(screen.getByText('Acme QSBS Co')).toBeInTheDocument());
      expect(screen.queryByText('$999')).not.toBeInTheDocument();
      expect(screen.queryByText('$9.9900')).not.toBeInTheDocument();
    });

    it('still draws an older API build that sends no captions', async () => {
      await renderWith(detail);
      await waitFor(() => expect(screen.getByText('Acme Parent')).toBeInTheDocument());
      expect(screen.getAllByText(/\$10,000,000/).length).toBeGreaterThan(0);
      expect(screen.getByText('$2.5000')).toBeInTheDocument();
    });
  });

  it('says nothing about excluded figures when every entity concluded equity', async () => {
    mockApi();
    render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Acme Holdings')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Subsidiaries excluded')).toBeInTheDocument());
    expect(screen.queryByText(/not an equity value/)).not.toBeInTheDocument();
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

    /*
     * Round 262: this asserted the operation sentence *alone*, and had been
     * red on main since the call site moved to `describeActionFailure`. That
     * helper deliberately answers with both halves — what did not happen, then
     * why — so an exact match on the first half can only ever fail. Asserted as
     * the two facts it is: the operation, and a reason beyond it.
     */
    const message = await screen.findByText(/Could not create the organization\./);
    expect(message).toBeInTheDocument();
    expect(message.textContent!.length).toBeGreaterThan('Could not create the organization.'.length);
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

  it('surfaces the server’s own reason when an organization cannot be opened', async () => {
    // R427: `describeLoadFailure` prefers a `detail` the server wrote over the
    // page's own fallback sentence — this API's own `/organizations/:id` sends
    // a bare 404 by design, but the helper's contract is general, and this
    // pins it against any detail-carrying refusal.
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

    expect(await screen.findByText('gone')).toBeInTheDocument();
    expect(screen.queryByText('Could not load the organization.')).toBeNull();
  });

  it('falls back to its own sentence when the server gives no reason', async () => {
    const user = userEvent.setup();
    const beta = { ...org, id: 'org2', name: 'Beta Fund' };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const key = String(url).replace(/^.*\/api\/v1/, '');
      if (key === '/organizations') return jsonResponse({ organizations: [org, beta] });
      // What this route actually sends — a bare 404, deliberately, per R180.
      if (key === '/organizations/org2') return jsonResponse({}, 404);
      return jsonResponse(detail);
    });

    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Beta Fund' }));

    expect(await screen.findByText('Could not load the organization.')).toBeInTheDocument();
  });
});

/**
 * Two organization details outstanding at once.
 *
 * The sidebar is click-to-switch, so the detail for the entity the user just
 * left can reply after the one they are looking at. What renders is one
 * organization's subsidiaries, currencies and consolidated equity value under
 * another organization's name — self-consistent, unexplained, and the figure a
 * fund reads off this page.
 */
describe('PortfolioPage — the detail that replies late', () => {
  beforeEach(() => vi.restoreAllMocks());

  const beta = { ...org, id: 'org2', name: 'Beta Fund' };
  const named = (name: string) => ({
    ...detail,
    entities: [{ ...detail.entities[0]!, company_name: name }],
  });

  function deferDetails() {
    const pending: Array<{ key: string; resolve: (body: unknown, status?: number) => void }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const key = String(url).replace(/^.*\/api\/v1/, '');
      if (key === '/organizations') return jsonResponse({ organizations: [org, beta] });
      return new Promise<Response>((res) =>
        pending.push({ key, resolve: (body, status = 200) => res(jsonResponse(body, status)) }),
      );
    });
    return pending;
  }

  it('shows the selected organization, not the one that replied last', async () => {
    const user = userEvent.setup();
    const pending = deferDetails();
    render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(pending).toHaveLength(1));
    await user.click(await screen.findByRole('button', { name: 'Beta Fund' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0]!.key).toBe('/organizations/org1');
    expect(pending[1]!.key).toBe('/organizations/org2');

    pending[1]!.resolve(named('Beta Subsidiary'));
    await screen.findByText('Beta Subsidiary');
    pending[0]!.resolve(named('Acme Subsidiary'));

    await waitFor(() => expect(screen.getByText('Beta Subsidiary')).toBeInTheDocument());
    expect(screen.queryByText('Acme Subsidiary')).toBeNull();
  });

  it('does not blame the selected organization for the abandoned one’s failure', async () => {
    const user = userEvent.setup();
    const pending = deferDetails();
    render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(pending).toHaveLength(1));
    await user.click(await screen.findByRole('button', { name: 'Beta Fund' }));
    await waitFor(() => expect(pending).toHaveLength(2));

    pending[1]!.resolve(named('Beta Subsidiary'));
    await screen.findByText('Beta Subsidiary');
    pending[0]!.resolve({ detail: 'gone' }, 404);

    await waitFor(() => expect(screen.getByText('Beta Subsidiary')).toBeInTheDocument());
    expect(screen.queryByText('Could not load the organization.')).toBeNull();
  });
});
