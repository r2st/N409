import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps } from '../auth/rbac.js';
import { VALUATION_STATES } from '../domain/valuation.js';
import {
  AUTO_EMAIL_CONDITIONS,
  renderTemplate,
  type AutoEmailRow,
  type CommunicationTemplateRow,
} from '../domain/communications.js';
import {
  createAutoEmail,
  createCommunicationTemplate,
  deleteAutoEmail,
  deleteCommunicationTemplate,
  findAutoEmailById,
  findTemplateById,
  findTemplateByKey,
  listAutoEmails,
  listCommunicationTemplates,
  updateAutoEmail,
  updateCommunicationTemplate,
} from '../repos/communications.js';
import { runDueAutoEmails } from '../hooks/autoEmails.js';
import { retryFailedEmails } from '../hooks/emailRetry.js';
import type { EmailTransport } from '../hooks/stateChange.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Communication templates + auto email campaigns (409.ai §15.5/§15.6).
 * Ops-only, audited. Templates re-skin the workflow/transactional emails and
 * feed the drip campaigns; campaigns are scanned on an interval (index.ts)
 * and on demand via POST /admin/auto-emails/run.
 */

const TemplateBody = z.object({
  key: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_]+$/, 'lowercase letters, digits and _ only'),
  channel: z.enum(['email', 'sms']).default('email'),
  description: z.string().max(500).default(''),
  subject: z.string().max(500).default(''),
  body: z.string().min(1).max(20_000),
  enabled: z.boolean().default(true),
});

const TemplatePatch = TemplateBody.omit({ key: true, channel: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'empty patch' });

const AutoEmailBody = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_]+$/, 'lowercase letters, digits and _ only'),
  channel: z.enum(['email', 'sms']).default('email'),
  trigger_state: z.enum(VALUATION_STATES),
  condition: z.enum(AUTO_EMAIL_CONDITIONS).default('always'),
  delay_hours: z
    .number()
    .int()
    .min(0)
    .max(24 * 90)
    .default(24),
  repeat_hours: z
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .nullable()
    .default(null),
  max_sends: z.number().int().min(1).max(10).default(1),
  template_key: z.string().min(1).max(100),
  enabled: z.boolean().default(true),
});

const AutoEmailPatch = AutoEmailBody.omit({ name: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'empty patch' });

export function registerCommunicationRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; transport?: EmailTransport; smsTransport?: EmailTransport },
): void {
  const requireOps = (req: Parameters<typeof requirePrincipal>[0]) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Communication settings are operations-only');
    return principal;
  };

  const auditTemplate = async (actorId: string, type: string, t: CommunicationTemplateRow) =>
    recordAdminEvent(deps.pool, {
      type,
      actor: { actorType: 'human', actorId },
      subjectType: 'communication_template',
      subjectId: t.id,
      subjectLabel: t.key,
      payload: { channel: t.channel, enabled: t.enabled },
    });

  const auditAutoEmail = async (actorId: string, type: string, a: AutoEmailRow) =>
    recordAdminEvent(deps.pool, {
      type,
      actor: { actorType: 'human', actorId },
      subjectType: 'auto_email',
      subjectId: a.id,
      subjectLabel: a.name,
      payload: {
        channel: a.channel,
        trigger_state: a.trigger_state,
        template_key: a.template_key,
        enabled: a.enabled,
      },
    });

  // ── Templates ───────────────────────────────────────────────────────────────

  app.get('/api/v1/admin/communication-templates', { preHandler: app.authenticate }, async (req) => {
    requireOps(req);
    return { templates: await listCommunicationTemplates(deps.pool) };
  });

  app.post('/api/v1/admin/communication-templates', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireOps(req);
    const parsed = TemplateBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid template', { errors: parsed.error.issues });
    if (parsed.data.channel === 'email' && !parsed.data.subject)
      throw problems.unprocessable('Email templates need a subject');
    if (await findTemplateByKey(deps.pool, parsed.data.key))
      throw problems.conflict('A template with this key already exists');

    const template = await createCommunicationTemplate(deps.pool, parsed.data, principal.id);
    await auditTemplate(principal.id, 'communication_template_created', template);
    return reply.status(201).send({ template });
  });

  app.patch('/api/v1/admin/communication-templates/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requireOps(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const existing = await findTemplateById(deps.pool, id);
    if (!existing) throw problems.notFound();

    const parsed = TemplatePatch.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid patch', { errors: parsed.error.issues });
    if (existing.channel === 'email' && parsed.data.subject === '')
      throw problems.unprocessable('Email templates need a subject');

    const template = await updateCommunicationTemplate(deps.pool, id, parsed.data, principal.id);
    if (!template) throw problems.notFound();
    await auditTemplate(principal.id, 'communication_template_updated', template);
    return { template };
  });

  app.delete(
    '/api/v1/admin/communication-templates/:id',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requireOps(req);
      const { id } = req.params as { id: string };
      if (!isUlid(id)) throw problems.notFound();
      const existing = await findTemplateById(deps.pool, id);
      if (!existing) throw problems.notFound();
      if (!(await deleteCommunicationTemplate(deps.pool, id)))
        throw problems.conflict('Template is referenced by an auto email campaign');
      await auditTemplate(principal.id, 'communication_template_deleted', existing);
      return reply.status(204).send();
    },
  );

  // Renders a template against sample vars — the admin UI preview.
  app.post(
    '/api/v1/admin/communication-templates/:id/preview',
    { preHandler: app.authenticate },
    async (req) => {
      requireOps(req);
      const { id } = req.params as { id: string };
      if (!isUlid(id)) throw problems.notFound();
      const template = await findTemplateById(deps.pool, id);
      if (!template) throw problems.notFound();

      const vars = z.record(z.union([z.string(), z.number()])).parse(
        (req.body as { vars?: unknown } | null)?.vars ?? {
          company_name: 'Acme Corp',
          kind: '409a',
          kind_label: '409A',
          valuation_number: '1766',
          link: 'https://example.com/reset-password#token=…',
          invited_by: 'ops@n409.local',
        },
      );
      return {
        subject: renderTemplate(template.subject, vars),
        body: renderTemplate(template.body, vars),
      };
    },
  );

  // ── Auto email campaigns ────────────────────────────────────────────────────

  app.get('/api/v1/admin/auto-emails', { preHandler: app.authenticate }, async (req) => {
    requireOps(req);
    return { auto_emails: await listAutoEmails(deps.pool) };
  });

  app.post('/api/v1/admin/auto-emails', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireOps(req);
    const parsed = AutoEmailBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid campaign', { errors: parsed.error.issues });

    const template = await findTemplateByKey(deps.pool, parsed.data.template_key);
    if (!template) throw problems.unprocessable('Unknown template_key');
    if (template.channel !== parsed.data.channel)
      throw problems.unprocessable(
        `Template ${template.key} is a ${template.channel} template; the campaign channel must match`,
      );

    let campaign: AutoEmailRow;
    try {
      campaign = await createAutoEmail(deps.pool, parsed.data);
    } catch (err) {
      if ((err as { code?: string }).code === '23505')
        throw problems.conflict('A campaign with this name already exists');
      throw err;
    }
    await auditAutoEmail(principal.id, 'auto_email_created', campaign);
    return reply.status(201).send({ auto_email: campaign });
  });

  app.patch('/api/v1/admin/auto-emails/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requireOps(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const existing = await findAutoEmailById(deps.pool, id);
    if (!existing) throw problems.notFound();

    const parsed = AutoEmailPatch.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid patch', { errors: parsed.error.issues });

    const templateKey = parsed.data.template_key ?? existing.template_key;
    const channel = parsed.data.channel ?? existing.channel;
    const template = await findTemplateByKey(deps.pool, templateKey);
    if (!template) throw problems.unprocessable('Unknown template_key');
    if (template.channel !== channel)
      throw problems.unprocessable(
        `Template ${template.key} is a ${template.channel} template; the campaign channel must match`,
      );

    const campaign = await updateAutoEmail(deps.pool, id, parsed.data);
    if (!campaign) throw problems.notFound();
    await auditAutoEmail(principal.id, 'auto_email_updated', campaign);
    return { auto_email: campaign };
  });

  app.delete('/api/v1/admin/auto-emails/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireOps(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const existing = await findAutoEmailById(deps.pool, id);
    if (!existing) throw problems.notFound();
    await deleteAutoEmail(deps.pool, id);
    await auditAutoEmail(principal.id, 'auto_email_deleted', existing);
    return reply.status(204).send();
  });

  // On-demand scan — same code path the interval runs.
  app.post('/api/v1/admin/auto-emails/run', { preHandler: app.authenticate }, async (req) => {
    requireOps(req);
    const result = await runDueAutoEmails({
      pool: deps.pool,
      transport: deps.transport,
      smsTransport: deps.smsTransport,
      log: req.log,
    });
    return result;
  });

  // On-demand retry of 'failed' outbox rows — same code path the retry
  // sweep runs (index.ts).
  app.post('/api/v1/admin/outbox/retry', { preHandler: app.authenticate }, async (req) => {
    requireOps(req);
    const result = await retryFailedEmails({
      pool: deps.pool,
      transport: deps.transport,
      smsTransport: deps.smsTransport,
      log: req.log,
    });
    return result;
  });
}
