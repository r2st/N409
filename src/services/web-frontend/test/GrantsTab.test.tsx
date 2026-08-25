import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { GrantsTab } from '../src/pages/valuation/GrantsTab';
import type { User, Valuation } from '../src/lib/types';

/**
 * Option grants are struck at the board-adopted FMV and are what an employee
 * eventually exercises against, so the two things worth pinning hardest are
 * units and permissions.
 *
 * Units: `exercise_price` and every scenario figure are *minor* units, and
 * `formatMoney` divides by 100. A grant priced at 250 is $2.50 a share, not
 * $250 — the same number is defensible either way on screen, and nothing else
 * in the frontend re-checks it.
 *
 * Permissions: `isOps` decides whether the issue and cancel controls exist at
 * all. A non-ops viewer seeing a cancel button is a support incident; the
 * server would refuse it, but only after the user believed they had done it.
 */

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'complete',
  company_name: 'Acme',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

let mockUser: User;
vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

const opsUser = { id: 'u-ops', email: 'ops@example.com', roles: ['admin'] } as unknown as User;
const viewerUser = { id: 'u-v', email: 'v@example.com', roles: ['client'] } as unknown as User;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const GRANT = {
  id: 'g1',
  grantee_name: 'Dana Reed',
  grantee_email: 'dana@example.com',
  grant_date: '2026-01-15',
  options_count: 40_000,
  // Minor units: $2.50 a share.
  exercise_price: '250',
  currency: 'USD',
  vesting_template: 'standard_4yr_1yr_cliff',
  vesting_start_date: '2026-01-15',
  vesting_months: 48,
  cliff_months: 12,
  frequency_months: 1,
  status: 'active' as const,
  vesting: {
    totalShares: 40_000,
    vestedShares: 10_000,
    unvestedShares: 30_000,
    percentVested: 25,
    fullyVested: false,
    cliffCleared: true,
  },
};

const CANCELLED = { ...GRANT, id: 'g2', grantee_name: 'Sam Ito', status: 'cancelled' as const };

const DETAIL = {
  grant: GRANT,
  timeline: [
    { monthOffset: 0, date: '2026-01-15', cumulativeVested: 0 },
    { monthOffset: 12, date: '2027-01-15', cumulativeVested: 10_000 },
    { monthOffset: 48, date: '2030-01-15', cumulativeVested: 40_000 },
  ],
  scenarios: [
    {
      fmv: 500,
      spreadPerShare: 250,
      grossValue: 10_000_000,
      exerciseCost: 10_000_000,
      multipleOfCurrent: 2,
    },
  ],
};

const TEMPLATES = [
  {
    key: 'standard_4yr_1yr_cliff',
    label: '4 years, 1-year cliff',
    vestingMonths: 48,
    cliffMonths: 12,
    frequencyMonths: 1,
  },
  { key: 'monthly_3yr', label: '3 years, monthly', vestingMonths: 36, cliffMonths: 0, frequencyMonths: 1 },
];

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function mockApi(
  opts: {
    grants?: () => Response;
    detail?: () => Response;
    create?: () => Response;
    remove?: () => Response;
    /** The schedule catalog loads on its own; failing it alone is the case. */
    templates?: () => Response;
  } = {},
): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    if (/\/grant-templates$/.test(url)) {
      return opts.templates ? opts.templates() : json({ templates: TEMPLATES });
    }
    if (/\/grants$/.test(url) && method === 'POST') return opts.create ? opts.create() : json({});
    if (/\/grants$/.test(url)) return opts.grants ? opts.grants() : json({ grants: [GRANT] });
    if (/\/grants\/[^/]+$/.test(url) && method === 'DELETE') {
      return opts.remove ? opts.remove() : json({});
    }
    if (/\/grants\/[^/]+$/.test(url)) return opts.detail ? opts.detail() : json(DETAIL);
    // HrisSyncPanel's provider list, and anything else incidental.
    if (/\/hris$/.test(url)) return json({ providers: [] });
    return json({});
  });
  return calls;
}

const problem = (status: number, detail: string) => () => json({ status, title: 'Error', detail }, status);

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/grants']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/grants" element={<GrantsTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const ready = () => screen.findByRole('heading', { name: 'Option grants' });
const grantCard = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

describe('GrantsTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUser = opsUser;
  });

  describe('the grant list', () => {
    it('shows a loading block until the grants arrive', async () => {
      mockApi();
      renderTab();
      expect(screen.getByText('Loading grants…')).toBeInTheDocument();
      await ready();
      expect(screen.queryByText('Loading grants…')).not.toBeInTheDocument();
    });

    it('prices the grant in major units', async () => {
      // 250 minor units is $2.50 a share. Printing "$250.00" here would
      // misstate the strike by 100× on every grant in the list.
      mockApi();
      renderTab();
      await ready();
      expect(grantCard('Dana Reed')).toHaveTextContent('40,000 @ $2.50');
    });

    it('identifies the grantee and when the grant was made', async () => {
      mockApi();
      renderTab();
      await ready();
      const card = grantCard('Dana Reed');
      expect(card).toHaveTextContent('dana@example.com');
      expect(card).toHaveTextContent('granted 2026-01-15');
    });

    it('states how much has vested', async () => {
      mockApi();
      renderTab();
      await ready();
      expect(grantCard('Dana Reed')).toHaveTextContent('25% · 10,000 vested');
    });

    it('marks a cancelled grant and offers no way to cancel it again', async () => {
      mockApi({ grants: () => json({ grants: [CANCELLED] }) });
      renderTab();
      await ready();
      const card = grantCard('Sam Ito');
      expect(card).toHaveTextContent('cancelled');
      expect(within(card).queryByRole('button', { name: 'cancel' })).not.toBeInTheDocument();
    });

    it('says nothing has been issued when nothing has', async () => {
      mockApi({ grants: () => json({ grants: [] }) });
      renderTab();
      await ready();
      expect(screen.getByText('No grants issued yet')).toBeInTheDocument();
      expect(screen.getByText(/Once the board approves the 409A/)).toBeInTheDocument();
    });

    it('tells a viewer the list is read-only rather than inviting them to issue', async () => {
      mockUser = viewerUser;
      mockApi({ grants: () => json({ grants: [] }) });
      renderTab();
      await ready();
      expect(screen.getByText(/will appear here/)).toBeInTheDocument();
    });

    it('reports a failed load instead of claiming there are no grants', async () => {
      // The failure mode this pins: swallowing the error and rendering the
      // empty state tells ops "No grants issued yet — issue option grants
      // here" on a valuation that may be full of them. Issuing a duplicate
      // grant off the back of that is a real, expensive mistake.
      mockApi({ grants: problem(503, 'The grants service is unavailable.') });
      renderTab();
      await ready();
      expect(await screen.findByRole('alert')).toHaveTextContent('The grants service is unavailable.');
      expect(screen.queryByText('No grants issued yet')).not.toBeInTheDocument();
    });
  });

  describe('permissions', () => {
    it('offers ops the issue and cancel controls', async () => {
      mockApi();
      renderTab();
      await ready();
      expect(screen.getByRole('button', { name: 'New grant' })).toBeInTheDocument();
      expect(within(grantCard('Dana Reed')).getByRole('button', { name: 'cancel' })).toBeInTheDocument();
    });

    it('offers a viewer neither, nor the HRIS import', async () => {
      mockUser = viewerUser;
      mockApi();
      renderTab();
      await ready();
      expect(screen.queryByRole('button', { name: 'New grant' })).not.toBeInTheDocument();
      expect(
        within(grantCard('Dana Reed')).queryByRole('button', { name: 'cancel' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/HRIS/i)).not.toBeInTheDocument();
    });

    it('still lets a viewer open the detail', async () => {
      mockUser = viewerUser;
      mockApi();
      renderTab();
      await ready();
      expect(within(grantCard('Dana Reed')).getByRole('button', { name: 'Detail' })).toBeInTheDocument();
    });
  });

  describe('issuing a grant', () => {
    const openForm = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: 'New grant' }));
    };

    it('opens and closes the form', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await openForm(user);
      expect(screen.getByLabelText(/^Grantee name/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByLabelText(/^Grantee name/)).not.toBeInTheDocument();
    });

    it('offers the schedules the server defines, plus a custom option', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await openForm(user);
      const select = screen.getByLabelText(/^Vesting schedule/);
      expect(within(select).getByRole('option', { name: '4 years, 1-year cliff' })).toBeInTheDocument();
      expect(within(select).getByRole('option', { name: '3 years, monthly' })).toBeInTheDocument();
      expect(within(select).getByRole('option', { name: 'Custom…' })).toBeInTheDocument();
    });

    it('names the schedule it will actually use when the catalog is missing', async () => {
      /*
       * `vesting_template` defaults to 'standard_4yr_1yr_cliff' and is
       * submitted as-is. With the catalog gone the select rendered blank over
       * that default and offered "Custom…" as the only visible choice — which
       * is a materially different grant (4-year monthly, no cliff). The wrong
       * option looked like the only one.
       */
      const user = userEvent.setup();
      const calls = mockApi({ templates: () => json({ detail: 'nope' }, 503) });
      renderTab();
      await ready();
      await openForm(user);

      const select = screen.getByLabelText(/^Vesting schedule/);
      expect(select).toHaveValue('standard_4yr_1yr_cliff');
      expect(within(select).getByRole('option', { name: 'standard_4yr_1yr_cliff' })).toBeInTheDocument();
      expect(screen.getByText(/schedule catalog could not be loaded/)).toBeInTheDocument();

      // And the grant it creates is the one the control now names.
      await user.type(screen.getByLabelText(/^Grantee name/), 'Ada Lovelace');
      await user.type(screen.getByLabelText(/^Grant date/), '2026-01-15');
      await user.type(screen.getByLabelText(/^Number of options/), '1000');
      await user.click(screen.getByRole('button', { name: 'Issue grant' }));
      await waitFor(() => {
        const post = calls.find((c) => c.method === 'POST' && /\/grants$/.test(c.url));
        expect(post).toBeTruthy();
        expect(post!.body).toMatchObject({ vesting_template: 'standard_4yr_1yr_cliff' });
      });
    });

    it('says nothing of the sort when the catalog loads', async () => {
      // The other half — the hint must be earned.
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await openForm(user);

      expect(screen.queryByText(/schedule catalog could not be loaded/)).toBeNull();
    });

    it('explains what custom terms actually do', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await openForm(user);
      await user.selectOptions(screen.getByLabelText(/^Vesting schedule/), 'custom');
      expect(screen.getByText(/4-year monthly schedule by default/)).toBeInTheDocument();
    });

    it('names each unspecified part of the grant instead of a dead submit button', async () => {
      // R29 — the button was disabled until all three were filled, which
      // refuses the submit without saying which part is missing.
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await openForm(user);

      await user.click(screen.getByRole('button', { name: 'Issue grant' }));

      expect(await screen.findByText('Grantee name is required.')).toBeInTheDocument();
      expect(screen.getByText('Grant date is required.')).toBeInTheDocument();
      expect(screen.getByText('Number of options is required.')).toBeInTheDocument();
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('refuses a fractional option count, which is what the default step meant', async () => {
      // `type="number"` with no `step` is a step of 1, so the browser rejected
      // this. `Number(form.options_count)` would have posted 40000.5 options.
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await openForm(user);

      await user.type(screen.getByLabelText(/^Grantee name/), 'Dana Reed');
      await user.type(screen.getByLabelText(/^Grant date/), '2026-01-15');
      await user.type(screen.getByLabelText(/^Number of options/), '40000.5');
      await user.click(screen.getByRole('button', { name: 'Issue grant' }));

      expect(await screen.findByText('Number of options must be a whole number.')).toBeInTheDocument();
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('refuses a zero-option grant', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await openForm(user);

      await user.type(screen.getByLabelText(/^Grantee name/), 'Dana Reed');
      await user.type(screen.getByLabelText(/^Grant date/), '2026-01-15');
      await user.type(screen.getByLabelText(/^Number of options/), '0');
      await user.click(screen.getByRole('button', { name: 'Issue grant' }));

      expect(await screen.findByText('Number of options must be at least 1.')).toBeInTheDocument();
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('checks the grantee email only when one is given', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await openForm(user);

      await user.type(screen.getByLabelText(/^Grantee name/), 'Dana Reed');
      await user.type(screen.getByLabelText(/^Grant date/), '2026-01-15');
      await user.type(screen.getByLabelText(/^Number of options/), '40000');
      await user.type(screen.getByLabelText(/^Grantee email/), 'dana@');
      await user.click(screen.getByRole('button', { name: 'Issue grant' }));

      expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('sends a blank email as null and defaults the vesting start to the grant date', async () => {
      // Both are deliberate: the column is nullable rather than empty-string,
      // and a grant whose vesting starts on a different day than it was made
      // is the exception, not the default.
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await openForm(user);
      await user.type(screen.getByLabelText(/^Grantee name/), '  Dana Reed  ');
      await user.type(screen.getByLabelText(/^Grant date/), '2026-01-15');
      await user.type(screen.getByLabelText(/^Number of options/), '40000');
      await user.click(screen.getByRole('button', { name: 'Issue grant' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
      expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
        grantee_name: 'Dana Reed',
        grantee_email: null,
        grant_date: '2026-01-15',
        options_count: 40_000,
        vesting_template: 'standard_4yr_1yr_cliff',
        vesting_start_date: '2026-01-15',
      });
    });

    it('sends an explicit vesting start when one is given', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await openForm(user);
      await user.type(screen.getByLabelText(/^Grantee name/), 'Dana Reed');
      await user.type(screen.getByLabelText(/^Grantee email/), 'dana@example.com');
      await user.type(screen.getByLabelText(/^Grant date/), '2026-01-15');
      await user.type(screen.getByLabelText(/^Number of options/), '40000');
      await user.type(screen.getByLabelText(/^Vesting start/), '2025-11-01');
      await user.click(screen.getByRole('button', { name: 'Issue grant' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
      expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
        grantee_email: 'dana@example.com',
        vesting_start_date: '2025-11-01',
      });
    });

    it('closes the form and re-reads the list once the grant is issued', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await openForm(user);
      await user.type(screen.getByLabelText(/^Grantee name/), 'Dana Reed');
      await user.type(screen.getByLabelText(/^Grant date/), '2026-01-15');
      await user.type(screen.getByLabelText(/^Number of options/), '40000');
      await user.click(screen.getByRole('button', { name: 'Issue grant' }));
      await waitFor(() => expect(screen.queryByLabelText(/^Grantee name/)).not.toBeInTheDocument());
      expect(calls.filter((c) => c.method === 'GET' && /\/grants$/.test(c.url))).toHaveLength(2);
    });

    it('keeps the form open with its values when the server refuses', async () => {
      // Losing what was typed on a rejection means re-keying the whole grant.
      const user = userEvent.setup();
      mockApi({ create: problem(422, 'The board has not approved this valuation.') });
      renderTab();
      await ready();
      await openForm(user);
      await user.type(screen.getByLabelText(/^Grantee name/), 'Dana Reed');
      await user.type(screen.getByLabelText(/^Grant date/), '2026-01-15');
      await user.type(screen.getByLabelText(/^Number of options/), '40000');
      await user.click(screen.getByRole('button', { name: 'Issue grant' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The board has not approved this valuation.',
      );
      expect(screen.getByLabelText(/^Grantee name/)).toHaveValue('Dana Reed');
    });
  });

  describe('cancelling a grant', () => {
    it('deletes the grant and re-reads the list', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await user.click(within(grantCard('Dana Reed')).getByRole('button', { name: 'cancel' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
      expect(calls.find((c) => c.method === 'DELETE')!.url).toMatch(/\/grants\/g1$/);
      await waitFor(() =>
        expect(calls.filter((c) => c.method === 'GET' && /\/grants$/.test(c.url))).toHaveLength(2),
      );
    });

    it('reports a refused cancellation', async () => {
      const user = userEvent.setup();
      mockApi({ remove: problem(409, 'This grant has already been exercised.') });
      renderTab();
      await ready();
      await user.click(within(grantCard('Dana Reed')).getByRole('button', { name: 'cancel' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('This grant has already been exercised.');
    });
  });

  describe('the grant detail', () => {
    it('opens and closes on the same control', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await user.click(within(grantCard('Dana Reed')).getByRole('button', { name: 'Detail' }));
      expect(await screen.findByRole('heading', { name: 'Vesting timeline' })).toBeInTheDocument();
      await user.click(within(grantCard('Dana Reed')).getByRole('button', { name: 'Hide detail' }));
      expect(screen.queryByRole('heading', { name: 'Vesting timeline' })).not.toBeInTheDocument();
    });

    it('plots the vesting curve between its first and last date', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await user.click(within(grantCard('Dana Reed')).getByRole('button', { name: 'Detail' }));
      expect(await screen.findByRole('img', { name: 'Vesting timeline' })).toBeInTheDocument();
      // Both the visible axis ends and the data table's row headers carry
      // these dates now, so the count is the assertion.
      expect(screen.getAllByText('2026-01-15').length).toBeGreaterThan(0);
      expect(screen.getAllByText('2030-01-15').length).toBeGreaterThan(0);
    });

    /**
     * `role="img"` makes the `<svg>` a leaf: the polyline, the points and the
     * axis are all pruned, so the chart announced its own title and not one
     * figure from the schedule. The bar above it gives today's percentage; how
     * much lands at the cliff, and when the rest follows, was in the picture
     * only (WCAG 1.1.1).
     */
    it('puts the vesting schedule in a table beside the curve', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await user.click(within(grantCard('Dana Reed')).getByRole('button', { name: 'Detail' }));
      const table = await screen.findByRole('table', { name: 'Vesting timeline' });
      // The cliff, which is the whole shape of a standard schedule: nothing
      // for a year, then a quarter of the grant at once.
      const cliff = within(table).getByRole('rowheader', { name: '2027-01-15' });
      expect(cliff.parentElement).toHaveTextContent('10,000 of 40,000');
      expect(within(table).getByRole('rowheader', { name: '2026-01-15' }).parentElement).toHaveTextContent(
        '0 of 40,000',
      );
      expect(within(table).getAllByRole('row')).toHaveLength(4); // header + three points
    });

    it('draws no curve from a single point', async () => {
      // One point is not a line; the chart would render a degenerate polyline
      // that reads as "nothing vests, ever".
      const user = userEvent.setup();
      mockApi({
        detail: () =>
          json({ ...DETAIL, timeline: [{ monthOffset: 0, date: '2026-01-15', cumulativeVested: 0 }] }),
      });
      renderTab();
      await ready();
      await user.click(within(grantCard('Dana Reed')).getByRole('button', { name: 'Detail' }));
      expect(await screen.findByRole('heading', { name: 'Vesting timeline' })).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'Vesting timeline' })).not.toBeInTheDocument();
      // No curve and no table: one point is not a schedule either.
      expect(screen.queryByRole('table', { name: 'Vesting timeline' })).not.toBeInTheDocument();
    });

    it('states the exercise scenario in major units throughout', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await user.click(within(grantCard('Dana Reed')).getByRole('button', { name: 'Detail' }));
      await screen.findByText('Exercise scenarios');
      const row = screen.getByText('2×').closest('tr') as HTMLElement;
      expect(row).toHaveTextContent('$5.00');
      expect(row).toHaveTextContent('$2.50');
      expect(row).toHaveTextContent('$100,000.00');
    });

    it('says the scenarios are illustrative and not tax advice', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await user.click(within(grantCard('Dana Reed')).getByRole('button', { name: 'Detail' }));
      expect(await screen.findByText(/Not tax advice/)).toBeInTheDocument();
      expect(screen.getByText(/all 40,000 options/)).toBeInTheDocument();
    });

    it('shows a spinner while the detail is still loading', async () => {
      const user = userEvent.setup();
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      mockApi({ detail: () => json(DETAIL) });
      // Re-wrap so only the detail call hangs.
      const original = globalThis.fetch as typeof fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (/\/grants\/[^/]+$/.test(url)) {
          await held;
          return json(DETAIL);
        }
        return original(input, init);
      });
      renderTab();
      await ready();
      await user.click(within(grantCard('Dana Reed')).getByRole('button', { name: 'Detail' }));
      expect(await screen.findByRole('status')).toBeInTheDocument();
      release();
      expect(await screen.findByRole('heading', { name: 'Vesting timeline' })).toBeInTheDocument();
    });

    /**
     * The detail fetch had an empty `.catch(() => {})`, so a grant whose
     * detail could not be loaded expanded into a spinner that never resolved
     * and said nothing. A reader cannot tell that from a slow request.
     */
    it('says why the detail could not be loaded rather than spinning forever', async () => {
      const user = userEvent.setup();
      mockApi({
        detail: () => json({ title: 'Not Found', detail: 'This grant has been cancelled.' }, 404),
      });
      renderTab();
      await ready();
      await user.click(within(grantCard('Dana Reed')).getByRole('button', { name: 'Detail' }));

      expect(await screen.findByText('This grant has been cancelled.')).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('falls back to a plain message when the detail fails without a problem body', async () => {
      const user = userEvent.setup();
      mockApi();
      // Re-wrap so only the detail call fails, and with no problem body.
      const base = globalThis.fetch as typeof fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (/\/grants\/[^/]+$/.test(url)) throw new TypeError('network down');
        return base(input, init);
      });
      renderTab();
      await ready();
      await user.click(within(grantCard('Dana Reed')).getByRole('button', { name: 'Detail' }));

      expect(await screen.findByText('Could not load the grant.')).toBeInTheDocument();
    });
  });
});
