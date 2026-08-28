import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { displayName, STATE_LABELS } from '../lib/format';
import type { UserOption, Valuation, ValuationState } from '../lib/types';
import { Button, ErrorNote, Field, PickerOverflowNote, Select } from './ui';

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
  // Capped server-side; a picker that is quietly short is its own failure.
  const [optionsCapped, setOptionsCapped] = useState(false);

  useEffect(() => {
    api<{ options: UserOption[]; truncated: boolean }>('/users/options?group=ops')
      .then((res) => {
        setOptions(res.options);
        setOptionsCapped(res.truncated);
      })
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
        <Button
          variant="secondary"
          disabled={busy || !canRestart}
          // The two states it refuses are not visible from the button. A
          // published engagement is the one a restart would be most damaging
          // on, and "already at the start" is the other — neither is guessable
          // from a control that is simply grey.
          title={
            valuation.state === 'published'
              ? 'A published valuation cannot be restarted. Clone it instead.'
              : valuation.state === 'started'
                ? 'This engagement is already at the first stage.'
                : 'Send this engagement back to the first stage.'
          }
          onClick={() => void run('restart')}
        >
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
              <PickerOverflowNote truncated={optionsCapped} />
            </Select>
          </Field>
        </div>
        <Button
          variant="secondary"
          disabled={busy || optionsFailed || (reviewerId || null) === valuation.assigned_reviewer_id}
          // Two different refusals behind one grey button: the roster never
          // arrived, or the picker still names the reviewer already assigned.
          // The second is the confusing one — the control looks broken when
          // in fact there is nothing to apply.
          title={
            optionsFailed
              ? 'The reviewer list could not be loaded, so there is nothing to choose from.'
              : (reviewerId || null) === valuation.assigned_reviewer_id
                ? 'This is already the assigned reviewer. Pick a different one to reassign.'
                : undefined
          }
          onClick={() => void run('reassign', { reviewer_id: reviewerId || null })}
        >
          Reassign
        </Button>
      </div>
    </section>
  );
}
