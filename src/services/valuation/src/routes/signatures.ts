import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import type { EventActor } from '../events/record.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { deleteSignature, listSignatures, upsertSignature } from '../repos/signatures.js';
import { requirePrincipal } from '../plugins/auth.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody } from '../domain/validationProblem.js';
import { nonBlankText } from '../domain/nonBlankText.js';

/**
 * Signature workflow (remaining-gaps §3 #3): 409.ai gates publish behind
 * Signature (main) / Signature (second). Reviewers sign by typing their
 * name; the transition guard in domain/publishGate lets nothing into
 * 'published' without the main signature.
 */

const SignBody = z.object({
  role: z.enum(['main', 'second']),
  signer_name: nonBlankText(2, 200),
  signer_title: z.string().max(200).nullable().optional(),
  signature_text: nonBlankText(2, 500),
});

const actorOf = (principal: Principal): EventActor => ({ actorType: 'human', actorId: principal.id });

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('Signatures are operations-only');
}

async function loadValuation(pool: pg.Pool, id: string): Promise<ValuationRow> {
  if (!isUlid(id)) throw problems.notFound();
  const valuation = await findValuationById(pool, id);
  if (!valuation) throw problems.notFound();
  return valuation;
}

export function registerSignatureRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/valuations/:id/signatures', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    await loadValuation(deps.pool, id);
    return { signatures: await listSignatures(deps.pool, id) };
  });

  app.post('/api/v1/valuations/:id/signatures', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(deps.pool, id);
    refuseIfRetired(valuation, 'accepting signatures');
    if (valuation.state === 'published') {
      throw problems.conflict('Cannot re-sign a published valuation');
    }

    const parsed = SignBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid signature', parsed.error);

    const signature = await upsertSignature(
      deps.pool,
      {
        valuationId: id,
        role: parsed.data.role,
        signerUserId: principal.id,
        signerName: parsed.data.signer_name,
        signerTitle: parsed.data.signer_title ?? null,
        signatureText: parsed.data.signature_text,
      },
      actorOf(principal),
    );
    return reply.status(201).send({ signature });
  });

  app.delete(
    '/api/v1/valuations/:id/signatures/:role',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      requireOps(principal);
      const { id, role } = req.params as { id: string; role: string };
      const valuation = await loadValuation(deps.pool, id);
      if (valuation.state === 'published') {
        throw problems.conflict('Cannot remove signatures from a published valuation');
      }
      if (role !== 'main' && role !== 'second') throw problems.notFound();
      const removed = await deleteSignature(deps.pool, id, role, actorOf(principal));
      if (!removed) throw problems.notFound();
      return reply.status(204).send();
    },
  );
}
