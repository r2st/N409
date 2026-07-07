import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { VALUATION_KINDS } from '../domain/valuation.js';
import {
  activateTemplate,
  archiveTemplate,
  createTemplateVersion,
  findTemplateById,
  listTemplates,
  templateLabel,
  updateDraftTemplate,
  type ReportTemplateRow,
} from '../repos/reportTemplates.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Report template management (M4, P1 #20). Versioned like "409a.v53":
 * creating against an existing name mints the next version as a draft;
 * activation atomically archives the previously active version.
 * Ops-only — templates are production tooling.
 */

const CreateBody = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase letters, digits, - and _ only'),
  kind: z.enum(VALUATION_KINDS),
  body: z.string().max(1_000_000).optional(),
  notes: z.string().max(2000).optional(),
});

const PatchBody = z
  .object({
    body: z.string().max(1_000_000),
    notes: z.string().max(2000).nullable(),
  })
  .partial()
  .strict();

const ListQuery = z.object({
  name: z.string().optional(),
  kind: z.enum(VALUATION_KINDS).optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
});

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('Report templates are operations-only');
}

function serialize(t: ReportTemplateRow) {
  return { ...t, label: templateLabel(t) };
}

async function loadTemplate(pool: pg.Pool, id: string): Promise<ReportTemplateRow> {
  if (!isUlid(id)) throw problems.notFound();
  const template = await findTemplateById(pool, id);
  if (!template) throw problems.notFound();
  return template;
}

export function registerTemplateRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  // P2 #12 — template changes land in the admin audit log.
  const audit = async (
    type: string,
    actorId: string,
    template: ReportTemplateRow,
    payload: Record<string, unknown> = {},
  ) => {
    await recordAdminEvent(deps.pool, {
      type,
      actor: { actorType: 'human', actorId },
      subjectType: 'template',
      subjectId: template.id,
      subjectLabel: templateLabel(template),
      payload,
    });
  };

  app.get('/api/v1/report-templates', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) throw problems.badRequest('Invalid query', { errors: parsed.error.issues });
    const templates = await listTemplates(deps.pool, parsed.data);
    return { templates: templates.map(serialize) };
  });

  app.post('/api/v1/report-templates', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid template', { errors: parsed.error.issues });
    const template = await createTemplateVersion(deps.pool, {
      ...parsed.data,
      createdBy: principal.id,
    });
    await audit('template_created', principal.id, template);
    return reply.status(201).send({ template: serialize(template) });
  });

  app.get('/api/v1/report-templates/:id', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    return { template: serialize(await loadTemplate(deps.pool, id)) };
  });

  app.patch('/api/v1/report-templates/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const template = await loadTemplate(deps.pool, id);

    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid patch', { errors: parsed.error.issues });
    if (template.status !== 'draft') {
      throw problems.conflict('Only draft templates are editable — create a new version instead');
    }
    const updated = await updateDraftTemplate(deps.pool, id, parsed.data);
    if (!updated) throw problems.conflict('Template is no longer a draft');
    await audit('template_updated', principal.id, updated, { fields: Object.keys(parsed.data) });
    return { template: serialize(updated) };
  });

  app.post('/api/v1/report-templates/:id/activate', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const template = await loadTemplate(deps.pool, id);
    if (template.status === 'archived') {
      throw problems.conflict('Archived versions cannot be re-activated — create a new version');
    }
    const activated = await activateTemplate(deps.pool, id);
    await audit('template_activated', principal.id, activated ?? template);
    return { template: serialize(activated ?? template) };
  });

  app.post('/api/v1/report-templates/:id/archive', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    await loadTemplate(deps.pool, id);
    const archived = await archiveTemplate(deps.pool, id);
    await audit('template_archived', principal.id, archived!);
    return { template: serialize(archived!) };
  });
}
