import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, ifMatch } from '../../lib/api';
import { paramsVersionKey, useRowVersion } from '../../lib/rowVersion';
import { Button, ErrorNote, Field, InfoTooltip, Spinner, TextInput } from '../ui';

/**
 * The discount-rate build-up.
 *
 * `engine/wacc.py` builds the cost of equity on a modified CAPM — a treasury
 * yield matched to the forecast horizon, a guideline beta unlevered and
 * relevered to the subject's target structure, a size premium off the
 * capitalisation tier, a company-specific premium — and blends it with the
 * after-tax cost of debt. `compute.py` runs it under the `auto_wacc` flag and
 * records the whole build-up for the report.
 *
 * None of it was reachable. Nothing in the service ever set `auto_wacc`, so
 * `results.auto.wacc` was never populated, and Appendix I — Discount Rate
 * Build-Up, which reads it and is named in the report's index of exhibits,
 * could not render on any engagement. The discount rate was a number typed
 * into a field, exactly as the volatility was before it was derived.
 *
 * Two things the panel is deliberate about, both mirroring the volatility
 * derivation:
 *
 *   * Recording a build-up and letting it drive the rate are separate. The
 *     switch is its own control, so an analyst can hold a build-up on the
 *     engagement while deciding whether to adopt it.
 *   * Preview reads the *stored* build-up, not the form. A preview that showed
 *     a rate the calculation would not reproduce is worse than no preview.
 *     Save, then preview.
 */

/** One guideline company's observed beta, as the engine takes it. */
interface BetaRow {
  ticker: string;
  beta: string;
  debt_to_equity: string;
}

interface WaccInputs {
  comparable_betas?: Array<{ ticker?: string; beta: number; debt_to_equity?: number }>;
  unlevered_beta_input?: number;
  target_debt_to_equity?: number;
  market_cap?: number;
  tax_rate?: number;
  equity_risk_premium?: number;
  forecast_horizon_years?: number;
  risk_free_rate_override?: number;
  company_specific_premium?: number;
  cost_of_debt?: number;
}

interface ParamsResponse {
  params: {
    wacc_inputs: WaccInputs | null;
    auto_wacc: boolean;
    /** Optimistic-lock counter (0158), shared with the methodology form. */
    version?: number;
  };
}

interface WaccResult {
  wacc: number;
  cost_of_equity: number;
  cost_of_debt: number;
  after_tax_cost_of_debt: number;
  capm: {
    risk_free_rate: number;
    beta_unlevered: number;
    beta_relevered: number;
    equity_risk_premium: number;
    size_premium: number;
    size_tier: string;
    company_specific_premium: number;
  };
  weights: { equity: number; debt: number };
  tax_rate: number;
  comparables: Array<{ ticker?: string; beta?: number; unlevered?: number }>;
}

const pct = (v: number | null | undefined, digits = 2): string =>
  typeof v === 'number' ? `${(v * 100).toFixed(digits)}%` : '—';

/** A percentage field → a fraction, or undefined for a field left blank. */
function fraction(raw: string): number | undefined {
  const t = raw.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n / 100 : undefined;
}

/** A plain number field → a number, or undefined for a field left blank. */
function plain(raw: string): number | undefined {
  const t = raw.trim();
  if (t === '') return undefined;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/** A fraction → the percentage string the field shows. */
function asPercentField(v: number | undefined): string {
  return typeof v === 'number' ? String(Number((v * 100).toFixed(4))) : '';
}

const EMPTY_BETA: BetaRow = { ticker: '', beta: '', debt_to_equity: '' };

export function WaccPanel({ valuationId, readOnly }: { valuationId: string; readOnly: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<WaccResult | null>(null);
  const [appliedOnNextRun, setAppliedOnNextRun] = useState(false);

  const [autoWacc, setAutoWacc] = useState(false);
  const [betas, setBetas] = useState<BetaRow[]>([{ ...EMPTY_BETA }]);
  const [form, setForm] = useState({
    unlevered_beta_input: '',
    target_debt_to_equity: '',
    market_cap: '',
    tax_rate: '',
    equity_risk_premium: '',
    forecast_horizon_years: '',
    risk_free_rate_override: '',
    company_specific_premium: '',
    cost_of_debt: '',
  });

  /**
   * The `valuation_params` version, shared with the methodology form above.
   * Both write the same row and both move the same counter — see
   * lib/rowVersion.ts.
   */
  const [version, setVersion] = useRowVersion(paramsVersionKey(valuationId));

  const load = useCallback(async () => {
    try {
      const res = await api<ParamsResponse>(`/valuations/${valuationId}/params`);
      setVersion(res.params.version);
      const w = res.params.wacc_inputs ?? {};
      setAutoWacc(res.params.auto_wacc === true);
      setBetas(
        (w.comparable_betas ?? []).length > 0
          ? (w.comparable_betas ?? []).map((b) => ({
              ticker: b.ticker ?? '',
              beta: String(b.beta),
              debt_to_equity: b.debt_to_equity === undefined ? '' : String(b.debt_to_equity),
            }))
          : [{ ...EMPTY_BETA }],
      );
      setForm({
        unlevered_beta_input: w.unlevered_beta_input === undefined ? '' : String(w.unlevered_beta_input),
        target_debt_to_equity: w.target_debt_to_equity === undefined ? '' : String(w.target_debt_to_equity),
        market_cap: w.market_cap === undefined ? '' : String(w.market_cap),
        tax_rate: asPercentField(w.tax_rate),
        equity_risk_premium: asPercentField(w.equity_risk_premium),
        forecast_horizon_years:
          w.forecast_horizon_years === undefined ? '' : String(w.forecast_horizon_years),
        risk_free_rate_override: asPercentField(w.risk_free_rate_override),
        company_specific_premium: asPercentField(w.company_specific_premium),
        cost_of_debt: asPercentField(w.cost_of_debt),
      });
      setLoaded(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the discount-rate build-up.');
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  /** The stored shape, built from the form. Blank fields are omitted, not zeroed. */
  const buildInputs = (): WaccInputs | null => {
    // A row with no beta in it is a blank line on the form, not an input. The
    // ticker and the gearing are optional to the engine, so only the beta
    // decides whether the row exists at all.
    const rows: NonNullable<WaccInputs['comparable_betas']> = [];
    for (const b of betas) {
      const beta = plain(b.beta);
      if (beta === undefined) continue;
      const de = plain(b.debt_to_equity);
      rows.push({
        ...(b.ticker.trim() === '' ? {} : { ticker: b.ticker.trim() }),
        beta,
        ...(de === undefined ? {} : { debt_to_equity: de }),
      });
    }

    const out: WaccInputs = {
      ...(rows.length > 0 ? { comparable_betas: rows } : {}),
      ...(plain(form.unlevered_beta_input) === undefined
        ? {}
        : { unlevered_beta_input: plain(form.unlevered_beta_input) }),
      ...(plain(form.target_debt_to_equity) === undefined
        ? {}
        : { target_debt_to_equity: plain(form.target_debt_to_equity) }),
      ...(plain(form.market_cap) === undefined ? {} : { market_cap: plain(form.market_cap) }),
      ...(fraction(form.tax_rate) === undefined ? {} : { tax_rate: fraction(form.tax_rate) }),
      ...(fraction(form.equity_risk_premium) === undefined
        ? {}
        : { equity_risk_premium: fraction(form.equity_risk_premium) }),
      ...(plain(form.forecast_horizon_years) === undefined
        ? {}
        : { forecast_horizon_years: plain(form.forecast_horizon_years) }),
      ...(fraction(form.risk_free_rate_override) === undefined
        ? {}
        : { risk_free_rate_override: fraction(form.risk_free_rate_override) }),
      ...(fraction(form.company_specific_premium) === undefined
        ? {}
        : { company_specific_premium: fraction(form.company_specific_premium) }),
      ...(fraction(form.cost_of_debt) === undefined ? {} : { cost_of_debt: fraction(form.cost_of_debt) }),
    };
    return Object.keys(out).length > 0 ? out : null;
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      // `buildInputs()` rebuilds the whole build-up from this form, so this
      // save reverts anything another editor changed in it since the panel
      // loaded — the same shape as the methodology form beside it, over a
      // smaller document.
      const res = await api<{ params?: { version?: number } }>(`/valuations/${valuationId}/params`, {
        method: 'PATCH',
        body: { wacc_inputs: buildInputs(), auto_wacc: autoWacc },
        headers: ifMatch(version),
      });
      // Optional all the way down: `load()` below re-reads the row anyway, so a
      // response shape without the version costs a stale header for no requests
      // rather than a thrown save.
      setVersion(res.params?.version);
      setNote(
        autoWacc
          ? 'Build-up saved. The next calculation will use it as the DCF discount rate where none was entered by hand.'
          : 'Build-up saved. It is recorded but not driving the discount rate.',
      );
      await load();
      return true;
    } catch (err) {
      // An out-of-date panel rather than a failed save: reload so the analyst
      // reapplies onto what actually landed instead of over it.
      if (err instanceof ApiError && err.status === 409) {
        await load();
        setError(
          err.problem.detail ??
            'Someone else changed these parameters while you were editing. They have been reloaded — please reapply your changes.',
        );
        return false;
      }
      setError(err instanceof ApiError ? err.message : 'Could not save the discount-rate build-up.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ wacc: WaccResult; applied_on_next_run: boolean }>(
        `/valuations/${valuationId}/wacc/preview`,
        { method: 'POST', body: {} },
      );
      setPreview(res.wacc);
      setAppliedOnNextRun(res.applied_on_next_run);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build the discount rate.');
    } finally {
      setBusy(false);
    }
  };

  if (error && !loaded) return <ErrorNote>{error}</ErrorNote>;
  if (!loaded) return <Spinner />;

  return (
    <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <h3 className="overline mb-1 flex items-center text-ink-400">
        Discount rate build-up (WACC)
        <InfoTooltip
          className="ml-1.5"
          label="About the discount rate build-up"
          text="The cost of equity is built on a modified CAPM — risk-free rate, a guideline beta relevered to the subject's target structure, a size premium and a company-specific premium — and blended with the after-tax cost of debt. Printed as Appendix I."
        />
      </h3>
      <p className="mb-5 max-w-2xl text-sm text-ink-400">
        Enter the guideline beta set and the target capital structure. Every premium and rate is entered as a
        percentage. Leave a field blank to take the engine&rsquo;s default for it.
      </p>

      {error && (
        <div className="mb-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {note && (
        <div className="mb-4 rounded-lg border border-paper-300 bg-paper-50 px-4 py-3 text-sm text-ink-500">
          {note}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-paper-300">
        <table className="w-full min-w-[440px] text-sm" aria-label="Guideline betas">
          <thead>
            <tr className="border-b border-paper-300 text-left">
              <th className="overline px-4 py-2.5 font-semibold text-ink-400">Ticker</th>
              <th className="overline px-4 py-2.5 font-semibold text-ink-400">Levered beta</th>
              <th className="overline px-4 py-2.5 font-semibold text-ink-400">Debt / equity</th>
              {!readOnly && <th className="px-4 py-2.5" />}
            </tr>
          </thead>
          <tbody>
            {betas.map((row, i) => (
              // Keyed by position: the rows have no identity of their own until
              // they are saved, and a ticker the analyst is halfway through
              // typing is not one.
              <tr key={i} className="border-b border-paper-200 last:border-0">
                {/* A column header names a cell, not a control inside one, so
                    an editable grid has to name each input itself — otherwise
                    every box in the table is announced as "blank, edit text"
                    and there is no way to tell which column you are in. */}
                <td className="px-4 py-2">
                  <TextInput
                    disabled={readOnly}
                    value={row.ticker}
                    placeholder="AAA"
                    aria-label={`Peer ${i + 1} ticker`}
                    onChange={(e) =>
                      setBetas((b) => b.map((r, j) => (j === i ? { ...r, ticker: e.target.value } : r)))
                    }
                  />
                </td>
                <td className="px-4 py-2">
                  <TextInput
                    disabled={readOnly}
                    inputMode="decimal"
                    value={row.beta}
                    placeholder="1.20"
                    aria-label={`Peer ${i + 1} levered beta`}
                    onChange={(e) =>
                      setBetas((b) => b.map((r, j) => (j === i ? { ...r, beta: e.target.value } : r)))
                    }
                  />
                </td>
                <td className="px-4 py-2">
                  <TextInput
                    disabled={readOnly}
                    inputMode="decimal"
                    aria-label={`Peer ${i + 1} debt to equity`}
                    value={row.debt_to_equity}
                    placeholder="0.25"
                    onChange={(e) =>
                      setBetas((b) =>
                        b.map((r, j) => (j === i ? { ...r, debt_to_equity: e.target.value } : r)),
                      )
                    }
                  />
                </td>
                {!readOnly && (
                  <td className="px-4 py-2 text-right">
                    <Button
                      variant="ghost"
                      type="button"
                      aria-label={`Remove peer ${i + 1}${row.ticker ? ` (${row.ticker})` : ''}`}
                      onClick={() =>
                        setBetas((b) => (b.length === 1 ? [{ ...EMPTY_BETA }] : b.filter((_, j) => j !== i)))
                      }
                    >
                      Remove
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <div className="mt-3">
          <Button variant="ghost" type="button" onClick={() => setBetas((b) => [...b, { ...EMPTY_BETA }])}>
            + Add guideline beta
          </Button>
        </div>
      )}

      <div className="mt-6 grid gap-5 sm:grid-cols-3">
        <Field
          label="Unlevered beta"
          hint="Use instead of the set above when the beta is taken from a published source."
        >
          <TextInput
            disabled={readOnly}
            inputMode="decimal"
            value={form.unlevered_beta_input}
            onChange={(e) => set('unlevered_beta_input')(e.target.value)}
          />
        </Field>
        <Field label="Target debt / equity" hint="The subject's structure, not the peers'.">
          <TextInput
            disabled={readOnly}
            inputMode="decimal"
            value={form.target_debt_to_equity}
            onChange={(e) => set('target_debt_to_equity')(e.target.value)}
          />
        </Field>
        <Field label="Market capitalisation" hint="Sets the size-premium tier. Whole currency units.">
          <TextInput
            disabled={readOnly}
            inputMode="decimal"
            value={form.market_cap}
            onChange={(e) => set('market_cap')(e.target.value)}
          />
        </Field>
        <Field label="Equity risk premium (%)">
          <TextInput
            disabled={readOnly}
            inputMode="decimal"
            value={form.equity_risk_premium}
            onChange={(e) => set('equity_risk_premium')(e.target.value)}
          />
        </Field>
        <Field label="Company-specific premium (%)">
          <TextInput
            disabled={readOnly}
            inputMode="decimal"
            value={form.company_specific_premium}
            onChange={(e) => set('company_specific_premium')(e.target.value)}
          />
        </Field>
        <Field label="Tax rate (%)">
          <TextInput
            disabled={readOnly}
            inputMode="decimal"
            value={form.tax_rate}
            onChange={(e) => set('tax_rate')(e.target.value)}
          />
        </Field>
        <Field
          label="Forecast horizon (years)"
          hint="Matches the treasury yield to the forecast it discounts."
        >
          <TextInput
            disabled={readOnly}
            inputMode="decimal"
            value={form.forecast_horizon_years}
            onChange={(e) => set('forecast_horizon_years')(e.target.value)}
          />
        </Field>
        <Field label="Risk-free rate (%)" hint="Overrides the horizon-matched treasury yield.">
          <TextInput
            disabled={readOnly}
            inputMode="decimal"
            value={form.risk_free_rate_override}
            onChange={(e) => set('risk_free_rate_override')(e.target.value)}
          />
        </Field>
        <Field label="Cost of debt, pre-tax (%)">
          <TextInput
            disabled={readOnly}
            inputMode="decimal"
            value={form.cost_of_debt}
            onChange={(e) => set('cost_of_debt')(e.target.value)}
          />
        </Field>
      </div>

      {!readOnly && (
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={autoWacc}
              onChange={(e) => setAutoWacc(e.target.checked)}
              className="h-4 w-4 rounded border-ink-300 text-bond-600 focus:ring-bond-600/20"
              data-testid="auto-wacc"
            />
            Use this build-up as the DCF discount rate
          </label>
          <Button type="button" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save build-up'}
          </Button>
          <Button variant="ghost" type="button" onClick={runPreview} disabled={busy}>
            Preview rate
          </Button>
        </div>
      )}
      {/* Said plainly rather than left to the checkbox: a hand-entered discount
          rate still wins in the engine, so a build-up can be switched on and
          the DCF still run on the typed figure. */}
      <p className="mt-3 text-xs text-ink-400">
        A discount rate entered by hand on the Overwrites tab still takes precedence. The build-up is recorded
        and printed as Appendix I either way, so the report can show the derived rate beside the applied one.
      </p>

      {preview && (
        <div className="mt-6 rounded-lg border border-paper-300 bg-paper-50 p-5">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="overline text-ink-400">Weighted average cost of capital</span>
            <span className="tnum font-display text-2xl font-semibold text-ink-900">{pct(preview.wacc)}</span>
            {!appliedOnNextRun && (
              <span className="text-xs text-ink-400">
                — not switched on, so this will not reach the discount rate
              </span>
            )}
          </div>
          <table className="mt-4 w-full text-sm" aria-label="Cost of capital build-up">
            <tbody>
              {[
                ['Risk-free rate', pct(preview.capm.risk_free_rate)],
                ['Equity risk premium', pct(preview.capm.equity_risk_premium)],
                ['Unlevered beta', preview.capm.beta_unlevered.toFixed(4)],
                ['Relevered beta', preview.capm.beta_relevered.toFixed(4)],
                [`Size premium (${preview.capm.size_tier})`, pct(preview.capm.size_premium)],
                ['Company-specific premium', pct(preview.capm.company_specific_premium)],
                ['Cost of equity', pct(preview.cost_of_equity)],
                ['Cost of debt, after tax', pct(preview.after_tax_cost_of_debt)],
                [
                  'Weights (equity / debt)',
                  `${pct(preview.weights.equity, 1)} / ${pct(preview.weights.debt, 1)}`,
                ],
              ].map(([label, value]) => (
                <tr key={label} className="border-b border-paper-200 last:border-0">
                  <td className="py-1.5 text-ink-500">{label}</td>
                  <td className="tnum py-1.5 text-right font-medium text-ink-900">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
