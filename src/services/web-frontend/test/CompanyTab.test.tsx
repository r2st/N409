import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { CompanyTab } from '../src/pages/valuation/CompanyTab';
import type { Valuation } from '../src/lib/types';

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
  beforeEach(() => vi.restoreAllMocks());

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

  it('rejects an implausible headcount', async () => {
    const fetchSpy = mockApi(null);
    renderTab();
    await screen.findByLabelText('Employees');
    const before = fetchSpy.mock.calls.length;

    await userEvent.type(screen.getByLabelText('Employees'), '10000001');
    await userEvent.click(screen.getByRole('button', { name: /Save profile/i }));

    await screen.findByText('Employee count must be a whole number.');
    expect(fetchSpy.mock.calls).toHaveLength(before);
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
    await screen.findByText('Could not save the company profile.');
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
});
