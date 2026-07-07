import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { STATE_LABELS } from '../lib/format';
import type { Valuation, ValuationState } from '../lib/types';
import { Button, ErrorNote, TextInput } from './ui';

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

  const next = AUTO_ADVANCE[valuation.state];
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
    <section className="rounded-lg border border-paper-300 bg-white p-6 shadow-card">
      <h2 className="overline mb-5 text-ink-400">Workflow</h2>
      {error && <div className="mb-4"><ErrorNote>{error}</ErrorNote></div>}
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
          <label className="mb-1.5 block text-[0.8rem] font-semibold text-ink-700">Assigned reviewer</label>
          <TextInput
            value={reviewerId}
            onChange={(e) => setReviewerId(e.target.value)}
            placeholder="Reviewer user id (blank to unassign)"
          />
        </div>
        <Button
          variant="secondary"
          disabled={busy || (reviewerId.trim() || null) === valuation.assigned_reviewer_id}
          onClick={() => void run('reassign', { reviewer_id: reviewerId.trim() || null })}
        >
          Reassign
        </Button>
      </div>
    </section>
  );
}
