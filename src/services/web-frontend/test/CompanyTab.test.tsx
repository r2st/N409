import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { CompanyTab } from '../src/pages/valuation/CompanyTab';
import type { Valuation } from '../src/lib/types';

/**
 * Mutable so a case can drop to a client principal: the AI drafting panel is
 * ops-only, matching the `isOps` gate the `/ai/*` routes enforce, and the tab
 * itself is editable by the requesting client too.
 */
let roles: string[] = ['admin'];
vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', roles } }),
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
  website: 'https://acme.example',
  address_line1: '1 Market St',
  address_line2: 'Suite 400',
  city: 'San Francisco',
  region: 'CA',
  postal_code: '94105',
  country: 'US',
  industry: 'B2B SaaS — logistics',
  business_description: 'Route-planning software for regional freight carriers.',
  sic_code: '7372',
  naics_code: '511210',
  founded_on: '2019-03-15',
  employee_count: 42,
  revenue_range: '1m_10m',
  cap_table_summary: 'Common 8m, Series A 2m.',
  updated_at: '2026-07-01T00:00:00Z',
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ status, title: 'Error', detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

/** GET returns `profile`; a PATCH goes to `onWrite` so a case can reject it. */
function mockApi(profile: unknown, onWrite?: (init: RequestInit) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if ((init?.method ?? 'GET') !== 'GET') {
      return onWrite ? onWrite(init!) : jsonResponse({ profile });
    }
    return jsonResponse({ profile });
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

describe('CompanyTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    roles = ['admin'];
  });

  it('seeds every field from the stored profile', async () => {
    mockApi(PROFILE);
    renderTab();
    await screen.findByDisplayValue('Acme Robotics, Inc.');

    expect(screen.getByDisplayValue('https://acme.example')).toBeInTheDocument();
    expect(screen.getByDisplayValue('B2B SaaS — logistics')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2019-03-15')).toBeInTheDocument();
    expect(screen.getByDisplayValue('42')).toBeInTheDocument();
    expect(screen.getByDisplayValue('1 Market St')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Suite 400')).toBeInTheDocument();
    expect(screen.getByDisplayValue('94105')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Common 8m, Series A 2m.')).toBeInTheDocument();
    expect(screen.getByLabelText('Revenue range')).toHaveValue('1m_10m');
  });

  it('starts blank when the engagement has no profile yet', async () => {
    mockApi(null);
    renderTab();
    // The engagement name is the hint on the legal-name field, so a profile-less
    // tab still tells the analyst what the engagement is called.
    await screen.findByText(/Engagement name: Acme Robotics/);
    expect(screen.getByLabelText(/^Legal name/)).toHaveValue('');
    expect(screen.getByLabelText('Employees')).toHaveValue('');
  });

  it('reports a failed load rather than presenting an empty form as the truth', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    renderTab();
    await screen.findByText(/Could not load the company profile/i);
    // A blank form here would invite the analyst to overwrite a profile that
    // simply failed to arrive.
    expect(screen.queryByLabelText(/^Legal name/)).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('sends every field, nulling the ones left blank', async () => {
    let body: Record<string, unknown> | null = null;
    mockApi(null, (init) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({ profile: null });
    });
    renderTab();
    await screen.findByLabelText(/^Legal name/);

    await userEvent.type(screen.getByLabelText(/^Legal name/), '  Newco Ltd  ');
    await userEvent.click(screen.getByRole('button', { name: /Save profile/i }));

    await waitFor(() => expect(body).not.toBeNull());
    // Trimmed, and every untouched field is an explicit null rather than an
    // empty string the server would store as content.
    expect(body!.legal_name).toBe('Newco Ltd');
    expect(body!.website).toBeNull();
    expect(body!.city).toBeNull();
    expect(body!.employee_count).toBeNull();
    expect(body!.revenue_range).toBeNull();
    expect(body!.cap_table_summary).toBeNull();
  });

  it('sends the employee count as a number', async () => {
    let body: Record<string, unknown> | null = null;
    mockApi(null, (init) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({ profile: null });
    });
    renderTab();
    await screen.findByLabelText('Employees');

    await userEvent.type(screen.getByLabelText('Employees'), '120');
    await userEvent.click(screen.getByRole('button', { name: /Save profile/i }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.employee_count).toBe(120);
  });

  it('rejects a fractional or non-numeric employee count before it reaches the server', async () => {
    const fetchSpy = mockApi(null);
    renderTab();
    await screen.findByLabelText('Employees');
    const before = fetchSpy.mock.calls.length;

    await userEvent.type(screen.getByLabelText('Employees'), '12.5');
    await userEvent.click(screen.getByRole('button', { name: /Save profile/i }));

    await screen.findByText('Employee count must be a whole number.');
    expect(fetchSpy.mock.calls).toHaveLength(before);
  });

  /**
   * A headcount over the ceiling *is* a whole number, so it gets its own
   * refusal — being told to enter a whole number when you just did sends the
   * analyst hunting for a typo that is not there.
   */
  it('rejects an implausible headcount, and says why', async () => {
    const fetchSpy = mockApi(null);
    renderTab();
    await screen.findByLabelText('Employees');
    const before = fetchSpy.mock.calls.length;

    await userEvent.type(screen.getByLabelText('Employees'), '10000001');
    await userEvent.click(screen.getByRole('button', { name: /Save profile/i }));

    await screen.findByText('Employee count must be 10,000,000 or fewer.');
    expect(fetchSpy.mock.calls).toHaveLength(before);
  });

  /** The ceiling itself is allowed — the API's own bound is inclusive. */
  it('accepts the ceiling headcount', async () => {
    let body: Record<string, unknown> | null = null;
    mockApi(null, (init) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({ profile: null });
    });
    renderTab();
    await screen.findByLabelText('Employees');

    await userEvent.type(screen.getByLabelText('Employees'), '10000000');
    await userEvent.click(screen.getByRole('button', { name: /Save profile/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.employee_count).toBe(10_000_000);
  });

  /**
   * Every input on this form is wired through one curried `set('key')` helper,
   * so the key literal spelled at the call site is the only thing tying a box
   * to the column it writes. A key copy-pasted onto the wrong box does not
   * announce itself — the box appears not to accept typing while a different
   * field quietly takes the text — and the form is long enough that the two
   * are rarely on screen together. Type a distinct value into each and assert
   * the PATCH that goes out.
   */
  it('wires every input to the column it is labelled with', async () => {
    let body: Record<string, unknown> | null = null;
    mockApi(null, (init) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({ profile: null });
    });
    renderTab();
    await screen.findByLabelText(/^Legal name/);

    const typed: Array<[string | RegExp, string, string]> = [
      [/^Legal name/, 'legal_name', 'Newco Ltd'],
      ['Website', 'website', 'https://newco.example'],
      ['Industry', 'industry', 'Marketplace — freight'],
      ['Employees', 'employee_count', '7'],
      [/^Business description/, 'business_description', 'Digital freight brokerage.'],
      [/^SIC code/, 'sic_code', '4731'],
      [/^NAICS code/, 'naics_code', '488510'],
      ['Address line 1', 'address_line1', '9 Wharf Rd'],
      ['Address line 2', 'address_line2', 'Unit 3'],
      ['City', 'city', 'Oakland'],
      ['State / region', 'region', 'CA'],
      ['Postal code', 'postal_code', '94607'],
      ['Country', 'country', 'US'],
      [/^Summary/, 'cap_table_summary', 'Common 5m, seed 1m.'],
    ];
    for (const [label, , value] of typed) {
      await userEvent.type(screen.getByLabelText(label), value);
    }
    // A date input takes a value rather than keystrokes.
    await userEvent.clear(screen.getByLabelText('Founded'));
    await userEvent.type(screen.getByLabelText('Founded'), '2021-11-02');
    await userEvent.selectOptions(screen.getByLabelText('Revenue range'), '10m_50m');

    await userEvent.click(screen.getByRole('button', { name: /Save profile/i }));

    await waitFor(() => expect(body).not.toBeNull());
    for (const [, column, value] of typed) {
      expect(body![column], `${column} did not receive what was typed into its box`).toBe(
        column === 'employee_count' ? Number(value) : value,
      );
    }
    expect(body!.founded_on).toBe('2021-11-02');
    expect(body!.revenue_range).toBe('10m_50m');
  });

  it('confirms the save and withdraws the confirmation once the form is edited again', async () => {
    mockApi(PROFILE);
    renderTab();
    await screen.findByDisplayValue('Acme Robotics, Inc.');

    await userEvent.click(screen.getByRole('button', { name: /Save profile/i }));
    await screen.findByText('Saved.');

    // A stale "Saved." next to unsaved edits is a lie about what the server has.
    await userEvent.type(screen.getByLabelText('City'), 'x');
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
  });

  it('surfaces the server message when the save is refused', async () => {
    mockApi(PROFILE, () => problem(422, 'website must be an absolute URL'));
    renderTab();
    await screen.findByDisplayValue('Acme Robotics, Inc.');

    await userEvent.click(screen.getByRole('button', { name: /Save profile/i }));
    await screen.findByText('website must be an absolute URL');
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
    // The edits survive the rejection.
    expect(screen.getByDisplayValue('Acme Robotics, Inc.')).toBeInTheDocument();
  });

  it('falls back to a plain message when the save fails without a problem document', async () => {
    mockApi(PROFILE, () => {
      throw new TypeError('network down');
    });
    renderTab();
    await screen.findByDisplayValue('Acme Robotics, Inc.');

    await userEvent.click(screen.getByRole('button', { name: /Save profile/i }));
    await screen.findByText(/Could not save the company profile\./);
  });

  it('offers each revenue band and sends the one chosen', async () => {
    let body: Record<string, unknown> | null = null;
    mockApi(null, (init) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({ profile: null });
    });
    renderTab();
    const select = await screen.findByLabelText('Revenue range');

    expect(screen.getByRole('option', { name: 'Pre-revenue' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Over $100M' })).toBeInTheDocument();
    await userEvent.selectOptions(select, '10m_50m');
    await userEvent.click(screen.getByRole('button', { name: /Save profile/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.revenue_range).toBe('10m_50m');
  });

  it('disables the button while the save is in flight', async () => {
    let release: (() => void) | undefined;
    mockApi(PROFILE, () => {
      throw new Error('unreachable');
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if ((init?.method ?? 'GET') !== 'GET') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return jsonResponse({ profile: PROFILE });
    });
    renderTab();
    await screen.findByDisplayValue('Acme Robotics, Inc.');

    await userEvent.click(screen.getByRole('button', { name: /Save profile/i }));
    const button = await screen.findByRole('button', { name: 'Saving…' });
    expect(button).toBeDisabled();

    release!();
    await waitFor(() => expect(screen.getByRole('button', { name: /Save profile/i })).toBeEnabled());
  });

  /**
   * R33 — migration 0151 added these three columns and the PATCH route accepted
   * them from the day it shipped, but the editor had no box for any of them:
   * the only way to fill the fields the report's company section is drafted
   * from was the `company_profile` agent or a hand-written PATCH.
   */
  describe('business and classification', () => {
    it('seeds the description and the codes from the stored profile', async () => {
      mockApi(PROFILE);
      renderTab();
      expect(
        await screen.findByDisplayValue('Route-planning software for regional freight carriers.'),
      ).toBeInTheDocument();
      expect(screen.getByLabelText(/^SIC code/)).toHaveValue('7372');
      expect(screen.getByLabelText(/^NAICS code/)).toHaveValue('511210');
    });

    it('sends them on save, nulling the ones left blank', async () => {
      let body: Record<string, unknown> | null = null;
      mockApi(null, (init) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ profile: null });
      });
      renderTab();
      await screen.findByLabelText(/^SIC code/);

      await userEvent.type(screen.getByLabelText(/^SIC code/), '7372');
      await userEvent.click(screen.getByRole('button', { name: /Save profile/i }));

      await waitFor(() => expect(body).not.toBeNull());
      expect(body!.sic_code).toBe('7372');
      expect(body!.naics_code).toBeNull();
      expect(body!.business_description).toBeNull();
    });

    /**
     * The failure a malformed SIC causes is silent and far away — it reaches
     * the comparable screen, ranks against no universe row, and presents as
     * "no comparable companies found". Both entry points refuse it.
     */
    it('refuses a malformed SIC before it reaches the server', async () => {
      const fetchSpy = mockApi(null);
      renderTab();
      await screen.findByLabelText(/^SIC code/);
      const before = fetchSpy.mock.calls.length;

      await userEvent.type(screen.getByLabelText(/^SIC code/), '73A2');
      await userEvent.click(screen.getByRole('button', { name: /Save profile/i }));

      await screen.findByText('A SIC code is 2–4 digits.');
      expect(fetchSpy.mock.calls).toHaveLength(before);
    });

    it('refuses a NAICS code that is too long', async () => {
      const fetchSpy = mockApi(null);
      renderTab();
      await screen.findByLabelText(/^NAICS code/);
      const before = fetchSpy.mock.calls.length;

      await userEvent.type(screen.getByLabelText(/^NAICS code/), '5112101');
      await userEvent.click(screen.getByRole('button', { name: /Save profile/i }));

      await screen.findByText('A NAICS code is 2–6 digits.');
      expect(fetchSpy.mock.calls).toHaveLength(before);
    });
  });

  describe('AI drafting', () => {
    const applied = (profile: unknown, extra: Record<string, unknown> = {}) =>
      jsonResponse({
        profile,
        applied_fields: ['business_description', 'sic_code'],
        skipped_fields: [],
        source_job_id: '01JJOB000000000000000000001',
        ...extra,
      });

    it('runs the agent and then applies what it drafted', async () => {
      const posts: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if ((init?.method ?? 'GET') !== 'GET') {
          posts.push(String(url));
          return String(url).includes('/apply') ? applied(PROFILE) : jsonResponse({});
        }
        return jsonResponse({ profile: null });
      });
      renderTab();
      await screen.findByRole('button', { name: 'Draft with AI' });

      await userEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));
      await waitFor(() => expect(posts).toHaveLength(2));
      expect(posts[0]).toMatch(/\/ai\/company_profile$/);
      expect(posts[1]).toMatch(/\/ai\/company_profile\/apply$/);
    });

    it('puts the drafted values into the form', async () => {
      mockApi(null, (init) =>
        String(init.body ?? '').includes('overwrite') ? applied(PROFILE) : jsonResponse({}),
      );
      renderTab();
      await screen.findByRole('button', { name: 'Draft with AI' });

      await userEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));
      expect(
        await screen.findByDisplayValue('Route-planning software for regional freight carriers.'),
      ).toBeInTheDocument();
      expect(screen.getByLabelText(/^SIC code/)).toHaveValue('7372');
    });

    /**
     * The apply returns the whole stored row, so seeding the form from it would
     * discard an unsaved edit elsewhere — the analyst who typed a website and
     * then asked for a description would silently lose the website. Only the
     * agent's own four columns are merged back.
     */
    it('keeps unsaved edits to fields the agent does not write', async () => {
      mockApi(null, (init) =>
        String(init.body ?? '').includes('overwrite') ? applied(PROFILE) : jsonResponse({}),
      );
      renderTab();
      await screen.findByLabelText('Website');

      await userEvent.type(screen.getByLabelText('Website'), 'https://typed.example');
      await userEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));
      await screen.findByDisplayValue('Route-planning software for regional freight carriers.');

      // PROFILE.website is https://acme.example — the returned row must not win.
      expect(screen.getByLabelText('Website')).toHaveValue('https://typed.example');
    });

    it('names what it wrote and what it left alone', async () => {
      mockApi(null, (init) =>
        String(init.body ?? '').includes('overwrite')
          ? jsonResponse({
              profile: PROFILE,
              applied_fields: ['business_description'],
              skipped_fields: [
                { field: 'sic_code', reason: 'already_set' },
                { field: 'naics_code', reason: 'empty' },
              ],
            })
          : jsonResponse({}),
      );
      renderTab();
      await screen.findByRole('button', { name: 'Draft with AI' });

      await userEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));
      const note = await screen.findByText(/Drafted and saved/);
      expect(note).toHaveTextContent('Drafted and saved Business description.');
      expect(note).toHaveTextContent('SIC code (already filled in)');
      expect(note).toHaveTextContent('NAICS code (the documents did not say)');
    });

    /** Blanks only unless the analyst explicitly opts in. */
    it('sends overwrite only when the box is ticked', async () => {
      const bodies: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if ((init?.method ?? 'GET') !== 'GET') {
          if (String(url).includes('/apply')) {
            bodies.push(String(init!.body));
            return applied(PROFILE);
          }
          return jsonResponse({});
        }
        return jsonResponse({ profile: null });
      });
      renderTab();
      await screen.findByRole('button', { name: 'Draft with AI' });

      await userEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));
      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(JSON.parse(bodies[0]!)).toEqual({ overwrite: false });

      await userEvent.click(screen.getByLabelText(/Replace values already on the profile/i));
      await userEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));
      await waitFor(() => expect(bodies).toHaveLength(2));
      expect(JSON.parse(bodies[1]!)).toEqual({ overwrite: true });
    });

    /** The 422 raised when every field the run produced is already filled in. */
    it('surfaces the message telling the analyst to opt into overwriting', async () => {
      mockApi(null, () =>
        problem(
          422,
          'Every field this run produced is already set on the profile — pass overwrite to replace them',
        ),
      );
      renderTab();
      await screen.findByRole('button', { name: 'Draft with AI' });

      await userEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));
      expect(await screen.findByText(/pass overwrite to replace them/)).toBeInTheDocument();
    });

    /** A failed run must not fall through to an apply of some earlier one. */
    it('does not apply when the agent run fails', async () => {
      const posts: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if ((init?.method ?? 'GET') !== 'GET') {
          posts.push(String(url));
          return problem(422, 'Upload a document before running the company-profile agent');
        }
        return jsonResponse({ profile: null });
      });
      renderTab();
      await screen.findByRole('button', { name: 'Draft with AI' });

      await userEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));
      expect(
        await screen.findByText('Upload a document before running the company-profile agent'),
      ).toBeInTheDocument();
      expect(posts).toHaveLength(1);
    });

    it('falls back to a plain message when the agent fails without a problem document', async () => {
      mockApi(null, () => {
        throw new TypeError('network down');
      });
      renderTab();
      await screen.findByRole('button', { name: 'Draft with AI' });

      await userEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));
      expect(await screen.findByText(/Could not draft the company profile\./)).toBeInTheDocument();
    });

    /**
     * The tab is editable by the requesting client, the `/ai/*` routes are
     * ops-only — so the panel has to be gated on the narrower of the two.
     */
    it('is hidden from the client who owns the engagement', async () => {
      roles = ['client'];
      mockApi(PROFILE);
      renderTab();
      await screen.findByDisplayValue('Acme Robotics, Inc.');

      expect(screen.queryByRole('button', { name: 'Draft with AI' })).not.toBeInTheDocument();
      // The fields themselves stay — the client can still type them.
      expect(screen.getByLabelText(/^SIC code/)).toBeInTheDocument();
    });
  });
});
