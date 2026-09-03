import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { CapTableTab } from '../src/pages/valuation/CapTableTab';
import type { User, Valuation } from '../src/lib/types';

let mockUser: User;
vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ user: mockUser }) }));

const OPS_USER = { id: 'u-ops', email: 'ops@example.com', roles: ['admin'] } as unknown as User;

/**
 * A capped list that does not say it was capped is read as the whole answer
 * (R402, methodology M8).
 *
 * The server bounds a validation at `MAX_CAP_TABLE_ISSUES` because the per-entry
 * rules are a product — entries times rules — and a systematic finding on a
 * 2,000-row register ran to 2,001 issue objects and 342 kB of prose. The count
 * of what was dropped rides on the response, and this is the half that has to
 * draw it: an analyst told "200 warnings" about a table with 2,001 findings
 * would fix the two hundred and re-import expecting a clean sheet.
 */
const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'in_progress',
  company_name: 'Acme',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const SUMMARY = {
  total_shares: 12_000_000,
  common_shares: 8_000_000,
  preferred_shares: 4_000_000,
  option_shares: 0,
  warrant_shares: 0,
  fully_diluted_shares: 12_000_000,
  total_preference_stack: 5_000_000,
  class_count: 2,
};

const ENTRIES = [
  {
    security_class: 'Common Stock',
    class_type: 'common',
    shares: 8_000_000,
    price_per_share: 0.1,
    invested_amount: null,
    liquidation_multiple: null,
    seniority: null,
    conversion_ratio: null,
  },
];

const FORMATS = [
  { key: 'generic', label: 'Generic', mapping: { security_class: 'class', shares: 'shares' } },
  { key: 'carta', label: 'Carta export', mapping: { security_class: 'Security', shares: 'Quantity' } },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi(body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/\/cap-table\/formats/.test(url)) return json({ formats: FORMATS });
    if (/\/cap-table$/.test(url)) return json(body);
    return json({});
  });
}

function issues(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    severity: 'warning' as const,
    code: 'no_investment',
    row: i + 2,
    message: `Row ${i + 2}: "Series ${i}" records no price per share or invested amount.`,
  }));
}

function renderTab() {
  render(
    <MemoryRouter initialEntries={['/cap-table']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/cap-table" element={<CapTableTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('the cap-table validation banner discloses a capped list (R402, M8)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUser = OPS_USER;
  });

  it('says how many findings were left off', async () => {
    mockApi({
      cap_table: {
        source_format: 'carta',
        entries: ENTRIES,
        validation: { valid: true, issues: issues(200), issues_truncated: 1_801, summary: SUMMARY },
        updated_at: '2026-08-01T00:00:00.000Z',
      },
      can_edit: true,
    });
    renderTab();
    expect(await screen.findByText(/1,801 more findings/)).toBeTruthy();
  });

  it('says nothing when the whole list is there', async () => {
    mockApi({
      cap_table: {
        source_format: 'carta',
        entries: ENTRIES,
        validation: { valid: true, issues: issues(3), issues_truncated: 0, summary: SUMMARY },
        updated_at: '2026-08-01T00:00:00.000Z',
      },
      can_edit: true,
    });
    renderTab();
    // The banner is up — so the absence below is about the notice, not about
    // the list having failed to render at all.
    expect(await screen.findByText(/3 warning\(s\)/)).toBeTruthy();
    expect(screen.queryByText(/more findings/)).toBeNull();
    expect(screen.queryByText(/more finding\b/)).toBeNull();
  });
});
