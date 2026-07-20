import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    currencies: ['USD'],
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
