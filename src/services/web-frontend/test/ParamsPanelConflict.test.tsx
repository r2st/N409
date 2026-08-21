import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ParamsPanel } from '../src/components/valuation/ParamsPanel';
import { WaccPanel } from '../src/components/valuation/WaccPanel';
import { resetRowVersions } from '../src/lib/rowVersion';

/**
 * The methodology form's half of the lost-update fix (round 93).
 *
 * `valuation_params` has carried a version since migration 0158 and the
 * financial-model panel has been sending it back ever since; this form — the
 * larger of the two by a wide margin — was not. It posts forty-odd fields it
 * read when the tab was opened, so a save built on a stale load does not lose
 * the race, it wins it and reverts the other editor.
 *
 * Four things have to hold, and the last two are what keep the guard from being
 * worse than nothing: it sends the version it loaded, it adopts the version
 * each save returns, it reloads on a 409 rather than leaving the stale form
 * sitting there ready to be posted again — and it does *not* fire on the writes
 * made beside it, by the scenario grid and the build-up panel, which move the
 * same counter without touching a field this form holds.
 */

const PARAMS = {
  valuation_id: 'v1',
  rolling_forward: false,
  inception_date: null,
  fiscal_year_end: null,
  exit_timeline: null,
  business_overview: null,
  revenue_status: null,
  development_stage: null,
  last_round_date: null,
  last_year_revenue_cents: null,
  ytd_revenue_cents: null,
  runway_months: null,
  weight_asset: null,
  weight_opm: null,
  weight_income: null,
  weight_market: null,
  dloc: null,
  dlom: null,
  dlom_method: null,
  dlom_qualitative: null,
  allocation_method: 'opm',
  market_method: null,
  market_horizon: null,
  asset_method: null,
  wacc_inputs: null,
  auto_wacc: false,
  updated_at: '2026-08-01T00:00:00Z',
};

/** One complete PWERM scenario, so the scenario save is not blocked. */
const ENGINE_INPUTS = {
  pwerm: {
    scenarios: [
      { name: 'IPO', type: 'ipo', probability: 1, equity_value: 20_000_000, time_to_exit_years: 2 },
    ],
  },
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type PatchOutcome = 'ok' | 'conflict';

/**
 * A stand-in for the row, not for a sequence of replies.
 *
 * Every panel here reads the row back after it writes it, so a mock answering
 * GETs from a fixed list would keep handing them a version the server had
 * already moved past — and the cross-panel behaviour this file is about would
 * be untestable. `current` is the row's version: every successful write moves
 * it, and every read reports it, exactly as the API does.
 */
function mockApi(startVersion: number, patches: PatchOutcome[], params: Record<string, unknown> = {}) {
  let current = startVersion;
  let writes = 0;
  const row = () => ({ ...PARAMS, ...params, version: current });
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    const isWrite = init?.method === 'PATCH';
    if (path.includes('/engine-inputs')) {
      if (!isWrite) return jsonResponse({ engine_inputs: ENGINE_INPUTS, version: current });
      current += 1;
      return jsonResponse({ params: row() });
    }
    if (path.includes('/params')) {
      if (!isWrite) return jsonResponse({ params: row() });
      const outcome = patches[Math.min(writes, patches.length - 1)] ?? 'ok';
      writes += 1;
      if (outcome === 'conflict') {
        // The server has moved on; a real 409 is raised by a write that landed.
        current += 1;
        return jsonResponse(
          {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            detail: `These valuation parameters were changed by someone else (now ${current}).`,
          },
          409,
        );
      }
      current += 1;
      return jsonResponse({ params: row() });
    }
    return jsonResponse({});
  });
}

const callsTo = (mock: ReturnType<typeof mockApi>, method: string | undefined, fragment: string) =>
  mock.mock.calls.filter(([url, init]) => String(url).includes(fragment) && init?.method === method) as Array<
    Parameters<typeof fetch>
  >;

const paramsPatches = (mock: ReturnType<typeof mockApi>) => callsTo(mock, 'PATCH', '/params');

const ifMatchOf = (call: Parameters<typeof fetch>): string | undefined =>
  new Headers(call[1]?.headers).get('if-match') ?? undefined;

const saveMethodology = async () =>
  userEvent.click(screen.getByRole('button', { name: /save methodology/i }));

describe('ParamsPanel — concurrent editors', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRowVersions();
  });

  it('sends the version it loaded as If-Match', async () => {
    const fetchMock = mockApi(4, ['ok']);
    render(<ParamsPanel valuationId="v1" readOnly={false} />);
    await screen.findByRole('button', { name: /save methodology/i });

    await saveMethodology();
    await waitFor(() => expect(paramsPatches(fetchMock)).toHaveLength(1));
    expect(ifMatchOf(paramsPatches(fetchMock)[0]!)).toBe('"4"');
  });

  /**
   * Without this the panel conflicts with itself: the second save would assert
   * the version the first one consumed, and the analyst would be told somebody
   * else edited the methodology when the somebody else was them.
   */
  it('adopts the version the save returned, so a second save is not refused', async () => {
    const fetchMock = mockApi(4, ['ok', 'ok']);
    render(<ParamsPanel valuationId="v1" readOnly={false} />);
    await screen.findByRole('button', { name: /save methodology/i });

    await saveMethodology();
    await waitFor(() => expect(paramsPatches(fetchMock)).toHaveLength(1));
    await saveMethodology();
    await waitFor(() => expect(paramsPatches(fetchMock)).toHaveLength(2));
    expect(ifMatchOf(paramsPatches(fetchMock)[1]!)).toBe('"5"');
  });

  /**
   * A 409 is an out-of-date panel, not a failed save. Reloading is what clears
   * the stale fields the form would otherwise post again on the next attempt —
   * retrying without it just loses the same race a second time.
   */
  it('reloads and explains itself on a conflict', async () => {
    const fetchMock = mockApi(4, ['conflict']);
    render(<ParamsPanel valuationId="v1" readOnly={false} />);
    await screen.findByRole('button', { name: /save methodology/i });
    const readsBefore = callsTo(fetchMock, undefined, '/params').length;

    await saveMethodology();
    expect(await screen.findByText(/changed by someone else/i)).toBeInTheDocument();
    await waitFor(() => expect(callsTo(fetchMock, undefined, '/params').length).toBeGreaterThan(readsBefore));
  });

  it('sends the reloaded version on the retry, not the one that was refused', async () => {
    const fetchMock = mockApi(4, ['conflict', 'ok']);
    render(<ParamsPanel valuationId="v1" readOnly={false} />);
    await screen.findByRole('button', { name: /save methodology/i });

    await saveMethodology();
    await screen.findByText(/changed by someone else/i);
    await saveMethodology();
    await waitFor(() => expect(paramsPatches(fetchMock)).toHaveLength(2));
    // 5 — what the reload read — not the 4 the server refused.
    expect(ifMatchOf(paramsPatches(fetchMock)[1]!)).toBe('"5"');
  });

  /**
   * The failure the shared version exists to prevent. The scenario grid saves
   * to `/engine-inputs`, which moves the same row's version — so a panel that
   * kept its own copy would refuse the analyst's very next click, two inches up
   * the same page, for a change they had just made themselves.
   */
  it('adopts the version its own scenario save produced', async () => {
    const fetchMock = mockApi(4, ['ok'], { allocation_method: 'pwerm' });
    render(<ParamsPanel valuationId="v1" readOnly={false} />);
    const scenarioSave = await screen.findByRole('button', { name: 'Save scenarios' });

    await userEvent.click(scenarioSave);
    await waitFor(() => expect(callsTo(fetchMock, 'PATCH', '/engine-inputs')).toHaveLength(1));

    await saveMethodology();
    await waitFor(() => expect(paramsPatches(fetchMock)).toHaveLength(1));
    expect(ifMatchOf(paramsPatches(fetchMock)[0]!)).toBe('"5"');
  });

  /**
   * The same failure across two components. ParamsPanel and WaccPanel render on
   * one tab and write one row; the build-up save moves the version, and the
   * methodology form has to hear about it rather than assert a number the
   * server has already left behind.
   */
  it('adopts the version the build-up panel beside it produced', async () => {
    const fetchMock = mockApi(4, ['ok', 'ok']);
    render(
      <>
        <ParamsPanel valuationId="v1" readOnly={false} />
        <WaccPanel valuationId="v1" readOnly={false} />
      </>,
    );
    await screen.findByRole('button', { name: /save methodology/i });
    const buildUpSave = await screen.findByRole('button', { name: /save build-up/i });

    await userEvent.click(buildUpSave);
    await waitFor(() => expect(paramsPatches(fetchMock)).toHaveLength(1));
    expect(ifMatchOf(paramsPatches(fetchMock)[0]!)).toBe('"4"');

    await saveMethodology();
    await waitFor(() => expect(paramsPatches(fetchMock)).toHaveLength(2));
    // 5, the version the build-up save produced — not 4, which it consumed.
    expect(ifMatchOf(paramsPatches(fetchMock)[1]!)).toBe('"5"');
  });
});
