import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { formatDate, moneyFormatter } from '../../lib/format';
import { Button, EmptyState, ErrorNote, Field, InfoTooltip, Select, Spinner, TextInput } from '../ui';

/**
 * Roll-forward — the bridge from the prior 409A to this one.
 *
 * The endpoints behind this panel (routes/rollforward.ts, migration 0150) went
 * in without a caller: an analyst could roll an engagement forward only by
 * POSTing to the API by hand, which means in practice nobody did, which means
 * the feature the engine has carried since it was written stayed switched off.
 * This is the surface that turns it on.
 *
 * It inherits the two rules the route is built around, and the shape follows
 * VolatilityPanel for the same reason they do:
 *
 *   * Running and adopting are separate presses. "Roll forward" records a
 *     proposal; it must not move the backsolve anchor of an engagement somebody
 *     may be mid-review on. Adoption is its own button, on its own row.
 *   * The anchor the calculation would read today is shown beside the rolled
 *     value at all times. A roll-forward nobody adopted, sitting next to a
 *     different anchor, is the one failure mode the panel exists to make
 *     visible — Exhibit B-2 only prints an adopted run.
 *
 * The prior valuation comes from `bridge-candidates`, which is already "other
 * valuations of this company with a completed calculation" — exactly the set a
 * roll-forward can start from, since the prior *concluded equity value* is what
 * it carries forward.
 */

/** One step of the calibration trail, as the run stores it. */
interface CalibrationStep {
  step: string;
  value: number;
  annual_rate?: number;
  years?: number;
  factor?: number;
  label?: string;
}

interface MaterialChange {
  field: string;
  material: boolean;
  detail: string;
  delta_pct?: number;
}

interface RollforwardRun {
  id: string;
  prior_valuation_id: string | null;
  prior_calculation_id: string | null;
  prior_valuation_number: string | null;
  prior_valuation_date: string;
  new_valuation_date: string;
  years_elapsed: number;
  prior_equity_value: number;
  rolled_equity_value: number;
  annual_accretion: number;
  new_round_post_money: number | null;
  calibration_steps: CalibrationStep[];
  material_changes: MaterialChange[];
  requires_full_revaluation: boolean;
  material_change_count: number;
  applied_at: string | null;
  created_at: string;
}

interface RollforwardResponse {
  runs: RollforwardRun[];
  applied_anchor: number | null;
  new_valuation_date: string | null;
  rolling_forward: boolean;
  can_edit: boolean;
}

interface Candidate {
  id: string;
  number: string;
  created_at: string;
  fmv_per_share: string | null;
}

/** A pending adjustment row in the form, before it is sent. */
interface AdjustmentDraft {
  key: number;
  label: string;
  pct: string;
  amount: string;
}

const STEP_LABELS: Record<string, string> = {
  prior_equity_value: 'Prior concluded equity value',
  new_round_post_money: 'New priced round supersedes the prior value',
  time_accretion: 'Time accretion',
  adjustment: 'Adjustment',
};

/** `revenue` → `Revenue`, for a change field the panel has no gloss for. */
const FIELD_LABELS: Record<string, string> = {
  new_round: 'New priced round',
  valuation_date: 'Elapsed time',
  revenue: 'Revenue',
  share_classes: 'Share classes',
};

const titleise = (field: string): string =>
  FIELD_LABELS[field] ?? field.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const pct = (v: number | null | undefined, digits = 1): string =>
  typeof v === 'number' ? `${(v * 100).toFixed(digits)}%` : '—';

/** The tolerance the anchor comparison uses — half a cent, in whole currency. */
const ANCHOR_EPSILON = 0.005;

/** Row identity for the adjustment drafts; see `addAdjustment`. */
let nextKey = 1;

export function RollforwardPanel({
  valuationId,
  currency = 'USD',
  candidates: given,
}: {
  valuationId: string;
  currency?: string | null;
  /**
   * The prior-valuation candidates, when the host already has them — the value
   * bridge on the same tab loads exactly this list, and two components fetching
   * one endpoint is a request the server did not need to serve. Omitted, the
   * panel loads them itself and stands alone.
   */
  candidates?: Candidate[] | null;
}) {
  const [data, setData] = useState<RollforwardResponse | null>(null);
  const [fetched, setFetched] = useState<Candidate[] | null>(null);
  const candidates = given ?? fetched;
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [priorId, setPriorId] = useState('');
  /** Entered as a percentage, because that is how a cost of capital is read. */
  const [accretion, setAccretion] = useState('');
  const [newRound, setNewRound] = useState('');
  const [adjustments, setAdjustments] = useState<AdjustmentDraft[]>([]);

  const money = useMemo(
    () => moneyFormatter(currency, { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
    [currency],
  );
  const amount = (v: number | null | undefined): string => (typeof v === 'number' ? money(v) : '—');

  const load = useCallback(async () => {
    try {
      setData(await api<RollforwardResponse>(`/valuations/${valuationId}/rollforward`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the roll-forward.');
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (given !== undefined) return;
    // Soft-failing on its own: without the candidate list the panel can still
    // show the runs already recorded, which is most of what a reader wants.
    api<{ candidates: Candidate[] }>(`/valuations/${valuationId}/bridge-candidates`)
      .then((r) => setFetched(r.candidates))
      .catch(() => setFetched([]));
  }, [valuationId, given]);

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

  const rollForward = async () => {
    setNote(null);
    if (priorId === '') {
      setError('Choose the prior valuation this engagement rolls forward from.');
      return;
    }

    let annualAccretion: number | undefined;
    if (accretion.trim() !== '') {
      const n = Number(accretion.trim()) / 100;
      // The engine's own band, stated where the number is typed: a rate at or
      // below -100% is a typo, and 2000 entered for 20 is a plausible slip.
      if (!(Number.isFinite(n) && n > -1 && n <= 10)) {
        setError('The annual accretion is a percentage above -100 and no more than 1000.');
        return;
      }
      annualAccretion = n;
    }

    let postMoney: number | undefined;
    if (newRound.trim() !== '') {
      const n = Number(newRound.trim().replace(/[,\s]/g, ''));
      if (!(Number.isFinite(n) && n > 0)) {
        setError('A new round post-money is an amount above zero.');
        return;
      }
      postMoney = n;
    }

    const valueAdjustments: Array<{ label: string; pct?: number; amount?: number }> = [];
    for (const adj of adjustments) {
      const label = adj.label.trim();
      const hasPct = adj.pct.trim() !== '';
      const hasAmount = adj.amount.trim() !== '';
      if (label === '' || (!hasPct && !hasAmount)) {
        setError('Every adjustment needs a label and either a percentage or an amount.');
        return;
      }
      const p = hasPct ? Number(adj.pct.trim()) / 100 : null;
      if (p !== null && !(Number.isFinite(p) && p > -0.99 && p <= 10)) {
        setError(`"${label}" is a percentage between -99 and 1000.`);
        return;
      }
      const a = hasAmount ? Number(adj.amount.trim().replace(/[,\s]/g, '')) : null;
      if (a !== null && !Number.isFinite(a)) {
        setError(`"${label}" is not an amount.`);
        return;
      }
      valueAdjustments.push({
        label,
        ...(p === null ? {} : { pct: p }),
        ...(a === null ? {} : { amount: a }),
      });
    }

    await run(async () => {
      const res = await api<{ run: RollforwardRun }>(`/valuations/${valuationId}/rollforward`, {
        method: 'POST',
        body: {
          prior_valuation_id: priorId,
          ...(annualAccretion === undefined ? {} : { annual_accretion: annualAccretion }),
          ...(postMoney === undefined ? {} : { new_round_post_money: postMoney }),
          ...(valueAdjustments.length > 0 ? { value_adjustments: valueAdjustments } : {}),
        },
      });
      const r = res.run;
      setNote(
        `${amount(r.prior_equity_value)} rolled to ${amount(r.rolled_equity_value)} over ` +
          `${r.years_elapsed.toFixed(2)} years at ${pct(r.annual_accretion)}. ` +
          'Not yet adopted as the backsolve anchor.',
      );
    }, 'Could not roll the prior valuation forward.');
  };

  const adopt = (row: RollforwardRun) =>
    run(async () => {
      const res = await api<{ recalculation_required: boolean }>(
        `/valuations/${valuationId}/rollforward/${row.id}/apply`,
        { method: 'POST', body: {} },
      );
      setNote(
        res.recalculation_required
          ? `Adopted ${amount(row.rolled_equity_value)} as the backsolve anchor. Re-run the calculation for ` +
              'the concluded value to reflect it.'
          : `Adopted ${amount(row.rolled_equity_value)}. The calculation already ran on this anchor.`,
      );
    }, 'Could not adopt the roll-forward as the backsolve anchor.');

  const addAdjustment = () =>
    setAdjustments((rows) =>
      // Keyed off a monotonic counter rather than the index, so removing a row
      // above an edited one doesn't hand its state to its neighbour.
      rows.length >= 10 ? rows : [...rows, { key: nextKey++, label: '', pct: '', amount: '' }],
    );
  const setAdjustment = (key: number, patch: Partial<AdjustmentDraft>) =>
    setAdjustments((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const dropAdjustment = (key: number) => setAdjustments((rows) => rows.filter((r) => r.key !== key));

  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;

  const latest = data.runs[0] ?? null;
  const applied = data.applied_anchor;
  const adopted = data.runs.find((r) => r.applied_at !== null) ?? null;
  // The disagreement the panel exists to surface: a bridge was struck and the
  // engagement is calculating on a different anchor.
  const divergent =
    latest !== null &&
    applied !== null &&
    Math.abs(applied - latest.rolled_equity_value) > ANCHOR_EPSILON;
  const datedForRun = data.new_valuation_date !== null;
  const noCandidates = candidates !== null && candidates.length === 0;

  return (
    <section className="mt-10">
      <div>
        <h2 className="overline text-ink-400">
          Roll-forward from the prior 409A
          <InfoTooltip
            className="ml-1.5"
            label="About the roll-forward"
            text="When a company re-values without a new priced round, the prior appraisal's backsolve equity value is the only figure on the engagement calibrated to an arm's-length transaction. A roll-forward carries it to this valuation date rather than discarding it."
          />
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-400">
          Carries the prior engagement's concluded equity value forward to this valuation date. The
          calibration is printed as Exhibit B-2 once a run has been adopted as the backsolve anchor.
        </p>
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {note && (
        <div className="mt-4 rounded-lg border border-paper-300 bg-surface px-4 py-3 text-sm text-ink-500">
          {note}
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-4">
        <div className="rounded-lg border border-paper-300 bg-surface px-5 py-4 shadow-card">
          <div className="overline text-ink-400">Applied backsolve anchor</div>
          <div className="tnum mt-1 font-display text-2xl font-semibold text-ink-900">{amount(applied)}</div>
          <div className="mt-1 text-xs text-ink-400">
            {applied === null ? 'No anchor set on the engine inputs' : 'inputs.last_round_post_money'}
            {data.rolling_forward && ' · marked as rolling forward'}
          </div>
        </div>
        {latest && (
          <div
            className={`rounded-lg border px-5 py-4 shadow-card ${
              divergent ? 'border-amber-300 bg-amber-50' : 'border-paper-300 bg-surface'
            }`}
          >
            <div className="overline text-ink-400">Rolled forward</div>
            <div className="tnum mt-1 font-display text-2xl font-semibold text-ink-900">
              {amount(latest.rolled_equity_value)}
            </div>
            <div className="mt-1 text-xs text-ink-400">
              {latest.prior_valuation_number ?? 'Prior valuation'} · {latest.prior_valuation_date} to{' '}
              {latest.new_valuation_date}
              {latest.applied_at === null && ' · not adopted'}
            </div>
          </div>
        )}
      </div>

      {divergent && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          The engagement anchors on {amount(applied)} against a rolled {amount(latest.rolled_equity_value)}.
          Adopt the roll-forward, or leave it as working material — Exhibit B-2 only prints a run that was
          adopted.
        </p>
      )}

      {latest?.requires_full_revaluation && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {latest.material_change_count} material{' '}
          {latest.material_change_count === 1 ? 'change' : 'changes'} since the prior valuation. A
          roll-forward is not a substitute for a full revaluation where the business has moved materially —
          state the basis if you adopt it anyway.
        </p>
      )}

      {data.can_edit && (
        <div className="mt-6 rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="sm:col-span-2">
              <Field
                label="Prior valuation"
                hint="Another valuation of this company with a completed calculation."
              >
                <Select value={priorId} onChange={(e) => setPriorId(e.target.value)}>
                  <option value="">Select the prior valuation…</option>
                  {(candidates ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.number} · {formatDate(c.created_at)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field
              label="Annual accretion (%)"
              hint="Leave blank to use the cost of capital the prior appraisal concluded."
            >
              <TextInput
                inputMode="decimal"
                placeholder="e.g. 18"
                value={accretion}
                onChange={(e) => setAccretion(e.target.value)}
              />
            </Field>
            <Field
              label="New round post-money"
              hint="A round priced since the prior valuation supersedes the time accretion entirely."
            >
              <TextInput
                inputMode="decimal"
                placeholder="e.g. 60000000"
                value={newRound}
                onChange={(e) => setNewRound(e.target.value)}
              />
            </Field>
          </div>

          {adjustments.length > 0 && (
            <div className="mt-4 space-y-3">
              {adjustments.map((adj, i) => (
                <div key={adj.key} className="grid items-end gap-3 sm:grid-cols-4">
                  <div className="sm:col-span-2">
                    <Field label="Adjustment">
                      <TextInput
                        placeholder="e.g. Loss of anchor customer"
                        aria-label={`Adjustment ${i + 1} label`}
                        value={adj.label}
                        onChange={(e) => setAdjustment(adj.key, { label: e.target.value })}
                      />
                    </Field>
                  </div>
                  <Field label="Percent">
                    <TextInput
                      inputMode="decimal"
                      placeholder="e.g. -15"
                      aria-label={`Adjustment ${i + 1} percent`}
                      value={adj.pct}
                      onChange={(e) => setAdjustment(adj.key, { pct: e.target.value })}
                    />
                  </Field>
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <Field label="Amount">
                        <TextInput
                          inputMode="decimal"
                          aria-label={`Adjustment ${i + 1} amount`}
                          value={adj.amount}
                          onChange={(e) => setAdjustment(adj.key, { amount: e.target.value })}
                        />
                      </Field>
                    </div>
                    <Button variant="ghost" onClick={() => dropAdjustment(adj.key)} className="mb-0.5">
                      Remove {i + 1}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button onClick={rollForward} disabled={busy || !datedForRun || noCandidates}>
              Run rollforward
            </Button>
            <Button variant="ghost" onClick={addAdjustment} disabled={adjustments.length >= 10}>
              Add an adjustment
            </Button>
          </div>

          {!datedForRun && (
            <p className="mt-3 text-sm text-ink-400">
              This engagement states no valuation date, so there is nothing to roll forward to. Set one on the
              engine inputs first.
            </p>
          )}
          {noCandidates && (
            <p className="mt-3 text-sm text-ink-400">
              No other valuation of this company has a completed calculation, so there is no prior concluded
              equity value to carry forward.
            </p>
          )}
        </div>
      )}

      {data.runs.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No roll-forward recorded">
            The engagement's backsolve anchor stands on its own. Roll the prior 409A forward so the report can
            show how this year's value follows from last year's.
          </EmptyState>
        </div>
      ) : (
        <>
          {latest && latest.calibration_steps.length > 0 && (
            <div className="mt-6 overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card">
              <table className="w-full min-w-[520px] text-sm" aria-label="Calibration trail">
                <thead>
                  <tr className="border-b border-paper-300 text-left">
                    <th className="overline px-5 py-3 font-semibold text-ink-400">Step</th>
                    <th className="overline px-4 py-3 font-semibold text-ink-400">Basis</th>
                    <th className="overline px-5 py-3 text-right font-semibold text-ink-400">
                      Running value
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {latest.calibration_steps.map((s, i) => (
                    <tr key={`${s.step}-${i}`} className="border-b border-paper-200 last:border-0">
                      <td className="px-5 py-3 font-medium text-ink-900">
                        {s.step === 'adjustment' && s.label ? s.label : (STEP_LABELS[s.step] ?? s.step)}
                      </td>
                      <td className="px-4 py-3 text-ink-500">
                        {s.step === 'time_accretion'
                          ? `${pct(s.annual_rate)} for ${s.years?.toFixed(2) ?? '—'} years` +
                            (typeof s.factor === 'number' ? ` (×${s.factor.toFixed(4)})` : '')
                          : '—'}
                      </td>
                      <td className="tnum px-5 py-3 text-right text-ink-900">{amount(s.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {latest && latest.material_changes.length > 0 && (
            <div className="mt-4 overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card">
              <table className="w-full min-w-[520px] text-sm" aria-label="Changes since the prior valuation">
                <thead>
                  <tr className="border-b border-paper-300 text-left">
                    <th className="overline px-5 py-3 font-semibold text-ink-400">Field</th>
                    <th className="overline px-4 py-3 font-semibold text-ink-400">What changed</th>
                    <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Move</th>
                    <th className="overline px-5 py-3 font-semibold text-ink-400">Assessment</th>
                  </tr>
                </thead>
                <tbody>
                  {latest.material_changes.map((c) => (
                    <tr key={c.field + c.detail} className="border-b border-paper-200 last:border-0">
                      <td className="px-5 py-3 font-medium text-ink-900">{titleise(c.field)}</td>
                      <td className="px-4 py-3 text-ink-500">{c.detail}</td>
                      <td className="tnum px-4 py-3 text-right text-ink-500">
                        {c.delta_pct === undefined ? '—' : pct(c.delta_pct)}
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[0.7rem] font-semibold ring-1 ring-inset ${
                            c.material
                              ? 'bg-amber-50 text-amber-800 ring-amber-200'
                              : 'bg-paper-100 text-ink-500 ring-paper-300'
                          }`}
                        >
                          {c.material ? 'Material' : 'Not material'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-6 overflow-x-auto rounded-lg border border-paper-300 bg-surface shadow-card">
            <table className="w-full min-w-[720px] text-sm" aria-label="Roll-forward history">
              <thead>
                <tr className="border-b border-paper-300 text-left">
                  <th className="overline px-5 py-3 font-semibold text-ink-400">Run</th>
                  <th className="overline px-4 py-3 font-semibold text-ink-400">Prior 409A</th>
                  <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Prior value</th>
                  <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Rolled value</th>
                  <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Accretion</th>
                  <th className="overline px-4 py-3 text-right font-semibold text-ink-400">Changes</th>
                  <th className="overline px-5 py-3 font-semibold text-ink-400">Status</th>
                  {data.can_edit && <th className="px-5 py-3" />}
                </tr>
              </thead>
              <tbody>
                {data.runs.map((row) => (
                  <tr key={row.id} className="border-b border-paper-200 last:border-0">
                    <td className="px-5 py-3 text-ink-500">
                      {row.created_at.slice(0, 10)}
                      <div className="text-xs text-ink-400">{row.years_elapsed.toFixed(2)} years elapsed</div>
                    </td>
                    <td className="px-4 py-3 text-ink-500">
                      {row.prior_valuation_number ?? '—'}
                      <div className="text-xs text-ink-400">{row.prior_valuation_date}</div>
                    </td>
                    <td className="tnum px-4 py-3 text-right text-ink-500">
                      {amount(row.prior_equity_value)}
                    </td>
                    <td className="tnum px-4 py-3 text-right font-medium text-ink-900">
                      {amount(row.rolled_equity_value)}
                    </td>
                    <td className="tnum px-4 py-3 text-right text-ink-500">
                      {row.new_round_post_money === null ? pct(row.annual_accretion) : 'new round'}
                    </td>
                    <td className="tnum px-4 py-3 text-right text-ink-500">{row.material_change_count}</td>
                    <td className="px-5 py-3 text-ink-500">
                      {row.applied_at ? `Adopted ${row.applied_at.slice(0, 10)}` : 'Proposal'}
                    </td>
                    {data.can_edit && (
                      <td className="px-5 py-3 text-right">
                        {row.applied_at === null && (
                          <Button variant="ghost" onClick={() => adopt(row)} disabled={busy}>
                            Adopt run
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {adopted === null && (
            <p className="mt-3 text-sm text-ink-400">
              No run has been adopted, so the engagement is not calculating on a rolled anchor and Exhibit B-2
              will not print.
            </p>
          )}
        </>
      )}
    </section>
  );
}
