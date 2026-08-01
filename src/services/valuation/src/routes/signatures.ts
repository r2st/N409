import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { deleteSignature, listSignatures, upsertSignature } from '../repos/signatures.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Signature workflow (remaining-gaps §3 #3): 409.ai gates publish behind
 * Signature (main) / Signature (second). Reviewers sign by typing their
 * name; the transition guard in domain/publishGate lets nothing into
 * 'published' without the main signature.
 */

const SignBody = z.object({
  role: z.enum(['main', 'second']),
  signer_name: z.string().min(2).max(200),
  signer_title: z.string().max(200).nullable().optional(),
  signature_text: z.string().min(2).max(500),
});

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
    if (valuation.state === 'published') {
      throw problems.conflict('Cannot re-sign a published valuation');
    }

    const parsed = SignBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid signature', { errors: parsed.error.issues });

    const signature = await upsertSignature(deps.pool, {
      valuationId: id,
      role: parsed.data.role,
      signerUserId: principal.id,
      signerName: parsed.data.signer_name,
      signerTitle: parsed.data.signer_title ?? null,
      signatureText: parsed.data.signature_text,
    });
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
      const removed = await deleteSignature(deps.pool, id, role);
      if (!removed) throw problems.notFound();
      return reply.status(204).send();
    },
  );
}
