import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { CompanyTab } from '../src/pages/valuation/CompanyTab';
import type { Valuation } from '../src/lib/types';

/**
 * The company profile's half of the lost-update fix (migration 0166).
 *
 * This form posts all sixteen columns on every save, from a snapshot it took
 * when the tab mounted — so it does not say "set the website", it says "make
 * the row look like it did when I opened this tab". Three writers reach that
 * row, and one of them is a button on this very panel: the `company_profile`
 * agent's apply writes three columns straight into it.
 *
 * That is what makes the second test here as important as the first. A guard
 * that refuses the analyst's save because of their own agent run, two inches up
 * the same page, is worse than no guard — the recovery is a reload, and a
 * reload discards whatever else they had typed.
 */

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', roles: ['admin'] } }),
}));

const valuation = {
  id: '01JCOMPANY00000000000000001',
  kind: '409a',
  state: 'drafted',
  company_name: 'Acme Robotics',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const PROFILE = {
  valuation_id: valuation.id,
  legal_name: 'Acme Robotics, Inc.',
  website: null,
  address_line1: null,
  address_line2: null,
  city: null,
  region: null,
  postal_code: null,
  country: null,
  industry: null,
  business_description: null,
  sic_code: null,
  naics_code: null,
  founded_on: null,
  employee_count: null,
  revenue_range: null,
  cap_table_summary: null,
  updated_at: '2026-08-01T00:00:00Z',
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type PatchOutcome = 'ok' | 'conflict';

/**
 * The row, not a script of replies: the tab re-reads after a conflict and the
 * agent's apply writes through a different URL, so the version has to live in
 * the mock the way it lives in the table.
 */
function mockApi(startVersion: number | undefined, patches: PatchOutcome[] = ['ok']) {
  let current = startVersion;
  let writes = 0;
  const row = () => (current === undefined ? null : { ...PROFILE, version: current });
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.includes('/ai/company_profile/apply')) {
      current = (current ?? 0) + 1;
      return jsonResponse({
        profile: { ...PROFILE, business_description: 'Drafted by the agent.', version: current },
        applied_fields: ['business_description'],
        skipped_fields: [],
      });
    }
    if (path.includes('/ai/company_profile')) return jsonResponse({ ok: true });
    if (init?.method === 'PATCH') {
      const outcome = patches[Math.min(writes, patches.length - 1)] ?? 'ok';
      writes += 1;
      current = (current ?? 0) + 1;
      if (outcome === 'conflict') {
        return jsonResponse(
          {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            detail: `This company profile was changed by someone else (now ${current}).`,
          },
          409,
        );
      }
      return jsonResponse({ profile: row() });
    }
    return jsonResponse({ profile: row(), company_name: valuation.company_name });
  });
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/company']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/company" element={<CompanyTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const patchCalls = (mock: ReturnType<typeof mockApi>) =>
  mock.mock.calls.filter(([, init]) => init?.method === 'PATCH') as Array<Parameters<typeof fetch>>;

const getCalls = (mock: ReturnType<typeof mockApi>) =>
  mock.mock.calls.filter(([, init]) => init?.method === undefined) as Array<Parameters<typeof fetch>>;

const ifMatchOf = (call: Parameters<typeof fetch>): string | undefined =>
  new Headers(call[1]?.headers).get('if-match') ?? undefined;

const save = async () => userEvent.click(screen.getByRole('button', { name: /Save profile/i }));

describe('CompanyTab — concurrent editors', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends the version it loaded as If-Match', async () => {
    const fetchMock = mockApi(4);
    renderTab();
    await screen.findByRole('button', { name: /Save profile/i });

    await save();
    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1));
    expect(ifMatchOf(patchCalls(fetchMock)[0]!)).toBe('"4"');
  });

  it('adopts the version the save returned, so a second save is not refused', async () => {
    const fetchMock = mockApi(4, ['ok', 'ok']);
    renderTab();
    await screen.findByRole('button', { name: /Save profile/i });

    await save();
    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1));
    await save();
    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(2));
    expect(ifMatchOf(patchCalls(fetchMock)[1]!)).toBe('"5"');
  });

  /**
   * The agent's apply writes the row this form is holding, so it makes this
   * form stale — and the writer that made it stale is the analyst who is about
   * to press Save. Without adopting the version the apply returned, the guard
   * would refuse their own click and take the rest of the form down with it.
   */
  it('adopts the version its own agent apply produced', async () => {
    const fetchMock = mockApi(4);
    renderTab();
    await screen.findByRole('button', { name: 'Draft with AI' });

    await userEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));
    await screen.findByText(/Drafted and saved/);

    await save();
    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1));
    expect(ifMatchOf(patchCalls(fetchMock)[0]!)).toBe('"5"');
  });

  /**
   * A conflict is an out-of-date form, not a failed save. Reloading is what
   * clears the stale sixteen columns this form would otherwise post again — the
   * agent's description among them.
   */
  it('reloads and explains itself on a conflict', async () => {
    const fetchMock = mockApi(4, ['conflict']);
    renderTab();
    await screen.findByRole('button', { name: /Save profile/i });
    const readsBefore = getCalls(fetchMock).length;

    await save();
    expect(await screen.findByText(/changed by someone else/i)).toBeInTheDocument();
    await waitFor(() => expect(getCalls(fetchMock).length).toBeGreaterThan(readsBefore));
  });

  it('sends the reloaded version on the retry, not the one that was refused', async () => {
    const fetchMock = mockApi(4, ['conflict', 'ok']);
    renderTab();
    await screen.findByRole('button', { name: /Save profile/i });

    await save();
    await screen.findByText(/changed by someone else/i);
    await save();
    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(2));
    expect(ifMatchOf(patchCalls(fetchMock)[1]!)).toBe('"5"');
  });

  /**
   * Nothing stored means nothing to be stale against. The GET returns
   * `profile: null` and no version, so the first save sends no header and
   * creates the row — asserting a version for a row nobody has ever written
   * would be a conflict the client could never resolve.
   */
  it('sends no If-Match for a profile that has never been saved', async () => {
    const fetchMock = mockApi(undefined);
    renderTab();
    await screen.findByRole('button', { name: /Save profile/i });

    await save();
    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1));
    expect(ifMatchOf(patchCalls(fetchMock)[0]!)).toBeUndefined();
  });
});
