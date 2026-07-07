import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { formatMoney } from '../../lib/pipeline';
import { useWorkspace } from './ValuationWorkspace';
import { EmptyState, ErrorNote, Field, Spinner, StatCard, TextInput } from '../../components/ui';

interface Baseline {
  calculation_id: string;
  created_at: string;
  equity_value: number | null;
  fmv_per_share: number | null;
}

interface BaselineResponse {
  baseline: Baseline | null;
  defaults: {
    revenue: number | null;
    growth_rate: number | null;
    discount_rate: number | null;
    multiples: number[] | null;
    volatility: number | null;
  } | null;
  approaches: { asset: boolean; opm_backsolve: boolean; income: boolean; market: boolean } | null;
  currency: string;
}

interface PreviewResponse {
  scenario: { equity_value: number; fmv_per_share: number };
  baseline: Baseline;
  delta: { equity_value: number | null; fmv_per_share: number | null };
  currency: string;
}

/** Form state is kept as strings so partially-typed numbers don't fight the user. */
interface Knobs {
  revenue: string;
  growth_rate: string;
  discount_rate: string;
  multiples: string;
}

function knobsFromDefaults(d: NonNullable<BaselineResponse['defaults']>): Knobs {
  return {
    revenue: d.revenue != null ? String(d.revenue) : '',
    // Rates are edited as percentages — friendlier for clients than decimals.
    growth_rate: d.growth_rate != null ? String(Math.round(d.growth_rate * 10000) / 100) : '',
    discount_rate: d.discount_rate != null ? String(Math.round(d.discount_rate * 10000) / 100) : '',
    multiples: d.multiples ? d.multiples.join(', ') : '',
  };
}

/** Builds the preview body from the knobs; returns null while an entry is unparseable. */
function toPreviewBody(knobs: Knobs, defaults: Knobs): Record<string, unknown> | null {
  const body: Record<string, unknown> = {};
  const num = (s: string): number | null => {
    const n = Number(s.trim());
    return s.trim() !== '' && Number.isFinite(n) ? n : null;
  };
  if (knobs.revenue.trim() !== '' && knobs.revenue !== defaults.revenue) {
    const v = num(knobs.revenue);
    if (v === null || v <= 0) return null;
    body.revenue = v;
  }
  if (knobs.growth_rate.trim() !== '' && knobs.growth_rate !== defaults.growth_rate) {
    const v = num(knobs.growth_rate);
    if (v === null) return null;
    body.growth_rate = v / 100;
  }
  if (knobs.discount_rate.trim() !== '' && knobs.discount_rate !== defaults.discount_rate) {
    const v = num(knobs.discount_rate);
    if (v === null || v <= 0) return null;
    body.discount_rate = v / 100;
  }
  if (knobs.multiples.trim() !== '' && knobs.multiples !== defaults.multiples) {
    const parts = knobs.multiples.split(',').map((p) => Number(p.trim()));
    if (parts.length === 0 || parts.some((p) => !Number.isFinite(p) || p <= 0)) return null;
    body.multiples = parts;
  }
  return body;
}

function DeltaBadge({ delta, currency }: { delta: number | null; currency: string }) {
  if (delta === null || Math.abs(delta) < 1e-9) return null;
  const up = delta > 0;
  return (
    <span
      className={`ml-2 rounded-full px-2 py-0.5 text-xs font-semibold ${
        up ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
      }`}
    >
      {up ? '▲' : '▼'} {formatMoney(Math.abs(delta), currency)}
    </span>
  );
}

/**
 * Improvement 3 — "What-If Scenarios" sandbox. Clients adjust the headline
 * assumptions and watch the value respond in real time. Strictly read-only:
 * previews never touch the official calculation or the valuation.
 */
export function ScenariosTab() {
  const { valuation } = useWorkspace();
  const [boot, setBoot] = useState<BaselineResponse | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [knobs, setKnobs] = useState<Knobs | null>(null);
  const [defaults, setDefaults] = useState<Knobs | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [computing, setComputing] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api<BaselineResponse>(`/valuations/${valuation.id}/scenarios/baseline`);
        setBoot(res);
        if (res.defaults) {
          const k = knobsFromDefaults(res.defaults);
          setKnobs(k);
          setDefaults(k);
        }
      } catch (err) {
        setBootError(err instanceof ApiError ? err.message : 'Could not load the scenario sandbox.');
      }
    })();
  }, [valuation.id]);

  const runPreview = useCallback(
    (body: Record<string, unknown>) => {
      const seq = ++requestSeq.current;
      setComputing(true);
      setPreviewError(null);
      void api<PreviewResponse>(`/valuations/${valuation.id}/scenarios/preview`, {
        method: 'POST',
        body,
      })
        .then((res) => {
          if (seq === requestSeq.current) setPreview(res);
        })
        .catch((err) => {
          if (seq === requestSeq.current) {
            setPreviewError(err instanceof ApiError ? err.message : 'Preview failed.');
          }
        })
        .finally(() => {
          if (seq === requestSeq.current) setComputing(false);
        });
    },
    [valuation.id],
  );

  // Real-time: preview 400ms after the last keystroke.
  const update = (patch: Partial<Knobs>) => {
    if (!knobs || !defaults) return;
    const next = { ...knobs, ...patch };
    setKnobs(next);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      const body = toPreviewBody(next, defaults);
      if (body) runPreview(body);
    }, 400);
  };

  const reset = () => {
    if (!defaults) return;
    setKnobs(defaults);
    setPreview(null);
    setPreviewError(null);
    if (debounce.current) clearTimeout(debounce.current);
  };

  if (bootError) return <ErrorNote>{bootError}</ErrorNote>;
  if (!boot) return <Spinner />;

  if (!boot.baseline || !knobs || !defaults) {
    return (
      <EmptyState title="No calculation to explore yet">
        The what-if sandbox opens once your valuation has its first completed calculation.
      </EmptyState>
    );
  }

  const currency = boot.currency ?? 'USD';
  const showIncome = boot.approaches?.income ?? true;
  const showMarket = boot.approaches?.market ?? true;
  const current = preview?.scenario ?? {
    equity_value: boot.baseline.equity_value,
    fmv_per_share: boot.baseline.fmv_per_share,
  };

  return (
    <div className="space-y-6">
      <div className="rounded-md border border-bond-200 bg-bond-50 px-4 py-3 text-sm text-bond-700">
        Sandbox only — adjusting these assumptions never changes your official valuation.
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Scenario FMV / share"
          accent
          value={
            <>
              {formatMoney(current.fmv_per_share, currency)}
              <DeltaBadge delta={preview?.delta.fmv_per_share ?? null} currency={currency} />
            </>
          }
        />
        <StatCard
          label="Scenario equity value"
          value={
            <>
              {formatMoney(current.equity_value, currency)}
              <DeltaBadge delta={preview?.delta.equity_value ?? null} currency={currency} />
            </>
          }
        />
        <StatCard label="Baseline FMV / share" value={formatMoney(boot.baseline.fmv_per_share, currency)} />
      </div>

      {previewError && <ErrorNote>{previewError}</ErrorNote>}
      {computing && <p className="text-xs text-ink-400">Recomputing…</p>}

      <section className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="overline text-ink-400">Adjust assumptions</h2>
          <button
            onClick={reset}
            className="cursor-pointer text-sm font-semibold text-bond-600 hover:text-bond-700"
          >
            Reset to baseline
          </button>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          {showMarket && (
            <Field label="Revenue" hint={`Trailing revenue used by the market approach (${currency}).`}>
              <TextInput
                inputMode="decimal"
                value={knobs.revenue}
                onChange={(e) => update({ revenue: e.target.value })}
                placeholder={defaults.revenue || 'e.g. 5000000'}
              />
            </Field>
          )}
          {showMarket && (
            <Field label="Comparable multiples" hint="Comma-separated, e.g. 4.5, 6, 8.">
              <TextInput
                value={knobs.multiples}
                onChange={(e) => update({ multiples: e.target.value })}
                placeholder={defaults.multiples || 'e.g. 4.5, 6, 8'}
              />
            </Field>
          )}
          {showIncome && (
            <Field label="Discount rate (%)" hint="Rate used to discount future cash flows.">
              <TextInput
                inputMode="decimal"
                value={knobs.discount_rate}
                onChange={(e) => update({ discount_rate: e.target.value })}
                placeholder={defaults.discount_rate || 'e.g. 25'}
              />
            </Field>
          )}
          {showIncome && (
            <Field label="Terminal growth rate (%)" hint="Long-run growth after the projection horizon.">
              <TextInput
                inputMode="decimal"
                value={knobs.growth_rate}
                onChange={(e) => update({ growth_rate: e.target.value })}
                placeholder={defaults.growth_rate || 'e.g. 3'}
              />
            </Field>
          )}
        </div>
        {!showIncome && !showMarket && (
          <p className="mt-4 text-sm text-ink-400">
            This valuation is weighted entirely on approaches without adjustable assumptions.
          </p>
        )}
      </section>
    </div>
  );
}
