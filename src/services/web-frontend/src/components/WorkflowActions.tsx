import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { displayName, STATE_LABELS } from '../lib/format';
import type { UserOption, Valuation, ValuationState } from '../lib/types';
import { Button, ErrorNote, Field, Select } from './ui';

/**
 * Workflow engine controls (M4) — auto-advance, restart, reassign. Rendered
 * for ops only; mirrors src/services/valuation/src/domain/workflow.ts.
 */

const AUTO_ADVANCE: Partial<Record<ValuationState, ValuationState>> = {
  pending: 'started',
  started: 'onboarding_completed',
  onboarding_completed: 'user_finished',
  user_finished: 'completed',
  completed: 'review',
  paid: 'review',
  review: 'reviewed',
  reviewed: 'drafted',
  drafted: 'draft_accepted',
  draft_accepted: 'published',
};

export function WorkflowActions({
  valuation,
  onChanged,
}: {
  valuation: Valuation;
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewerId, setReviewerId] = useState(valuation.assigned_reviewer_id ?? '');
  const [options, setOptions] = useState<UserOption[]>([]);
  // An empty reviewer list reads as "there are no reviewers"; a load that failed
  // has to say so, or ops is left staring at a control that cannot work.
  const [optionsFailed, setOptionsFailed] = useState(false);

  useEffect(() => {
    api<{ options: UserOption[] }>('/users/options?group=ops')
      .then((res) => setOptions(res.options))
      .catch(() => setOptionsFailed(true));
  }, []);

  // Mirrors nextState() server-side, payment divert included — the button
  // names the state the server will actually move to, not the one this table
  // defaults to. Promising "review" and landing on "paid" is how ops stop
  // trusting the control.
  const next =
    valuation.state === 'completed' && valuation.paid_status !== 'unpaid'
      ? ('paid' as ValuationState)
      : AUTO_ADVANCE[valuation.state];
  const canRestart = valuation.state !== 'published' && valuation.state !== 'started';

  const run = async (path: string, body?: unknown) => {
    setError(null);
    setBusy(true);
    try {
      await api(`/valuations/${valuation.id}/workflow/${path}`, { method: 'POST', body });
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Workflow action failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-paper-300 bg-surface p-6 shadow-card">
      <h2 className="overline mb-5 text-ink-400">Workflow</h2>
      {error && (
        <div className="mb-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy || !next} onClick={() => void run('advance')}>
          {next ? `Advance → ${STATE_LABELS[next]}` : 'No next step'}
        </Button>
        <Button variant="secondary" disabled={busy || !canRestart} onClick={() => void run('restart')}>
          Restart
        </Button>
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="w-72">
          <Field
            label="Assigned reviewer"
            error={optionsFailed ? 'Reviewers could not be loaded — reload to try again.' : null}
          >
            <Select
              value={reviewerId}
              disabled={optionsFailed}
              onChange={(e) => setReviewerId(e.target.value)}
            >
              <option value="">Unassigned</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {displayName(o)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button
          variant="secondary"
          disabled={
            busy || optionsFailed || (reviewerId || null) === valuation.assigned_reviewer_id
          }
          onClick={() => void run('reassign', { reviewer_id: reviewerId || null })}
        >
          Reassign
        </Button>
      </div>
    </section>
  );
}
