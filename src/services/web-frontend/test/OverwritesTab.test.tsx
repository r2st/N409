import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { OverwritesTab } from '../src/pages/valuation/OverwritesTab';
import type { Valuation } from '../src/lib/types';

/**
 * A manual override replaces an AI-extracted or computed value with an
 * analyst's own, and the whole feature rests on the original surviving: the
 * override, the value it displaced and the stated reason are what a reviewer
 * reconciles when they ask why the model disagrees with the workpapers.
 *
 * So the assertions worth having are about what reaches the server. A numeric
 * field must not send the string "1.2" (or, worse, a NaN from an empty box) —
 * `Number` is applied and refused before it leaves. An untouched "original
 * value" box must be omitted from the body rather than sent as an empty
 * string, because an empty string is a claim that the source value *was*
 * empty. And an edit of an existing override must not offer that box at all:
 * the original was captured the first time and re-stating it would overwrite
 * the audit trail with whatever the analyst types today.
 */

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'in_progress',
  company_name: 'Acme',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const FIELDS = [
  {
    key: 'revenue_ttm',
    category: 'financial_metrics',
    class: 'numeric' as const,
    label: 'Revenue (TTM)',
    description: 'Trailing twelve months revenue.',
    min: 0,
    max: 1_000_000_000,
    example: 2_500_000,
  },
  {
    key: 'headcount',
    category: 'financial_metrics',
    class: 'numeric' as const,
    label: 'Headcount',
    description: 'Full-time equivalents at the valuation date.',
    example: 42,
  },
  {
    key: 'incorporation_date',
    category: 'company_info',
    class: 'date' as const,
    label: 'Incorporation date',
    description: 'Date of incorporation per the charter.',
    example: '2020-01-01',
  },
  {
    key: 'state_of_incorporation',
    category: 'company_info',
    class: 'text' as const,
    label: 'State of incorporation',
    description: 'Delaware, etc.',
    example: 'DE',
  },
];

const SCHEMA = {
  categories: [
    { key: 'financial_metrics', field_count: 2 },
    { key: 'company_info', field_count: 2 },
  ],
  fields: FIELDS,
  total: 4,
};

const EXISTING = {
  id: 'o1',
  valuation_id: valuation.id,
  category: 'financial_metrics',
  field_key: 'revenue_ttm',
  class: 'numeric' as const,
  value: 3_100_000,
  original_value: 2_500_000,
  reason: 'Agreed to the audited statements.',
  created_by: 'u-ops',
  updated_by: 'u-ops',
  created_at: '2026-02-01T00:00:00.000Z',
  updated_at: '2026-02-02T09:30:00.000Z',
};

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function mockApi(
  opts: {
    schema?: () => Response;
    list?: () => Response;
    save?: () => Response;
    remove?: () => Response;
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
    if (/\/overwrites\/schema$/.test(url)) return opts.schema ? opts.schema() : json(SCHEMA);
    if (/\/overwrites\/[^/]+$/.test(url) && method === 'PUT') {
      return opts.save ? opts.save() : json({});
    }
    if (/\/overwrites\/[^/]+$/.test(url) && method === 'DELETE') {
      return opts.remove ? opts.remove() : json({});
    }
    if (/\/overwrites$/.test(url)) return opts.list ? opts.list() : json({ overwrites: [] });
    return json({});
  });
  return calls;
}

const problem = (status: number, detail: string) => () => json({ status, title: 'Error', detail }, status);

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/overwrites']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/overwrites" element={<OverwritesTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const ready = () => screen.findByText('Financial Metrics');
const row = (label: string) => screen.getByText(label).closest('li') as HTMLElement;
const lastPut = (calls: Call[]) => calls.filter((c) => c.method === 'PUT').at(-1)!;

/** Opens the override form on a field and returns its container. */
async function openForm(user: ReturnType<typeof userEvent.setup>, label: string, action = 'Override') {
  await user.click(within(row(label)).getByRole('button', { name: action }));
  return row(label);
}

describe('OverwritesTab', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('loading', () => {
    it('waits for the schema and the current overrides together', async () => {
      mockApi();
      renderTab();
      expect(screen.getByRole('status')).toBeInTheDocument();
      await ready();
    });

    it('reports a failed load rather than an empty field list', async () => {
      mockApi({ schema: problem(503, 'The overwrite schema is unavailable.') });
      renderTab();
      expect(await screen.findByRole('alert')).toHaveTextContent('The overwrite schema is unavailable.');
    });
  });

  describe('the field list', () => {
    it('groups fields under their category label, not the raw key', async () => {
      mockApi();
      renderTab();
      await ready();
      expect(screen.getByText('Financial Metrics')).toBeInTheDocument();
      expect(screen.getByText('Company Information')).toBeInTheDocument();
      expect(screen.queryByText('financial_metrics')).not.toBeInTheDocument();
    });

    it('counts how many fields are overridden, overall and per category', async () => {
      mockApi({ list: () => json({ overwrites: [EXISTING] }) });
      renderTab();
      await ready();
      expect(screen.getByText('1 of 4 overridden')).toBeInTheDocument();
      // Financial Metrics holds the one override; Company Information holds none.
      expect(screen.getByText('1 / 2 overridden')).toBeInTheDocument();
      expect(screen.getByText('0 / 2 overridden')).toBeInTheDocument();
    });

    it('names each field by label and by the key the API uses', async () => {
      mockApi();
      renderTab();
      await ready();
      const r = row('Revenue (TTM)');
      expect(within(r).getByText('revenue_ttm')).toBeInTheDocument();
      expect(within(r).getByText('Trailing twelve months revenue.')).toBeInTheDocument();
    });

    it('shows an un-overridden field as having no value of its own', async () => {
      mockApi();
      renderTab();
      await ready();
      expect(row('Headcount')).toHaveTextContent('—');
      expect(within(row('Headcount')).queryByRole('button', { name: 'Revert' })).not.toBeInTheDocument();
    });
  });

  describe('an existing override', () => {
    it('shows the new value over the struck-through original', async () => {
      // Both, together: the override alone is unreviewable, because the
      // question a reviewer asks is what it displaced.
      mockApi({ list: () => json({ overwrites: [EXISTING] }) });
      renderTab();
      await ready();
      const r = row('Revenue (TTM)');
      expect(within(r).getByText('3,100,000')).toBeInTheDocument();
      expect(within(r).getByText('2,500,000')).toBeInTheDocument();
    });

    it('carries the reason and when it was set', async () => {
      mockApi({ list: () => json({ overwrites: [EXISTING] }) });
      renderTab();
      await ready();
      expect(row('Revenue (TTM)')).toHaveTextContent('Agreed to the audited statements.');
    });

    it('is flagged, with the original and reason in the badge title', async () => {
      mockApi({ list: () => json({ overwrites: [EXISTING] }) });
      renderTab();
      await ready();
      expect(within(row('Revenue (TTM)')).getByText('overridden')).toHaveAttribute(
        'title',
        'Original: 2,500,000 · Reason: Agreed to the audited statements.',
      );
    });

    it('offers Edit rather than Override, and a way back', async () => {
      mockApi({ list: () => json({ overwrites: [EXISTING] }) });
      renderTab();
      await ready();
      expect(within(row('Revenue (TTM)')).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
      expect(within(row('Revenue (TTM)')).getByRole('button', { name: 'Revert' })).toBeInTheDocument();
    });

    it('shows an em dash for an original nobody recorded', async () => {
      mockApi({ list: () => json({ overwrites: [{ ...EXISTING, original_value: null, reason: null }] }) });
      renderTab();
      await ready();
      expect(within(row('Revenue (TTM)')).getByText('overridden')).toHaveAttribute('title', 'Original: —');
    });
  });

  describe('the override form', () => {
    it('opens and closes on the same control', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await openForm(user, 'Headcount');
      expect(within(row('Headcount')).getByLabelText(/^Reason/)).toBeInTheDocument();
      await user.click(within(row('Headcount')).getByRole('button', { name: 'Override' }));
      expect(within(row('Headcount')).queryByLabelText(/^Reason/)).not.toBeInTheDocument();
    });

    it('closes on Cancel', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await openForm(user, 'Headcount');
      await user.click(within(row('Headcount')).getByRole('button', { name: 'Cancel' }));
      expect(within(row('Headcount')).queryByLabelText(/^Reason/)).not.toBeInTheDocument();
    });

    it('states the range when the field has one, and an example when it does not', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await openForm(user, 'Revenue (TTM)');
      expect(within(row('Revenue (TTM)')).getByText('Range: 0 to 1000000000')).toBeInTheDocument();
      await openForm(user, 'Headcount');
      expect(within(row('Headcount')).getByText('e.g. 42')).toBeInTheDocument();
    });

    it('asks a date field for a date', async () => {
      const user = userEvent.setup();
      mockApi();
      renderTab();
      await ready();
      await openForm(user, 'Incorporation date');
      const r = row('Incorporation date');
      expect(within(r).getByText('YYYY-MM-DD')).toBeInTheDocument();
      expect(within(r).getByLabelText(/^Override value \(date\)/)).toHaveAttribute('type', 'date');
    });

    it('offers the original-value box only when there is no override yet', async () => {
      // Editing must not re-state the original: it was captured the first
      // time, and re-sending it would overwrite the audit trail with whatever
      // is typed today.
      const user = userEvent.setup();
      mockApi({ list: () => json({ overwrites: [EXISTING] }) });
      renderTab();
      await ready();
      await openForm(user, 'Revenue (TTM)', 'Edit');
      expect(within(row('Revenue (TTM)')).queryByLabelText(/^Original value/)).not.toBeInTheDocument();
      await openForm(user, 'Headcount');
      expect(within(row('Headcount')).getByLabelText(/^Original value/)).toBeInTheDocument();
    });

    it('starts an edit from the values already stored', async () => {
      const user = userEvent.setup();
      mockApi({ list: () => json({ overwrites: [EXISTING] }) });
      renderTab();
      await ready();
      await openForm(user, 'Revenue (TTM)', 'Edit');
      const r = row('Revenue (TTM)');
      expect(within(r).getByLabelText(/^Override value/)).toHaveValue('3100000');
      expect(within(r).getByLabelText(/^Reason/)).toHaveValue('Agreed to the audited statements.');
    });
  });

  describe('validation before anything is sent', () => {
    it('refuses an empty numeric field rather than sending NaN', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await openForm(user, 'Headcount');
      await user.click(within(row('Headcount')).getByRole('button', { name: 'Apply override' }));
      expect(within(row('Headcount')).getByRole('alert')).toHaveTextContent('Enter a number.');
      expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    });

    it('refuses a numeric field that is not a number', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await openForm(user, 'Headcount');
      await user.type(within(row('Headcount')).getByLabelText(/^Override value/), 'forty-two');
      await user.click(within(row('Headcount')).getByRole('button', { name: 'Apply override' }));
      expect(within(row('Headcount')).getByRole('alert')).toHaveTextContent('Enter a number.');
      expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    });

    it('refuses an empty text field', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await openForm(user, 'State of incorporation');
      await user.click(within(row('State of incorporation')).getByRole('button', { name: 'Apply override' }));
      expect(within(row('State of incorporation')).getByRole('alert')).toHaveTextContent('Enter a value.');
      expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    });

    it('refuses an original value that is not a number on a numeric field', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await openForm(user, 'Headcount');
      const r = row('Headcount');
      await user.type(within(r).getByLabelText(/^Override value/), '50');
      await user.type(within(r).getByLabelText(/^Original value/), 'about forty');
      await user.click(within(r).getByRole('button', { name: 'Apply override' }));
      expect(within(r).getByRole('alert')).toHaveTextContent('Original value must be a number.');
      expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    });
  });

  describe('what reaches the server', () => {
    it('sends a numeric override as a number', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await openForm(user, 'Headcount');
      await user.type(within(row('Headcount')).getByLabelText(/^Override value/), '50');
      await user.click(within(row('Headcount')).getByRole('button', { name: 'Apply override' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
      expect(lastPut(calls).body).toEqual({ value: 50 });
      expect(lastPut(calls).url).toMatch(/\/overwrites\/headcount$/);
    });

    it('omits a reason nobody gave rather than sending an empty one', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await openForm(user, 'Headcount');
      await user.type(within(row('Headcount')).getByLabelText(/^Override value/), '50');
      await user.type(within(row('Headcount')).getByLabelText(/^Reason/), '   ');
      await user.click(within(row('Headcount')).getByRole('button', { name: 'Apply override' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
      expect(lastPut(calls).body).not.toHaveProperty('reason');
    });

    it('omits an untouched original rather than claiming the source was empty', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await openForm(user, 'Headcount');
      await user.type(within(row('Headcount')).getByLabelText(/^Override value/), '50');
      await user.click(within(row('Headcount')).getByRole('button', { name: 'Apply override' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
      expect(lastPut(calls).body).not.toHaveProperty('original_value');
    });

    it('sends the reason and the original when both are given', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await openForm(user, 'Headcount');
      const r = row('Headcount');
      await user.type(within(r).getByLabelText(/^Override value/), '50');
      await user.type(within(r).getByLabelText(/^Original value/), '42');
      await user.type(within(r).getByLabelText(/^Reason/), '  Per the HR export.  ');
      await user.click(within(r).getByRole('button', { name: 'Apply override' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
      expect(lastPut(calls).body).toEqual({
        value: 50,
        reason: 'Per the HR export.',
        original_value: 42,
      });
    });

    it('sends a text override as the string it is, trimmed only where stated', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await openForm(user, 'State of incorporation');
      const r = row('State of incorporation');
      await user.type(within(r).getByLabelText(/^Override value/), 'DE');
      await user.type(within(r).getByLabelText(/^Original value/), '  CA  ');
      await user.click(within(r).getByRole('button', { name: 'Apply override' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
      expect(lastPut(calls).body).toEqual({ value: 'DE', original_value: 'CA' });
    });

    it('closes the form and re-reads the list once saved', async () => {
      const user = userEvent.setup();
      const calls = mockApi();
      renderTab();
      await ready();
      await openForm(user, 'Headcount');
      await user.type(within(row('Headcount')).getByLabelText(/^Override value/), '50');
      await user.click(within(row('Headcount')).getByRole('button', { name: 'Apply override' }));
      await waitFor(() =>
        expect(within(row('Headcount')).queryByLabelText(/^Reason/)).not.toBeInTheDocument(),
      );
      expect(calls.filter((c) => /\/overwrites$/.test(c.url))).toHaveLength(2);
    });

    it('reports a rejected save', async () => {
      const user = userEvent.setup();
      mockApi({ save: problem(422, 'Revenue must be at least 0.') });
      renderTab();
      await ready();
      await openForm(user, 'Headcount');
      await user.type(within(row('Headcount')).getByLabelText(/^Override value/), '-5');
      await user.click(within(row('Headcount')).getByRole('button', { name: 'Apply override' }));
      expect(await screen.findByText('Revenue must be at least 0.')).toBeInTheDocument();
    });
  });

  describe('reverting', () => {
    it('deletes the override and re-reads the list', async () => {
      const user = userEvent.setup();
      const calls = mockApi({ list: () => json({ overwrites: [EXISTING] }) });
      renderTab();
      await ready();
      await user.click(within(row('Revenue (TTM)')).getByRole('button', { name: 'Revert' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
      expect(calls.find((c) => c.method === 'DELETE')!.url).toMatch(/\/overwrites\/revenue_ttm$/);
      await waitFor(() => expect(calls.filter((c) => /\/overwrites$/.test(c.url))).toHaveLength(2));
    });

    it('reports a refused revert', async () => {
      const user = userEvent.setup();
      mockApi({
        list: () => json({ overwrites: [EXISTING] }),
        remove: problem(409, 'The valuation is locked.'),
      });
      renderTab();
      await ready();
      await user.click(within(row('Revenue (TTM)')).getByRole('button', { name: 'Revert' }));
      expect(await screen.findByText('The valuation is locked.')).toBeInTheDocument();
    });
  });
});
