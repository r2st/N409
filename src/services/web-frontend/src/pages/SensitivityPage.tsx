import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatMoney } from '../lib/format';
import type { AxisTable, SensitivityAxis, SensitivityResult } from '../lib/types';
import { Button, ErrorNote, Field, TextInput } from '../components/ui';
import { ModelSensitivityPanel } from '../components/valuation/ModelSensitivityPanel';

/**
 * Sensitivity dashboard — three OPM stress tables (Term×Vol, RFR×Vol,
 * RFR×Term) showing how the per-share FMV moves under different assumptions.
 * Ops only (the API enforces it; this page just renders the 403 nicely).
 */

const AXIS_META: Record<SensitivityAxis, { label: string; format: (v: number) => string }> = {
  volatility: { label: 'Volatility', format: (v) => `${(v * 100).toFixed(0)}%` },
  termYears: { label: 'Term', format: (v) => `${v}y` },
  riskFreeRate: { label: 'Risk-free', format: (v) => `${(v * 100).toFixed(1)}%` },
};

const defaultAssumptions = {
  equity_value: '50000000',
  strike: '20000000',
  volatility: '60',
  term_years: '3',
  risk_free_rate: '4.3',
  common_shares: '10000000',
  dlom: '30',
};

function deltaClass(delta: number): string {
  if (delta > 0.001) return 'text-bond-700';
  if (delta < -0.001) return 'text-red-700';
  return 'text-ink-500';
}

function AxisTableView({
  title,
  table,
  currency,
  baseFmvCents,
  priceOnly = false,
}: {
  title: string;
  table: AxisTable;
  currency: string | null;
  baseFmvCents: number;
  /** Gap 8 — clean price-only view without the delta-vs-base row. */
  priceOnly?: boolean;
}) {
  const rowMeta = AXIS_META[table.rowAxis];
  const colMeta = AXIS_META[table.colAxis];
  return (
    <div>
      <h2 className="mb-2 font-display text-lg font-semibold text-ink-900">{title}</h2>
      <div className="overflow-x-auto rounded-lg border border-paper-300 bg-white shadow-card">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-paper-300">
              <th className="overline px-4 py-3 text-left font-semibold text-ink-400">
                {rowMeta.label} \ {colMeta.label}
              </th>
              {table.colValues.map((v) => (
                <th key={v} className="tnum px-4 py-3 text-right font-semibold text-ink-700">
                  {colMeta.format(v)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={table.rowValues[i]} className="border-b border-paper-200 last:border-0">
                <td className="tnum px-4 py-2.5 font-semibold text-ink-700">
                  {rowMeta.format(table.rowValues[i]!)}
                </td>
                {row.map((cell, j) => {
                  const isBase = cell.deltaFromBase === 0 && cell.fmvPerShareCents === baseFmvCents;
                  return (
                    <td
                      key={j}
                      className={`tnum px-4 py-2.5 text-right ${isBase ? 'bg-bond-50 font-semibold' : ''}`}
                    >
                      <div className="text-ink-900">{formatMoney(cell.fmvPerShareCents, currency)}</div>
                      {!priceOnly && (
                        <div className={`text-xs ${deltaClass(cell.deltaFromBase)}`}>
                          {cell.deltaFromBase > 0 ? '+' : ''}
                          {(cell.deltaFromBase * 100).toFixed(1)}%
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SensitivityPage() {
  const { id } = useParams<{ id: string }>();
  const [form, setForm] = useState(defaultAssumptions);
  const [result, setResult] = useState<SensitivityResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [priceOnly, setPriceOnly] = useState(false);

  const set = (key: keyof typeof defaultAssumptions) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const run = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { sensitivity } = await api<{ sensitivity: SensitivityResult }>(
        `/valuations/${id}/sensitivity`,
        {
          method: 'POST',
          body: {
            equity_value_cents: Math.round(Number(form.equity_value) * 100),
            strike_cents: Math.round(Number(form.strike) * 100),
            volatility: Number(form.volatility) / 100,
            term_years: Number(form.term_years),
            risk_free_rate: Number(form.risk_free_rate) / 100,
            common_shares: Math.round(Number(form.common_shares)),
            dlom: Number(form.dlom) / 100,
          },
        },
      );
      setResult(sensitivity);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Sensitivity analysis is operations-only.'
          : err instanceof ApiError
            ? err.message
            : 'Could not compute the stress table.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Link to={`/valuations/${id}`} className="text-sm font-semibold text-bond-600 hover:text-bond-700">
        ← Back to valuation
      </Link>
      <div className="mt-3">
        <div className="overline text-ink-400">OPM stress analysis</div>
        <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">Sensitivity dashboard</h1>
      </div>

      <form onSubmit={run} className="mt-6 rounded-lg border border-paper-300 bg-white p-6 shadow-card">
        {error && <div className="mb-5"><ErrorNote>{error}</ErrorNote></div>}
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Equity value ($)">
            <TextInput type="number" min="1" step="any" value={form.equity_value} onChange={set('equity_value')} required />
          </Field>
          <Field label="Preference stack / strike ($)">
            <TextInput type="number" min="0" step="any" value={form.strike} onChange={set('strike')} required />
          </Field>
          <Field label="Volatility (%)">
            <TextInput type="number" min="1" max="500" step="any" value={form.volatility} onChange={set('volatility')} required />
          </Field>
          <Field label="Term to exit (years)">
            <TextInput type="number" min="0.1" max="30" step="any" value={form.term_years} onChange={set('term_years')} required />
          </Field>
          <Field label="Risk-free rate (%)">
            <TextInput type="number" min="0" max="25" step="any" value={form.risk_free_rate} onChange={set('risk_free_rate')} required />
          </Field>
          <Field label="Common shares (FD)">
            <TextInput type="number" min="1" step="1" value={form.common_shares} onChange={set('common_shares')} required />
          </Field>
          <Field label="DLOM (%)">
            <TextInput type="number" min="0" max="95" step="any" value={form.dlom} onChange={set('dlom')} required />
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={busy}>
              {busy ? 'Computing…' : 'Run stress table'}
            </Button>
          </div>
        </div>
      </form>

      {result && (
        <div className="mt-8 space-y-8">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <div className="font-display text-xl font-semibold text-ink-900">
              Base FMV: {formatMoney(result.base.fmvPerShareCents, result.currency)} / share
            </div>
            <div className="text-sm text-ink-500">
              σ {(result.base.volatility * 100).toFixed(0)}% · {result.base.termYears}y
              {result.base.riskFreeRate !== undefined &&
                ` · r ${(result.base.riskFreeRate * 100).toFixed(1)}%`}{' '}
              · DLOM {(result.dlom * 100).toFixed(0)}%
            </div>
            <label className="ml-auto flex items-center gap-1.5 text-xs font-semibold text-ink-600">
              <input
                type="checkbox"
                className="h-4 w-4 accent-bond-600"
                checked={priceOnly}
                onChange={(e) => setPriceOnly(e.target.checked)}
              />
              Prices only
            </label>
          </div>

          {result.tables ? (
            <>
              <AxisTableView
                title="Term × Volatility"
                table={result.tables.term_vol}
                currency={result.currency}
                baseFmvCents={result.base.fmvPerShareCents}
                priceOnly={priceOnly}
              />
              <AxisTableView
                title="Risk-free rate × Volatility"
                table={result.tables.rfr_vol}
                currency={result.currency}
                baseFmvCents={result.base.fmvPerShareCents}
                priceOnly={priceOnly}
              />
              <AxisTableView
                title="Risk-free rate × Term"
                table={result.tables.rfr_term}
                currency={result.currency}
                baseFmvCents={result.base.fmvPerShareCents}
                priceOnly={priceOnly}
              />
            </>
          ) : (
            <AxisTableView
              title="Volatility × Term"
              table={{
                rowAxis: 'volatility',
                colAxis: 'termYears',
                rowValues: result.volatilities,
                colValues: result.terms,
                rows: result.rows.map((row) =>
                  row.map((c) => ({ fmvPerShareCents: c.fmvPerShareCents, deltaFromBase: c.deltaFromBase })),
                ),
              }}
              currency={result.currency}
              baseFmvCents={result.base.fmvPerShareCents}
              priceOnly={priceOnly}
            />
          )}
          <p className="text-xs text-ink-400">
            Common stock valued as a Black-Scholes call on equity struck at the preference stack, spread
            across fully diluted common, less DLOM. Stress steps: volatility ±20%, term ±1 year,
            risk-free rate ±2%.
          </p>
        </div>
      )}

      <div className="mt-10 border-t border-paper-300 pt-8">
        <ModelSensitivityPanel valuationId={id ?? ''} currency={result?.currency ?? null} />
      </div>
    </div>
  );
}
