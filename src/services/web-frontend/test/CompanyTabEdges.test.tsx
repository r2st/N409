import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { CompanyTab } from '../src/pages/valuation/CompanyTab';
import type { Valuation } from '../src/lib/types';

/**
 * The shapes CompanyTab.test.tsx does not send: a stored row that is mostly
 * null, an apply that holds fields back while the analyst has unsaved edits in
 * them, and the two states the drafting button spends its time in.
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

/** Every optional column null — a row created by the engagement, never edited. */
const BLANK_PROFILE = {
  valuation_id: valuation.id,
  legal_name: null,
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
  updated_at: '2026-07-01T00:00:00Z',
};

const STORED = {
  ...BLANK_PROFILE,
  industry: 'Freight logistics',
  business_description: 'Route-planning software.',
  sic_code: '7372',
  naics_code: '511210',
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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

describe('CompanyTab — a row with nothing in it', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    roles = ['admin'];
  });

  it('renders every field empty rather than as the string "null"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ profile: BLANK_PROFILE }));
    renderTab();

    expect(await screen.findByLabelText('Legal name')).toHaveValue('');
    for (const label of [
      'Website',
      'Industry',
      'Founded',
      'Employees',
      'Address line 1',
      'Address line 2',
      'City',
      'State / region',
      'Postal code',
      'Country',
    ]) {
      expect(screen.getByLabelText(label)).toHaveValue('');
    }
    expect(screen.getByLabelText(/^SIC code/)).toHaveValue('');
    expect(screen.getByLabelText(/^NAICS code/)).toHaveValue('');
    expect(screen.getByLabelText(/^Business description/)).toHaveValue('');
    expect(screen.getByLabelText(/^Summary/)).toHaveValue('');
    expect(screen.getByLabelText('Revenue range')).toHaveValue('');
  });

  it('saves a blank row back as nulls, not as empty strings', async () => {
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if ((init?.method ?? 'GET') !== 'GET') {
        bodies.push(String(init!.body));
        return jsonResponse({ profile: BLANK_PROFILE });
      }
      return jsonResponse({ profile: BLANK_PROFILE });
    });
    renderTab();

    await userEvent.type(await screen.findByLabelText('City'), '  Boston  ');
    await userEvent.click(screen.getByRole('button', { name: /Save profile/i }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    const sent = JSON.parse(bodies[0]!) as Record<string, unknown>;
    expect(sent.city).toBe('Boston'); // trimmed
    expect(sent.website).toBeNull();
    expect(sent.employee_count).toBeNull();
    expect(sent.revenue_range).toBeNull();
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('clears the saved marker as soon as a field is edited again', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ profile: BLANK_PROFILE }),
    );
    renderTab();

    await userEvent.click(await screen.findByRole('button', { name: /Save profile/i }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('City'), 'B');
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
  });

  it('surfaces a load failure instead of a form that would save over the row', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 500 }, 500));
    renderTab();

    expect(await screen.findByText('Could not load the company profile.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save profile/i })).not.toBeInTheDocument();
  });
});

describe('CompanyTab — what the apply is allowed to change', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    roles = ['admin'];
  });

  /** GET → `stored`; the run POST → {}; the apply POST → `applyBody`. */
  function mockAgent(stored: unknown, applyBody: unknown) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResponse({ profile: stored });
      if (String(url).includes('/apply')) return jsonResponse(applyBody);
      if (String(url).includes('/ai/company_profile')) return jsonResponse({});
      return jsonResponse({ profile: stored });
    });
  }

  /**
   * The overwrite box clear means "do not replace what is already there", and
   * an unsaved entry is what is already there as far as the analyst can see.
   * The server holds those fields back and says so; merging the whole stored
   * row back put the old value over the analyst's typing anyway, under a note
   * that read "Left alone: Industry (already filled in)".
   */
  it('does not overwrite a field the apply reports it held back', async () => {
    mockAgent(STORED, {
      profile: STORED,
      applied_fields: ['business_description'],
      skipped_fields: [
        { field: 'industry', reason: 'already_set' },
        { field: 'sic_code', reason: 'already_set' },
        { field: 'naics_code', reason: 'already_set' },
      ],
    });
    renderTab();

    const industry = await screen.findByLabelText('Industry');
    await userEvent.clear(industry);
    await userEvent.type(industry, 'Fintech — payments');
    const sic = screen.getByLabelText(/^SIC code/);
    await userEvent.clear(sic);
    await userEvent.type(sic, '6199');

    await userEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));
    await screen.findByText(/Drafted and saved/);

    // The one field the apply wrote is refreshed from the stored row…
    expect(screen.getByLabelText(/^Business description/)).toHaveValue('Route-planning software.');
    // …and the three it held back keep what the analyst had typed.
    expect(industry).toHaveValue('Fintech — payments');
    expect(sic).toHaveValue('6199');
    expect(screen.getByText(/Left alone/)).toHaveTextContent('Industry (already filled in)');
  });

  it('clears a written field when the apply stored a null for it', async () => {
    mockAgent(STORED, {
      profile: { ...STORED, naics_code: null },
      applied_fields: ['naics_code'],
      skipped_fields: [],
    });
    renderTab();

    await screen.findByRole('button', { name: 'Draft with AI' });
    await userEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));
    await screen.findByText(/Drafted and saved/);
    expect(screen.getByLabelText(/^NAICS code/)).toHaveValue('');
  });

  it('ignores a field name in applied_fields that is not one the agent writes', async () => {
    // The apply is the server's word on what it wrote, but the form only lets
    // it speak for its own four columns — a `legal_name` here must not become a
    // way for the apply response to rewrite the rest of the form.
    mockAgent(STORED, {
      profile: { ...STORED, legal_name: 'Rewritten, Inc.' },
      applied_fields: ['legal_name', 'industry'],
      skipped_fields: [],
    });
    renderTab();

    const legal = await screen.findByLabelText('Legal name');
    await userEvent.type(legal, 'Typed by hand');
    await userEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));
    await screen.findByText(/Drafted and saved/);

    expect(legal).toHaveValue('Typed by hand');
    expect(screen.getByLabelText('Industry')).toHaveValue('Freight logistics');
  });

  it('leaves the apply out of the unsaved-changes marker', async () => {
    // The apply already wrote the row, so the form must not then claim there is
    // something waiting on Save — nor keep a stale "Saved." from before it.
    mockAgent(BLANK_PROFILE, {
      profile: STORED,
      applied_fields: ['industry'],
      skipped_fields: [],
    });
    renderTab();

    await userEvent.click(await screen.findByRole('button', { name: /Save profile/i }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));
    await screen.findByText(/Drafted and saved/);
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
  });

  it('walks the button through both phases and back', async () => {
    let releaseRun: (() => void) | undefined;
    let releaseApply: (() => void) | undefined;
    const run = new Promise<void>((r) => (releaseRun = r));
    const apply = new Promise<void>((r) => (releaseApply = r));

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResponse({ profile: BLANK_PROFILE });
      if (String(url).includes('/apply')) {
        await apply;
        return jsonResponse({ profile: STORED, applied_fields: ['industry'], skipped_fields: [] });
      }
      await run;
      return jsonResponse({});
    });
    renderTab();

    await userEvent.click(await screen.findByRole('button', { name: 'Draft with AI' }));

    const reading = await screen.findByRole('button', { name: 'Reading documents…' });
    expect(reading).toBeDisabled();
    // The wait is long enough to be worth warning about while it is happening.
    expect(screen.getByText(/Free-tier models can take up to a minute/)).toBeInTheDocument();

    releaseRun!();
    expect(await screen.findByRole('button', { name: 'Applying…' })).toBeDisabled();
    expect(screen.queryByText(/Free-tier models can take up to a minute/)).not.toBeInTheDocument();

    releaseApply!();
    expect(await screen.findByRole('button', { name: 'Draft with AI' })).toBeEnabled();
  });

  it('reports the field name and reason verbatim when it does not recognise them', async () => {
    // A reason the front end has no phrase for is shown as it came rather than
    // dropped: an unexplained hold is worse than an ugly one.
    mockAgent(BLANK_PROFILE, {
      profile: STORED,
      applied_fields: ['industry'],
      skipped_fields: [{ field: 'sic_code', reason: 'rate_limited' }],
    });
    renderTab();

    await screen.findByRole('button', { name: 'Draft with AI' });
    await userEvent.click(screen.getByRole('button', { name: 'Draft with AI' }));
    const note = await screen.findByText(/Drafted and saved/);
    expect(note).toHaveTextContent('SIC code (rate_limited)');
  });

  it('shows the agent failure and re-enables the button', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResponse({ profile: BLANK_PROFILE });
      if (String(url).includes('/apply')) return jsonResponse({}, 200);
      return new Response(JSON.stringify({ status: 502, detail: 'The model was unreachable.' }), {
        status: 502,
        headers: { 'content-type': 'application/problem+json' },
      });
    });
    renderTab();

    await userEvent.click(await screen.findByRole('button', { name: 'Draft with AI' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The model was unreachable.');
    expect(screen.getByRole('button', { name: 'Draft with AI' })).toBeEnabled();
    expect(screen.queryByText(/Drafted and saved/)).not.toBeInTheDocument();
  });

  it('hides the drafting panel from a non-ops principal', async () => {
    roles = ['client'];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ profile: BLANK_PROFILE }));
    renderTab();

    // The tab itself stays editable — it is the AI routes that are ops-only.
    expect(await screen.findByLabelText('Legal name')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Draft with AI' })).not.toBeInTheDocument();
  });
});
