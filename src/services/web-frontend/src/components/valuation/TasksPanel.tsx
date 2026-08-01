import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  REVIEW_TASK_KINDS,
  REVIEW_TASK_STATUSES,
  TASK_KIND_LABELS,
  TASK_STATUS_LABELS,
  dueLabel,
  type ReviewTask,
  type ReviewTaskKind,
  type ReviewTaskStatus,
} from '../../lib/pipeline';
import { Button, EmptyState, ErrorNote, Field, Select, Spinner, TextInput } from '../ui';

export function TaskStatusBadge({ task }: { task: Pick<ReviewTask, 'status' | 'overdue'> }) {
  const tone =
    task.overdue && task.status !== 'done' && task.status !== 'cancelled'
      ? 'bg-red-50 text-red-800 ring-red-200'
      : task.status === 'done'
        ? 'bg-bond-50 text-bond-700 ring-bond-200'
        : task.status === 'in_progress'
          ? 'bg-sky-50 text-sky-800 ring-sky-200'
          : task.status === 'blocked'
            ? 'bg-amber-50 text-amber-800 ring-amber-200'
            : 'bg-paper-200 text-ink-600 ring-ink-200';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${tone}`}
    >
      {task.overdue && task.status !== 'done' && task.status !== 'cancelled'
        ? 'Overdue'
        : TASK_STATUS_LABELS[task.status]}
    </span>
  );
}

/** Review pipeline tasks for one valuation: create, assign, move status. Ops-only. */
export function TasksPanel({ valuationId }: { valuationId: string }) {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<ReviewTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    kind: 'data_review' as ReviewTaskKind,
    title: '',
    sla_hours: '48',
    assignToMe: true,
  });

  const load = useCallback(async () => {
    try {
      const { tasks: items } = await api<{ tasks: ReviewTask[] }>(`/valuations/${valuationId}/tasks`);
      setTasks(items);
    } catch {
      setError('Could not load tasks.');
    }
  }, [valuationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api(`/valuations/${valuationId}/tasks`, {
        method: 'POST',
        body: {
          kind: form.kind,
          title: form.title.trim(),
          sla_hours: form.sla_hours ? Number(form.sla_hours) : null,
          assignee_id: form.assignToMe ? user?.id : null,
        },
      });
      setForm((f) => ({ ...f, title: '' }));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the task.');
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (task: ReviewTask, status: ReviewTaskStatus) => {
    try {
      await api(`/tasks/${task.id}`, { method: 'PATCH', body: { status } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the task.');
    }
  };

  if (!tasks && !error) return <Spinner />;

  return (
    <div className="space-y-6">
      {error && <ErrorNote>{error}</ErrorNote>}

      <form onSubmit={create} className="rounded-lg border border-paper-300 bg-surface p-5 shadow-card">
        <h3 className="overline mb-4 text-ink-400">New review task</h3>
        <div className="grid gap-4 sm:grid-cols-[1fr_11rem_7rem_auto]">
          <Field label="Title">
            <TextInput
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="e.g. Tie out preferred share count"
              required
              maxLength={300}
            />
          </Field>
          <Field label="Type">
            <Select
              value={form.kind}
              onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as ReviewTaskKind }))}
            >
              {REVIEW_TASK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {TASK_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="SLA (hours)">
            <TextInput
              type="number"
              min={1}
              max={2160}
              value={form.sla_hours}
              onChange={(e) => setForm((f) => ({ ...f, sla_hours: e.target.value }))}
            />
          </Field>
          <div className="flex items-end pb-0.5">
            <Button type="submit" disabled={busy || !form.title.trim()}>
              {busy ? 'Adding…' : 'Add task'}
            </Button>
          </div>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-ink-600">
          <input
            type="checkbox"
            checked={form.assignToMe}
            onChange={(e) => setForm((f) => ({ ...f, assignToMe: e.target.checked }))}
          />
          Assign to me
        </label>
      </form>

      {tasks && tasks.length === 0 && (
        <EmptyState title="No review tasks yet">
          Create typed tasks to drive the analyst → reviewer → sign-off pipeline.
        </EmptyState>
      )}

      {tasks && tasks.length > 0 && (
        <ul className="divide-y divide-paper-300 rounded-lg border border-paper-300 bg-surface shadow-card">
          {tasks.map((task) => (
            <li key={task.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink-900">{task.title}</span>
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
                onChange={(e) => void setStatus(task, e.target.value as ReviewTaskStatus)}
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
  );
}
