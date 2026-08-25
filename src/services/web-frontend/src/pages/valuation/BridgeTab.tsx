import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useWorkspace } from './ValuationWorkspace';
import { WaterfallChart } from '../../components/charts';
import { RollforwardPanel } from '../../components/valuation/RollforwardPanel';
import { EmptyState, ErrorNote, Select, Spinner, WriteGate } from '../../components/ui';
import { useLatestOnly } from '../../lib/useLatestOnly';

interface Candidate {
  id: string;
  number: string;
  created_at: string;
  fmv_per_share: string | null;
}

interface BridgeFactor {
  key: string;
  label: string;
  from: number;
  to: number;
  contribution: number;
}
interface BridgeDriver {
  key: string;
  label: string;
  from: number | null;
  to: number | null;
  delta: number | null;
}
interface BridgeResponse {
  bridge: {
    from_fmv: number;
    to_fmv: number;
    delta: number;
    pct_change: number | null;
    factors: BridgeFactor[];
    drivers: BridgeDriver[];
    decomposable: boolean;
  };
  from: { number: string; created_at: string };
  to: { number: string; created_at: string };
  company_name: string;
}

const money = (v: number) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const driverValue = (key: string, v: number | null): string => {
  if (v === null) return '—';
  if (key === 'dlom' || key === 'dloc' || key.startsWith('weight_') || key === 'volatility')
    return `${(v * 100).toFixed(1)}%`;
  if (key === 'equity_value') return `$${Math.round(v).toLocaleString()}`;
  return v.toFixed(2);
};

/**
 * Cross-period value bridge (feature 3): pick an earlier valuation of the same
 * company and see the per-share FMV walk from it to this one, with the LMDI
 * factor attribution as a waterfall and the raw assumption deltas below.
 */
export function BridgeTab() {
  const { valuation, retired } = useWorkspace();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [compareId, setCompareId] = useState('');
  const [data, setData] = useState<BridgeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const claim = useLatestOnly();

  useEffect(() => {
    api<{ candidates: Candidate[] }>(`/valuations/${valuation.id}/bridge-candidates`)
      .then((r) => setCandidates(r.candidates))
      .catch(() => setError('Could not load comparable valuations.'));
  }, [valuation.id]);

  useEffect(() => {
    if (!compareId) {
      setData(null);
      return;
    }
    // A dropdown the analyst flips through: the reply for the comparable they
    // just left can land after the one they are looking at, and the bridge is
    // then a decomposition of a different pair of valuations under the current
    // label. See `useLatestOnly`.
    const current = claim();
    setBusy(true);
    setError(null);
    api<BridgeResponse>(`/valuations/${valuation.id}/bridge/${compareId}`)
      .then((d) => current() && setData(d))
      .catch(
        (err) =>
          current() && setError(err instanceof ApiError ? err.message : 'Could not build the value bridge.'),
      )
      .finally(() => current() && setBusy(false));
  }, [compareId, valuation.id, claim]);

  const steps = useMemo(
    () => data?.bridge.factors.map((f) => ({ label: f.label, value: f.contribution })) ?? [],
    [data],
  );

  if (candidates === null && !error) return <Spinner />;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-ink-900">Value bridge</h2>
        <p className="mt-1 text-sm text-ink-400">
          Explain the change in fair market value per share against an earlier valuation of{' '}
          {valuation.company_name}.
        </p>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {candidates && candidates.length === 0 ? (
        <EmptyState title="No comparable valuations yet">
          Once this company has another completed valuation, you can compare them here.
        </EmptyState>
      ) : (
        <label className="block max-w-md">
          <span className="overline mb-1.5 block text-ink-400">Compare against</span>
          <Select
            value={compareId}
            onChange={(e) => setCompareId(e.target.value)}
            aria-label="Compare against"
          >
            <option value="">Select an earlier valuation…</option>
            {candidates?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.number} · {formatDateTime(c.created_at)}
                {c.fmv_per_share ? ` · ${money(Number(c.fmv_per_share))}` : ''}
              </option>
            ))}
          </Select>
        </label>
      )}

      {busy && <Spinner />}

      {data && (
        <div className="space-y-6" data-testid="bridge-result">
          <div className="flex flex-wrap gap-6 rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
            <Metric label={`From (${data.from.number})`} value={money(data.bridge.from_fmv)} />
            <Metric label={`To (${data.to.number})`} value={money(data.bridge.to_fmv)} />
            <Metric
              label="Change"
              value={`${data.bridge.delta >= 0 ? '+' : ''}${money(data.bridge.delta)}`}
              accent={data.bridge.delta >= 0 ? 'up' : 'down'}
            />
            {data.bridge.pct_change !== null && (
              <Metric
                label="% change"
                value={`${data.bridge.pct_change >= 0 ? '+' : ''}${(data.bridge.pct_change * 100).toFixed(1)}%`}
                accent={data.bridge.pct_change >= 0 ? 'up' : 'down'}
              />
            )}
          </div>

          {data.bridge.decomposable ? (
            <WaterfallChart
              title="Per-share FMV bridge"
              start={{ label: `Prior (${data.from.number})`, value: data.bridge.from_fmv }}
              steps={steps}
              format={money}
            />
          ) : (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
              A factor attribution isn't available (a per-share value is zero or negative), but the totals and
              driver changes are shown below.
            </p>
          )}

          <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-paper-300 bg-surface shadow-card">
            <table className="w-full min-w-[420px] text-sm">
              <caption className="sr-only">Driver changes</caption>
              <thead>
                <tr className="border-b border-paper-300 text-left">
                  <th className="overline px-4 py-3 font-semibold text-ink-400">Driver</th>
                  <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Prior</th>
                  <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Current</th>
                  <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Change</th>
                </tr>
              </thead>
              <tbody>
                {data.bridge.drivers.map((d) => (
                  <tr key={d.key} className="border-b border-paper-200 last:border-0">
                    <td className="px-4 py-2.5 text-ink-700">{d.label}</td>
                    <td className="tnum px-4 py-2.5 text-right text-ink-600">{driverValue(d.key, d.from)}</td>
                    <td className="tnum px-4 py-2.5 text-right text-ink-600">{driverValue(d.key, d.to)}</td>
                    <td className="tnum px-4 py-2.5 text-right font-semibold text-ink-900">
                      {d.delta === null ? '—' : driverValue(d.key, d.delta)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/*
        The other bridge, and the one that moves a number: the value bridge
        above explains a change after the fact, while the roll-forward carries
        the prior 409A's concluded equity value into this engagement's
        backsolve. Same tab because they answer the same question — "what does
        last year's valuation say about this one?" — from either end.
      */}
      {/* Every control on the panel writes: rolling a prior valuation forward
          records a run, and adopting one sets the backsolve anchor. The runs
          already recorded stay legible above them. */}
      <WriteGate closed={retired}>
        <RollforwardPanel valuationId={valuation.id} currency={valuation.currency} candidates={candidates} />
      </WriteGate>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: 'up' | 'down' }) {
  const color = accent === 'up' ? 'text-emerald-700' : accent === 'down' ? 'text-red-700' : 'text-ink-900';
  return (
    <div>
      <div className="overline text-ink-400">{label}</div>
      <div className={`tnum mt-1 font-display text-2xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}
