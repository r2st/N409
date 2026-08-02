import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { formatMoney, formatNumber } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { isOps } from '../../lib/rbac';
import { useWorkspace } from './ValuationWorkspace';
import { HrisSyncPanel } from '../../components/valuation/HrisSyncPanel';
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  LoadingBlock,
  Select,
  Skeleton,
  SkeletonCardList,
  Spinner,
  TextInput,
} from '../../components/ui';

/**
 * Grant management (feature 6). Ops issue option grants at the board-adopted
 * 409A FMV, track vested vs unvested shares, and model exercise value at future
 * valuations. Grants can only be created once the board has approved.
 */

interface VestingStatus {
  totalShares: number;
  vestedShares: number;
  unvestedShares: number;
  percentVested: number;
  fullyVested: boolean;
  cliffCleared: boolean;
}

interface Grant {
  id: string;
  grantee_name: string;
  grantee_email: string | null;
  grant_date: string;
  options_count: number;
  exercise_price: string;
  currency: string;
  vesting_template: string;
  vesting_start_date: string;
  vesting_months: number;
  cliff_months: number;
  frequency_months: number;
  status: 'active' | 'cancelled';
  vesting: VestingStatus;
}

interface VestingPoint {
  monthOffset: number;
  date: string;
  cumulativeVested: number;
}

interface ExerciseScenario {
  fmv: number;
  spreadPerShare: number;
  grossValue: number;
  exerciseCost: number;
  multipleOfCurrent: number;
}

interface GrantDetail {
  grant: Grant;
  timeline: VestingPoint[];
  scenarios: ExerciseScenario[];
}

interface Template {
  key: string;
  label: string;
  vestingMonths: number;
  cliffMonths: number;
  frequencyMonths: number;
}

function VestingBar({ vesting }: { vesting: VestingStatus }) {
  return (
    <div className="min-w-[8rem]">
      <div className="h-2 w-full overflow-hidden rounded-full bg-paper-300">
        <div
          className="h-full rounded-full bg-bond-500"
          style={{ width: `${Math.min(100, vesting.percentVested)}%` }}
        />
      </div>
      <div className="tnum mt-1 text-xs text-ink-500">
        {vesting.percentVested}% · {formatNumber(vesting.vestedShares)} vested
      </div>
    </div>
  );
}

/** Simple SVG cumulative-vesting curve (step chart) for a grant. */
function VestingTimeline({ timeline, total }: { timeline: VestingPoint[]; total: number }) {
  if (timeline.length < 2 || total <= 0) return null;
  const width = 560;
  const height = 140;
  const pad = 4;
  const maxMonth = timeline[timeline.length - 1]!.monthOffset || 1;
  const x = (m: number) => pad + (m / maxMonth) * (width - 2 * pad);
  const y = (v: number) => height - pad - (v / total) * (height - 2 * pad);
  const points = timeline.map((p) => `${x(p.monthOffset)},${y(p.cumulativeVested)}`).join(' ');
  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-36 w-full min-w-[420px]"
        role="img"
        aria-label="Vesting timeline"
      >
        <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="#d6d3ce" />
        <polyline points={points} fill="none" stroke="#16a34a" strokeWidth={2} />
        {timeline.map((p) => (
          <circle key={p.monthOffset} cx={x(p.monthOffset)} cy={y(p.cumulativeVested)} r={2} fill="#16a34a" />
        ))}
      </svg>
      <div className="tnum flex justify-between text-xs text-ink-400">
        <span>{timeline[0]!.date}</span>
        <span>{timeline[timeline.length - 1]!.date}</span>
      </div>
    </div>
  );
}

function GrantDetailPanel({ valuationId, grant }: { valuationId: string; grant: Grant }) {
  const [detail, setDetail] = useState<GrantDetail | null>(null);
  useEffect(() => {
    let live = true;
    void api<GrantDetail>(`/valuations/${valuationId}/grants/${grant.id}`)
      .then((d) => live && setDetail(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [valuationId, grant.id]);

  if (!detail) return <Spinner />;
  const { currency } = grant;
  return (
    <div className="space-y-5 border-t border-paper-200 pt-4">
      <div>
        <h4 className="overline mb-2 text-ink-400">Vesting timeline</h4>
        <VestingTimeline timeline={detail.timeline} total={grant.options_count} />
      </div>
      <div>
        <h4 className="overline mb-2 text-ink-400">Exercise scenarios</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-paper-300 text-left text-xs text-ink-500 uppercase">
                <th className="py-1.5 pr-3">Future FMV</th>
                <th className="py-1.5 pr-3">×current</th>
                <th className="py-1.5 pr-3">Spread/share</th>
                <th className="py-1.5 pr-3">Exercise cost</th>
                <th className="py-1.5">Potential value</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {detail.scenarios.map((s) => (
                <tr key={s.fmv} className="border-b border-paper-200 last:border-0">
                  <td className="py-1.5 pr-3">{formatMoney(s.fmv, currency)}</td>
                  <td className="py-1.5 pr-3 text-ink-500">{s.multipleOfCurrent}×</td>
                  <td className="py-1.5 pr-3">{formatMoney(s.spreadPerShare, currency)}</td>
                  <td className="py-1.5 pr-3 text-ink-500">{formatMoney(s.exerciseCost, currency)}</td>
                  <td className="py-1.5 font-semibold text-bond-700">
                    {formatMoney(s.grossValue, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-ink-400">
          Illustrative in-the-money value of exercising all {formatNumber(grant.options_count)} options. Not
          tax advice.
        </p>
      </div>
    </div>
  );
}

const emptyForm = {
  grantee_name: '',
  grantee_email: '',
  grant_date: '',
  options_count: '',
  vesting_template: 'standard_4yr_1yr_cliff',
  vesting_start_date: '',
};

export function GrantsTab() {
  const { valuation } = useWorkspace();
  const { user } = useAuth();
  const ops = isOps(user);
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const load = useCallback(async () => {
    try {
      const { grants: g } = await api<{ grants: Grant[] }>(`/valuations/${valuation.id}/grants`);
      setGrants(g);
    } catch {
      setGrants([]);
    }
  }, [valuation.id]);

  useEffect(() => {
    void load();
    if (ops) {
      void api<{ templates: Template[] }>('/grant-templates')
        .then((r) => setTemplates(r.templates))
        .catch(() => {});
    }
  }, [load, ops]);

  const custom = form.vesting_template === 'custom';

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        grantee_name: form.grantee_name.trim(),
        grantee_email: form.grantee_email.trim() || null,
        grant_date: form.grant_date,
        options_count: Number(form.options_count),
        vesting_template: form.vesting_template,
        vesting_start_date: form.vesting_start_date || form.grant_date,
      };
      await api(`/valuations/${valuation.id}/grants`, { method: 'POST', body });
      setForm(emptyForm);
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not issue the grant.');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    setBusy(true);
    try {
      await api(`/valuations/${valuation.id}/grants/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel the grant.');
    } finally {
      setBusy(false);
    }
  };

  if (!grants)
    return (
      <LoadingBlock label="Loading grants…" className="max-w-4xl space-y-6">
        <div className="space-y-2" aria-hidden>
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-3.5 w-96 max-w-full" />
        </div>
        <SkeletonCardList rows={5} lines={2} badges={1} />
      </LoadingBlock>
    );

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-ink-900">Option grants</h2>
          <p className="mt-1 text-sm text-ink-400">
            Grants are struck at the board-adopted 409A fair market value.
          </p>
        </div>
        {ops && (
          <Button onClick={() => setShowForm((s) => !s)} variant={showForm ? 'secondary' : 'primary'}>
            {showForm ? 'Cancel' : 'New grant'}
          </Button>
        )}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {ops && <HrisSyncPanel valuationId={valuation.id} onImported={load} />}

      {ops && showForm && (
        <form
          onSubmit={create}
          className="grid gap-4 rounded-lg border border-paper-300 bg-surface p-5 shadow-card sm:grid-cols-2"
        >
          <Field label="Grantee name">
            <TextInput
              value={form.grantee_name}
              onChange={(e) => setForm((f) => ({ ...f, grantee_name: e.target.value }))}
              required
              maxLength={200}
            />
          </Field>
          <Field label="Grantee email (optional)">
            <TextInput
              type="email"
              value={form.grantee_email}
              onChange={(e) => setForm((f) => ({ ...f, grantee_email: e.target.value }))}
              maxLength={320}
            />
          </Field>
          <Field label="Grant date">
            <TextInput
              type="date"
              value={form.grant_date}
              onChange={(e) => setForm((f) => ({ ...f, grant_date: e.target.value }))}
              required
            />
          </Field>
          <Field label="Number of options">
            <TextInput
              type="number"
              min={1}
              value={form.options_count}
              onChange={(e) => setForm((f) => ({ ...f, options_count: e.target.value }))}
              required
            />
          </Field>
          <Field label="Vesting schedule">
            <Select
              value={form.vesting_template}
              onChange={(e) => setForm((f) => ({ ...f, vesting_template: e.target.value }))}
            >
              {templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </Select>
          </Field>
          <Field label="Vesting start (optional)" hint="Defaults to the grant date.">
            <TextInput
              type="date"
              value={form.vesting_start_date}
              onChange={(e) => setForm((f) => ({ ...f, vesting_start_date: e.target.value }))}
            />
          </Field>
          {custom && (
            <p className="text-xs text-ink-400 sm:col-span-2">
              Custom terms use a 4-year monthly schedule by default; adjust after creating via the API.
              (Standard templates cover the common cases.)
            </p>
          )}
          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={busy || !form.grantee_name.trim() || !form.grant_date || !form.options_count}
            >
              {busy ? 'Issuing…' : 'Issue grant'}
            </Button>
          </div>
        </form>
      )}

      {grants.length === 0 ? (
        <EmptyState title="No grants issued yet">
          {ops
            ? 'Once the board approves the 409A, issue option grants here.'
            : 'Option grants issued against this valuation will appear here.'}
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {grants.map((g) => (
            <li
              key={g.id}
              className={`rounded-lg border border-paper-300 bg-surface p-5 shadow-card ${g.status === 'cancelled' ? 'opacity-60' : ''}`}
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="min-w-[10rem]">
                  <div className="font-semibold text-ink-900">{g.grantee_name}</div>
                  {g.grantee_email && <div className="text-xs text-ink-400">{g.grantee_email}</div>}
                </div>
                <div className="tnum text-sm text-ink-600">
                  {formatNumber(g.options_count)} @ {formatMoney(Number(g.exercise_price), g.currency)}
                </div>
                <div className="text-xs text-ink-400">granted {g.grant_date}</div>
                <VestingBar vesting={g.vesting} />
                {g.status === 'cancelled' && (
                  <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-red-200 ring-inset">
                    cancelled
                  </span>
                )}
                <span className="ml-auto flex items-center gap-3">
                  <button
                    className="cursor-pointer text-xs font-semibold text-bond-600 hover:underline"
                    onClick={() => setExpanded((e) => (e === g.id ? null : g.id))}
                  >
                    {expanded === g.id ? 'Hide detail' : 'Detail'}
                  </button>
                  {ops && g.status === 'active' && (
                    <button
                      className="cursor-pointer text-xs font-semibold text-red-700 hover:underline"
                      disabled={busy}
                      onClick={() => void cancel(g.id)}
                    >
                      cancel
                    </button>
                  )}
                </span>
              </div>
              {expanded === g.id && (
                <div className="mt-4">
                  <GrantDetailPanel valuationId={valuation.id} grant={g} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
