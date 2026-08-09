import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { NetworkTab } from '../src/pages/valuation/NetworkTab';
import type { Valuation } from '../src/lib/types';

vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', roles: ['admin'] } }),
}));

const valuation = {
  id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
  kind: '409a',
  state: 'review',
  company_name: 'Zorblatt Dynamics',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

const OK_ITEM = {
  id: '01JNETITEMAAAAAAAAAAAAAAAA',
  service: 'engine',
  name: 'engine compute',
  status: 200,
  error: null,
  duration_ms: 142,
  request_id: 'req-abc',
  created_at: '2026-07-01T10:00:00Z',
};

/** The row that matters: nothing else in the platform records this call. */
const TIMED_OUT_ITEM = {
  id: '01JNETITEMBBBBBBBBBBBBBBBB',
  service: 'ai-service',
  name: 'ai extract',
  status: null,
  error: 'did not respond within 120s',
  duration_ms: 120_004,
  request_id: 'req-def',
  created_at: '2026-07-01T09:00:00Z',
};

const PAGE = {
  items: [OK_ITEM, TIMED_OUT_ITEM],
  total: 2,
  page: 1,
  per_page: 50,
  counts: { engine: 1, 'ai-service': 1 },
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi(page: unknown = PAGE, detail?: unknown) {
  const calls: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    calls.push(path);
    if (/\/network-items\/[0-9A-Z]+/.test(path)) {
      return jsonResponse(
        detail ?? {
          item: {
            ...OK_ITEM,
            request: { params: { allocation_method: 'opm' }, inputs: { volatility: 0.6 } },
            response: { results: { fmv_per_share: 1.2 } },
          },
        },
      );
    }
    if (path.includes('/network-items')) return jsonResponse(page);
    throw new Error(`unexpected fetch ${path}`);
  });
  return { spy, calls };
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/network']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/network" element={<NetworkTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('NetworkTab', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists each call with its status and duration', async () => {
    mockApi();
    renderTab();
    expect(await screen.findByText('engine compute')).toBeTruthy();
    expect(screen.getByText('200')).toBeTruthy();
    expect(screen.getByText('142 ms')).toBeTruthy();
  });

  it('shows a call that never got a response as such, not as a status code', async () => {
    // A refused connection and our own deadline are both "no response", which
    // is a different failure from a 500 and the one worth spotting in a list.
    mockApi();
    renderTab();
    expect(await screen.findByText('no response')).toBeTruthy();
    expect(screen.getByText('did not respond within 120s')).toBeTruthy();
  });

  it('fetches the payloads only when a row is opened', async () => {
    const { calls } = mockApi();
    renderTab();
    await screen.findByText('engine compute');
    // The list carries no payloads — one compute request is the whole cap table.
    expect(calls.some((c) => /\/network-items\/[0-9A-Z]+/.test(c))).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: /engine compute/ }));
    await waitFor(() => expect(calls.some((c) => c.includes(`/network-items/${OK_ITEM.id}`))).toBe(true));
    expect(await screen.findByText(/allocation_method/)).toBeTruthy();
    expect(screen.getByText(/fmv_per_share/)).toBeTruthy();
  });

  it('offers a tab per tier with its own count', async () => {
    mockApi();
    renderTab();
    expect(await screen.findByRole('button', { name: 'All 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Engine 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'AI 1' })).toBeTruthy();
  });

  it('keeps every tier’s tab visible while filtered to one of them', async () => {
    // The counts are unfiltered server-side precisely so the strip does not
    // collapse to the tier being viewed.
    const { calls } = mockApi();
    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: 'Engine 1' }));
    await waitFor(() => expect(calls.some((c) => c.includes('service=engine'))).toBe(true));
    expect(screen.getByRole('button', { name: 'AI 1' })).toBeTruthy();
  });

  it('says the log is empty rather than rendering a bare table', async () => {
    mockApi({ items: [], total: 0, page: 1, per_page: 50, counts: {} });
    renderTab();
    expect(await screen.findByText(/No calls recorded yet/)).toBeTruthy();
  });

  it('surfaces a failed load instead of an endless spinner', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ title: 'Forbidden', detail: 'The network log is operations-only' }, 403),
    );
    renderTab();
    expect(await screen.findByText(/operations-only/)).toBeTruthy();
  });

  it('renders an unparseable upstream body as the raw text it was', async () => {
    // The response column is not always JSON — a proxy's HTML error page is
    // often the whole answer, and stringifying it would be noise.
    mockApi(PAGE, {
      item: { ...OK_ITEM, request: { a: 1 }, response: '<html>gateway error</html>' },
    });
    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: /engine compute/ }));
    const detail = await screen.findByText(/gateway error/);
    // Verbatim — not `"<html>gateway error</html>"`, which is what running it
    // through JSON.stringify would produce.
    expect(detail.textContent).toBe('<html>gateway error</html>');
  });
});
