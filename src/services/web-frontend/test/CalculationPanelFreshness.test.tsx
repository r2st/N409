import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalculationPanel } from '../src/components/valuation/CalculationPanel';
import type { Calculation } from '../src/lib/pipeline';

/**
 * What the panel shows once the engine state moves underneath it.
 *
 * `CalculationPanelRuns` and `CalculationPreflight` both assert against a list
 * that never changes: the panel loads once, and every later assertion reads the
 * same fixture. That covers the wording of a failure and says nothing about the
 * question an analyst actually has after pressing the button — whether the
 * figures on screen are the ones the engine just produced.
 *
 * Three ways they can fail to be, and each renders a page that looks correct:
 *
 * - **Stale.** The run succeeds, the panel does not re-read, and the standing
 *   conclusion is the previous one. Nothing is missing and nothing is flagged;
 *   the number is simply the old number.
 * - **Optimistic.** The panel shows the new figures before the server has
 *   confirmed them, so a rejected run leaves an FMV on screen that no
 *   calculation record supports.
 * - **Blanked.** A run fails, or the reload after it fails, and the panel drops
 *   the conclusion it already had. The engine failing is not a reason for the
 *   last good valuation to disappear from the screen — it is a reason to say
 *   the engine failed.
 *
 * The mock here returns a *different* list after the compute POST, which is
 * what makes the difference between reading and re-reading observable at all.
 */

const VALUATION_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';

/** The run standing before the analyst presses anything. FMV $1.20. */
const STANDING: Calculation = {
  id: 'c-standing',
  valuation_id: VALUATION_ID,
  engine_version: 'py-1.0.0',
  status: 'succeeded',
  inputs: {},
  results: {
    approaches: { income: { equity_value: 12_000_000, weight: 1.0 } },
    discounts: { dloc: 0.1, dlom: 0.25, dlom_method: 'finnerty' },
    assumptions: { time_to_exit_years: 3, volatility: 0.6, risk_free_rate: 0.042 },
  },
  equity_value: '12000000',
  fmv_per_share: '1.2',
  error: null,
  diagnostics: [],
  created_at: '2026-07-01T00:00:00Z',
};

/** What the engine returns from the run under test. FMV $3.40, DLOM 15%. */
const RECOMPUTED: Calculation = {
  ...STANDING,
  id: 'c-recomputed',
  results: {
    approaches: { income: { equity_value: 34_000_000, weight: 1.0 } },
    discounts: { dloc: 0.1, dlom: 0.15, dlom_method: 'finnerty' },
    assumptions: { time_to_exit_years: 3, volatility: 0.6, risk_free_rate: 0.042 },
  },
  equity_value: '34000000',
  fmv_per_share: '3.4',
  created_at: '2026-07-02T00:00:00Z',
};

/** A run that failed. Carries no figures of its own — that is the point. */
const FAILED: Calculation = {
  ...STANDING,
  id: 'c-failed',
  status: 'failed',
  results: {},
  equity_value: null,
  fmv_per_share: null,
  error: 'engine timed out after 30s',
  created_at: '2026-07-03T00:00:00Z',
};

// As `formatMoney` in lib/pipeline renders them. Under 100, so it allows up to
// four decimals — but the currency style still carries a two-digit minimum, so
// these keep their trailing zero.
const STANDING_FMV = '$1.20';
const RECOMPUTED_FMV = '$3.40';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A fetch mock whose calculation list changes when the compute POST lands.
 *
 * `before` is served until the POST, `after` from then on — so an assertion
 * that finds `before`'s figures after a successful run has caught a panel that
 * never re-read. `holdPost` lets a test inspect the screen mid-flight.
 */
function mockApi(opts: {
  before: Calculation[];
  after?: Calculation[];
  compute?: { status: number; body: unknown } | 'network';
  /** Fails the list reload that follows the POST, leaving the POST itself fine. */
  failReload?: boolean;
  holdPost?: Promise<void>;
}) {
  let posted = false;
  let reloads = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') {
      if (opts.holdPost) await opts.holdPost;
      posted = true;
      if (opts.compute === 'network') throw new TypeError('network down');
      const { status, body } = opts.compute ?? { status: 201, body: { calculation: RECOMPUTED } };
      return jsonResponse(body, status);
    }
    if (posted) {
      reloads += 1;
      if (opts.failReload) return jsonResponse({ status: 503 }, 503);
      return jsonResponse({ calculations: opts.after ?? opts.before });
    }
    return jsonResponse({ calculations: opts.before });
  });
  return { reloadCount: () => reloads };
}

const renderPanel = () => render(<CalculationPanel valuationId={VALUATION_ID} currency="USD" />);

const runCalculation = async () =>
  userEvent.click(await screen.findByRole('button', { name: 'Run calculation' }));

/**
 * The value on one of the three headline cards.
 *
 * Read through the card's own label rather than by searching the page for the
 * figure, because the run history below prints every run's FMV too — and is
 * *supposed* to. A bare `getByText('$1.20')` matches both, so it can neither
 * tell the conclusion from the history nor assert that the old figure has left
 * the conclusion while remaining, correctly, in the list.
 */
function card(label: string): string {
  // Narrowed to the card's own label element: "Equity value" is also a column
  // header in the approach breakdown below, and the `overline` class is what
  // distinguishes a headline card's caption from a table heading.
  const caption = screen
    .getAllByText(label)
    .find((node) => node.tagName === 'DIV' && node.className.includes('overline'));
  if (!caption) throw new Error(`no headline card labelled ${label}`);
  return (caption.parentElement?.textContent ?? '').replace(label, '').trim();
}

const concluded = () => card('Fair market value / share');

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('CalculationPanel — a run that succeeds', () => {
  it('shows the figures the run just produced, not the ones it was rendered with', async () => {
    mockApi({ before: [STANDING], after: [RECOMPUTED, STANDING] });
    renderPanel();
    await waitFor(() => expect(concluded()).toBe(STANDING_FMV));

    await runCalculation();

    await waitFor(() => expect(concluded()).toBe(RECOMPUTED_FMV));
  });

  it('moves every figure together, not just the headline one', async () => {
    // A panel that re-read the conclusion while holding an older allocation
    // would satisfy the assertion above and still be wrong — the price right
    // and the schedule behind it stale.
    mockApi({ before: [STANDING], after: [RECOMPUTED, STANDING] });
    renderPanel();
    await waitFor(() => expect(card('DLOM applied')).toBe('25.0%'));
    expect(card('Equity value')).toBe('$12,000,000');

    await runCalculation();

    await waitFor(() => expect(card('DLOM applied')).toBe('15.0%'));
    expect(card('Equity value')).toBe('$34,000,000');
  });

  it('re-reads the list from the server rather than trusting the POST body', async () => {
    // The POST returns the new calculation, so a panel could splice it in
    // without asking. It must not: the run may have superseded more than the
    // one record it hands back, and the list is the thing with the ordering.
    const { reloadCount } = mockApi({ before: [STANDING], after: [RECOMPUTED, STANDING] });
    renderPanel();
    await waitFor(() => expect(concluded()).toBe(STANDING_FMV));

    await runCalculation();

    await waitFor(() => expect(reloadCount()).toBeGreaterThan(0));
  });
});

describe('CalculationPanel — while the engine is working', () => {
  it('shows the standing figures until the server confirms, and never a guess', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockApi({ before: [STANDING], after: [RECOMPUTED, STANDING], holdPost: held });
    renderPanel();
    await waitFor(() => expect(concluded()).toBe(STANDING_FMV));

    await runCalculation();

    // Mid-flight: the button says so and refuses a second press, and the panel
    // still shows the last confirmed conclusion rather than an optimistic one.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Computing…' })).toBeDisabled());
    expect(concluded()).toBe(STANDING_FMV);

    release();
    await waitFor(() => expect(concluded()).toBe(RECOMPUTED_FMV));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run calculation' })).toBeEnabled());
  });
});

describe('CalculationPanel — a run that fails mid-calculation', () => {
  it('keeps the standing conclusion on screen beside the error', async () => {
    // The engine failing is not a reason for the last good valuation to leave
    // the screen. An analyst who has just lost the figure they were reading
    // cannot tell a failed recalculation from a wiped engagement.
    mockApi({
      before: [STANDING],
      compute: { status: 502, body: { status: 502, title: 'Bad Gateway', detail: 'the engine is down' } },
    });
    renderPanel();
    await waitFor(() => expect(concluded()).toBe(STANDING_FMV));

    await runCalculation();

    expect(await screen.findByText('the engine is down')).toBeInTheDocument();
    expect(concluded()).toBe(STANDING_FMV);
    expect(screen.getByRole('button', { name: 'Run calculation' })).toBeEnabled();
  });

  it('does not promote the failed run to the conclusion when it lands in the history', async () => {
    // The failed run is newer than the standing one and carries a null FMV.
    // Reading "the latest run" rather than "the latest succeeded run" would put
    // an em dash where the valuation goes.
    mockApi({
      before: [STANDING],
      after: [FAILED, STANDING],
      compute: { status: 502, body: { status: 502, title: 'Bad Gateway', detail: 'the engine is down' } },
    });
    renderPanel();
    await waitFor(() => expect(concluded()).toBe(STANDING_FMV));

    await runCalculation();

    expect(await screen.findByText('the engine is down')).toBeInTheDocument();
    // The failed run is in the history…
    expect(await screen.findByText('engine timed out after 30s')).toBeInTheDocument();
    // …and the conclusion is still the last one that succeeded.
    expect(concluded()).toBe(STANDING_FMV);
  });

  it('keeps the figures when the reload after a successful run is what fails', async () => {
    // The compute landed; only the re-read did not. The panel has no fresh
    // list, so it says so — and holds the one it has rather than blanking to a
    // spinner, which would claim it is still loading something it has stopped
    // asking for.
    mockApi({ before: [STANDING], failReload: true });
    renderPanel();
    await waitFor(() => expect(concluded()).toBe(STANDING_FMV));

    await runCalculation();

    expect(await screen.findByText('Could not load calculations.')).toBeInTheDocument();
    expect(concluded()).toBe(STANDING_FMV);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
