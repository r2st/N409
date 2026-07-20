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
  INTAKE_EVENT_TYPES,
  INTAKE_SECTIONS,
} from '../domain/intake.js';
import { REQUIRED_DOCUMENT_KINDS } from '../domain/progress.js';
import {
  findQuestionnaire,
  saveQuestionnaire,
  submitQuestionnaire,
} from '../repos/intake.js';

/**
 * Client self-service portal (feature 7): a guided intake questionnaire, a
 * missing-document checklist, and ops-triggered document reminders. The
 * questionnaire is owned by the client (the valuation owner) and visible to
 * ops; the schema + completion rules live in domain/intake.ts.
 */

const SaveBody = z.object({
  answers: z.record(z.string(), z.unknown()),
});

async function loadReadable(
  pool: pg.Pool,
  id: string,
  principal: Principal,
): Promise<ValuationRow> {
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
  // The questionnaire schema is static — expose it so the wizard renders from
  // the same source of truth as the completion calculation.
  app.get('/api/v1/intake/schema', { preHandler: app.authenticate }, async () => ({
    sections: INTAKE_SECTIONS,
  }));

  // Questionnaire + completion + document checklist for a valuation.
  app.get('/api/v1/valuations/:id/questionnaire', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadReadable(deps.pool, id, principal);
    const row = await findQuestionnaire(deps.pool, id);
    const answers = row?.answers ?? {};
    return {
      answers,
      submitted_at: row?.submitted_at ?? null,
      completion: computeCompletion(answers),
      missing_documents: await missingDocuments(deps.pool, id),
      can_edit: canEditIntake(principal, await findValuationById(deps.pool, id).then((v) => v!)),
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
    const parsed = SaveBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid answers', { errors: parsed.error.issues });

    const row = await saveQuestionnaire(deps.pool, id, parsed.data.answers, {
      actorType: 'human',
      actorId: principal.id,
    });
    return {
      answers: row.answers,
      submitted_at: row.submitted_at,
      completion: computeCompletion(row.answers),
    };
  });

  // Submit: only when every required field is answered.
  app.post('/api/v1/valuations/:id/questionnaire/submit', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(deps.pool, id, principal);
    if (!canEditIntake(principal, valuation)) {
      throw problems.forbidden('Only the client or operations can submit the questionnaire');
    }
    const row = await findQuestionnaire(deps.pool, id);
    const completion = computeCompletion(row?.answers ?? {});
    if (!completion.ready) {
      throw problems.unprocessable('Complete all required fields before submitting', {
        completion,
      });
    }
    const submitted = await submitQuestionnaire(deps.pool, id, {
      actorType: 'human',
      actorId: principal.id,
    });
    return { submitted_at: submitted.submitted_at, completion };
  });

  // Email the client a reminder of the documents still outstanding (ops).
  app.post('/api/v1/valuations/:id/remind-documents', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Reminders are operations-only');
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(deps.pool, id, principal);
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
