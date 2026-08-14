import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter } from 'react-router-dom';
import { CalculatorPage } from '../src/pages/marketing/CalculatorPage';

/**
 * The free 409A estimator.
 *
 * The risks worth testing are the ones that would make it read as a valuation
 * rather than an estimate: a figure shown before any evidence was entered, or
 * the safe-harbor disclaimer failing to render alongside a number. Both are
 * asserted here, along with the request never firing on an empty form.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const RESULT = {
  inputs: { stages: ['series_a'], round_ages: ['under_6m'] },
  result: {
    stage: 'series_a',
    equity_value: { p10: 20_000_000, median: 25_000_000, p90: 31_000_000 },
    common_allocation: { p10: 6_250_000, median: 7_900_000, p90: 10_000_000 },
    common_share_band: { low: 0.25, high: 0.4 },
    common_fmv: { p10: 4_500_000, median: 5_688_000, p90: 7_200_000 },
    dlom: 0.28,
    per_share: { p10: 0.45, median: 0.57, p90: 0.72 },
    evidence: [
      {
        source: 'priced_round',
        label: 'Last priced round',
        weight: 1,
        implied: { p10: 20_000_000, median: 25_000_000, p90: 31_000_000 },
        note: 'A round inside six months is the strongest evidence of value there is.',
      },
    ],
    curve: Array.from({ length: 40 }, (_, i) => ({
      value: 10_000_000 * Math.exp(i / 20),
      density: Math.exp(-((i - 20) ** 2) / 100),
    })),
    disclaimer: 'This is an estimate, not a valuation. It carries no IRS safe-harbor protection.',
  },
};

const renderPage = () =>
  render(
    <HelmetProvider>
      <MemoryRouter>
        <CalculatorPage />
      </MemoryRouter>
    </HelmetProvider>,
  );

describe('CalculatorPage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(RESULT)),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /**
   * R30 — every box here is free text and `parseMoney` returns null for
   * anything it cannot read, so a visitor who typed "2.5m" had their figure
   * silently dropped and was then asked to enter the figure they had just
   * entered. Nothing is required; what is checked is that a figure which was
   * typed is one the estimator can use.
   */
  it('says a figure it cannot read is unreadable, rather than ignoring it', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/Post-money of that round/), '2.5m');
    await user.tab();

    expect(await screen.findByText('Enter a figure in digits, e.g. 2500000.')).toBeInTheDocument();
  });

  it('says a zero or negative figure is one, rather than dropping it', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/Total capital raised/), '-400');
    await user.tab();

    expect(await screen.findByText('Enter a figure above zero, or leave the box blank.')).toBeInTheDocument();
  });

  it('says nothing about a blank box, which is the normal state here', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByLabelText(/Revenue, last 12 months/));
    await user.tab();

    expect(screen.queryByText(/Enter a figure/)).not.toBeInTheDocument();
  });

  it('shows no figure, and calls nothing, until evidence is entered', async () => {
    renderPage();
    expect(screen.getByText(/Enter a round price, profit, revenue, or capital raised/i)).toBeTruthy();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('estimates from a single figure and shows the three steps of the appraisal', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();

    await user.type(screen.getByLabelText(/Post-money of that round/i), '25000000');
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      stage: 'series_a',
      round_age: 'under_6m',
      post_money: 25_000_000,
    });

    // Scoped to the result panel: the static "Method" section below also
    // contains the phrase "total equity value".
    const panel = await screen.findByTestId('calculator-result');
    await waitFor(() => expect(panel.textContent).toMatch(/Total equity value/i));
    // Allocation and DLOM are labelled with the figures actually applied.
    expect(panel.textContent).toMatch(/Common allocation \(25–40%\)/);
    expect(panel.textContent).toMatch(/Common after DLOM \(28%\)/);
    // Per-share is a range, never a point.
    expect(panel.textContent).toMatch(/\$0\.45 – \$0\.72/);
  });

  it('renders the disclaimer from the response, next to the number', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await user.type(screen.getByLabelText(/Revenue, last 12 months/i), '2300000');
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => expect(screen.getByText(/no IRS safe-harbor protection/i)).toBeTruthy());
  });

  it('tolerates the commas and dollar signs people actually type', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await user.type(screen.getByLabelText(/Total capital raised/i), '$6,000,000');
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const last = JSON.parse((calls[calls.length - 1]![1] as RequestInit).body as string);
    expect(last.capital_raised).toBe(6_000_000);
  });

  it('surfaces a failure instead of a stale figure', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: 422, detail: 'Enter a round price.' }, 422)),
    );
    renderPage();
    await user.type(screen.getByLabelText(/Revenue, last 12 months/i), '1000');
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Enter a round price/));
    expect(screen.getByTestId('calculator-result').textContent).not.toMatch(/Total equity value/i);
  });
});
