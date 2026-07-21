import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { HelpIcon } from '../components/HelpIcon';
import { useAuth } from '../lib/auth';
import { isOps } from '../lib/rbac';
import { displayName, formatDate, KIND_LABELS, STATE_LABELS } from '../lib/format';
import type { ReviewQueueItem, UserOption } from '../lib/types';
import {
  REVIEW_TASK_STATUSES,
  TASK_KIND_LABELS,
  TASK_STATUS_LABELS,
  dueLabel,
  type ReviewTask,
  type ReviewTaskStatus,
} from '../lib/pipeline';
import { TaskStatusBadge } from '../components/valuation/TasksPanel';
import { Button, EmptyState, ErrorNote, KindBadge, Select, Spinner, StateBadge } from '../components/ui';

type View = 'tasks' | 'reviews';
type Scope = 'me' | 'all' | 'overdue';

const SCOPES: Array<{ key: Scope; label: string }> = [
  { key: 'me', label: 'Assigned to me' },
  { key: 'all', label: 'All tasks' },
  { key: 'overdue', label: 'Overdue' },
];

function Toggle<K extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ key: K; label: string }>;
  value: K;
  onChange: (key: K) => void;
}) {
  return (
    <div className="flex rounded-md border border-ink-200 bg-white p-0.5">
      {options.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`cursor-pointer rounded px-3 py-1.5 text-sm font-semibold transition-colors ${
            value === key ? 'bg-ink-900 text-paper-50' : 'text-ink-600 hover:text-ink-900'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Global review-task queue + valuation review queue (P1 #6, ops only). */
export function TasksPage() {
  const { user } = useAuth();
  const [view, setView] = useState<View>('tasks');
  const [options, setOptions] = useState<UserOption[]>([]);

  useEffect(() => {
    api<{ options: UserOption[] }>('/users/options?group=ops')
      .then((res) => setOptions(res.options))
      .catch(() => {});
  }, []);

  if (!isOps(user)) {
    return <ErrorNote>Review tasks are available to operations roles only.</ErrorNote>;
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-display text-3xl font-semibold text-ink-900">Review tasks</h1>
            <HelpIcon article="engagement-overview" className="h-6 w-6 text-sm" />
          </div>
          <p className="mt-1 text-sm text-ink-500">
            The analyst → reviewer → sign-off pipeline across all valuations.
          </p>
        </div>
        <Toggle
          options={[
            { key: 'tasks' as View, label: 'Tasks' },
            { key: 'reviews' as View, label: 'Review queue' },
          ]}
          value={view}
          onChange={setView}
        />
      </div>
      {view === 'tasks' ? <TaskQueue options={options} /> : <ReviewQueue options={options} />}
    </div>
  );
}

// ── Tasks tab — typed review tasks with inline actions ───────────────────────

function TaskQueue({ options }: { options: UserOption[] }) {
  const { user } = useAuth();
  const [scope, setScope] = useState<Scope>('me');
  const [status, setStatus] = useState<'' | ReviewTaskStatus>('');
  const [tasks, setTasks] = useState<ReviewTask[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ per_page: '100' });
      if (scope === 'me') params.set('assignee', 'me');
      if (scope === 'overdue') params.set('overdue', 'true');
      if (status) params.set('status', status);
      const res = await api<{ tasks: ReviewTask[]; total: number }>(`/tasks?${params}`);
      setTasks(res.tasks);
      setTotal(res.total);
    } catch {
      setError('Could not load tasks.');
    }
  }, [scope, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const patchTask = async (task: ReviewTask, patch: Record<string, unknown>) => {
    try {
      await api(`/tasks/${task.id}`, { method: 'PATCH', body: patch });
      await load();
    } catch {
      setError('Could not update the task.');
    }
  };

  return (
    <div>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Toggle options={SCOPES} value={scope} onChange={setScope} />
        <Select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value as '' | ReviewTaskStatus)}
          className="w-40"
        >
          <option value="">Any status</option>
          {REVIEW_TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TASK_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
        <span className="tnum ml-auto text-sm text-ink-400">{total} tasks</span>
      </div>

      <div className="mt-6">
        {error && <ErrorNote>{error}</ErrorNote>}
        {!tasks && !error && <Spinner />}
        {tasks && tasks.length === 0 && (
          <EmptyState title="Nothing here">
            {scope === 'overdue' ? 'No overdue tasks — the SLA board is clean.' : 'No tasks match this filter.'}
          </EmptyState>
        )}
        {tasks && tasks.length > 0 && (
          <ul className="divide-y divide-paper-300 rounded-lg border border-paper-300 bg-white shadow-card">
            {tasks.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/valuations/${task.valuation_id}/tasks`}
                      className="text-sm font-semibold text-ink-900 hover:text-bond-700"
                    >
                      {task.title}
                    </Link>
                    <TaskStatusBadge task={task} />
                    {task.due_at && (
                      <span
                        className={`tnum text-xs font-semibold ${
                          task.overdue ? 'text-red-600' : 'text-ink-400'
                        }`}
                      >
                        {dueLabel(task.due_at)}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-ink-400">
                    {TASK_KIND_LABELS[task.kind] ?? task.kind}
                    {task.assignee_id === user?.id && ' · assigned to you'}
                  </div>
                </div>
                {task.assignee_id !== user?.id && task.status !== 'done' && task.status !== 'cancelled' && (
                  <Button
                    variant="ghost"
                    onClick={() => void patchTask(task, { assignee_id: user?.id ?? null })}
                  >
                    Pick up
                  </Button>
                )}
                <Select
                  aria-label={`Assignee of ${task.title}`}
                  value={task.assignee_id ?? ''}
                  onChange={(e) => void patchTask(task, { assignee_id: e.target.value || null })}
                  className="w-44"
                >
                  <option value="">Unassigned</option>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {displayName(o)}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label={`Status of ${task.title}`}
                  value={task.status}
                  onChange={(e) => void patchTask(task, { status: e.target.value })}
                  className="w-36"
                >
                  {REVIEW_TASK_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {TASK_STATUS_LABELS[s]}
                    </option>
                  ))}
                </Select>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Review queue tab — valuations awaiting approve / request-changes ─────────

function ReviewQueue({ options }: { options: UserOption[] }) {
  const { user } = useAuth();
  const [mine, setMine] = useState<'me' | 'all'>('me');
  const [reviews, setReviews] = useState<ReviewQueueItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Valuation currently collecting a request-changes comment. */
  const [changesFor, setChangesFor] = useState<string | null>(null);
  const [comment, setComment] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ per_page: '100' });
      if (mine === 'me') params.set('assignee', 'me');
      const res = await api<{ reviews: ReviewQueueItem[]; total: number }>(`/reviews?${params}`);
      setReviews(res.reviews);
      setTotal(res.total);
    } catch {
      setError('Could not load the review queue.');
    }
  }, [mine]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (v: ReviewQueueItem, decision: 'approve' | 'request_changes') => {
    setBusyId(v.id);
    setError(null);
    try {
      await api(`/valuations/${v.id}/review/decision`, {
        method: 'POST',
        body: { decision, ...(decision === 'request_changes' && comment.trim() ? { comment: comment.trim() } : {}) },
      });
      setChangesFor(null);
      setComment('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the decision.');
    } finally {
      setBusyId(null);
    }
  };

  const reviewerName = (id: string | null) => {
    if (!id) return 'Unassigned';
    const option = options.find((o) => o.id === id);
    return option ? displayName(option) : id;
  };

  return (
    <div>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Toggle
          options={[
            { key: 'me' as const, label: 'Assigned to me' },
            { key: 'all' as const, label: 'All in review' },
          ]}
          value={mine}
          onChange={setMine}
        />
        <span className="tnum ml-auto text-sm text-ink-400">{total} awaiting review</span>
      </div>

      <div className="mt-6">
        {error && <ErrorNote>{error}</ErrorNote>}
        {!reviews && !error && <Spinner />}
        {reviews && reviews.length === 0 && (
          <EmptyState title="Review queue is clear">
            {mine === 'me'
              ? 'Nothing in review is assigned to you.'
              : 'No valuations are waiting on a review decision.'}
          </EmptyState>
        )}
        {reviews && reviews.length > 0 && (
          <ul className="divide-y divide-paper-300 rounded-lg border border-paper-300 bg-white shadow-card">
            {reviews.map((v) => (
              <li key={v.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to={`/valuations/${v.id}`}
                        className="text-sm font-semibold text-ink-900 hover:text-bond-700"
                      >
                        {v.company_name}
                      </Link>
                      <KindBadge kind={v.kind} />
                      <StateBadge state={v.state} />
                      {v.signed_main ? (
                        <span className="rounded-full bg-bond-50 px-2 py-0.5 text-xs font-semibold text-bond-700 ring-1 ring-inset ring-bond-200">
                          Signed
                        </span>
                      ) : (
                        <span
                          className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-inset ring-amber-200"
                          title="A main signature is required before this valuation can be published."
                        >
                          Awaiting signature
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-400">
                      {KIND_LABELS[v.kind]} ·{' '}
                      {v.assigned_reviewer_id === user?.id
                        ? 'assigned to you'
                        : reviewerName(v.assigned_reviewer_id)}
                      {v.due_date && ` · due ${formatDate(v.due_date)}`}
                    </div>
                  </div>
                  <Button
                    disabled={busyId === v.id}
                    onClick={() => void decide(v, 'approve')}
                    title={`Advance to ${STATE_LABELS[v.state === 'review' ? 'reviewed' : 'drafted']}`}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busyId === v.id}
                    onClick={() => {
                      setComment('');
                      setChangesFor(changesFor === v.id ? null : v.id);
                    }}
                  >
                    Request changes
                  </Button>
                </div>
                {changesFor === v.id && (
                  <form
                    className="mt-3 flex flex-wrap items-end gap-2 rounded-md bg-paper-100 p-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void decide(v, 'request_changes');
                    }}
                  >
                    <div className="min-w-64 flex-1">
                      <label className="mb-1.5 block text-[0.8rem] font-semibold text-ink-700">
                        What needs to change?
                      </label>
                      <textarea
                        aria-label={`Changes requested for ${v.company_name}`}
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        rows={2}
                        className="w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 focus:border-bond-500 focus:outline-none"
                        placeholder="Recorded as an internal note on the valuation."
                      />
                    </div>
                    <Button type="submit" disabled={busyId === v.id}>
                      Send back
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setChangesFor(null)}>
                      Cancel
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
