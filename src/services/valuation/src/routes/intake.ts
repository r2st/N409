import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { findUserById } from '../repos/users.js';
import { listDocuments } from '../repos/documents.js';
import { requirePrincipal } from '../plugins/auth.js';
import { sendTransactionalEmail } from '../email/transactional.js';
import type { EmailTransport } from '../hooks/stateChange.js';
import { recordEvent } from '../events/record.js';
import { withTransaction } from '../db/pool.js';
import {
  computeCompletion,
  hasBlockingIssues,
  INTAKE_EVENT_TYPES,
  IntakeAnswers,
  validateIntake,
} from '../domain/intake.js';
import { intakeCrossRulesFor, intakeFieldKeysFor, intakeSectionsFor } from '../domain/intakeKinds.js';
import { VALUATION_KINDS, type ValuationKind } from '../domain/valuation.js';
import { REQUIRED_DOCUMENT_KINDS } from '../domain/progress.js';
import { findQuestionnaire, saveQuestionnaire, submitQuestionnaire } from '../repos/intake.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';

/**
 * Client self-service portal (feature 7): a guided intake questionnaire, a
 * missing-document checklist, and ops-triggered document reminders. The
 * questionnaire is owned by the client (the valuation owner) and visible to
 * ops; the schema + completion rules live in domain/intake.ts.
 */

const SaveBody = z.object({ answers: IntakeAnswers });

async function loadReadable(pool: pg.Pool, id: string, principal: Principal): Promise<ValuationRow> {
  if (!isUlid(id)) throw problems.notFound();
  const valuation = await findValuationById(pool, id);
  if (!valuation) throw problems.notFound();
  if (!canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })) {
    throw problems.notFound();
  }
  return valuation;
}

/** The client owner or ops may edit the questionnaire. */
function canEditIntake(principal: Principal, valuation: ValuationRow): boolean {
  return isOps(principal) || valuation.user_id === principal.id;
}

/** Required document kinds with no live upload yet. */
async function missingDocuments(pool: pg.Pool, valuationId: string) {
  const docs = await listDocuments(pool, valuationId);
  const present = new Set(docs.map((d) => d.kind));
  return REQUIRED_DOCUMENT_KINDS.filter((r) => !present.has(r.kind));
}

export function registerIntakeRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; transport?: EmailTransport },
): void {
  // The questionnaire schema is static per kind — expose it so the wizard
  // renders from the same source of truth as the completion calculation.
  // The rules ride along with the schema so the wizard warns as the client
  // types without a round trip, and judges answers exactly as submit will.
  // `?kind=` selects the report type's form; the default stays the 409A form
  // so existing callers see exactly what they always saw.
  app.get('/api/v1/intake/schema', { preHandler: app.authenticate }, async (req) => {
    const parsed = z.object({ kind: z.enum(VALUATION_KINDS).default('409a') }).safeParse(req.query ?? {});
    if (!parsed.success) throw invalidQuery(parsed.error, 'Invalid kind');
    const kind = parsed.data.kind;
    return {
      kind,
      sections: intakeSectionsFor(kind),
      cross_rules: intakeCrossRulesFor(kind),
    };
  });

  // Questionnaire + completion + document checklist for a valuation. The
  // schema, completion and validation all follow the valuation's kind.
  app.get('/api/v1/valuations/:id/questionnaire', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(deps.pool, id, principal);
    const kind = valuation.kind as ValuationKind;
    const sections = intakeSectionsFor(kind);
    const row = await findQuestionnaire(deps.pool, id);
    const answers = row?.answers ?? {};
    return {
      kind,
      sections,
      cross_rules: intakeCrossRulesFor(kind),
      answers,
      submitted_at: row?.submitted_at ?? null,
      completion: computeCompletion(answers, sections),
      issues: validateIntake(answers, { sections, crossRules: intakeCrossRulesFor(kind) }),
      missing_documents: await missingDocuments(deps.pool, id),
      can_edit: canEditIntake(principal, valuation),
    };
  });

  // Save answers (merge). Owner or ops.
  app.put('/api/v1/valuations/:id/questionnaire', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(deps.pool, id, principal);
    if (!canEditIntake(principal, valuation)) {
      throw problems.forbidden('Only the client or operations can edit the questionnaire');
    }
    refuseIfRetired(valuation, 'accepting questionnaire answers');
    const parsed = SaveBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid answers', parsed.error);

    const kind = valuation.kind as ValuationKind;
    const sections = intakeSectionsFor(kind);
    const row = await saveQuestionnaire(
      deps.pool,
      id,
      parsed.data.answers,
      { actorType: 'human', actorId: principal.id },
      intakeFieldKeysFor(kind),
    );
    return {
      answers: row.answers,
      submitted_at: row.submitted_at,
      completion: computeCompletion(row.answers, sections),
      issues: validateIntake(row.answers, { sections, crossRules: intakeCrossRulesFor(kind) }),
    };
  });

  // Submit: only when every required field is answered.
  app.post('/api/v1/valuations/:id/questionnaire/submit', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(deps.pool, id, principal);
    refuseIfRetired(valuation, 'accepting questionnaire answers');
    if (!canEditIntake(principal, valuation)) {
      throw problems.forbidden('Only the client or operations can submit the questionnaire');
    }
    const kind = valuation.kind as ValuationKind;
    const sections = intakeSectionsFor(kind);
    const row = await findQuestionnaire(deps.pool, id);
    const answers = row?.answers ?? {};
    const completion = computeCompletion(answers, sections);
    if (!completion.ready) {
      throw problems.unprocessable('Complete all required fields before submitting', {
        completion,
      });
    }
    // Warnings are the client's judgement call; errors are answers that cannot
    // be true, and an analyst would only have to send them back.
    const issues = validateIntake(answers, { sections, crossRules: intakeCrossRulesFor(kind) });
    if (hasBlockingIssues(issues)) {
      throw problems.unprocessable('Correct the highlighted answers before submitting', {
        issues: issues.filter((i) => i.severity === 'error'),
      });
    }
    const submitted = await submitQuestionnaire(deps.pool, id, {
      actorType: 'human',
      actorId: principal.id,
    });
    return { submitted_at: submitted.submitted_at, completion, issues };
  });

  // Email the client a reminder of the documents still outstanding (ops).
  app.post('/api/v1/valuations/:id/remind-documents', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Reminders are operations-only');
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(deps.pool, id, principal);
    // Before `missingDocuments`, so a retired engagement is refused rather than
    // answered with "all required documents have already been provided" — the
    // 409 below is about the file being complete, which is a different fact.
    refuseIfRetired(valuation, 'sending reminders');
    const missing = await missingDocuments(deps.pool, id);
    if (missing.length === 0) {
      throw problems.conflict('All required documents have already been provided');
    }
    const owner = await findUserById(deps.pool, valuation.user_id);
    if (!owner) throw problems.conflict('The valuation has no client to remind');

    const list = missing.map((m) => `• ${m.label}`).join('\n');
    await sendTransactionalEmail(
      { pool: deps.pool, transport: deps.transport, log: app.log },
      {
        toUserId: owner.id,
        toEmail: owner.email,
        templateKey: 'document_reminder',
        subject: `Documents still needed for ${valuation.company_name}`,
        body:
          `Hello,\n\nTo continue your valuation of ${valuation.company_name}, we still need the ` +
          `following documents:\n\n${list}\n\n` +
          `Please upload them at your earliest convenience. Thank you.`,
        vars: { company_name: valuation.company_name, missing_count: missing.length },
      },
    );
    await withTransaction(deps.pool, (client) =>
      recordEvent(client, {
        valuationId: id,
        type: INTAKE_EVENT_TYPES.reminderSent,
        actor: { actorType: 'human', actorId: principal.id },
        payload: { missing: missing.map((m) => m.kind) },
      }),
    );
    return { reminded: owner.email, missing };
  });
}
