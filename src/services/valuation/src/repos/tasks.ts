import type pg from 'pg';
import { newUlid, problems } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import {
  PIPELINE_EVENT_TYPES,
  TASK_STATUS_LABELS,
  type ReviewTaskKind,
  type ReviewTaskStatus,
} from '../domain/pipeline.js';
import { recordEvent, type EventActor } from '../events/record.js';

export interface ReviewTaskRow {
  id: string;
  valuation_id: string;
  kind: ReviewTaskKind;
  title: string;
  description: string | null;
  status: ReviewTaskStatus;
  assignee_id: string | null;
  created_by: string | null;
  sla_hours: number | null;
  due_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  /** Computed in SQL: active task past its due_at. */
  overdue: boolean;
  [key: string]: unknown;
}

const OVERDUE_SQL = `(t.due_at IS NOT NULL
  AND t.status IN ('open','in_progress','blocked')
  AND t.due_at < now()) AS overdue`;

export interface CreateTaskInput {
  valuationId: string;
  kind: ReviewTaskKind;
  title: string;
  description?: string | null;
  assigneeId?: string | null;
  slaHours?: number | null;
  dueAt?: string | null;
  createdBy: string;
}

/**
 * Creates the task and its audit event atomically. When `slaHours` is given
 * without an explicit due date, due_at is derived from it (SLA tracking).
 */
export async function createTask(
  pool: pg.Pool,
  input: CreateTaskInput,
  actor: EventActor,
): Promise<ReviewTaskRow> {
  return withTransaction(pool, async (client) => {
    const id = newUlid();
    const { rows } = await client.query<ReviewTaskRow>(
      `INSERT INTO review_tasks AS t
         (id, valuation_id, kind, title, description, assignee_id, created_by, sla_hours, due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               COALESCE($9::timestamptz, CASE WHEN $8::integer IS NOT NULL THEN now() + make_interval(hours => $8::integer) END))
       RETURNING *, ${OVERDUE_SQL}`,
      [
        id,
        input.valuationId,
        input.kind,
        input.title,
        input.description ?? null,
        input.assigneeId ?? null,
        input.createdBy,
        input.slaHours ?? null,
        input.dueAt ?? null,
      ],
    );
    await recordEvent(client, {
      valuationId: input.valuationId,
      type: PIPELINE_EVENT_TYPES.taskCreated,
      actor,
      payload: { task_id: id, kind: input.kind, title: input.title, assignee_id: input.assigneeId ?? null },
    });
    return rows[0]!;
  });
}

export async function findTaskById(pool: pg.Pool, id: string): Promise<ReviewTaskRow | null> {
  const { rows } = await pool.query<ReviewTaskRow>(
    `SELECT *, ${OVERDUE_SQL} FROM review_tasks t WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface TaskFilters {
  valuationId?: string;
  assigneeId?: string;
  status?: ReviewTaskStatus;
  overdueOnly?: boolean;
  page: number;
  perPage: number;
}

export async function listTasks(
  pool: pg.Pool,
  filters: TaskFilters,
): Promise<{ items: ReviewTaskRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };

  if (filters.valuationId) add('t.valuation_id = ?', filters.valuationId);
  if (filters.assigneeId) add('t.assignee_id = ?', filters.assigneeId);
  if (filters.status) add('t.status = ?', filters.status);
  if (filters.overdueOnly) {
    where.push(`t.due_at IS NOT NULL AND t.status IN ('open','in_progress','blocked') AND t.due_at < now()`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM review_tasks t ${whereSql}`,
    params,
  );
  params.push(filters.perPage, (filters.page - 1) * filters.perPage);
  const { rows } = await pool.query<ReviewTaskRow>(
    `SELECT *, ${OVERDUE_SQL} FROM review_tasks t ${whereSql}
     ORDER BY (t.status IN ('done','cancelled')), t.due_at ASC NULLS LAST, t.created_at DESC, t.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: rows, total: Number(countRows[0]!.count) };
}

const TASK_PATCH_COLUMNS = new Set([
  'kind',
  'title',
  'description',
  'status',
  'assignee_id',
  'sla_hours',
  'due_at',
]);

/**
 * Applies a field patch; stamps started_at/completed_at on status moves.
 *
 * A STATUS MOVE IS CONDITIONAL ON THE STATUS THE CALLER READ. Everything this
 * decides — whether the status is changing at all, whether the clock starts,
 * whether completion is stamped or cleared, and what the audit event says the
 * task moved *from* — is computed from `current`, a row read on a different
 * connection some milliseconds earlier by the route. The tasks board is a
 * shared ops worklist with a status control on every row, so two people working
 * the same queue is the ordinary case rather than the exotic one, and off one
 * read both moves committed:
 *
 *   * Two `task_updated` events for one transition, the second saying
 *     `from: open` for a move out of `in_progress` — a transition that never
 *     happened, on the append-only spine a compliance reader is entitled to
 *     believe. `terminalStatusWrites` marks this table unguarded and is right
 *     about the question it asks: reopening a task is *meant* to be legal, so
 *     there is no terminal state to protect. "Is this still the state I read"
 *     is a different question and nothing was asking it.
 *   * `completed_at` re-stamped, so a task closed at 09:00 and touched again at
 *     11:00 by somebody still holding the morning's row reports the later time.
 *
 * Guarding only the status move is deliberate: a reassignment or a due-date
 * edit sets its own column and clobbers nothing, so failing it because a
 * colleague moved the status would be a refusal with no lost write behind it.
 *
 * `started_at` is decided in SQL rather than from `current` for the same
 * reason the guard exists — COALESCE reads the row being written, so the clock
 * cannot be restarted by a caller whose copy predates it starting.
 */
export async function patchTask(
  pool: pg.Pool,
  current: ReviewTaskRow,
  fields: Record<string, unknown>,
  actor: EventActor,
): Promise<ReviewTaskRow> {
  const entries = Object.entries(fields).filter(([k, v]) => TASK_PATCH_COLUMNS.has(k) && current[k] !== v);
  if (entries.length === 0) return current;

  return withTransaction(pool, async (client) => {
    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [];
    for (const [key, value] of entries) {
      params.push(value);
      sets.push(`${key} = $${params.length}`);
    }

    const newStatus = fields.status as ReviewTaskStatus | undefined;
    const moving = Boolean(newStatus && newStatus !== current.status);
    if (moving) {
      if (newStatus === 'in_progress') sets.push('started_at = COALESCE(started_at, now())');
      if (newStatus === 'done' || newStatus === 'cancelled') sets.push('completed_at = now()');
      else sets.push('completed_at = NULL');
    }

    params.push(current.id);
    const where = [`id = $${params.length}`];
    if (moving) {
      params.push(current.status);
      where.push(`status = $${params.length}`);
    }
    const { rows } = await client.query<ReviewTaskRow>(
      `UPDATE review_tasks AS t SET ${sets.join(', ')} WHERE ${where.join(' AND ')}
       RETURNING *, ${OVERDUE_SQL}`,
      params,
    );
    if (rows.length === 0) throw await stalePatch(client, current);

    const changes = Object.fromEntries(entries.map(([k, v]) => [k, { from: current[k] ?? null, to: v }]));
    await recordEvent(client, {
      valuationId: current.valuation_id,
      type: PIPELINE_EVENT_TYPES.taskUpdated,
      actor,
      payload: { task_id: current.id, changes },
    });
    return rows[0]!;
  });
}

/**
 * Why the conditional UPDATE matched nothing, as something to throw.
 *
 * The same two possibilities `staleAdvance` distinguishes for the engagement
 * board, and they want the same two answers: somebody else moved the task
 * (409, naming where it went, because that is what decides what the caller does
 * next), or the task is gone — its valuation was hard-deleted and
 * `ON DELETE CASCADE` took it (404). The throw rolls the transaction back, so a
 * lost race writes no event either.
 */
async function stalePatch(client: pg.PoolClient, current: ReviewTaskRow): Promise<Error> {
  const { rows } = await client.query<{ status: ReviewTaskStatus }>(
    'SELECT status FROM review_tasks WHERE id = $1',
    [current.id],
  );
  const actual = rows[0]?.status;
  if (actual === undefined)
    return problems.notFound(
      'This task no longer exists — the valuation it belongs to was deleted while this change was ' +
        'being made. Nothing was recorded.',
    );
  return problems.conflict(
    `This task moved to "${TASK_STATUS_LABELS[actual] ?? actual}" while your change was being made. ` +
      'Reload the task list and try again.',
  );
}
