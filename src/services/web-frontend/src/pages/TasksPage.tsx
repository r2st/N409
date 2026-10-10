import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, describeActionFailure, describeLoadFailure } from '../lib/api';
import { useFormValidation } from '../lib/useFormValidation';
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
import {
  Button,
  EmptyState,
  ErrorNote,
  Field,
  KindBadge,
  LoadError,
  PickerOverflowNote,
  ResultCount,
  Select,
  StateBadge,
  TableSkeleton,
} from '../components/ui';

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
    <div className="flex rounded-md border border-ink-200 bg-surface p-0.5">
      {options.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          aria-pressed={value === key}
          className={`tap-area cursor-pointer rounded px-3 py-1.5 text-sm font-semibold transition-colors ${
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
  const [optionsCapped, setOptionsCapped] = useState(false);
  /*
   * The roster failing to load is not the same as the roster being empty, and
   * both tabs below turn an empty roster into a claim about people: the task
   * picker labels every assignee it cannot find "(not in list)", and the review
   * queue prints raw ids where names go. Neither is true of an outage, so the
   * outage has to say its own name. Mirrors `WorkflowActions`.
   */
  const [optionsFailed, setOptionsFailed] = useState(false);

  useEffect(() => {
    api<{ options: UserOption[]; truncated: boolean }>('/users/options?group=ops')
      .then((res) => {
        setOptions(res.options);
        setOptionsCapped(res.truncated);
      })
      .catch(() => setOptionsFailed(true));
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
      {view === 'tasks' ? (
        <TaskQueue options={options} capped={optionsCapped} rosterFailed={optionsFailed} />
      ) : (
        <ReviewQueue options={options} rosterFailed={optionsFailed} />
      )}
    </div>
  );
}

/**
 * Says the roster is missing rather than letting an empty one speak for it.
 * Both tabs render people from `/users/options`, and both degrade into claims
 * about those people when the list is absent.
 */
function RosterUnavailableNote() {
  return (
    <p className="mt-4 text-sm text-ink-400">
      The list of operations users could not be loaded, so names are shown as ids and assignees cannot be
      changed here. Reload the page to try again.
    </p>
  );
}

// ── Tasks tab — typed review tasks with inline actions ───────────────────────

function TaskQueue({
  options,
  capped,
  rosterFailed,
}: {
  options: UserOption[];
  capped: boolean;
  rosterFailed: boolean;
}) {
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
    } catch (err) {
      setError(describeLoadFailure(err, 'Could not load tasks.'));
    }
  }, [scope, status]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Two things a failed patch owes the reader, and this owed neither.
   *
   * The server refuses a status move that lost a race by naming where the task
   * actually went — "This task moved to 'Done' while your change was being
   * made" — and a bare `catch` threw that sentence away for "Could not update
   * the task", which is the operation and not the reason.
   * `describeActionFailure` is what the panel next door already uses.
   *
   * And the board is now a screen showing a status the database disagrees with:
   * the row still reads "Open" because nothing re-fetched. Reloading on the
   * failure is what makes the refusal actionable — the reader is told the task
   * moved *and* shown where to.
   */
  const patchTask = async (task: ReviewTask, patch: Record<string, unknown>) => {
    try {
      await api(`/tasks/${task.id}`, { method: 'PATCH', body: patch });
      await load();
    } catch (err) {
      const message = describeActionFailure(err, 'Could not update the task.');
      await load();
      setError(message);
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
        {/* The same figure as the span beside it, in a live region — the span
            is silent, so changing the status filter changed the list and said
            nothing. */}
        <ResultCount count={total} noun="task" />
      </div>

      <div className="mt-6">
        {error && !tasks && <LoadError message={error} onRetry={() => { setError(null); void load(); }} />}
        {error && tasks && <ErrorNote>{error}</ErrorNote>}
        {rosterFailed && <RosterUnavailableNote />}
        {!tasks && !error && <TableSkeleton columns={5} rows={6} label="Loading tasks…" />}
        {tasks && tasks.length === 0 && (
          <EmptyState title="Nothing here">
            {scope === 'overdue'
              ? 'No overdue tasks — the SLA board is clean.'
              : 'No tasks match this filter.'}
          </EmptyState>
        )}
        {tasks && tasks.length > 0 && (
          <ul className="divide-y divide-paper-300 rounded-lg border border-paper-300 bg-surface shadow-card">
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
                  /*
                   * With no roster the only reachable option is "Unassigned",
                   * and this picker writes on change — so a failed load turned
                   * the control into a one-way unassign button for a queue ops
                   * were only trying to read.
                   */
                  disabled={rosterFailed}
                >
                  <option value="">Unassigned</option>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {displayName(o)}
                    </option>
                  ))}
                  {/*
                   * The roster this picker lists is neither complete nor
                   * permanent: `/users/options` drops deleted accounts and caps
                   * at PICKER_LIMIT (hence `capped`), while `assignee_id` is
                   * whoever the task was given to whenever that happened. A
                   * controlled `<select>` whose value matches no option selects
                   * nothing, so a task assigned to somebody off the list read as
                   * *Unassigned* — the one state the row also offers to fix,
                   * with "Pick up" sitting next to it. Carrying the id as its own
                   * option keeps the select honest; the label falls back to the
                   * id exactly as `reviewerName` does on the other tab.
                   */}
                  {task.assignee_id && !options.some((o) => o.id === task.assignee_id) && (
                    <option value={task.assignee_id}>
                      {/*
                       * "(not in list)" is a finding about the person — they
                       * left, or lost the role. It is only a finding when there
                       * was a list to be absent from; when the roster failed to
                       * load *every* assignee is missing from it, and the row
                       * would accuse the whole queue of having been deleted.
                       */}
                      {task.assignee_id}
                      {rosterFailed ? '' : ' (not in list)'}
                    </option>
                  )}
                  <PickerOverflowNote truncated={capped} />
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

function ReviewQueue({ options, rosterFailed }: { options: UserOption[]; rosterFailed: boolean }) {
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
    } catch (err) {
      setError(describeLoadFailure(err, 'Could not load the review queue.'));
    }
  }, [mine]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * Sending a valuation back is the one decision that carries an instruction,
   * and the box collecting it was optional: "Send back" on an empty form
   * returned the engagement to the analyst with the state changed and nothing
   * saying why. The API still accepts a bare `request_changes` — approving does
   * not need a note — so the requirement belongs here, on the form that asks
   * the question.
   */
  const { errorFor, blurHandler, handleSubmit, reset } = useFormValidation(
    { comment },
    {
      comment: (v) =>
        String(v.comment).trim() ? null : 'Say what needs to change — this is the note the analyst gets.',
    },
  );

  const decide = async (v: ReviewQueueItem, decision: 'approve' | 'request_changes') => {
    setBusyId(v.id);
    setError(null);
    try {
      await api(`/valuations/${v.id}/review/decision`, {
        method: 'POST',
        body: {
          decision,
          ...(decision === 'request_changes' && comment.trim() ? { comment: comment.trim() } : {}),
        },
      });
      setChangesFor(null);
      setComment('');
      reset();
      await load();
    } catch (err) {
      setError(describeActionFailure(err, 'Could not record the decision.'));
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
        {error && !reviews && <LoadError message={error} onRetry={() => { setError(null); void load(); }} />}
        {error && reviews && <ErrorNote>{error}</ErrorNote>}
        {rosterFailed && <RosterUnavailableNote />}
        {!reviews && !error && <TableSkeleton columns={5} rows={4} label="Loading review queue…" />}
        {reviews && reviews.length === 0 && (
          <EmptyState title="Review queue is clear">
            {mine === 'me'
              ? 'Nothing in review is assigned to you.'
              : 'No valuations are waiting on a review decision.'}
          </EmptyState>
        )}
        {reviews && reviews.length > 0 && (
          <ul className="divide-y divide-paper-300 rounded-lg border border-paper-300 bg-surface shadow-card">
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
                      // The panel is reused for whichever valuation is open, so
                      // a message revealed on the last one must not greet the
                      // next with an error it has not earned.
                      reset();
                      setChangesFor(changesFor === v.id ? null : v.id);
                    }}
                  >
                    Request changes
                  </Button>
                </div>
                {changesFor === v.id && (
                  <form
                    className="mt-3 flex flex-wrap items-end gap-2 rounded-md bg-paper-100 p-3"
                    onSubmit={handleSubmit(() => decide(v, 'request_changes'))}
                    noValidate
                  >
                    <div className="min-w-64 flex-1">
                      <Field label="What needs to change?" error={errorFor('comment')}>
                        <textarea
                          aria-label={`Changes requested for ${v.company_name}`}
                          value={comment}
                          onChange={(e) => setComment(e.target.value)}
                          onBlur={blurHandler('comment')}
                          required
                          rows={2}
                          className="w-full rounded-md border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 focus:border-bond-500 focus:outline-none"
                          placeholder="Recorded as an internal note on the valuation."
                        />
                      </Field>
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
