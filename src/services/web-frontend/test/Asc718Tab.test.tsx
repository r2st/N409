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

    expect(screen.getByRole('button', { name: 'About Expected-term method' })).toBeInTheDocument();

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

/**
 * R340, methodology M5 — a failed read of the saved ASC 718 settings.
 *
 * `load` swallowed every failure under "settings are optional". Absence is not
 * a failure here: the route answers `{ settings: null }` for a valuation with
 * no row, and the `if (s)` handles it. What the swallow caught was the other
 * thing, and it left the three controls on this component's defaults — private,
 * no ticker, SAB 107 simplified — with nothing on screen saying so.
 *
 * `PUT .../asc718/settings` is a whole-row replace, and the four fields this
 * form does not own ride along in `untouchedSettings(settings)`, which answers
 * `{}` while `settings` is null. So the next Save wrote the defaults over the
 * row and nulled the ESPP discount, the lookback, the RSU performance
 * conditions and the TSR peer basket — none of which are on this screen.
 */
describe('Asc718Tab — the saved settings could not be read', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUser = opsUser;
  });

  const settingsPath = '/asc718/settings';

  function mockSettingsRead(respond: () => Response | Promise<Response>) {
    const puts: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ settings: { company_type: 'private', expected_term_method: 'simplified' } });
      }
      if (String(url).includes(settingsPath)) return respond();
      return jsonResponse({});
    });
    return puts;
  }

  it('says so rather than showing its own defaults as if they were saved', async () => {
    mockSettingsRead(() => jsonResponse({ title: 'Internal Server Error' }, 500));
    renderTab();

    const note = await screen.findByTestId('settings-load-error');
    expect(note).toHaveAttribute('role', 'alert');
    expect(note.textContent).toMatch(/defaults/i);
  });

  it('will not save the defaults over the row it could not read', async () => {
    const puts = mockSettingsRead(() => jsonResponse({ title: 'Internal Server Error' }, 500));
    renderTab();

    await screen.findByTestId('settings-load-error');
    const save = screen.getByRole('button', { name: 'Save settings' });
    expect(save).toBeDisabled();
    await userEvent.setup().click(save);
    expect(puts).toHaveLength(0);
  });

  it('treats a transport failure the same way', async () => {
    mockSettingsRead(() => Promise.reject(new TypeError('Failed to fetch')));
    renderTab();

    expect(await screen.findByTestId('settings-load-error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
  });

  it('leaves a valuation that genuinely has no settings row alone', async () => {
    // The absence the old comment was written for: a 200 carrying null.
    const puts = mockSettingsRead(() => jsonResponse({ settings: null }));
    renderTab();

    const save = await screen.findByRole('button', { name: 'Save settings' });
    expect(screen.queryByTestId('settings-load-error')).toBeNull();
    expect(save).not.toBeDisabled();
    await userEvent.setup().click(save);
    expect(puts).toHaveLength(1);
  });
});
