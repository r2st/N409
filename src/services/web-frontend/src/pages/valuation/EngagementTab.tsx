import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useWorkspace } from './ValuationWorkspace';
import { Button, ErrorNote, Select, Spinner, WriteGate } from '../../components/ui';

/**
 * Engagement lifecycle panel (feature 8). Shows the current stage + SLA, the
 * per-stage expected-vs-actual timing, an activity feed, and controls to
 * advance the stage or reassign the analyst. Ops-only (guarded by the API).
 */

interface Stage {
  key: string;
  label: string;
  slaHours: number;
  terminal?: boolean;
}
interface Sla {
  stage: string;
  label: string;
  expectedHours: number;
  elapsedHours: number;
  dueAt: string | null;
  overdue: boolean;
  level: 'green' | 'yellow' | 'red';
}
interface Duration {
  stage: string;
  label: string;
  enteredAt: string;
  exitedAt: string | null;
  actualHours: number;
  expectedHours: number;
  breachedSla: boolean;
}
interface ActivityEntry {
  id: string;
  type: string;
  actor_type: string;
  occurred_at: string;
}
interface EngagementView {
  engagement: {
    current_stage: string;
    assigned_analyst_id: string | null;
    stage_entered_at: string;
  };
  sla: Sla;
  stages: Stage[];
  durations: Duration[];
  activity: ActivityEntry[];
}

export const SLA_TONE: Record<'green' | 'yellow' | 'red', string> = {
  green: 'bg-bond-50 text-bond-700 ring-bond-200',
  yellow: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
};

function hours(h: number): string {
  return h >= 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`;
}

export function EngagementTab() {
  const { valuation, retired } = useWorkspace();
  const [view, setView] = useState<EngagementView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api<EngagementView>(`/valuations/${valuation.id}/engagement`);
      setView(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the engagement.');
    }
  }, [valuation.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const advance = async (stage?: string) => {
    setError(null);
    setBusy(true);
    try {
      await api(`/valuations/${valuation.id}/engagement/advance`, {
        method: 'POST',
        body: stage ? { stage } : {},
      });
      setTarget('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not advance the stage.');
    } finally {
      setBusy(false);
    }
  };

  if (!view && !error) return <Spinner />;
  if (!view) return <ErrorNote>{error}</ErrorNote>;

  const { sla, stages, durations } = view;
  const currentIdx = stages.findIndex((s) => s.key === view.engagement.current_stage);

  return (
    <div className="max-w-3xl space-y-6">
      {error && <ErrorNote>{error}</ErrorNote>}

      <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 className="font-display text-lg font-semibold text-ink-900">Stage: {sla.label}</h2>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${SLA_TONE[sla.level]}`}
          >
            {sla.overdue ? 'Overdue' : sla.level === 'yellow' ? 'Approaching SLA' : 'On track'}
          </span>
          <span className="tnum text-xs text-ink-400">
            {hours(sla.elapsedHours)} elapsed
            {sla.expectedHours > 0 && ` / ${hours(sla.expectedHours)} SLA`}
          </span>
        </div>

        {/* Stage stepper */}
        <ol className="mb-5 flex flex-wrap gap-1.5">
          {stages
            .filter((s) => !s.terminal)
            .map((s, i) => (
              <li
                key={s.key}
                className={`rounded px-2 py-1 text-xs font-semibold ${
                  i < currentIdx
                    ? 'bg-bond-100 text-bond-700'
                    : i === currentIdx
                      ? `${SLA_TONE[sla.level]} ring-1 ring-inset`
                      : 'bg-paper-200 text-ink-400'
                }`}
              >
                {s.label}
              </li>
            ))}
        </ol>

        <div className="flex flex-wrap items-center gap-3">
          <WriteGate closed={retired}>
            <Button
              onClick={() => void advance()}
              disabled={busy || view.engagement.current_stage === 'complete'}
            >
              Advance to next stage
            </Button>
            <div className="flex items-center gap-2">
              <Select
                aria-label="Jump to stage"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="w-48"
              >
                <option value="">Jump to stage…</option>
                {stages.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </Select>
              <Button variant="secondary" disabled={busy || !target} onClick={() => void advance(target)}>
                Go
              </Button>
            </div>
          </WriteGate>
        </div>
      </section>

      <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <h3 className="overline mb-3 text-ink-400">Stage timing (expected vs actual)</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Stage timing</caption>
            <thead>
              <tr className="border-b border-paper-300 text-left text-xs text-ink-500 uppercase">
                <th className="py-1.5 pr-3">Stage</th>
                <th className="py-1.5 pr-3">Entered</th>
                <th className="py-1.5 pr-3">Actual</th>
                <th className="py-1.5 pr-3">SLA</th>
                <th className="py-1.5">Status</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {durations.map((d, i) => (
                <tr key={`${d.stage}-${i}`} className="border-b border-paper-200 last:border-0">
                  <td className="py-1.5 pr-3 font-semibold text-ink-800">{d.label}</td>
                  <td className="py-1.5 pr-3 text-ink-500">{formatDateTime(d.enteredAt)}</td>
                  <td className="py-1.5 pr-3">{hours(d.actualHours)}</td>
                  <td className="py-1.5 pr-3 text-ink-500">
                    {d.expectedHours > 0 ? hours(d.expectedHours) : '—'}
                  </td>
                  <td className="py-1.5">
                    {d.breachedSla ? (
                      <span className="text-red-700">breached</span>
                    ) : d.exitedAt ? (
                      <span className="text-bond-700">on time</span>
                    ) : (
                      <span className="text-ink-400">in progress</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
        <h3 className="overline mb-3 text-ink-400">Activity feed</h3>
        <ul className="space-y-1.5 text-sm">
          {view.activity.slice(0, 15).map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-ink-600">
              <span className="h-1.5 w-1.5 rounded-full bg-ink-300" />
              <span className="font-medium text-ink-800">{a.type.replace(/_/g, ' ')}</span>
              <span className="text-xs text-ink-400">{a.actor_type}</span>
              <span className="tnum ml-auto text-xs text-ink-400">{formatDateTime(a.occurred_at)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
