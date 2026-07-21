import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { Asc718Tab } from '../src/pages/valuation/Asc718Tab';
import type { User, Valuation } from '../src/lib/types';

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'started',
  company_name: 'Acme',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

let mockUser: User;
vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

const opsUser = { id: 'u-ops', email: 'ops@example.com', roles: ['admin'] } as unknown as User;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function WithWorkspace() {
  return <Outlet context={{ valuation, reload: async () => {} }} />;
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/asc718']}>
      <Routes>
        <Route element={<WithWorkspace />}>
          <Route path="/asc718" element={<Asc718Tab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('Asc718Tab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUser = opsUser;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ settings: null }));
  });

  it('renders a contextual HelpIcon that opens the public ASC 718 article', async () => {
    const user = userEvent.setup();
    renderTab();

    const help = await screen.findByRole('button', {
      name: /Help: ASC 718 for public companies/,
    });
    await user.click(help);
    const dialog = await screen.findByRole('dialog', { name: /ASC 718 for public companies/ });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open in Help Center/ })).toHaveAttribute(
      'href',
      '/help/asc718-public-overview',
    );
  });

  it('explains the volatility field with a tooltip', async () => {
    const user = userEvent.setup();
    renderTab();
    // The default-assumptions volatility field always carries a tooltip.
    const tip = await screen.findByRole('button', { name: 'About Volatility' });
    await user.hover(tip);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/volatility/i);
  });

  it('reveals the expected-term and lookback tooltips for public issuers', async () => {
    const user = userEvent.setup();
    renderTab();

    // Switch to public to expose the expected-term method + ESPP awards.
    const companyType = await screen.findByLabelText('Company type');
    await user.selectOptions(companyType, 'public');

    expect(
      screen.getByRole('button', { name: 'About Expected-term method' }),
    ).toBeInTheDocument();

    // Add an ESPP offering and confirm the lookback tooltip is present.
    await user.click(screen.getByRole('button', { name: 'Add ESPP' }));
    expect(screen.getByRole('button', { name: 'About Lookback months' })).toBeInTheDocument();
  });

  it('locks the tab down for non-ops users', async () => {
    mockUser = { id: 'u-cl', email: 'client@example.com', roles: ['valuation_user'] } as unknown as User;
    renderTab();
    expect(await screen.findByText('Operations only')).toBeInTheDocument();
  });
});
