import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeActionFailure } from '../../lib/api';
import { formatMoney } from '../../lib/pipeline';
import { formatDateTime, formatPerShare } from '../../lib/format';
import { useWorkspace } from './ValuationWorkspace';
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  LoadError,
  Select,
  Spinner,
  StatCard,
  TextInput,
  WriteGate,
  useRetry,
} from '../../components/ui';

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
  /**
   * Why there is no baseline, in the server's words, or `null` when there is
   * one. A completed run of the wrong shape is not "no calculation yet": a
   * specialty engine's run carries no weighted approaches and no income or
   * market assumptions for these knobs to move, so telling the client to check
   * back once the valuation is drafted would be telling them to wait for
   * something that has already happened. Composed server-side (`routes/scenarios.ts`)
   * because the browser cannot see which runs exist, and a mirrored kind list
   * here would be a second answer to the same question.
   */
  unavailable_reason?: string | null;
}

interface PreviewResponse {
  scenario: { equity_value: number; fmv_per_share: number };
  baseline: Baseline;
  delta: { equity_value: number | null; fmv_per_share: number | null };
  currency: string;
}

/** IMPROVEMENTS_RESEARCH §5.7 — saved bull/base/bear/custom cases. */
export const SCENARIO_LABELS = ['bull', 'base', 'bear', 'custom'] as const;
export type ScenarioLabel = (typeof SCENARIO_LABELS)[number];

const LABEL_STYLES: Record<ScenarioLabel, string> = {
  bull: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  base: 'bg-bond-50 text-bond-700 ring-bond-200',
  bear: 'bg-red-50 text-red-700 ring-red-200',
  custom: 'bg-paper-100 text-ink-500 ring-paper-300',
};

interface SavedScenario {
  id: string;
  name: string;
  label: ScenarioLabel;
  inputs: Record<string, unknown>;
  equity_value: string | null;
  fmv_per_share: string | null;
  created_at: string;
}

interface ScenarioListResponse {
  scenarios: SavedScenario[];
  baseline: Baseline | null;
  currency: string;
  max_scenarios: number;
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
  const { valuation, retired } = useWorkspace();
  const [boot, setBoot] = useState<BaselineResponse | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const { token, retryProps } = useRetry(() => setBootError(null));
  const [knobs, setKnobs] = useState<Knobs | null>(null);
  const [defaults, setDefaults] = useState<Knobs | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [computing, setComputing] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);

  // Saved bull/base/bear cases (§5.7) — side-by-side comparison state.
  const [saved, setSaved] = useState<ScenarioListResponse | null>(null);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [saveName, setSaveName] = useState('');
  const [saveLabel, setSaveLabel] = useState<ScenarioLabel>('custom');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /*
   * A failed read is said, and does not erase what was read before (R352, M5).
   *
   * `setSaved(null)` hid the whole comparison section, which is the one place
   * a saved bull/base/bear case is ever shown: a 403, a 503 or a dropped
   * connection rendered as *this engagement has no saved scenarios*, beside a
   * form still inviting one to be saved. Worse on the refresh path — this runs
   * after `saveScenario` and `deleteScenario` succeed, so a save that landed
   * followed by a reload that did not made the case the user had just stored
   * vanish, which reads as the save having done nothing.
   *
   * So: keep the last list that did arrive, and put the reason above it.
   */
  const loadSaved = useCallback(async () => {
    try {
      setSaved(await api<ScenarioListResponse>(`/valuations/${valuation.id}/scenarios`));
      setSavedError(null);
    } catch (err) {
      setSavedError(describeActionFailure(err, 'Could not load the saved scenarios.'));
    }
  }, [valuation.id]);

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
        setBootError(describeActionFailure(err, 'Could not load the scenario sandbox.'));
      }
    })();
    void loadSaved();
  }, [valuation.id, loadSaved, token]);

  const saveScenario = async () => {
    if (!knobs || !defaults) return;
    const body = toPreviewBody(knobs, defaults);
    if (!body) {
      setSaveError('Fix the highlighted assumptions before saving.');
      return;
    }
    setSaveBusy(true);
    setSaveError(null);
    try {
      await api(`/valuations/${valuation.id}/scenarios`, {
        method: 'POST',
        body: { ...body, name: saveName.trim(), label: saveLabel },
      });
      setSaveName('');
      await loadSaved();
    } catch (err) {
      setSaveError(describeActionFailure(err, 'Could not save the scenario.'));
    } finally {
      setSaveBusy(false);
    }
  };

  const deleteScenario = async (scenarioId: string) => {
    try {
      await api(`/valuations/${valuation.id}/scenarios/${scenarioId}`, { method: 'DELETE' });
      await loadSaved();
    } catch (err) {
      setSaveError(describeActionFailure(err, 'Could not delete the scenario.'));
    }
  };

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
            setPreviewError(describeActionFailure(err, 'Preview failed.'));
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
    // Abandon whatever is already in flight, too. Clearing the timer only stops
    // a preview that has not been sent yet; one that has still resolves, and
    // its `seq === requestSeq.current` check still passed, so it landed *after*
    // the reset and put the scenario's figures and delta badges back on the
    // cards under knobs the client can see are the baseline's — the sandbox
    // showing a number for assumptions that are not on screen, which is the one
    // failure this tab exists to avoid. Bumping the sequence is the same guard
    // the out-of-order case uses, applied to a request nothing replaced.
    requestSeq.current++;
    setComputing(false);
  };

  if (bootError) return <LoadError message={bootError} {...retryProps} />;
  if (!boot) return <Spinner />;

  if (!boot.baseline || !knobs || !defaults) {
    return (
      <EmptyState title="No calculation to explore yet">
        {boot.unavailable_reason ??
          'The what-if sandbox opens once your valuation has its first completed calculation.'}
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
              {formatPerShare(current.fmv_per_share, currency)}
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
        <StatCard
          label="Baseline FMV / share"
          value={formatPerShare(boot.baseline.fmv_per_share, currency)}
        />
      </div>

      {previewError && <ErrorNote>{previewError}</ErrorNote>}
      {computing && <p className="text-xs text-ink-400">Recomputing…</p>}

      <WriteGate closed={retired}>
        <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
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

          {/* §5.7 — persist the current knobs as a named bull/base/bear case. */}
          <div className="mt-6 border-t border-paper-200 pt-5">
            <h3 className="mb-3 text-sm font-semibold text-ink-900">Save as a scenario</h3>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1">
                <TextInput
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  placeholder="e.g. Bull case — 2027 raise"
                  aria-label="Scenario name"
                />
              </div>
              <Select
                value={saveLabel}
                onChange={(e) => setSaveLabel(e.target.value as ScenarioLabel)}
                aria-label="Scenario label"
                className="w-32"
              >
                {SCENARIO_LABELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
              <Button onClick={() => void saveScenario()} disabled={saveBusy || saveName.trim() === ''}>
                {saveBusy ? 'Saving…' : 'Save scenario'}
              </Button>
            </div>
            {saveError && (
              <p role="alert" className="mt-2 text-sm text-red-600">
                {saveError}
              </p>
            )}
          </div>
        </section>
      </WriteGate>

      {(savedError || (saved && saved.scenarios.length > 0)) && (
        <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
          <div className="mb-4 flex items-center justify-between">
            <h2 id="scenario-comparison-heading" className="overline text-ink-400">
              Scenario comparison
            </h2>
            {saved && saved.scenarios.length > 0 && (
              <span className="text-xs text-ink-400">
                {saved.scenarios.length} of {saved.max_scenarios}
              </span>
            )}
          </div>
          {savedError && (
            <p role="alert" className="mb-4 text-sm text-red-600">
              {savedError}
            </p>
          )}
          {saved && saved.scenarios.length > 0 && (
          <div className="overflow-x-auto overscroll-x-contain">
            <table
              className="w-full text-left text-sm"
              data-testid="scenario-comparison"
              aria-labelledby="scenario-comparison-heading"
            >
              <thead>
                <tr className="border-b border-paper-300 text-xs text-ink-400">
                  <th className="py-2 pr-4 font-semibold">Scenario</th>
                  <th className="py-2 pr-4 font-semibold">FMV / share</th>
                  <th className="py-2 pr-4 font-semibold">Equity value</th>
                  <th className="py-2 pr-4 font-semibold">Δ vs baseline</th>
                  <th className="py-2 pr-4 font-semibold">Saved</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {saved.baseline && (
                  <tr className="border-b border-paper-200 bg-paper-50">
                    <td className="py-2.5 pr-4 font-semibold text-ink-800">Baseline (official)</td>
                    <td className="tnum py-2.5 pr-4">
                      {formatPerShare(saved.baseline.fmv_per_share, currency)}
                    </td>
                    <td className="tnum py-2.5 pr-4">{formatMoney(saved.baseline.equity_value, currency)}</td>
                    <td className="py-2.5 pr-4 text-ink-400">—</td>
                    <td className="py-2.5 pr-4 text-ink-400">—</td>
                    <td />
                  </tr>
                )}
                {saved.scenarios.map((scenario) => {
                  const equity = scenario.equity_value != null ? Number(scenario.equity_value) : null;
                  const delta =
                    equity != null && saved.baseline?.equity_value != null
                      ? equity - saved.baseline.equity_value
                      : null;
                  return (
                    <tr key={scenario.id} className="border-b border-paper-200 last:border-0">
                      <td className="py-2.5 pr-4">
                        <span className="font-medium text-ink-800">{scenario.name}</span>
                        <span
                          className={`ml-2 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${LABEL_STYLES[scenario.label]}`}
                        >
                          {scenario.label}
                        </span>
                      </td>
                      <td className="tnum py-2.5 pr-4">{formatPerShare(scenario.fmv_per_share, currency)}</td>
                      <td className="tnum py-2.5 pr-4">{formatMoney(scenario.equity_value, currency)}</td>
                      <td className="py-2.5 pr-4">
                        <DeltaBadge delta={delta} currency={currency} />
                        {(delta === null || Math.abs(delta) < 1e-9) && (
                          <span className="text-ink-400">—</span>
                        )}
                      </td>
                      <td className="tnum py-2.5 pr-4 text-xs text-ink-400">
                        {formatDateTime(scenario.created_at)}
                      </td>
                      <td className="py-2.5 text-right">
                        <WriteGate closed={retired}>
                          <button
                            onClick={() => void deleteScenario(scenario.id)}
                            className="cursor-pointer text-xs font-semibold text-red-600 hover:text-red-700"
                            aria-label={`Delete scenario ${scenario.name}`}
                          >
                            Delete
                          </button>
                        </WriteGate>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}
        </section>
      )}
    </div>
  );
}
