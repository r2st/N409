import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { REVIEW_TASK_KINDS, REVIEW_TASK_STATUSES, canTransitionTask, TASK_STATUS_LABELS } from '../domain/pipeline.js';
import { findValuationById } from '../repos/valuations.js';
import { createTask, findTaskById, listTasks, patchTask } from '../repos/tasks.js';
import { assertAssignable, assigneeFilter } from '../domain/assignee.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';
import { pageParam } from '../domain/pagination.js';
import { flagParam } from '../domain/queryFlag.js';
import { refuseIfRetired, refuseIfSubjectRetired } from '../domain/retiredEngagement.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { nonBlankText } from '../domain/nonBlankText.js';
import { ulidField } from '../domain/ulidField.js';

const CreateBody = z.object({
  kind: z.enum(REVIEW_TASK_KINDS),
  title: nonBlankText(1, 300),
  description: z.string().max(5000).nullable().optional(),
  /*
   * `ulidField()`, not `z.string()`. `assertAssigneeExists` returns early on a
   * falsy id and the write is `parsed.data.assignee_id ?? null`, which keeps
   * `''` — so a blank assignee skipped the existence check and reached
   * `review_tasks.assignee_id ulid`, whose CHECK answered 23514 and the caller
   * "Internal Server Error". The SPA never saw it because `TasksPage` converts
   * its own blank option (`e.target.value || null`); no other client does. See
   * domain/ulidField.ts.
   */
  assignee_id: ulidField().nullable().optional(),
  sla_hours: z
    .number()
    .int()
    .positive()
    .max(24 * 90)
    .nullable()
    .optional(),
  due_at: z.string().datetime().nullable().optional(),
}).strict();

const PatchBody = z
  .object({
    kind: z.enum(REVIEW_TASK_KINDS),
    title: nonBlankText(1, 300),
    description: z.string().max(5000).nullable(),
    status: z.enum(REVIEW_TASK_STATUSES),
    assignee_id: ulidField().nullable(),
    sla_hours: z
      .number()
      .int()
      .positive()
      .max(24 * 90)
      .nullable(),
    due_at: z.string().datetime().nullable(),
  })
  .partial()
  .strict();

const ListQuery = z.object({
  valuation_id: ulidField().optional(),
  assignee: assigneeFilter().optional(),
  status: z.enum(REVIEW_TASK_STATUSES).optional(),
  overdue: flagParam(),
  page: pageParam(),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

function actorFor(principal: Principal): EventActor {
  return { actorType: 'human', actorId: principal.id, source: 'api' };
}

/** The review pipeline is internal — every task route is ops-only. */
function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('Review tasks are operations-only');
}

async function assertAssigneeExists(pool: pg.Pool, assigneeId: string | null | undefined): Promise<void> {
  if (!assigneeId) return;
  await assertAssignable(pool, assigneeId, 'assignee', 'assignee_id');
}

export function registerTaskRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.post('/api/v1/valuations/:id/tasks', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    refuseIfRetired(valuation, 'accepting tasks');

    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid task', parsed.error);
    await assertAssigneeExists(deps.pool, parsed.data.assignee_id);

    const task = await createTask(
      deps.pool,
      {
        valuationId: id,
        kind: parsed.data.kind,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        assigneeId: parsed.data.assignee_id ?? null,
        slaHours: parsed.data.sla_hours ?? null,
        dueAt: parsed.data.due_at ?? null,
        createdBy: principal.id,
      },
      actorFor(principal),
    );
    return reply.status(201).send({ task });
  });

  app.get('/api/v1/valuations/:id/tasks', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    if (!isUlid(id) || !(await findValuationById(deps.pool, id))) throw problems.notFound();
    const { items, total } = await listTasks(deps.pool, { valuationId: id, page: 1, perPage: 100 });
    return { tasks: items, total };
  });

  app.get('/api/v1/tasks', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error);
    const q = parsed.data;

    const { items, total } = await listTasks(deps.pool, {
      valuationId: q.valuation_id,
      assigneeId: q.assignee === 'me' ? principal.id : q.assignee,
      status: q.status,
      overdueOnly: q.overdue,
      page: q.page,
      perPage: q.per_page,
    });
    return { tasks: items, page: q.page, per_page: q.per_page, total };
  });

  app.patch('/api/v1/tasks/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const task = await findTaskById(deps.pool, id);
    if (!task) throw problems.notFound();
    // The create half of this pair is `POST /valuations/:id/tasks`, which has
    // refused to open a task on withdrawn work since R89 — because it is under
    // a valuation id, and that is the whole set the retirement sweep can see.
    // The edit is addressed by the task's own id, so it sat outside that shape
    // and let the same task be retitled, reassigned, given a new due date or
    // moved to done on a file the firm has closed, writing a
    // `review_task_updated` onto a spine nothing can erase.
    await refuseIfSubjectRetired(deps.pool, task, 'accepting changes to its tasks');

    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid patch', parsed.error);
    if ('assignee_id' in parsed.data) await assertAssigneeExists(deps.pool, parsed.data.assignee_id);

    if (parsed.data.status && parsed.data.status !== task.status) {
      if (!canTransitionTask(task.status, parsed.data.status)) {
        throw problems.conflict(
          `Cannot move a ${TASK_STATUS_LABELS[task.status]} task to ${TASK_STATUS_LABELS[parsed.data.status]}`,
        );
      }
    }

    const updated = await patchTask(
      deps.pool,
      task,
      parsed.data as Record<string, unknown>,
      actorFor(principal),
    );
    return { task: updated };
  });
}
