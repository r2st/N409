import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { ParamsPanel } from '../src/components/valuation/ParamsPanel';
import { ReportTab } from '../src/pages/valuation/ReportTab';
import type { User, Valuation } from '../src/lib/types';

/**
 * R358, methodology M8 — two independent reads awaited one after the other.
 *
 * Both panels fill one screen from two documents of the same valuation, and in
 * neither case is the second request derived from the first one's answer: the
 * methodology panel reads `valuation_params` and the engine inputs beside it,
 * and the report tab reads the report body and — for ops, which is a prop known
 * before either request leaves — its version history. Awaiting them in turn
 * cost each panel two round trips to draw one screen.
 *
 * A duration is a property of the box, so these assert the shape instead: hold
 * the first response open and require the second request to have already been
 * issued. Serialised, it cannot have been.
 */

const VAL_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A promise plus the handles to settle it from the test body. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const PARAMS = {
  valuation_id: VAL_ID,
  allocation_method: 'pwerm',
  version: 3,
  updated_at: '2026-07-01T00:00:00Z',
};

describe('ParamsPanel — the two reads that fill the form', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('issues the engine-inputs read before the params read has answered', async () => {
    const held = deferred<Response>();
    const requested: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      requested.push(path);
      if (path.includes('/engine-inputs')) return json({ engine_inputs: {} });
      return held.promise;
    });

    render(<ParamsPanel valuationId={VAL_ID} readOnly={false} />);

    // The params read is still open; the engine-inputs read must already be out.
    await waitFor(() => expect(requested.some((p) => p.includes('/engine-inputs'))).toBe(true));
    expect(requested.some((p) => p.includes('/params'))).toBe(true);

    held.resolve(json({ params: PARAMS }));
    await screen.findByLabelText('Allocation method');
  });

  it('still reports a failed engine-inputs read when the params read succeeds', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/engine-inputs')) {
        return json({ status: 500, title: 'Error', detail: 'boom' }, 500);
      }
      return json({ params: PARAMS });
    });

    render(<ParamsPanel valuationId={VAL_ID} readOnly={false} />);
    expect(await screen.findByTestId('scenario-load-error')).toBeInTheDocument();
  });

  it('does not leave the engine-inputs rejection unhandled when params fails', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        json({ status: 500, title: 'Error', detail: 'boom' }, 500),
      );
      render(<ParamsPanel valuationId={VAL_ID} readOnly={false} />);
      expect(await screen.findByText(/could not load valuation params/i)).toBeInTheDocument();
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

const valuation = {
  id: VAL_ID,
  kind: '409a',
  state: 'complete',
  company_name: 'Acme Robotics, Inc.',
  user_id: 'u1',
  currency: 'USD',
} as unknown as Valuation;

let mockUser: User;
vi.mock('../src/lib/auth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

const opsUser = { id: 'u-ops', email: 'ops@example.com', roles: ['admin'] } as unknown as User;
const clientUser = { id: 'u-c', email: 'c@example.com', roles: ['client'] } as unknown as User;

const REPORT = {
  id: 'r1',
  valuation_id: VAL_ID,
  template_version: '409a.v12',
  status: 'draft' as const,
  current_version: 3,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
};

const CONTENT = {
  title: 'Acme Robotics — 409A Valuation',
  sections: [{ key: 'intro', heading: 'Introduction', html: '<p>Scope.</p>' }],
};

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/report']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/report" element={<ReportTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('ReportTab — the body and its version history', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUser = opsUser;
  });

  it('issues the versions read before the report body has answered', async () => {
    const held = deferred<Response>();
    const requested: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      requested.push(path);
      if (/\/report\/versions$/.test(path)) return json({ versions: [], truncated: false });
      if (/\/explanation$/.test(path)) return json({ explanation: null, model: null, generated_at: null });
      if (/\/report$/.test(path)) return held.promise;
      return json({});
    });

    renderTab();
    await waitFor(() => expect(requested.some((p) => /\/report\/versions$/.test(p))).toBe(true));

    held.resolve(json({ report: REPORT, version: { version: 3, content: CONTENT } }));
    await screen.findByTestId('report-outline');
  });

  it('asks for no version history at all for a client', async () => {
    mockUser = clientUser;
    const requested: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      requested.push(path);
      if (/\/explanation$/.test(path)) return json({ explanation: null, model: null, generated_at: null });
      if (/\/report$/.test(path)) return json({ report: REPORT, version: { version: 3, content: CONTENT } });
      return json({});
    });

    renderTab();
    await screen.findByTestId('report-outline');
    expect(requested.some((p) => /\/report\/versions$/.test(p))).toBe(false);
  });

  it('does not leave the versions rejection unhandled when the report 404s', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const path = String(url);
        if (/\/explanation$/.test(path)) return json({ explanation: null, model: null, generated_at: null });
        return json({ status: 404, title: 'Not Found', detail: 'no report' }, 404);
      });
      renderTab();
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
