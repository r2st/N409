import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ValuationComparePage } from '../src/pages/ValuationComparePage';

/**
 * Side-by-side comparison.
 *
 * The page exists because the number that moved is rarely the headline one, so
 * what is asserted here is the editorial default: it opens on *what changed*,
 * not on the full metric list, and it never asks the reader to work out which
 * direction is good — a rising discount is a fall in value, and the colouring
 * has to say so.
 */

const VAL_A = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const VAL_B = '01BX5ZZKBKACTAV9WEVGEMMVS0';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const listRow = (id: string, company: string, created: string) => ({
  id,
  number: id === VAL_A ? '1001' : '1002',
  kind: '409a',
  state: 'published',
  company_name: company,
  service_name: null,
  user_id: 'u1',
  partner_id: null,
  source: null,
  currency: 'USD',
  service_countries: [],
  waiting_on_client: false,
  assigned_reviewer_id: null,
  due_date: null,
  delivery_days: null,
  paid_status: 'paid',
  qsbs_attestation: null,
  created_at: created,
  updated_at: created,
});

const side = (id: string, engine: string, date: string) => ({
  valuation_id: id,
  company_name: 'Northwind Robotics',
  kind: '409a',
  currency: 'USD',
  state: 'published',
  calculation_id: `calc-${id}`,
  engine_version: engine,
  calculated_at: `${date}T00:00:00Z`,
  valuation_date: date,
});

const row = (
  key: string,
  label: string,
  over: Partial<{
    a_display: string | null;
    b_display: string | null;
    delta: number | null;
    delta_display: string | null;
    pct_change: number | null;
    changed: boolean;
  }> = {},
) => ({
  key,
  label,
  format: 'percent' as const,
  a: 1,
  b: 2,
  a_display: '1',
  b_display: '2',
  delta: 1,
  delta_display: '+1',
  pct_change: null,
  changed: true,
  ...over,
});

const COMPARISON = {
  a: side(VAL_A, '1.4.0', '2025-05-31'),
  b: side(VAL_B, '1.5.0', '2025-11-30'),
  summary: 'FMV per share is up from $1.4200 to $1.8700 (31.7%).',
  changed_count: 2,
  groups: [
    {
      key: 'conclusion',
      title: 'Conclusion',
      rows: [
        row('fmv_per_share', 'FMV per common share', {
          a_display: '$1.4200',
          b_display: '$1.8700',
          delta: 0.45,
          delta_display: '+$0.4500',
          pct_change: 0.3169,
        }),
        row('fully_diluted_common', 'Fully diluted common', {
          a_display: '33,802,816',
          b_display: '33,802,816',
          delta: 0,
          delta_display: '+0',
          changed: false,
        }),
      ],
    },
    {
      key: 'method',
      title: 'Method & discounts',
      rows: [
        row('dlom', 'Discount for lack of marketability', {
          a_display: '30.0%',
          b_display: '22.0%',
          delta: -0.08,
          delta_display: '−8.0 pts',
        }),
      ],
    },
  ],
};

function mockApi(comparison: unknown = COMPARISON, status = 200) {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url);
    urls.push(path);
    if (path.includes('/valuations/compare')) {
      return status === 200
        ? jsonResponse(comparison)
        : jsonResponse({ detail: 'These valuations are denominated differently' }, status);
    }
    if (path.includes('/valuations')) {
      return jsonResponse({
        valuations: [
          listRow(VAL_A, 'Northwind Robotics', '2025-06-01T00:00:00Z'),
          listRow(VAL_B, 'Northwind Robotics', '2025-12-01T00:00:00Z'),
        ],
        page: 1,
        per_page: 100,
        total: 2,
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  });
  return urls;
}

const renderAt = (search = '') =>
  render(
    <MemoryRouter initialEntries={[`/valuations/compare${search}`]}>
      <ValuationComparePage />
    </MemoryRouter>,
  );

// jsdom has no layout, so react-router's scroll restoration logs a
// "not implemented" line on unmount. Stubbing it for the whole file keeps the
// stub alive through cleanup, which a per-test restore would not.
beforeAll(() => vi.stubGlobal('scrollTo', () => {}));
afterAll(() => vi.unstubAllGlobals());
afterEach(() => vi.restoreAllMocks());

describe('ValuationComparePage', () => {
  it('asks for two valuations before fetching anything', async () => {
    const urls = mockApi();
    renderAt();

    expect(await screen.findByText('Choose two valuations')).toBeInTheDocument();
    // No point asking the server to compare nothing.
    await waitFor(() => expect(urls.some((u) => u.includes('/compare'))).toBe(false));
  });

  it('compares the pair named in the URL', async () => {
    const urls = mockApi();
    renderAt(`?a=${VAL_A}&b=${VAL_B}`);

    expect(
      await screen.findByText('FMV per share is up from $1.4200 to $1.8700 (31.7%).'),
    ).toBeInTheDocument();
    expect(urls.some((u) => u.includes(`a=${VAL_A}`) && u.includes(`b=${VAL_B}`))).toBe(true);
    expect(screen.getByText('2 metrics changed.')).toBeInTheDocument();
  });

  it('opens on what changed, hiding the metrics that held still', async () => {
    mockApi();
    renderAt(`?a=${VAL_A}&b=${VAL_B}`);
    await screen.findByText('FMV per common share');

    // The unchanged share count is real and correct and not why anyone opened
    // this page.
    expect(screen.queryByText('Fully diluted common')).not.toBeInTheDocument();
    expect(screen.getByText('Discount for lack of marketability')).toBeInTheDocument();
  });

  it('shows every metric on request', async () => {
    mockApi();
    const user = userEvent.setup();
    renderAt(`?a=${VAL_A}&b=${VAL_B}`);
    await screen.findByText('FMV per common share');

    await user.click(screen.getByRole('button', { name: 'Show all metrics' }));
    expect(await screen.findByText('Fully diluted common')).toBeInTheDocument();
  });

  it('reads a rising discount as a fall in value', async () => {
    mockApi({
      ...COMPARISON,
      groups: [
        {
          key: 'method',
          title: 'Method & discounts',
          rows: [
            row('dlom', 'Discount for lack of marketability', {
              a_display: '22.0%',
              b_display: '30.0%',
              delta: 0.08,
              delta_display: '+8.0 pts',
            }),
          ],
        },
      ],
    });
    renderAt(`?a=${VAL_A}&b=${VAL_B}`);

    const cell = (await screen.findByText('+8.0 pts')).closest('td')!;
    // Up is not good here: a bigger marketability discount pushes FMV down.
    expect(cell.className).toContain('text-red-700');
  });

  it('reads a rising FMV as a gain', async () => {
    mockApi();
    renderAt(`?a=${VAL_A}&b=${VAL_B}`);

    const cell = (await screen.findByText('+$0.4500')).closest('td')!;
    expect(cell.className).toContain('text-emerald-700');
  });

  it('shows both sides’ provenance so the reader knows what they are looking at', async () => {
    mockApi();
    renderAt(`?a=${VAL_A}&b=${VAL_B}`);
    await screen.findByText('FMV per common share');

    expect(screen.getByText(/engine 1\.4\.0/)).toBeInTheDocument();
    expect(screen.getByText(/engine 1\.5\.0/)).toBeInTheDocument();
    expect(screen.getByText(/as of 2025-05-31/)).toBeInTheDocument();
  });

  it('says plainly when nothing moved', async () => {
    mockApi({
      ...COMPARISON,
      summary: 'FMV per share is unchanged at $1.4200.',
      changed_count: 0,
      groups: [
        {
          key: 'conclusion',
          title: 'Conclusion',
          rows: [row('fmv_per_share', 'FMV per common share', { changed: false, delta: 0 })],
        },
      ],
    });
    renderAt(`?a=${VAL_A}&b=${VAL_B}`);

    expect(await screen.findByText('Nothing measured differs between these two.')).toBeInTheDocument();
    expect(screen.getByText('No differences')).toBeInTheDocument();
  });

  it('surfaces a refusal from the server', async () => {
    mockApi(null, 422);
    renderAt(`?a=${VAL_A}&b=${VAL_B}`);

    expect(await screen.findByText(/denominated differently/)).toBeInTheDocument();
  });

  it('will not let the same valuation be chosen on both sides', async () => {
    mockApi();
    renderAt(`?a=${VAL_A}&b=${VAL_B}`);
    await screen.findByText('FMV per common share');

    const baseline = screen.getByLabelText('Baseline (A)');
    // B is already taken; offering it on the A side would only produce a 400.
    expect(within(baseline).getByRole('option', { name: /1002/ })).toBeDisabled();
  });

  it('renders a side that has not computed yet without breaking', async () => {
    mockApi({
      ...COMPARISON,
      summary: null,
      changed_count: 1,
      b: {
        ...side(VAL_B, '1.5.0', '2025-11-30'),
        calculation_id: null,
        engine_version: null,
        calculated_at: null,
      },
      groups: [
        {
          key: 'conclusion',
          title: 'Conclusion',
          rows: [
            row('fmv_per_share', 'FMV per common share', {
              b_display: null,
              delta: null,
              delta_display: null,
            }),
          ],
        },
      ],
    });
    renderAt(`?a=${VAL_A}&b=${VAL_B}`);

    expect(await screen.findByText('No completed calculation yet')).toBeInTheDocument();
    expect(screen.getByText('changed')).toBeInTheDocument();
  });

  /**
   * Colour is the only thing that told a reader whether a move was good, and
   * roughly one man in twelve cannot read the green/red pair (WCAG 1.4.1).
   */
  describe('direction without colour', () => {
    it('names the direction and the verdict in text beside the delta', async () => {
      mockApi();
      renderAt(`?a=${VAL_A}&b=${VAL_B}`);

      const fmv = (await screen.findByText('FMV per common share')).closest('tr')!;
      expect(within(fmv).getByText(/increased, favourable/)).toBeInTheDocument();
      // The arrow is decoration on top of the words, not a substitute for them.
      expect(fmv.textContent).toContain('▲');
    });

    it('reads a falling discount as favourable and a falling value as not', async () => {
      mockApi();
      renderAt(`?a=${VAL_A}&b=${VAL_B}`);

      const dlom = (await screen.findByText('Discount for lack of marketability')).closest('tr')!;
      expect(within(dlom).getByText(/decreased, favourable/)).toBeInTheDocument();
      expect(dlom.textContent).toContain('▼');
    });

    it('says nothing about direction where a metric held still', async () => {
      mockApi();
      renderAt(`?a=${VAL_A}&b=${VAL_B}`);

      await screen.findByText('FMV per common share');
      await userEvent.click(screen.getByRole('button', { name: /show all metrics/i }));
      const flat = screen.getByText('Fully diluted common').closest('tr')!;
      expect(flat.textContent).not.toContain('▲');
      expect(flat.textContent).not.toContain('▼');
      expect(within(flat).queryByText(/increased|decreased/)).toBeNull();
    });
  });

  describe('CSV export', () => {
    it('downloads the comparison from the server, unfiltered by the view toggle', async () => {
      const urls = mockApi();
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      // jsdom implements neither of these; the download helper uses both.
      URL.createObjectURL = vi.fn(() => 'blob:comparison');
      URL.revokeObjectURL = vi.fn();
      renderAt(`?a=${VAL_A}&b=${VAL_B}`);

      await screen.findByRole('button', { name: /export csv/i });
      await userEvent.click(screen.getByRole('button', { name: /export csv/i }));

      await waitFor(() => expect(click).toHaveBeenCalled());
      // Asked the server for the file rather than serialising the filtered
      // rows the page happens to be showing.
      expect(urls.some((u) => u.includes('format=csv') && u.includes(VAL_A) && u.includes(VAL_B))).toBe(true);
    });
  });
});
