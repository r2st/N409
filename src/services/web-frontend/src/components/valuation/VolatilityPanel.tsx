import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  InfoTooltip,
  ListTruncationNote,
  LoadError,
  Select,
  Spinner,
  TextInput,
  useRetry,
} from '../ui';

/**
 * Where the expected volatility comes from.
 *
 * The `volatility` parameter has always described itself as "Equity volatility
 * from guideline companies", and until this panel there was no way to derive
 * it from guideline companies: it defaulted to 65% and was whatever an analyst
 * typed over that. It drives the OPM allocation, every option-based DLOM and
 * the ASC 718 assumptions table, and it is the input a reviewing appraiser
 * questions second, after the multiple.
 *
 * The estimator behind it (`engine/v1/volatility` — three estimators, a
 * per-company breakdown, a dispersion-graded confidence) has existed since the
 * engine was written and had no caller anywhere.
 *
 * Two things the panel is deliberate about:
 *
 *   * Estimating and adopting are separate actions. Pressing "Estimate" must
 *     not silently move the concluded value of an engagement somebody may be
 *     mid-review on, so the run is recorded and the analyst decides.
 *   * The applied figure is shown beside the derived one at all times, because
 *     the only thing worse than an underived sigma is a derivation nobody
 *     adopted sitting next to a different number in the report.
 */

const METHODS = [
  { value: 'historical', label: 'Close-to-close (daily log returns)' },
  { value: 'ewma', label: 'EWMA (RiskMetrics, λ = 0.94)' },
  { value: 'parkinson', label: 'Parkinson high-low range' },
] as const;

const WINDOWS = [
  { value: 365, label: '1 year' },
  { value: 730, label: '2 years' },
  { value: 1095, label: '3 years' },
  { value: 1825, label: '5 years' },
] as const;

const CONFIDENCE_TONE: Record<string, string> = {
  high: 'bg-bond-50 text-bond-700 ring-bond-200',
  medium: 'bg-paper-100 text-ink-600 ring-paper-300',
  low: 'bg-amber-50 text-amber-800 ring-amber-200',
  manual: 'bg-paper-100 text-ink-500 ring-paper-300',
};

interface EstimateCompany {
  ticker: string;
  volatility: number;
  used: boolean;
  observations?: number;
}

interface Estimate {
  id: string;
  method: string;
  periods_per_year: number;
  window_start: string;
  window_end: string;
  time_to_exit_years: number | null;
  recommended: number;
  median_volatility: number | null;
  mean_volatility: number | null;
  min_volatility: number | null;
  max_volatility: number | null;
  coefficient_of_variation: number | null;
  confidence: string;
  manual_override: number | null;
  companies: EstimateCompany[];
  excluded: Array<{ ticker: string; reason: string }>;
  measured_count: number;
  applied_at: string | null;
  created_at: string;
}

interface VolatilityResponse {
  estimates: Estimate[];
  applied_volatility: number | null;
  eligible_tickers: string[];
  can_edit: boolean;
  /** True when the peer set behind `eligible_tickers` ran past its page. */
  peers_truncated: boolean;
}

const pct = (v: number | null | undefined, digits = 1): string =>
  typeof v === 'number' ? `${(v * 100).toFixed(digits)}%` : '—';

export function VolatilityPanel({ valuationId }: { valuationId: string }) {
  const [data, setData] = useState<VolatilityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setError(null));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [method, setMethod] = useState<string>('historical');
  const [windowDays, setWindowDays] = useState<number>(365);
  /** A pinned figure, entered as a percentage because that is how it is read. */
  const [manual, setManual] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api<VolatilityResponse>(`/valuations/${valuationId}/volatility`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the volatility derivation.');
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load, token]);

  const run = async (work: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : failure);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const estimate = async () => {
    setNote(null);
    const pinned = manual.trim() === '' ? null : Number(manual.trim()) / 100;
    if (pinned !== null && !(Number.isFinite(pinned) && pinned > 0 && pinned < 5)) {
      setError('A pinned volatility is a percentage between 0 and 500.');
      return;
    }
    await run(async () => {
      const res = await api<{ estimate: Estimate }>(`/valuations/${valuationId}/volatility/estimate`, {
        method: 'POST',
        body: {
          method,
          window_days: windowDays,
          ...(pinned === null ? {} : { manual_override: pinned }),
        },
      });
      const e = res.estimate;
      // The count that matters is the measured one, not the set size — a peer
      // whose feed failed is in the set and not in the median, and reporting
      // only "estimated" would overstate the breadth of the number.
      setNote(
        `${pct(e.recommended)} from ${e.measured_count} ${e.measured_count === 1 ? 'company' : 'companies'}` +
          (e.excluded.length > 0 ? `. Not measured: ${e.excluded.map((x) => x.ticker).join(', ')}.` : '.') +
          ' Not yet adopted as the valuation assumption.',
      );
    }, 'Could not estimate the volatility from the peer set.');
  };

  const apply = (row: Estimate) =>
    run(async () => {
      const res = await api<{ recalculation_required: boolean }>(
        `/valuations/${valuationId}/volatility/${row.id}/apply`,
        { method: 'POST', body: {} },
      );
      setNote(
        res.recalculation_required
          ? `Applied ${pct(row.recommended)}. Re-run the calculation for the concluded value to reflect it.`
          : `Applied ${pct(row.recommended)}. The calculation already ran on this figure.`,
      );
    }, 'Could not adopt the estimate as the valuation assumption.');

  if (error && !data) return <LoadError message={error} {...retryProps} />;
  if (!data) return <Spinner />;

  const latest = data.estimates[0] ?? null;
  const applied = data.applied_volatility;
  // The disagreement the panel exists to surface: a derivation was run and the
  // engagement is on a different number.
  const divergent = latest !== null && applied !== null && Math.abs(applied - latest.recommended) > 0.0001;

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="overline text-ink-400">
            Selected volatility
            <InfoTooltip
              className="ml-1.5"
              label="About the selected volatility"
              text="A private company has no traded price series, so the expected volatility in the allocation is estimated from the observed return volatility of the guideline public companies, taken at the median."
            />
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-400">
            Measured from the included peers above. The derivation is printed as Exhibit F-1 once it has been
            adopted as the valuation assumption.
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
          className="mt-4 rounded-lg border border-paper-300 bg-surface px-4 py-3 text-sm text-ink-500"
        >
          {note}
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-4">
        <div className="rounded-lg border border-paper-300 bg-surface px-5 py-4 shadow-card">
          <div className="overline text-ink-400">Applied in the valuation</div>
          <div className="tnum mt-1 font-display text-2xl font-semibold text-ink-900">{pct(applied)}</div>
          <div className="mt-1 text-xs text-ink-400">
            {applied === null ? 'Engine default — nobody has set one' : 'valuation_params.volatility'}
          </div>
        </div>
        {latest && (
          <div
            className={`rounded-lg border px-5 py-4 shadow-card ${
              divergent ? 'border-amber-300 bg-amber-50' : 'border-paper-300 bg-surface'
            }`}
          >
            <div className="overline text-ink-400">Derived from peers</div>
            <div className="tnum mt-1 font-display text-2xl font-semibold text-ink-900">
              {pct(latest.recommended)}
            </div>
            <div className="mt-1 text-xs text-ink-400">
              {latest.measured_count} {latest.measured_count === 1 ? 'company' : 'companies'} ·{' '}
              {latest.window_start} to {latest.window_end}
              {latest.applied_at === null && ' · not adopted'}
            </div>
          </div>
        )}
      </div>

      {divergent && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          The valuation applies {pct(applied)} against a derived {pct(latest.recommended)}. Either adopt the
          derivation or state the basis for the departure in the report — Exhibit F-1 will print the
          difference either way.
        </p>
      )}

      {data.can_edit && (
        <div className="mt-6 grid gap-4 rounded-lg border border-paper-300 bg-surface p-5 shadow-card sm:grid-cols-4">
          <Field label="Estimator">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Observation window" hint="Measured back from the valuation date, not from today.">
            <Select value={String(windowDays)} onChange={(e) => setWindowDays(Number(e.target.value))}>
              {WINDOWS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Pin a figure (%)"
            hint="Records your own selection against the same peer measurements. Leave blank to take the median."
          >
            <TextInput
              inputMode="decimal"
              placeholder="e.g. 62"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Button onClick={estimate} disabled={busy || data.eligible_tickers.length === 0}>
              Estimate
            </Button>
          </div>
          {/* Not a list this panel draws, but the set the button measures
              over — a figure struck on a page of the peer set is a figure
              nobody can reconcile to the peer set. */}
          <div className="sm:col-span-4">
            <ListTruncationNote
              truncated={data.peers_truncated}
              shown={data.eligible_tickers.length}
              noun="peer tickers"
              hint="an estimate is struck on the tickers listed"
            />
          </div>
          {data.eligible_tickers.length === 0 && (
            <p className="text-sm text-ink-400 sm:col-span-4">
              No included comparable carries a ticker, so there is no price history to measure. Screen the set
              or add a peer with a ticker above.
            </p>
          )}
        </div>
      )}

      {data.estimates.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No volatility derivation recorded">
            The valuation is running on a volatility somebody typed. Estimate it from the peer set so the
            report can say where the figure came from.
          </EmptyState>
        </div>
      ) : (
        <>
          {latest && latest.companies.length > 0 && (
            <div className="mt-6 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
              <table className="w-full min-w-[520px] text-sm" aria-label="Per-company volatility">
                <thead>
                  <tr className="border-b border-paper-300 text-left">
                    <th className="overline px-5 py-3 font-semibold text-ink-400">Company</th>
                    <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Volatility</th>
                    <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Observations</th>
                    <th className="overline px-5 py-3 font-semibold text-ink-400">Treatment</th>
                  </tr>
                </thead>
                <tbody>
                  {[...latest.companies]
                    .sort((a, b) => b.volatility - a.volatility)
                    .map((c) => (
                      <tr
                        key={c.ticker}
                        className={`border-b border-paper-200 last:border-0 ${c.used ? '' : 'bg-paper-50 text-ink-400'}`}
                      >
                        <td className="px-5 py-3 font-medium text-ink-900">{c.ticker}</td>
                        <td className="tnum px-4 py-3 text-right">{pct(c.volatility)}</td>
                        <td className="tnum px-4 py-3 text-right">{c.observations ?? '—'}</td>
                        <td className="px-5 py-3">{c.used ? 'Included' : 'Excluded'}</td>
                      </tr>
                    ))}
                  <tr className="border-t border-paper-300 font-semibold">
                    <td className="px-5 py-3 text-ink-900">Median — selected</td>
                    <td className="tnum px-4 py-3 text-right text-ink-900">{pct(latest.recommended)}</td>
                    <td />
                    <td className="px-5 py-3 text-ink-500">
                      {pct(latest.min_volatility)}–{pct(latest.max_volatility)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {latest && latest.excluded.length > 0 && (
            <div className="mt-4 rounded-lg border border-paper-300 bg-surface px-5 py-4 text-sm text-ink-500">
              <div className="overline text-ink-400">Considered and not measured</div>
              <ul className="mt-2 space-y-1">
                {latest.excluded.map((x) => (
                  <li key={x.ticker}>
                    <span className="font-medium text-ink-700">{x.ticker}</span> — {x.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-6 overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
            <table className="w-full min-w-[640px] text-sm" aria-label="Volatility derivation history">
              <thead>
                <tr className="border-b border-paper-300 text-left">
                  <th className="overline px-5 py-3 font-semibold text-ink-400">Run</th>
                  <th className="overline px-4 py-3 font-semibold text-ink-400">Estimator</th>
                  <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Selected</th>
                  <th className="overline px-4 py-3 font-semibold text-ink-400">Confidence</th>
                  <th className="overline px-5 py-3 font-semibold text-ink-400">Status</th>
                  {data.can_edit && <th className="px-5 py-3" />}
                </tr>
              </thead>
              <tbody>
                {data.estimates.map((row) => (
                  <tr key={row.id} className="border-b border-paper-200 last:border-0">
                    <td className="px-5 py-3 text-ink-500">
                      {row.created_at.slice(0, 10)}
                      <div className="text-xs text-ink-400">
                        {row.window_start} to {row.window_end}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-ink-500">
                      {METHODS.find((m) => m.value === row.method)?.label ?? row.method}
                    </td>
                    <td className="tnum px-4 py-3 text-right font-medium text-ink-900">
                      {pct(row.recommended)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[0.7rem] font-semibold ring-1 ring-inset ${
                          CONFIDENCE_TONE[row.confidence] ?? CONFIDENCE_TONE.medium
                        }`}
                      >
                        {row.confidence}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-ink-500">
                      {row.applied_at ? `Adopted ${row.applied_at.slice(0, 10)}` : 'Estimate only'}
                    </td>
                    {data.can_edit && (
                      <td className="px-5 py-3 text-right">
                        {row.applied_at === null && (
                          <Button variant="ghost" onClick={() => apply(row)} disabled={busy}>
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
