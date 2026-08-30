import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalculationPanel } from '../src/components/valuation/CalculationPanel';
import type { Calculation } from '../src/lib/pipeline';

/**
 * The calculation panel's history and its per-approach recalculation.
 *
 * `CalculationPreflight.test.tsx` covers the dry run and the field issues a
 * rejected compute carries. This covers the rest of the panel: the run list
 * with a failure in it, the recalculate-one-approach strip, the inspector
 * toggle, and every place a result document arrives with a key missing —
 * which is the ordinary case for an older run, not a corrupt one.
 */

const VALUATION_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';

const SUCCEEDED: Calculation = {
  id: 'c-latest',
  valuation_id: VALUATION_ID,
  engine_version: 'py-1.0.0',
  status: 'succeeded',
  inputs: {},
  results: {
    approaches: {
      income: { equity_value: 12_000_000, weight: 0.6 },
      market: { equity_value: 9_000_000, weight: 0.4, reused: true },
    },
    discounts: { dloc: 0.1, dlom: 0.25, dlom_method: 'finnerty' },
    assumptions: { time_to_exit_years: 3, volatility: 0.6, risk_free_rate: 0.042 },
  },
  equity_value: '12000000',
  fmv_per_share: '1.2',
  error: null,
  diagnostics: [],
  created_at: '2026-07-01T00:00:00Z',
};

const FAILED: Calculation = {
  ...SUCCEEDED,
  id: 'c-failed',
  status: 'failed',
  results: {},
  equity_value: null,
  fmv_per_share: null,
  error: 'engine timed out after 30s',
  created_at: '2026-07-02T00:00:00Z',
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi(
  opts: {
    calculations?: Calculation[];
    /** Thrown (network-level) or returned (problem+json) by the compute POST. */
    compute?: { status: number; body: unknown } | 'network';
    listStatus?: number;
  } = {},
) {
  const posts: Array<{ url: string; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    // The step inspector, opened from a history row.
    if (/\/calculations\/c-[a-z]+$/.test(path))
      return jsonResponse({
        calculation: SUCCEEDED,
        steps: [],
        traced: true,
        request: {},
        response: {},
      });
    if (init?.method === 'POST') {
      posts.push({ url: path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (opts.compute === 'network') throw new TypeError('network down');
      const { status, body } = opts.compute ?? { status: 201, body: { calculation: SUCCEEDED } };
      return jsonResponse(body, status);
    }
    if (opts.listStatus) return jsonResponse({ status: opts.listStatus }, opts.listStatus);
    return jsonResponse({ calculations: opts.calculations ?? [] });
  });
  return posts;
}

const renderPanel = () => render(<CalculationPanel valuationId={VALUATION_ID} currency="USD" />);

describe('CalculationPanel — the list failing to load', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('says so rather than spinning forever', async () => {
    mockApi({ listStatus: 500 });
    renderPanel();

    expect(await screen.findByText('Could not load calculations.')).toBeInTheDocument();
    // The spinner is gone: the panel decided, it did not stall.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    // And the controls are still there, so the run can be retried.
    expect(screen.getByRole('button', { name: 'Run calculation' })).toBeEnabled();
  });
});

describe('CalculationPanel — a run that fails without field issues', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the server’s own message when there is one', async () => {
    mockApi({
      compute: { status: 502, body: { status: 502, title: 'Bad Gateway', detail: 'the engine is down' } },
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Run calculation' }));

    expect(await screen.findByText('the engine is down')).toBeInTheDocument();
    // No input-check panel: the failure was not about the inputs, and showing
    // an empty one would say the engine had looked at them.
    expect(screen.queryByText('Input check')).not.toBeInTheDocument();
  });

  it('falls back to its own wording when the request never reached the server', async () => {
    mockApi({ compute: 'network' });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Run calculation' }));

    expect(await screen.findByText(/Computation failed\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run calculation' })).toBeEnabled());
  });

  it('reports a pre-flight check the server refuses', async () => {
    // The preflight endpoint is a POST like the compute, so the same failure
    // routes to it — this asserts the check has its own wording.
    mockApi({ compute: 'network' });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Check inputs' }));

    expect(await screen.findByText(/Could not check the inputs\./)).toBeInTheDocument();
  });
});

describe('CalculationPanel — recalculating one approach', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('offers only the approaches carried by the latest run', async () => {
    mockApi({ calculations: [SUCCEEDED] });
    renderPanel();

    await screen.findByText('Approach breakdown');
    // income and market are in the latest results; asset and OPM are not.
    expect(screen.getByRole('button', { name: '↻ DCF' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '↻ Market' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '↻ Asset' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '↻ OPM' })).toHaveAttribute(
      'title',
      'The OPM approach has no weight in the latest run',
    );
  });

  it('names the approach in the POST, and only that one', async () => {
    const posts = mockApi({ calculations: [SUCCEEDED] });
    renderPanel();

    await screen.findByText('Approach breakdown');
    await userEvent.click(screen.getByRole('button', { name: '↻ DCF' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    // 'income' is the engine key behind the DCF label — the mapping is the
    // whole reason the button carries a different word from the payload.
    expect(posts[0]!.body).toEqual({ inputs: {}, approach: 'income' });
  });

  it('badges the approaches that were carried over rather than recomputed', async () => {
    mockApi({ calculations: [SUCCEEDED] });
    renderPanel();

    await screen.findByText('Approach breakdown');
    const marketRow = screen.getByText('Market (comps)').closest('tr')!;
    expect(marketRow).toHaveTextContent('reused');
    expect(screen.getByText('Income (DCF)').closest('tr')!).not.toHaveTextContent('reused');
  });
});

describe('CalculationPanel — a result document with keys missing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an approach the labels do not know, saying only what it knows', async () => {
    mockApi({
      calculations: [
        {
          ...SUCCEEDED,
          results: {
            // An approach key added engine-side that this build has no label
            // for, carrying neither a weight nor an equity value.
            approaches: { replacement_cost: {} },
          },
        },
      ],
    });
    renderPanel();

    await screen.findByText('Approach breakdown');
    const row = screen.getByText('replacement_cost').closest('tr')!;
    // No weight is a weight of nothing, which is true. No value is not a value
    // of nothing — the run reached no conclusion for this approach, and "$0.00"
    // said it reached one.
    expect(row).toHaveTextContent('0%');
    expect(row).toHaveTextContent('—');
    expect(row).not.toHaveTextContent('$0.00');
  });

  it('shows an em dash for a DLOM the run did not record', async () => {
    mockApi({
      calculations: [{ ...SUCCEEDED, results: { approaches: {}, discounts: { dloc: 0.1 } } }],
    });
    renderPanel();

    await screen.findByText('Approach breakdown');
    const dlom = screen.getByText('DLOM applied').parentElement!;
    expect(dlom).toHaveTextContent('—');
  });

  it('shows an em dash for a volatility the engine left null', async () => {
    mockApi({
      calculations: [
        {
          ...SUCCEEDED,
          results: {
            ...SUCCEEDED.results,
            assumptions: { time_to_exit_years: 3, volatility: null, risk_free_rate: 0.042 },
          },
        },
      ],
    });
    renderPanel();

    expect(await screen.findByText(/σ = —/)).toBeInTheDocument();
  });

  it('shows no review section for a run whose diagnostics key is absent', async () => {
    const { diagnostics: _omitted, ...withoutDiagnostics } = SUCCEEDED;
    mockApi({ calculations: [withoutDiagnostics as Calculation] });
    renderPanel();

    await screen.findByText('Approach breakdown');
    expect(screen.queryByText('Review points from the latest run')).not.toBeInTheDocument();
  });
});

describe('CalculationPanel — the run history', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('carries a failed run’s own error in place of a value', async () => {
    mockApi({ calculations: [FAILED, SUCCEEDED] });
    renderPanel();

    expect(await screen.findByText('engine timed out after 30s')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    // The successful run below it is still the one the summary is drawn from.
    expect(screen.getByText('Approach breakdown')).toBeInTheDocument();
  });

  it('says “failed” when the failure carries no message at all', async () => {
    mockApi({ calculations: [{ ...FAILED, error: null }] });
    renderPanel();

    // Twice: the status badge and the value column, which is the point —
    // a blank value column reads as a run that produced nothing yet.
    await waitFor(() => expect(screen.getAllByText('failed')).toHaveLength(2));
  });

  it('badges a per-approach recalculation with the approaches it redid', async () => {
    mockApi({
      calculations: [{ ...SUCCEEDED, results: { ...SUCCEEDED.results, recomputed: ['income', 'market'] } }],
    });
    renderPanel();

    expect(await screen.findByText('recalc: income, market')).toBeInTheDocument();
  });

  it('opens one run’s steps at a time, and closes the one that is open', async () => {
    mockApi({ calculations: [SUCCEEDED] });
    const user = userEvent.setup();
    renderPanel();

    const toggle = await screen.findByRole('button', { name: 'Inspect steps' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    const open = await screen.findByRole('button', { name: 'Hide steps' });
    expect(open).toHaveAttribute('aria-expanded', 'true');

    await user.click(open);
    expect(await screen.findByRole('button', { name: 'Inspect steps' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('offers the steps of a failed run too — they are the only account of it', async () => {
    mockApi({ calculations: [FAILED] });
    renderPanel();

    expect(await screen.findByRole('button', { name: 'Inspect steps' })).toBeEnabled();
    // No summary at all, because no run succeeded.
    expect(screen.queryByText('Approach breakdown')).not.toBeInTheDocument();
  });
});

/**
 * A specialty run sitting on the same valuation as a 409A one.
 *
 * `calculations` is one table holding two shapes of run: the 409A pipeline's
 * `results.approaches` document, and a specialty engine's `{ kind, specialty }`
 * (`routes/specialty.ts`), whose headline goes into the typed `equity_value` /
 * `fmv_per_share` columns where it means something else — an EMI run's
 * per-share figure is the *restricted* AMV, not a §409A fair market value.
 * Nothing stops an EMI engagement from also using this panel's own "Run
 * calculation" button, so the two interleave in one newest-first list.
 *
 * Taking simply the newest succeeded run let the specialty row drive this
 * panel: its AMV printed as "Fair market value / share", an empty table under
 * "Approach breakdown", and all four recalculate buttons disabled saying the
 * approach "has no weight in the latest run" — a claim about a weighting the
 * run does not have, while the 409A run those buttons could have recalculated
 * sat one row below.
 */
const SPECIALTY: Calculation = {
  ...SUCCEEDED,
  id: 'c-emi',
  results: { kind: 'emi', specialty: { amv_per_share: 0.42, umv_per_share: 1.1 } },
  equity_value: '5000000',
  fmv_per_share: '0.42',
  created_at: '2026-07-03T00:00:00Z',
};

describe('CalculationPanel — a specialty run newer than the 409A one', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('describes the 409A run, not the specialty row above it', async () => {
    mockApi({ calculations: [SPECIALTY, SUCCEEDED] });
    renderPanel();

    await screen.findByText('Approach breakdown');
    // The breakdown is the 409A run's, so the recalculate strip can tell the
    // truth about which approaches are there to recompute.
    expect(screen.getByText('Income (DCF)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '↻ DCF' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '↻ Market' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '↻ Asset' })).toBeDisabled();
  });

  it('recalculates against that run rather than refusing', async () => {
    const posts = mockApi({ calculations: [SPECIALTY, SUCCEEDED] });
    renderPanel();

    await screen.findByText('Approach breakdown');
    await userEvent.click(screen.getByRole('button', { name: '↻ Market' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ inputs: {}, approach: 'market' });
  });

  it('does not caption the specialty headline as a §409A fair market value', async () => {
    mockApi({ calculations: [SPECIALTY, SUCCEEDED] });
    renderPanel();

    await screen.findByText('Approach breakdown');
    // 1.2 is the 409A run's FMV per share; 0.42 is the EMI restricted AMV,
    // which this panel has no wording for and must not borrow one for.
    const card = screen.getByText('Fair market value / share').parentElement!;
    expect(card).toHaveTextContent('$1.20');
    expect(card).not.toHaveTextContent('0.42');
  });

  it('still lists the specialty run in the history', async () => {
    mockApi({ calculations: [SPECIALTY, SUCCEEDED] });
    renderPanel();

    await screen.findByText('History');
    // Two rows: nothing was filtered out of the record of what was run, only
    // out of the question "which run does this panel describe".
    expect(screen.getAllByRole('button', { name: 'Inspect steps' })).toHaveLength(2);
  });
});

describe('CalculationPanel — only specialty runs on the valuation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('offers no approach breakdown or recalculate strip at all', async () => {
    mockApi({ calculations: [SPECIALTY] });
    renderPanel();

    await screen.findByText('History');
    // There is no 409A run to describe. Four disabled buttons explaining that
    // each approach "has no weight" would be an account of a weighting that
    // does not exist, and an empty table under "Approach breakdown" asserts a
    // breakdown was computed and came to nothing.
    expect(screen.queryByText('Approach breakdown')).not.toBeInTheDocument();
    expect(screen.queryByText('Recalculate one approach:')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '↻ Asset' })).not.toBeInTheDocument();
    // And no borrowed caption over the restricted AMV.
    expect(screen.queryByText('Fair market value / share')).not.toBeInTheDocument();
    // The run itself is still there to inspect.
    expect(screen.getByRole('button', { name: 'Inspect steps' })).toBeInTheDocument();
  });

  it('still lets a full calculation be started', async () => {
    mockApi({ calculations: [SPECIALTY] });
    renderPanel();

    await screen.findByText('History');
    expect(screen.getByRole('button', { name: 'Run calculation' })).toBeEnabled();
  });
});

describe('CalculationPanel — an approach the engine produced no value for', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * `a.equity_value ?? 0` printed "$0" for an approach that indicated nothing
   * — a conclusion the engine never reached, on the screen the analyst signs
   * the run off from, and the same substitution the report's summary bar chart
   * was making one layer down.
   */
  it('shows an em-dash rather than a conclusion of zero', async () => {
    mockApi({
      calculations: [
        {
          ...SUCCEEDED,
          results: {
            ...SUCCEEDED.results,
            approaches: {
              income: { equity_value: 12_000_000, weight: 0.6 },
              market: { weight: 0.4 },
            },
          },
        },
      ],
    });
    renderPanel();

    const row = (await screen.findByText('Market (comps)')).closest('tr')!;
    // The weight is still stated — the approach did count — and the value is not.
    expect(row.textContent).toContain('40%');
    expect(row.textContent).toContain('—');
    expect(row.textContent).not.toContain('$0');
  });
});
