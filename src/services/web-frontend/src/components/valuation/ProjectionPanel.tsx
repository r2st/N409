import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { moneyFormatter } from '../../lib/format';
import { Button, EmptyState, ErrorNote, Field, InfoTooltip, Select, Spinner, TextInput } from '../ui';

/**
 * Where the DCF's cash flows come from.
 *
 * The free-cash-flow column above this panel is the income approach's primary
 * input — the stream every discount factor is applied to — and until this panel
 * it was a figure an analyst typed, one per year, with nothing anywhere saying
 * what revenue, what margin or what capital intensity produced it. It is the
 * input a reviewing appraiser questions first, and the honest answer was
 * unavailable.
 *
 * `engine/v1/projection` has built the stream from an assumption set since the
 * engine was written and had no caller: revenue top-down off a base and a
 * growth rate, or bottom-up off explicit lines, then
 *
 *     EBIT = Revenue − COGS − OpEx − D&A,  NOPAT = EBIT·(1−t),
 *     FCFF = NOPAT + D&A − CapEx − ΔNWC
 *
 * Two things the panel is deliberate about, both mirroring the volatility
 * derivation and the discount-rate build-up:
 *
 *   * Projecting and adopting are separate actions. Pressing "Project" must not
 *     silently move the concluded value of an engagement somebody may be
 *     mid-review on, so the run is recorded and the analyst decides.
 *   * The applied stream is shown beside the projected one at all times. A
 *     forecast nobody adopted, sitting next to a different column in the
 *     report, is worse than no forecast at all.
 */

const METHODS = [
  { value: 'growth', label: 'Top-down — grow a base revenue' },
  { value: 'driver', label: 'Bottom-up — enter each line by year' },
] as const;

const TERMINAL = [
  { value: 'none', label: 'None — explicit period only' },
  { value: 'gordon', label: 'Gordon growth' },
  { value: 'exit_multiple', label: 'Exit multiple' },
] as const;

/** The per-year lines an analyst enters directly in bottom-up mode. */
const DRIVER_LINES = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'cogs', label: 'COGS' },
  { key: 'opex', label: 'OpEx' },
  { key: 'da', label: 'D&A' },
  { key: 'capex', label: 'CapEx' },
  { key: 'nwc', label: 'NWC' },
] as const;

type DriverLine = (typeof DRIVER_LINES)[number]['key'];

interface ProjectionYear {
  year: number;
  revenue: number;
  cogs: number;
  opex: number;
  ebitda: number;
  da: number;
  ebit: number;
  nopat: number;
  capex: number;
  delta_nwc: number;
  fcff: number;
}

interface Projection {
  id: string;
  method: 'growth' | 'driver';
  years: number;
  tax_rate: number;
  projections: ProjectionYear[];
  free_cash_flows: number[];
  terminal_method: 'gordon' | 'exit_multiple' | null;
  terminal_value: number | null;
  terminal_ebitda: number | null;
  applied_at: string | null;
  created_at: string;
}

interface ProjectionResponse {
  projections: Projection[];
  applied_free_cash_flows: number[] | null;
  applied_matches_run: boolean;
}

/** A percentage field → a fraction; blank stays blank (the engine defaults it). */
function fraction(raw: string): number | undefined {
  const t = raw.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n / 100 : undefined;
}

/** A plain figure field → a number, tolerating the thousands separators typed in. */
function plain(raw: string): number | undefined {
  const t = raw.trim();
  if (t === '') return undefined;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

const EMPTY_GROWTH = {
  base_revenue: '',
  years: '5',
  revenue_growth: '',
  cogs_pct: '',
  opex_pct: '',
  da_pct: '',
  capex_pct: '',
  nwc_pct: '',
  prior_nwc: '',
};

const EMPTY_TERMINAL = {
  terminal_method: 'none',
  terminal_growth: '',
  discount_rate: '',
  exit_multiple: '',
  exit_metric: 'ebitda',
};

/** A blank bottom-up grid, one column per forecast year. */
const emptyDriver = (years: number): Record<DriverLine, string[]> =>
  Object.fromEntries(DRIVER_LINES.map((l) => [l.key, Array.from({ length: years }, () => '')])) as Record<
    DriverLine,
    string[]
  >;

export function ProjectionPanel({
  valuationId,
  currency,
  readOnly,
}: {
  valuationId: string;
  currency: string;
  readOnly: boolean;
}) {
  const [data, setData] = useState<ProjectionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const [method, setMethod] = useState<'growth' | 'driver'>('growth');
  const [growth, setGrowth] = useState({ ...EMPTY_GROWTH });
  const [driverYears, setDriverYears] = useState(5);
  const [driver, setDriver] = useState<Record<DriverLine, string[]>>(() => emptyDriver(5));
  const [taxRate, setTaxRate] = useState('21');
  const [terminal, setTerminal] = useState({ ...EMPTY_TERMINAL });

  const money = moneyFormatter(currency, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const cash = (v: number | null | undefined): string => (typeof v === 'number' ? money(v) : '—');

  const load = useCallback(async () => {
    try {
      setData(await api<ProjectionResponse>(`/valuations/${valuationId}/projection`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the cash-flow projection.');
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : failure);
    } finally {
      setBusy(false);
    }
  };

  /** Resize the bottom-up grid, keeping whatever has already been typed. */
  const setYears = (n: number) => {
    setDriverYears(n);
    setDriver(
      (d) =>
        Object.fromEntries(
          DRIVER_LINES.map((l) => [l.key, Array.from({ length: n }, (_, i) => d[l.key][i] ?? '')]),
        ) as Record<DriverLine, string[]>,
    );
  };

  const setCell = (line: DriverLine, i: number, value: string) =>
    setDriver((d) => ({ ...d, [line]: d[line].map((v, j) => (j === i ? value : v)) }));

  /**
   * The assumption set as the engine takes it.
   *
   * Blank fields are omitted rather than sent as zero: the engine defaults an
   * absent ratio to zero itself, and a field left blank because it does not
   * apply should not read in the stored assumptions as a figure somebody
   * asserted.
   */
  function body(): Record<string, unknown> {
    const out: Record<string, unknown> = { method };
    const tax = fraction(taxRate);
    if (tax !== undefined) out.tax_rate = tax;

    if (method === 'growth') {
      out.years = plain(growth.years);
      out.base_revenue = plain(growth.base_revenue);
      out.revenue_growth = fraction(growth.revenue_growth);
      for (const key of ['cogs_pct', 'opex_pct', 'da_pct', 'capex_pct', 'nwc_pct'] as const) {
        const v = fraction(growth[key]);
        if (v !== undefined) out[key] = v;
      }
      const prior = plain(growth.prior_nwc);
      if (prior !== undefined) out.prior_nwc = prior;
    } else {
      for (const line of DRIVER_LINES) {
        const vals = driver[line.key].map(plain);
        // A partially-filled line is refused here rather than sent: the engine
        // takes a list the length of the revenue list, and dropping the blanks
        // would silently shift every later year up one.
        if (vals.every((v) => v === undefined)) continue;
        out[line.key] = vals.map((v) => v ?? 0);
      }
    }

    if (terminal.terminal_method !== 'none') {
      out.terminal_method = terminal.terminal_method;
      if (terminal.terminal_method === 'gordon') {
        const g = fraction(terminal.terminal_growth);
        const r = fraction(terminal.discount_rate);
        if (g !== undefined) out.terminal_growth = g;
        if (r !== undefined) out.discount_rate = r;
      } else {
        const m = plain(terminal.exit_multiple);
        if (m !== undefined) out.exit_multiple = m;
        out.exit_metric = terminal.exit_metric;
      }
    }
    return out;
  }

  /** The engine's own requirements, checked here so a typo is not a round trip. */
  function formProblem(): string | null {
    if (method === 'growth') {
      if (plain(growth.base_revenue) === undefined) return 'Top-down needs a base revenue to grow from.';
      if (fraction(growth.revenue_growth) === undefined) return 'Top-down needs a revenue growth rate.';
      const y = plain(growth.years);
      if (y === undefined || !Number.isInteger(y) || y < 1 || y > 100) {
        return 'The forecast period is a whole number of years, from 1 to 100.';
      }
    } else if (driver.revenue.every((v) => plain(v) === undefined)) {
      return 'Bottom-up needs a revenue figure for at least the first year.';
    }
    if (terminal.terminal_method === 'gordon') {
      const g = fraction(terminal.terminal_growth) ?? 0;
      const r = fraction(terminal.discount_rate);
      if (r === undefined) return 'A Gordon terminal value needs the discount rate it capitalises at.';
      if (r <= g) return 'The discount rate must exceed terminal growth.';
    }
    if (terminal.terminal_method === 'exit_multiple' && plain(terminal.exit_multiple) === undefined) {
      return 'An exit-multiple terminal value needs the multiple.';
    }
    return null;
  }

  const project = async () => {
    setNote(null);
    const problem = formProblem();
    if (problem) {
      setError(problem);
      return;
    }
    await run(async () => {
      const res = await api<{ projection: Projection }>(`/valuations/${valuationId}/projection/run`, {
        method: 'POST',
        body: body(),
      });
      const p = res.projection;
      setNote(
        `${p.years}-year forecast, ${cash(p.free_cash_flows[0])} to ${cash(p.free_cash_flows.at(-1))}` +
          (p.terminal_value !== null ? `, terminal value ${cash(p.terminal_value)}` : '') +
          '. Not yet adopted as the valuation’s cash flows.',
      );
    }, 'Could not project the cash flows.');
  };

  const adopt = (row: Projection) =>
    run(async () => {
      const res = await api<{ recalculation_required: boolean }>(
        `/valuations/${valuationId}/projection/${row.id}/apply`,
        { method: 'POST', body: {} },
      );
      setNote(
        res.recalculation_required
          ? 'Adopted. Re-run the calculation for the concluded value to reflect the new cash flows.'
          : 'Adopted. The calculation already ran on these cash flows.',
      );
    }, 'Could not adopt the forecast as the valuation’s cash flows.');

  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;

  const latest = data.projections[0] ?? null;
  const applied = data.applied_free_cash_flows;
  // The disagreement the panel exists to surface: the engagement is discounting
  // a stream that is not one of these runs.
  const untraced = applied !== null && applied.length > 0 && !data.applied_matches_run;

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    opts: { hint?: string; placeholder?: string } = {},
  ) => (
    <Field label={label} hint={opts.hint}>
      <TextInput
        inputMode="decimal"
        disabled={readOnly}
        aria-label={label}
        placeholder={opts.placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );

  return (
    <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="overline text-ink-400">
            Cash-flow projection
            <InfoTooltip
              className="ml-1.5"
              label="About the cash-flow projection"
              text="The DCF discounts unlevered free cash flow to the firm: NOPAT plus D&A, less CapEx and the change in net working capital. Projecting it here records the revenue and margin assumptions behind each year, so the report can state where the stream came from."
            />
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-ink-500">
            Build the free-cash-flow stream from revenue and margin assumptions instead of typing it year by
            year. Projecting records the run; the forecast only becomes the valuation’s cash flows when it is
            adopted.
          </p>
        </div>
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {note && (
        <div
          role="status"
          className="mt-4 rounded-lg border border-paper-300 bg-paper-50 px-4 py-3 text-sm text-ink-500"
        >
          {note}
        </div>
      )}

      {untraced && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          The valuation is discounting a cash-flow stream that no projection here produced — it was entered by
          hand. Project the forecast and adopt it, or the report cannot say what revenue and margins the
          stream rests on.
        </p>
      )}

      {!readOnly && (
        <div className="mt-6 space-y-5 rounded-lg border border-paper-200 bg-paper-50 p-5">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Method">
              <Select
                aria-label="Method"
                value={method}
                onChange={(e) => setMethod(e.target.value as 'growth' | 'driver')}
              >
                {METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
            {field('Tax rate (%)', taxRate, (v) => setTaxRate(v), {
              hint: 'Strikes NOPAT off EBIT.',
            })}
            {method === 'growth' &&
              field('Forecast years', growth.years, (v) => setGrowth({ ...growth, years: v }), {
                hint: 'Five to ten is the usual explicit period.',
              })}
            {method === 'driver' && (
              <Field label="Forecast years" hint="Columns in the grid below.">
                <Select
                  aria-label="Forecast years"
                  value={String(driverYears)}
                  onChange={(e) => setYears(Number(e.target.value))}
                >
                  {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>

          {method === 'growth' ? (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {field('Base revenue', growth.base_revenue, (v) => setGrowth({ ...growth, base_revenue: v }), {
                hint: 'The last actual year — year 1 grows off this.',
              })}
              {field(
                'Revenue growth (%)',
                growth.revenue_growth,
                (v) => setGrowth({ ...growth, revenue_growth: v }),
                { hint: 'Applied to every forecast year.' },
              )}
              {field('COGS (% of revenue)', growth.cogs_pct, (v) => setGrowth({ ...growth, cogs_pct: v }))}
              {field('OpEx (% of revenue)', growth.opex_pct, (v) => setGrowth({ ...growth, opex_pct: v }))}
              {field('D&A (% of revenue)', growth.da_pct, (v) => setGrowth({ ...growth, da_pct: v }))}
              {field('CapEx (% of revenue)', growth.capex_pct, (v) => setGrowth({ ...growth, capex_pct: v }))}
              {field('NWC (% of revenue)', growth.nwc_pct, (v) => setGrowth({ ...growth, nwc_pct: v }), {
                hint: 'The level held, not the change — ΔNWC is derived.',
              })}
              {field('Prior-year NWC', growth.prior_nwc, (v) => setGrowth({ ...growth, prior_nwc: v }), {
                hint: 'Year 1’s ΔNWC is measured from this. Defaults to the base-revenue level.',
              })}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm" aria-label="Projection drivers by year">
                <thead>
                  <tr className="border-b border-paper-300 text-left">
                    <th className="overline px-2 py-2 font-semibold text-ink-400">Line</th>
                    {Array.from({ length: driverYears }, (_, i) => (
                      <th key={i} className="overline px-2 py-2 text-right font-semibold text-ink-400">
                        Year {i + 1}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {DRIVER_LINES.map((line) => (
                    <tr key={line.key} className="border-b border-paper-200 last:border-0">
                      <td className="px-2 py-2 font-medium text-ink-700">{line.label}</td>
                      {driver[line.key].map((v, i) => (
                        <td key={i} className="px-2 py-2">
                          <TextInput
                            inputMode="decimal"
                            aria-label={`${line.label} year ${i + 1}`}
                            value={v}
                            onChange={(e) => setCell(line.key, i, e.target.value)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-ink-400">
                Revenue is required; a line left wholly blank is taken as zero. NWC is the level held each
                year — the change is derived.
              </p>
            </div>
          )}

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Terminal value" hint="Recorded with the run; the DCF strikes its own from Params.">
              <Select
                aria-label="Terminal value"
                value={terminal.terminal_method}
                onChange={(e) => setTerminal({ ...terminal, terminal_method: e.target.value })}
              >
                {TERMINAL.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            {terminal.terminal_method === 'gordon' && (
              <>
                {field('Terminal growth (%)', terminal.terminal_growth, (v) =>
                  setTerminal({ ...terminal, terminal_growth: v }),
                )}
                {field('Discount rate (%)', terminal.discount_rate, (v) =>
                  setTerminal({ ...terminal, discount_rate: v }),
                )}
              </>
            )}
            {terminal.terminal_method === 'exit_multiple' && (
              <>
                {field('Exit multiple', terminal.exit_multiple, (v) =>
                  setTerminal({ ...terminal, exit_multiple: v }),
                )}
                <Field label="Struck on">
                  <Select
                    aria-label="Struck on"
                    value={terminal.exit_metric}
                    onChange={(e) => setTerminal({ ...terminal, exit_metric: e.target.value })}
                  >
                    <option value="ebitda">Terminal-year EBITDA</option>
                    <option value="revenue">Terminal-year revenue</option>
                  </Select>
                </Field>
              </>
            )}
          </div>

          <Button onClick={project} disabled={busy}>
            {busy ? 'Projecting…' : 'Project'}
          </Button>
        </div>
      )}

      {latest === null ? (
        <div className="mt-6">
          <EmptyState title="No cash-flow projection recorded">
            {applied === null || applied.length === 0
              ? 'The income approach has no cash flows yet. Project them from revenue and margin assumptions above.'
              : 'The valuation is discounting cash flows somebody typed. Project them so the report can say what they rest on.'}
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="mt-6 overflow-x-auto rounded-lg border border-paper-300">
            <table className="w-full min-w-[720px] text-sm" aria-label="Projected free cash flow">
              <thead>
                <tr className="border-b border-paper-300 text-left">
                  <th className="overline px-4 py-3 font-semibold text-ink-400">Line</th>
                  {latest.projections.map((p) => (
                    <th key={p.year} className="overline px-3 py-3 text-right font-semibold text-ink-400">
                      Year {p.year}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['Revenue', 'revenue'],
                    ['COGS', 'cogs'],
                    ['OpEx', 'opex'],
                    ['EBITDA', 'ebitda'],
                    ['D&A', 'da'],
                    ['EBIT', 'ebit'],
                    ['NOPAT', 'nopat'],
                    ['CapEx', 'capex'],
                    ['Δ NWC', 'delta_nwc'],
                  ] as Array<[string, keyof ProjectionYear]>
                ).map(([label, key]) => (
                  <tr key={key} className="border-b border-paper-200">
                    <td className="px-4 py-2 text-ink-500">{label}</td>
                    {latest.projections.map((p) => (
                      <td key={p.year} className="tnum px-3 py-2 text-right text-ink-700">
                        {cash(p[key])}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="border-t border-paper-300 font-semibold">
                  <td className="px-4 py-3 text-ink-900">Free cash flow</td>
                  {latest.projections.map((p) => (
                    <td key={p.year} className="tnum px-3 py-3 text-right text-ink-900">
                      {cash(p.fcff)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-4 text-sm text-ink-500">
            <span>
              Struck at a {(latest.tax_rate * 100).toFixed(1)}% tax rate
              {latest.terminal_value !== null &&
                ` · ${latest.terminal_method === 'gordon' ? 'Gordon' : 'exit-multiple'} terminal value ${cash(latest.terminal_value)}`}
              {latest.terminal_ebitda !== null &&
                ` · terminal EBITDA ${cash(latest.terminal_ebitda)} carried as the exit-multiple basis`}
            </span>
            {!readOnly && latest.applied_at === null && (
              <Button onClick={() => adopt(latest)} disabled={busy}>
                Adopt as the valuation’s cash flows
              </Button>
            )}
          </div>

          <div className="mt-6 overflow-x-auto rounded-lg border border-paper-300">
            <table className="w-full min-w-[560px] text-sm" aria-label="Projection history">
              <thead>
                <tr className="border-b border-paper-300 text-left">
                  <th className="overline px-4 py-3 font-semibold text-ink-400">Run</th>
                  <th className="overline px-4 py-3 font-semibold text-ink-400">Method</th>
                  <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Years</th>
                  <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Year 1 FCF</th>
                  <th className="overline px-4 py-3 font-semibold text-ink-400">Status</th>
                  {!readOnly && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {data.projections.map((row) => (
                  <tr key={row.id} className="border-b border-paper-200 last:border-0">
                    <td className="px-4 py-3 text-ink-500">{row.created_at.slice(0, 10)}</td>
                    <td className="px-4 py-3 text-ink-500">
                      {row.method === 'driver' ? 'Bottom-up' : 'Top-down'}
                    </td>
                    <td className="tnum px-4 py-3 text-right text-ink-500">{row.years}</td>
                    <td className="tnum px-4 py-3 text-right text-ink-700">{cash(row.free_cash_flows[0])}</td>
                    <td className="px-4 py-3 text-ink-500">
                      {row.applied_at ? `Adopted ${row.applied_at.slice(0, 10)}` : 'Forecast only'}
                    </td>
                    {!readOnly && (
                      <td className="px-4 py-3 text-right">
                        {row.applied_at === null && (
                          <Button variant="ghost" onClick={() => adopt(row)} disabled={busy}>
                            Adopt
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
