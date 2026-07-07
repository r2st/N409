import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isOps } from '../lib/rbac';
import {
  REVIEW_TASK_STATUSES,
  TASK_KIND_LABELS,
  TASK_STATUS_LABELS,
  dueLabel,
  type ReviewTask,
  type ReviewTaskStatus,
} from '../lib/pipeline';
import { TaskStatusBadge } from '../components/valuation/TasksPanel';
import { EmptyState, ErrorNote, Select, Spinner } from '../components/ui';

type Scope = 'me' | 'all' | 'overdue';

const SCOPES: Array<{ key: Scope; label: string }> = [
  { key: 'me', label: 'Assigned to me' },
  { key: 'all', label: 'All tasks' },
  { key: 'overdue', label: 'Overdue' },
];

/** Global review-task queue (ops): SLA tracking across every valuation. */
export function TasksPage() {
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

  const setTaskStatus = async (task: ReviewTask, next: ReviewTaskStatus) => {
    try {
      await api(`/tasks/${task.id}`, { method: 'PATCH', body: { status: next } });
      await load();
    } catch {
      setError('Could not update the task.');
    }
  };

  if (!isOps(user)) {
    return <ErrorNote>Review tasks are available to operations roles only.</ErrorNote>;
  }

  return (
    <div>
      <h1 className="font-display text-3xl font-semibold text-ink-900">Review tasks</h1>
      <p className="mt-1 text-sm text-ink-500">
        The analyst → reviewer → sign-off pipeline across all valuations.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border border-ink-200 bg-white p-0.5">
          {SCOPES.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setScope(key)}
              className={`cursor-pointer rounded px-3 py-1.5 text-sm font-semibold transition-colors ${
                scope === key ? 'bg-ink-900 text-paper-50' : 'text-ink-600 hover:text-ink-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
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
                  </div>
                  <div className="mt-0.5 text-xs text-ink-400">
                    {TASK_KIND_LABELS[task.kind] ?? task.kind}
                    {task.assignee_id === user?.id && ' · assigned to you'}
                    {task.due_at && ` · ${dueLabel(task.due_at)}`}
                  </div>
                </div>
                <Select
                  aria-label={`Status of ${task.title}`}
                  value={task.status}
                  onChange={(e) => void setTaskStatus(task, e.target.value as ReviewTaskStatus)}
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
