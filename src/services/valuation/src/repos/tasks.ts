import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import {
  PIPELINE_EVENT_TYPES,
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
export async function createTask(pool: pg.Pool, input: CreateTaskInput, actor: EventActor): Promise<ReviewTaskRow> {
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
     ORDER BY (t.status IN ('done','cancelled')), t.due_at ASC NULLS LAST, t.created_at DESC
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

/** Applies a field patch; stamps started_at/completed_at on status moves. */
export async function patchTask(
  pool: pg.Pool,
  current: ReviewTaskRow,
  fields: Record<string, unknown>,
  actor: EventActor,
): Promise<ReviewTaskRow> {
  const entries = Object.entries(fields).filter(
    ([k, v]) => TASK_PATCH_COLUMNS.has(k) && current[k] !== v,
  );
  if (entries.length === 0) return current;

  return withTransaction(pool, async (client) => {
    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [];
    for (const [key, value] of entries) {
      params.push(value);
      sets.push(`${key} = $${params.length}`);
    }

    const newStatus = fields.status as ReviewTaskStatus | undefined;
    if (newStatus && newStatus !== current.status) {
      if (newStatus === 'in_progress' && !current.started_at) sets.push('started_at = now()');
      if (newStatus === 'done' || newStatus === 'cancelled') sets.push('completed_at = now()');
      else sets.push('completed_at = NULL');
    }

    params.push(current.id);
    const { rows } = await client.query<ReviewTaskRow>(
      `UPDATE review_tasks AS t SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING *, ${OVERDUE_SQL}`,
      params,
    );

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
