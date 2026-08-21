import { describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { ComparablesTab } from '../src/pages/valuation/ComparablesTab';
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

type MultipleKey = 'ev_revenue_ltm' | 'ev_revenue_ntm' | 'ev_ebitda_ltm' | 'ev_ebitda_ntm';

/**
 * The wire shape of `GET /valuations/:id/comparables`. Spelled out here rather
 * than inferred from the fixture so a case can vary one nullable field — the
 * `figures_source` on an older row, a statistic with nothing retained — without
 * the fixture's own literal types calling it an error.
 */
interface Row {
  id: string;
  ticker: string | null;
  name: string;
  sic: string | null;
  source: string;
  included: boolean;
  exclude_reason: string | null;
  ev: number | null;
  revenue_ltm: number | null;
  revenue_ntm: number | null;
  ebitda_ltm: number | null;
  ebitda_ntm: number | null;
  score: number | null;
  multiples: Record<MultipleKey, number | null>;
  figures_source?: string | null;
  figures_as_of?: string | null;
}

interface Stat {
  key: MultipleKey;
  label: string;
  count: number;
  median: number | null;
  min: number | null;
  max: number | null;
}

interface Set {
  comparables: Row[];
  statistics: Record<MultipleKey, Stat>;
  primary_multiple: MultipleKey;
  market_method: string | null;
  market_horizon: string | null;
  can_edit: boolean;
}

const nullMultiples: Record<MultipleKey, number | null> = {
  ev_revenue_ltm: null,
  ev_revenue_ntm: null,
  ev_ebitda_ltm: null,
  ev_ebitda_ntm: null,
};

const SET: Set = {
  comparables: [
    {
      id: '01JCOMPAAAAAAAAAAAAAAAAAAA',
      ticker: 'AAA',
      name: 'Alpha Analytics',
      sic: '7372',
      source: 'market_feed',
      included: true,
      exclude_reason: null,
      ev: 1000,
      revenue_ltm: 100,
      revenue_ntm: null,
      ebitda_ltm: null,
      ebitda_ntm: null,
      score: 0.82,
      multiples: { ...nullMultiples, ev_revenue_ltm: 10 },
    },
    {
      id: '01JCOMPBBBBBBBBBBBBBBBBBBB',
      ticker: 'BBB',
      name: 'Beta Systems',
      sic: '7372',
      source: 'analyst',
      included: true,
      exclude_reason: null,
      ev: 1400,
      revenue_ltm: 100,
      revenue_ntm: null,
      ebitda_ltm: null,
      ebitda_ntm: null,
      score: null,
      multiples: { ...nullMultiples, ev_revenue_ltm: 14 },
    },
    {
      id: '01JCOMPZZZZZZZZZZZZZZZZZZZ',
      ticker: 'ZZZ',
      name: 'Zeta Mining',
      sic: '1000',
      source: 'market_feed',
      included: false,
      exclude_reason: 'different industry',
      ev: null,
      revenue_ltm: null,
      revenue_ntm: null,
      ebitda_ltm: null,
      ebitda_ntm: null,
      score: 0.05,
      multiples: { ...nullMultiples },
    },
  ],
  statistics: {
    ev_revenue_ltm: {
      key: 'ev_revenue_ltm',
      label: 'EV/LTM Revenue',
      count: 2,
      median: 12,
      min: 10,
      max: 14,
    },
    ev_revenue_ntm: {
      key: 'ev_revenue_ntm',
      label: 'EV/NTM Revenue',
      count: 0,
      median: null,
      min: null,
      max: null,
    },
    ev_ebitda_ltm: {
      key: 'ev_ebitda_ltm',
      label: 'EV/LTM EBITDA',
      count: 0,
      median: null,
      min: null,
      max: null,
    },
    ev_ebitda_ntm: {
      key: 'ev_ebitda_ntm',
      label: 'EV/NTM EBITDA',
      count: 0,
      median: null,
      min: null,
      max: null,
    },
  },
  primary_multiple: 'ev_revenue_ltm',
  market_method: 'revenue',
  market_horizon: 'ltm',
  can_edit: true,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi(over: Partial<Set> = {}, onWrite?: (path: string, init: RequestInit) => Response) {
  const body = { ...SET, ...over };
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      return onWrite ? onWrite(path, init!) : jsonResponse({});
    }
    if (path.includes('/comparables')) return jsonResponse(body);
    throw new Error(`unexpected fetch ${path}`);
  });
}

const problem = (detail: string, status = 422) =>
  new Response(JSON.stringify({ title: 'Unprocessable', status, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/comparables']}>
      <Routes>
        <Route element={<Outlet context={{ valuation, reload: async () => {} }} />}>
          <Route path="/comparables" element={<ComparablesTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('ComparablesTab', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists the peer set with each row’s source', async () => {
    mockApi();
    renderTab();
    expect(await screen.findByText('Alpha Analytics')).toBeInTheDocument();
    expect(screen.getByText('Beta Systems')).toBeInTheDocument();
    expect(screen.getByText('Analyst')).toBeInTheDocument();
  });

  /**
   * The excluded row is the point of the whole surface: it has to stay visible,
   * with the reason, or the tab is just a prettier version of the aggregate the
   * platform already stored.
   */
  it('keeps an excluded company on screen with the reason it was set aside', async () => {
    mockApi();
    renderTab();
    expect(await screen.findByText('Zeta Mining')).toBeInTheDocument();
    expect(screen.getByText(/Excluded — different industry/)).toBeInTheDocument();
  });

  it('names the multiple the market approach will strike, and its median', async () => {
    mockApi();
    renderTab();
    expect(await screen.findByText(/EV\/LTM Revenue — median/)).toBeInTheDocument();
    expect(screen.getByText('12.00x')).toBeInTheDocument();
    expect(screen.getByText(/2 of 3 companies/)).toBeInTheDocument();
  });

  it('shows only the multiples the retained set actually has', async () => {
    mockApi();
    renderTab();
    await screen.findByText('Alpha Analytics');
    const table = screen.getByRole('table', { name: 'Comparable companies' });
    expect(table).toHaveTextContent('EV/LTM Rev');
    // No retained comp reports EBITDA, so that column would be all dashes.
    expect(table).not.toHaveTextContent('EV/LTM EBITDA');
  });

  it('will not send an exclusion until a reason is given', async () => {
    const sent: Array<Record<string, unknown>> = [];
    mockApi({}, (_path, init) => {
      sent.push(JSON.parse(String(init.body)));
      return jsonResponse({});
    });
    renderTab();
    await screen.findByText('Alpha Analytics');

    await userEvent.click(screen.getAllByRole('button', { name: 'Exclude' })[0]!);
    const reason = await screen.findByLabelText(/why is this company not comparable/i);
    // Submitting empty never reaches the network — and since R29 it says why
    // rather than silently doing nothing.
    await userEvent.click(screen.getAllByRole('button', { name: 'Exclude' }).at(-1)!);
    expect(sent).toHaveLength(0);
    expect(await screen.findByText('A reason is required.')).toBeInTheDocument();

    await userEvent.type(reason, 'acquired mid-period');
    await userEvent.click(screen.getAllByRole('button', { name: 'Exclude' }).at(-1)!);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ included: false, exclude_reason: 'acquired mid-period' });
  });

  /** A screened row is excluded, never deleted — so it offers no Remove. */
  it('offers Remove on analyst rows only', async () => {
    mockApi();
    renderTab();
    await screen.findByText('Alpha Analytics');
    const removes = screen.getAllByRole('button', { name: 'Remove' });
    expect(removes).toHaveLength(1);
  });

  it('hides every edit control from a reader who cannot edit', async () => {
    mockApi({ can_edit: false });
    renderTab();
    await screen.findByText('Alpha Analytics');
    expect(screen.queryByRole('button', { name: 'Re-screen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Exclude' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add peer' })).not.toBeInTheDocument();
  });

  it('explains the fallback when nothing has been screened', async () => {
    mockApi({ comparables: [] });
    renderTab();
    expect(await screen.findByText('No comparables recorded')).toBeInTheDocument();
    expect(screen.getByText(/AI comp-selection run/)).toBeInTheDocument();
  });

  it('puts an excluded row back with one click', async () => {
    const sent: Array<{ path: string; method: string; body: unknown }> = [];
    mockApi({}, (path, init) => {
      sent.push({ path, method: String(init.method), body: JSON.parse(String(init.body)) });
      return jsonResponse({});
    });
    renderTab();
    await screen.findByText('Zeta Mining');

    await userEvent.click(screen.getByRole('button', { name: 'Include' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe('PATCH');
    expect(sent[0]!.path).toContain('01JCOMPZZZZZZZZZZZZZZZZZZZ');
    expect(sent[0]!.body).toEqual({ included: true });
  });

  it('deletes only the analyst row it was asked to remove', async () => {
    const sent: Array<{ path: string; method: string }> = [];
    mockApi({}, (path, init) => {
      sent.push({ path, method: String(init.method) });
      return jsonResponse({});
    });
    renderTab();
    await screen.findByText('Beta Systems');

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe('DELETE');
    expect(sent[0]!.path).toContain('01JCOMPBBBBBBBBBBBBBBBBBBB');
  });

  it('re-screens the set against the reference universe', async () => {
    const sent: string[] = [];
    mockApi({}, (path) => {
      sent.push(path);
      return jsonResponse({});
    });
    renderTab();
    await screen.findByText('Alpha Analytics');

    await userEvent.click(screen.getByRole('button', { name: 'Re-screen' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toContain('/comparables/screen');
  });

  /**
   * The refresh reports per ticker rather than collapsing to one error line: a
   * feed that reached nothing is not a failure, but an analyst who is not told
   * would believe they are now reading observed market data.
   */
  it('reports a wholly successful market refresh as a count', async () => {
    mockApi({}, (path) => {
      if (path.includes('/refresh')) {
        return jsonResponse({
          refreshed: [{ ticker: 'AAA', as_of: '2026-08-01' }],
          unavailable: [],
        });
      }
      return jsonResponse({});
    });
    renderTab();
    await screen.findByText('Alpha Analytics');

    await userEvent.click(screen.getByRole('button', { name: 'Refresh from market' }));
    expect(await screen.findByText('Refreshed 1 company from observed market data.')).toBeInTheDocument();
  });

  it('names the tickers a refresh could not reach, and says their figures stand', async () => {
    mockApi({}, (path) => {
      if (path.includes('/refresh')) {
        return jsonResponse({
          refreshed: [{ ticker: 'AAA', as_of: '2026-08-01' }],
          unavailable: [
            { ticker: 'BBB', warning: 'no quote' },
            { ticker: 'ZZZ', warning: 'delisted' },
          ],
        });
      }
      return jsonResponse({});
    });
    renderTab();
    await screen.findByText('Alpha Analytics');

    await userEvent.click(screen.getByRole('button', { name: 'Refresh from market' }));
    const note = await screen.findByText(/Refreshed 1 of 3\./);
    expect(note).toHaveTextContent('No live figures for BBB, ZZZ');
    expect(note).toHaveTextContent('those rows keep the figures they had');
  });

  it('adds a peer by hand, sending blank optional fields as null', async () => {
    const sent: Array<Record<string, unknown>> = [];
    mockApi({}, (path, init) => {
      if (init.method === 'POST' && path.endsWith('/comparables')) {
        sent.push(JSON.parse(String(init.body)));
      }
      return jsonResponse({});
    });
    renderTab();
    await screen.findByText('Alpha Analytics');

    await userEvent.click(screen.getByRole('button', { name: '+ Add peer' }));
    await userEvent.type(screen.getByLabelText('Company name'), 'Gamma Robotics');
    await userEvent.type(screen.getByLabelText('Enterprise value'), '2,400');
    await userEvent.click(screen.getByRole('button', { name: 'Add comparable' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      ticker: null,
      name: 'Gamma Robotics',
      sic: null,
      ev: 2400,
      revenue_ltm: null,
      ebitda_ltm: null,
    });
  });

  /** A figure that is not a number is "not known", never NaN on the wire. */
  it('sends an unparseable figure as null rather than NaN', async () => {
    const sent: Array<Record<string, unknown>> = [];
    mockApi({}, (path, init) => {
      if (init.method === 'POST' && path.endsWith('/comparables')) {
        sent.push(JSON.parse(String(init.body)));
      }
      return jsonResponse({});
    });
    renderTab();
    await screen.findByText('Alpha Analytics');

    await userEvent.click(screen.getByRole('button', { name: '+ Add peer' }));
    await userEvent.type(screen.getByLabelText('Company name'), 'Delta Corp');
    await userEvent.type(screen.getByLabelText('LTM revenue'), 'n/a');
    await userEvent.click(screen.getByRole('button', { name: 'Add comparable' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.revenue_ltm).toBeNull();
  });

  it('keeps the add form open, with its draft, when the write is rejected', async () => {
    mockApi({}, (path, init) =>
      init.method === 'POST' && path.endsWith('/comparables')
        ? problem('A comparable named Gamma Robotics is already in this set.')
        : jsonResponse({}),
    );
    renderTab();
    await screen.findByText('Alpha Analytics');

    await userEvent.click(screen.getByRole('button', { name: '+ Add peer' }));
    await userEvent.type(screen.getByLabelText('Company name'), 'Gamma Robotics');
    await userEvent.click(screen.getByRole('button', { name: 'Add comparable' }));

    expect(
      await screen.findByText('A comparable named Gamma Robotics is already in this set.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Company name')).toHaveValue('Gamma Robotics');
  });

  it('keeps the exclusion form open, with its reason, when the write is rejected', async () => {
    mockApi({}, () => problem('This valuation is published and cannot be edited.', 409));
    renderTab();
    await screen.findByText('Alpha Analytics');

    await userEvent.click(screen.getAllByRole('button', { name: 'Exclude' })[0]!);
    await userEvent.type(await screen.findByLabelText(/why is this company not comparable/i), 'acquired');
    await userEvent.click(screen.getAllByRole('button', { name: 'Exclude' }).at(-1)!);

    expect(await screen.findByText('This valuation is published and cannot be edited.')).toBeInTheDocument();
    expect(screen.getByLabelText(/why is this company not comparable/i)).toHaveValue('acquired');
  });

  it('abandons a half-typed exclusion on Cancel', async () => {
    mockApi();
    renderTab();
    await screen.findByText('Alpha Analytics');

    await userEvent.click(screen.getAllByRole('button', { name: 'Exclude' })[0]!);
    await userEvent.type(await screen.findByLabelText(/why is this company not comparable/i), 'oops');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText(/why is this company not comparable/i)).not.toBeInTheDocument();
  });

  /**
   * `source` is who put the row in the set; `figures_source` is where its
   * numbers came from. A multiple cannot be checked without both, and a row
   * written before the columns existed says nothing rather than guessing.
   */
  it('marks where each row’s figures came from, and stays silent on older rows', async () => {
    mockApi({
      comparables: [
        { ...SET.comparables[0]!, figures_source: 'live', figures_as_of: '2026-08-01T00:00:00Z' },
        { ...SET.comparables[1]!, figures_source: null, figures_as_of: null },
      ],
    });
    renderTab();
    await screen.findByText('Alpha Analytics');

    const market = screen.getByText('Market');
    expect(market).toHaveAttribute('title', 'Figures as at 2026-08-01');
    expect(screen.queryByText('Reference')).not.toBeInTheDocument();
    expect(screen.queryByText('Entered')).not.toBeInTheDocument();
  });

  it('renders an unrecognised figures source verbatim rather than dropping it', async () => {
    mockApi({
      comparables: [{ ...SET.comparables[0]!, figures_source: 'estimate', figures_as_of: null }],
    });
    renderTab();
    await screen.findByText('Alpha Analytics');
    expect(screen.getByText('estimate')).toBeInTheDocument();
  });

  it('shows the load failure instead of an endless spinner', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('/comparables')
        ? problem('You do not have access to this valuation.', 403)
        : jsonResponse({}),
    );
    renderTab();
    expect(await screen.findByText('You do not have access to this valuation.')).toBeInTheDocument();
  });

  it('falls back to a plain message when the load fails without a problem body', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    renderTab();
    expect(await screen.findByText('Could not load the comparable set.')).toBeInTheDocument();
  });

  it('falls back to a plain message when a write fails without a problem body', async () => {
    let loaded = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') !== 'GET') throw new TypeError('network down');
      if (String(url).includes('/comparables')) {
        loaded = true;
        return jsonResponse(SET);
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    renderTab();
    await screen.findByText('Alpha Analytics');
    expect(loaded).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Re-screen' }));
    expect(await screen.findByText('Could not re-screen the comparable set.')).toBeInTheDocument();
  });

  it('states the spread beside the median, and omits it when nothing was retained', async () => {
    mockApi();
    renderTab();
    await screen.findByText('Alpha Analytics');
    expect(screen.getByText(/10\.00x–14\.00x/)).toBeInTheDocument();

    cleanup();
    mockApi({
      statistics: {
        ...SET.statistics,
        ev_revenue_ltm: {
          key: 'ev_revenue_ltm',
          label: 'EV/LTM Revenue',
          count: 0,
          median: null,
          min: null,
          max: null,
        },
      },
    });
    renderTab();
    await screen.findByText('Alpha Analytics');
    expect(screen.getByText(/0 of 3 companies/)).toBeInTheDocument();
    expect(screen.queryByText(/x–/)).not.toBeInTheDocument();
  });

  /**
   * R29 — both forms here relied on the browser for their one required box,
   * which refuses the submit with a tooltip on the control and nothing in the
   * page. The exclusion reason is the one that matters: it is what an auditor
   * reads to understand why a peer was dropped from the set.
   */
  it('names the empty company name rather than refusing the add silently', async () => {
    const sent: Array<Record<string, unknown>> = [];
    mockApi({}, (path, init) => {
      if (init.method === 'POST' && path.endsWith('/comparables')) {
        sent.push(JSON.parse(String(init.body)));
      }
      return jsonResponse({});
    });
    renderTab();
    await screen.findByText('Alpha Analytics');

    await userEvent.click(screen.getByRole('button', { name: '+ Add peer' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add comparable' }));

    expect(await screen.findByText('Company name is required.')).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });

  it('treats a whitespace-only company name as no name', async () => {
    const sent: Array<Record<string, unknown>> = [];
    mockApi({}, (path, init) => {
      if (init.method === 'POST' && path.endsWith('/comparables')) {
        sent.push(JSON.parse(String(init.body)));
      }
      return jsonResponse({});
    });
    renderTab();
    await screen.findByText('Alpha Analytics');

    await userEvent.click(screen.getByRole('button', { name: '+ Add peer' }));
    await userEvent.type(screen.getByLabelText('Company name'), '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Add comparable' }));

    expect(await screen.findByText('Company name is required.')).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });

  it('clears the name message as soon as a name is typed', async () => {
    mockApi();
    renderTab();
    await screen.findByText('Alpha Analytics');

    await userEvent.click(screen.getByRole('button', { name: '+ Add peer' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add comparable' }));
    expect(await screen.findByText('Company name is required.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Company name'), 'Delta Corp');
    expect(screen.queryByText('Company name is required.')).not.toBeInTheDocument();
  });

  /**
   * R33 — the `comp_selection` agent and its apply endpoint both shipped API-only,
   * so the agent's set could only reach the peer set through a hand-written POST.
   * These cover the button that closed that.
   */
  describe('AI peer discovery', () => {
    /** Run then apply, in that order: applying without running would take
     *  whatever earlier run happened to be the latest successful one. */
    it('runs the agent and then applies its set', async () => {
      const posts: string[] = [];
      mockApi({}, (path) => {
        posts.push(path);
        return path.includes('/apply')
          ? jsonResponse({ applied: { selected: 6, excluded: 3, unusable: 0 }, written: 9 })
          : jsonResponse({});
      });
      renderTab();
      await screen.findByText('Alpha Analytics');

      await userEvent.click(screen.getByRole('button', { name: 'Find peers with AI' }));
      await waitFor(() => expect(posts).toHaveLength(2));
      expect(posts[0]).toMatch(/\/ai\/comp_selection$/);
      expect(posts[1]).toMatch(/\/ai\/comp_selection\/apply$/);
    });

    it('reports what landed and what was set aside', async () => {
      mockApi({}, (path) =>
        path.includes('/apply')
          ? jsonResponse({ applied: { selected: 6, excluded: 3, unusable: 0 }, written: 9 })
          : jsonResponse({}),
      );
      renderTab();
      await screen.findByText('Alpha Analytics');

      await userEvent.click(screen.getByRole('button', { name: 'Find peers with AI' }));
      expect(
        await screen.findByText('Applied the AI peer set — 6 companies included, 3 set aside.'),
      ).toBeInTheDocument();
    });

    /**
     * The unpriced count is called out separately because a comp the agent
     * *chose* and the market data could not price is set aside for a different
     * reason from one the agent rejected — and only the second is a judgement.
     */
    it('calls out the comps it chose but could not price', async () => {
      mockApi({}, (path) =>
        path.includes('/apply')
          ? jsonResponse({ applied: { selected: 1, excluded: 4, unusable: 2 }, written: 5 })
          : jsonResponse({}),
      );
      renderTab();
      await screen.findByText('Alpha Analytics');

      await userEvent.click(screen.getByRole('button', { name: 'Find peers with AI' }));
      const note = await screen.findByText(/Applied the AI peer set/);
      // Singular, because one company landed.
      expect(note).toHaveTextContent('1 company included, 4 set aside');
      expect(note).toHaveTextContent('2 of those chosen by the agent but carrying no market figures');
    });

    /**
     * A failed run must not fall through to the apply: that endpoint takes the
     * latest *successful* run, so it would silently write a set from some
     * earlier day that the analyst never asked for.
     */
    it('does not apply when the agent run fails', async () => {
      const posts: string[] = [];
      mockApi({}, (path) => {
        posts.push(path);
        return problem('The "comp_selection" agent is disabled');
      });
      renderTab();
      await screen.findByText('Alpha Analytics');

      await userEvent.click(screen.getByRole('button', { name: 'Find peers with AI' }));
      expect(await screen.findByText('The "comp_selection" agent is disabled')).toBeInTheDocument();
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatch(/\/ai\/comp_selection$/);
    });

    /** The 422 the apply raises when the run named nothing storable. */
    it('surfaces an apply that had nothing to write', async () => {
      mockApi({}, (path) =>
        path.includes('/apply')
          ? problem(
              'That comparable-selection run named no company with a ticker — re-run the agent, or add comps by hand',
            )
          : jsonResponse({}),
      );
      renderTab();
      await screen.findByText('Alpha Analytics');

      await userEvent.click(screen.getByRole('button', { name: 'Find peers with AI' }));
      expect(await screen.findByText(/named no company with a ticker/)).toBeInTheDocument();
    });

    it('falls back to a plain message when the agent fails without a problem body', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if ((init?.method ?? 'GET') !== 'GET') throw new TypeError('network down');
        if (String(url).includes('/comparables')) return jsonResponse(SET);
        throw new Error(`unexpected fetch ${String(url)}`);
      });
      renderTab();
      await screen.findByText('Alpha Analytics');

      await userEvent.click(screen.getByRole('button', { name: 'Find peers with AI' }));
      expect(await screen.findByText('Could not run the AI comparable agent.')).toBeInTheDocument();
    });

    /** Same ops-only gate the endpoints enforce — `can_edit` is `isOps`. */
    it('is hidden from a reader who cannot edit', async () => {
      mockApi({ can_edit: false });
      renderTab();
      await screen.findByText('Alpha Analytics');
      expect(screen.queryByRole('button', { name: 'Find peers with AI' })).not.toBeInTheDocument();
    });
  });
});
