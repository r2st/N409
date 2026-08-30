import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AdminEventType } from '../domain/auditTrail.js';
import { isUlid, problems } from '@n409/shared';
import { isOps } from '../auth/rbac.js';
import { VALUATION_STATES } from '../domain/valuation.js';
import {
  AUTO_EMAIL_CONDITIONS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_CATEGORY_LABELS,
  type AutoEmailRow,
  type CommunicationTemplateRow,
  type TemplateVars,
} from '../domain/communications.js';
import { TEMPLATE_VARIABLES, previewTemplate, unknownPlaceholders } from '../domain/templateVariables.js';
import { valuationTemplateVars } from '../domain/communications.js';
import type { SupportEmailSource } from '../hooks/autoEmails.js';
import { findValuationById } from '../repos/valuations.js';
import { publicPartnerNameSql } from '../repos/branding.js';
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
import { isUniqueViolation } from '../db/pgError.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { templateText } from '../domain/templateText.js';

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
  category: z.enum(TEMPLATE_CATEGORIES).default('account'),
  description: z.string().max(500).default(''),
  // Subject is optional here — an SMS template has none — so the blank check
  // is the channel-aware one below, on a value that is present.
  subject: z.string().max(500).default(''),
  body: templateText(20_000),
  enabled: z.boolean().default(true),
});

const TemplatePatch = TemplateBody.omit({ key: true, channel: true })
  .partial()
  .strict()
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
  /**
   * Marketing rather than transactional (migration 0118). Defaults to false
   * because the two mistakes are not symmetric: a marketing message wrongly
   * marked transactional is a compliance exposure, and a transactional one
   * wrongly marked marketing silences a client's status updates. The safe
   * direction is the one an operator must consciously change.
   */
  promotional: z.boolean().default(false),
});

const AutoEmailPatch = AutoEmailBody.omit({ name: true })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'empty patch' });

export function registerCommunicationRoutes(
  app: FastifyInstance,
  deps: {
    pool: pg.Pool;
    transport?: EmailTransport;
    smsTransport?: EmailTransport;
    /** Where a promotional message's unsubscribe footer points. */
    publicBaseUrl?: string;
    /** Answers `{{support_email}}` in a campaign template. */
    settings?: SupportEmailSource;
  },
): void {
  const requireOps = (req: Parameters<typeof requirePrincipal>[0]) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Communication settings are operations-only');
    return principal;
  };

  const auditTemplate = async (actorId: string, type: AdminEventType, t: CommunicationTemplateRow) =>
    recordAdminEvent(deps.pool, {
      type,
      actor: { actorType: 'human', actorId },
      subjectType: 'communication_template',
      subjectId: t.id,
      subjectLabel: t.key,
      payload: { channel: t.channel, category: t.category, enabled: t.enabled },
    });

  const auditAutoEmail = async (actorId: string, type: AdminEventType, a: AutoEmailRow) =>
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
        // Audited explicitly: flipping a campaign to promotional (or away from
        // it) changes who may lawfully receive it, and "who changed this and
        // when" is the first question after a complaint.
        promotional: a.promotional,
      },
    });

  // ── Templates ───────────────────────────────────────────────────────────────

  app.get('/api/v1/admin/communication-templates', { preHandler: app.authenticate }, async (req) => {
    requireOps(req);
    const parsed = z
      .object({
        category: z.enum(TEMPLATE_CATEGORIES).optional(),
        channel: z.enum(['email', 'sms']).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error, 'Invalid filter');
    const templates = await listCommunicationTemplates(deps.pool, parsed.data);
    return {
      templates: templates.map((t) => ({
        ...t,
        // Computed, not stored: the catalog moves under a saved template, and
        // a warning that was true at save time is not the one an operator
        // needs to see now.
        unknown_variables: unknownPlaceholders(t.subject, t.body),
      })),
      categories: TEMPLATE_CATEGORIES.map((key) => ({
        key,
        label: TEMPLATE_CATEGORY_LABELS[key],
        count: templates.filter((t) => t.category === key).length,
      })),
    };
  });

  /**
   * The editor's variable palette. Served rather than duplicated in the
   * frontend so a variable added here appears in the editor without a second
   * deployment — the catalog is the promise, and one copy of it is the point.
   */
  app.get(
    '/api/v1/admin/communication-templates/variables',
    { preHandler: app.authenticate },
    async (req) => {
      requireOps(req);
      return { variables: TEMPLATE_VARIABLES };
    },
  );

  app.post('/api/v1/admin/communication-templates', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requireOps(req);
    const parsed = TemplateBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid template', parsed.error);
    if (parsed.data.channel === 'email' && !parsed.data.subject.trim())
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
    if (!parsed.success) throw invalidBody('Invalid patch', parsed.error);
    // `.trim()`, not `=== ''`: a subject of three spaces is one every render
    // path treats as present and every mail client shows as no subject at all.
    if (existing.channel === 'email' && parsed.data.subject?.trim() === '')
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

  /**
   * Renders a template — the admin UI preview.
   *
   * Three layers, weakest first: the catalog's sample values, then a real
   * engagement's figures when `valuation_id` names one, then whatever the
   * caller passed in `vars`. The middle layer is the one that matters: a
   * template reads fine against "Acme Corp" and falls apart against a company
   * whose legal name runs to sixty characters, and the only way to find that
   * out before the client does is to preview it against a real row.
   *
   * The unrendered body is previewed too, not just the saved one: the editor
   * previews what is on screen, which is usually not what is in the table yet.
   */
  app.post(
    '/api/v1/admin/communication-templates/:id/preview',
    { preHandler: app.authenticate },
    async (req) => {
      requireOps(req);
      const { id } = req.params as { id: string };
      if (!isUlid(id)) throw problems.notFound();
      const template = await findTemplateById(deps.pool, id);
      if (!template) throw problems.notFound();

      const parsed = z
        .object({
          valuation_id: z.string().optional(),
          // Bounded on all three axes — how many substitutions, how long each
          // one is, and whether a number is a number. The preview renders these
          // into the template body, so an unbounded map is an unbounded email.
          vars: z
            .record(z.string().max(200), z.union([z.string().max(4000), z.number().finite()]))
            .refine((v) => Object.keys(v).length <= 200, { message: 'At most 200 template variables' })
            .default({}),
          // Unsaved editor content. Falls back to the stored row per field, so
          // previewing a body edit does not blank the subject.
          subject: z.string().max(500).optional(),
          body: z.string().max(20_000).optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) throw invalidBody('Invalid preview', parsed.error);

      let vars: TemplateVars = { ...parsed.data.vars };
      if (parsed.data.valuation_id) {
        if (!isUlid(parsed.data.valuation_id)) throw problems.notFound();
        const valuation = await findValuationById(deps.pool, parsed.data.valuation_id);
        if (!valuation) throw problems.notFound();
        // Ops-only route, so no scope check beyond requireOps: the preview
        // shows nothing the caller could not read on the valuation itself.
        const [{ rows: partnerRows }, { rows: dateRows }] = await Promise.all([
          // The *public* name, the same one the send resolves — an operator
          // previewing a template has to be shown what the client will read,
          // and `partners.name` is the internal channel label. See
          // `publicPartnerName`.
          valuation.partner_id
            ? deps.pool.query<{ name: string }>(
                `SELECT ${publicPartnerNameSql('p')} AS name FROM partners p WHERE p.id = $1`,
                [valuation.partner_id],
              )
            : Promise.resolve({ rows: [] as Array<{ name: string }> }),
          // The measurement date lives in valuation_params.engine_inputs
          // (0041) and nowhere on the valuation row — it is an engine input,
          // set when an analyst fixes the as-of date, and absent for most of
          // an engagement's life.
          deps.pool.query<{ valuation_date: string | null }>(
            `SELECT engine_inputs->>'valuation_date' AS valuation_date
             FROM valuation_params WHERE valuation_id = $1`,
            [valuation.id],
          ),
        ]);
        vars = {
          // Field by field rather than spreading the row: ValuationRow carries
          // an index signature, so a typo here would type-check as `unknown`
          // and render blank.
          ...valuationTemplateVars({
            company_name: valuation.company_name,
            kind: valuation.kind,
            number: valuation.number,
            valuation_date: dateRows[0]?.valuation_date ?? null,
            due_date: valuation.due_date,
            state: valuation.state,
            partner_name: partnerRows[0]?.name ?? null,
          }),
          ...vars,
        };
      }

      return previewTemplate(
        {
          subject: parsed.data.subject ?? template.subject,
          body: parsed.data.body ?? template.body,
        },
        vars,
      );
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
    if (!parsed.success) throw invalidBody('Invalid campaign', parsed.error);

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
      if (isUniqueViolation(err, 'auto_emails_name_key'))
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
    if (!parsed.success) throw invalidBody('Invalid patch', parsed.error);

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
      publicBaseUrl: deps.publicBaseUrl,
      settings: deps.settings,
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
