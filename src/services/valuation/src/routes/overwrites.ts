import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canEditWorkingData, canReadValuation } from '../auth/rbac.js';
import {
  OVERWRITE_CATEGORIES,
  OVERWRITE_FIELDS,
  OVERWRITE_FIELDS_BY_KEY,
  validateOverwriteValue,
} from '../domain/overwrites.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { deleteOverwrite, listOverwrites, upsertOverwrite } from '../repos/overwrites.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';
import type { Principal } from '../auth/rbac.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody } from '../domain/validationProblem.js';
import { forbidden } from '../domain/accessProblem.js';
import { quoteForMessage } from '../domain/displayText.js';

const PutBody = z
  .object({
    value: z.union([z.number(), z.string()]),
    reason: z.string().max(2000).optional(),
    /** the pre-override AI/computed value, captured on first write */
    original_value: z.union([z.number(), z.string(), z.null()]).optional(),
  })
  .strict();

function actorFor(principal: Principal): EventActor {
  return { actorType: 'human', actorId: principal.id, source: 'api' };
}

/** Working-data access: analyst/ops only, and the valuation must be in scope. */
async function loadForWorkingData(pool: pg.Pool, principal: Principal, id: string): Promise<ValuationRow> {
  if (!canEditWorkingData(principal)) throw forbidden('Reading working data', 'working-data');
  if (!isUlid(id)) throw problems.notFound();
  const valuation = await findValuationById(pool, id);
  if (
    !valuation ||
    !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
  ) {
    throw problems.notFound();
  }
  return valuation;
}

export function registerOverwriteRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  // Self-documenting schema explorer (features.md §3.6) — the 68-field set.
  app.get('/api/v1/overwrites/schema', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!canEditWorkingData(principal)) throw forbidden('Reading the overwrite schema', 'working-data');
    return {
      categories: OVERWRITE_CATEGORIES.map((key) => ({
        key,
        field_count: OVERWRITE_FIELDS.filter((f) => f.category === key).length,
      })),
      fields: OVERWRITE_FIELDS,
      total: OVERWRITE_FIELDS.length,
    };
  });

  app.get('/api/v1/valuations/:id/overwrites', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadForWorkingData(deps.pool, principal, id);
    const overwrites = await listOverwrites(deps.pool, id);
    return { overwrites, count: overwrites.length };
  });

  app.put('/api/v1/valuations/:id/overwrites/:field_key', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id, field_key } = req.params as { id: string; field_key: string };
    const valuation = await loadForWorkingData(deps.pool, principal, id);
    refuseIfRetired(valuation, 'accepting changes');

    const def = OVERWRITE_FIELDS_BY_KEY.get(field_key);
    if (!def) throw problems.notFound(`Unknown overwrite field "${quoteForMessage(field_key)}"`);

    const parsed = PutBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid overwrite', parsed.error);

    const invalid = validateOverwriteValue(def, parsed.data.value);
    if (invalid) throw problems.unprocessable(`Invalid value for "${field_key}": ${invalid}`);

    /*
     * The same check on the *other* value on this body.
     *
     * `original_value` is the pre-override AI/computed figure, frozen on the
     * first write and shown beside the override ever after — the "was X, now Y"
     * on the overwrites tab, and the `from` of the audit event this write
     * records. It is client-supplied like `value`, describes the same cell as
     * `value`, and until now was validated not at all: the schema admits a
     * number, a string or null, and nothing after it looked again.
     *
     * (Spelled in prose rather than in zod, deliberately. `finiteNumberSweep`
     * counts the number-accepting sites in this file textually, so a schema
     * quoted in a comment is a site to it — and a comment that inflated the
     * count would be read as a third union somebody forgot to bound.)
     *
     * Three things came through that gap. A numeric field could be told its
     * original value was the string "n/a", and a date field a number, so the
     * pair on screen and in the audit disagreed about what kind of thing the
     * cell holds. A character field's original could be any length the 1 MB
     * body allows, stored twice — the row and the event payload are both jsonb.
     * And `1e999` parses to Infinity, which `JSON.stringify` writes as `null`:
     * the original value an analyst supplied would be stored as "there wasn't
     * one", under a 200 saying it was saved. That last one is what
     * `finiteNumberSweep` exists to catch, and it did not, because its
     * exemption for this file names "the override value" in the singular and
     * the file has two.
     *
     * `null` stays legal — it is how "no prior value" is said, and it is what
     * the client sends by omitting the field entirely.
     */
    if (parsed.data.original_value !== undefined && parsed.data.original_value !== null) {
      const badOriginal = validateOverwriteValue(def, parsed.data.original_value);
      if (badOriginal)
        throw problems.unprocessable(`Invalid original_value for "${field_key}": ${badOriginal}`);
    }

    const overwrite = await upsertOverwrite(deps.pool, {
      valuationId: valuation.id,
      def,
      value: parsed.data.value,
      reason: parsed.data.reason ?? null,
      originalValue: parsed.data.original_value ?? null,
      actor: actorFor(principal),
    });
    return { overwrite };
  });

  app.delete(
    '/api/v1/valuations/:id/overwrites/:field_key',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id, field_key } = req.params as { id: string; field_key: string };
      const valuation = await loadForWorkingData(deps.pool, principal, id);
      if (!OVERWRITE_FIELDS_BY_KEY.has(field_key)) {
        throw problems.notFound(`Unknown overwrite field "${quoteForMessage(field_key)}"`);
      }
      const deleted = await deleteOverwrite(deps.pool, {
        valuationId: valuation.id,
        fieldKey: field_key,
        actor: actorFor(principal),
      });
      if (!deleted) throw problems.notFound(`No overwrite set for "${field_key}"`);
      return reply.status(204).send();
    },
  );
}
