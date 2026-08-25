import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { HelpIcon } from '../components/HelpIcon';
import { formatDateTime } from '../lib/format';
import { KindBadge, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { SLA_TONE } from './valuation/EngagementTab';

/**
 * Engagement pipeline dashboard (feature 8). Every active engagement with its
 * current stage, SLA status and assigned analyst. Grouped by stage as a light
 * kanban so ops can see where work is piling up. Ops-only (route-guarded).
 */

interface Stage {
  key: string;
  label: string;
  terminal?: boolean;
}
interface Sla {
  label: string;
  elapsedHours: number;
  expectedHours: number;
  overdue: boolean;
  level: 'green' | 'yellow' | 'red';
}
interface EngagementSummary {
  valuation_id: string;
  company_name: string;
  kind: string;
  valuation_state: string;
  current_stage: string;
  analyst_email: string | null;
  stage_entered_at: string;
  sla: Sla;
}

function hours(h: number): string {
  return h >= 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`;
}

export function EngagementsPage() {
  const [engagements, setEngagements] = useState<EngagementSummary[] | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ engagements: EngagementSummary[]; stages: Stage[] }>('/engagements')
      .then((r) => {
        setEngagements(r.engagements);
        setStages(r.stages.filter((s) => !s.terminal));
      })
      .catch(() => setError('Could not load the engagement pipeline.'));
  }, []);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!engagements) return <Spinner />;

  const overdue = engagements.filter((e) => e.sla.overdue).length;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-display text-3xl font-semibold text-ink-900">Engagement pipeline</h1>
            <HelpIcon article="engagement-overview" className="h-6 w-6 text-sm" />
          </div>
          <p className="mt-1 text-sm text-ink-400">
            {engagements.length} active · {overdue} past SLA
          </p>
        </div>
      </div>

      {engagements.length === 0 ? (
        <EmptyState title="No active engagements">
          Engagements appear here once work starts on a valuation.
        </EmptyState>
      ) : (
        <div className="flex gap-4 overflow-x-auto overscroll-x-contain pb-4">
          {stages.map((stage) => {
            const inStage = engagements.filter((e) => e.current_stage === stage.key);
            return (
              <div key={stage.key} className="w-72 flex-shrink-0">
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-ink-700">{stage.label}</h2>
                  <span className="tnum rounded-full bg-paper-200 px-2 py-0.5 text-xs text-ink-500">
                    {inStage.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {inStage.map((e) => (
                    <Link
                      key={e.valuation_id}
                      to={`/valuations/${e.valuation_id}/engagement`}
                      className="block rounded-lg border border-paper-300 bg-surface p-3 shadow-card hover:border-ink-300"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-semibold text-ink-900">{e.company_name}</span>
                        <KindBadge kind={e.kind as never} />
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${SLA_TONE[e.sla.level]}`}
                        >
                          {e.sla.overdue ? 'Overdue' : hours(e.sla.elapsedHours)}
                        </span>
                        <span className="truncate text-xs text-ink-400">
                          {e.analyst_email ?? 'Unassigned'}
                        </span>
                      </div>
                      <div className="tnum mt-1.5 text-[0.7rem] text-ink-400">
                        since {formatDateTime(e.stage_entered_at)}
                      </div>
                    </Link>
                  ))}
                  {inStage.length === 0 && (
                    <p className="rounded-lg border border-dashed border-paper-300 px-3 py-4 text-center text-xs text-ink-400">
                      —
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
