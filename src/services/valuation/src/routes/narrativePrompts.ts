import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { VALUATION_KINDS, type ValuationKind } from '../domain/valuation.js';
import { resolveNarrativeSections } from '../domain/narrativePrompts.js';
import {
  findNarrativePromptById,
  listNarrativePrompts,
  listNarrativePromptsForKind,
  patchNarrativePrompt,
  resetNarrativePrompt,
  type NarrativePromptRow,
} from '../repos/narrativePrompts.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { requirePrincipal } from '../plugins/auth.js';
import { invalidBody } from '../domain/validationProblem.js';
import { quoteForMessage } from '../domain/displayText.js';

/**
 * Narrative prompt library management (migration 0114). The sibling of the Bot
 * Prompts view: that one edits the *persona* each pipeline runs as, this one
 * edits what each report section must cover.
 *
 * The preview endpoint is the part reviewers actually use — "show me the
 * sections a gift & estate report will be drafted with" answers, in one call,
 * the question that otherwise takes running a valuation to find out.
 */

const PatchBody = z
  .object({
    label: z.string().min(1).max(200),
    guidance: z.string().min(1).max(8000),
    enabled: z.boolean(),
    // Sparse ordering; bounded so a typo can't sort a section into next week.
    sort_order: z.number().int().min(0).max(10_000),
  })
  .partial()
  .strict();

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('The narrative prompt library is operations-only');
}

function parseKind(value: string): ValuationKind {
  if (!(VALUATION_KINDS as readonly string[]).includes(value)) {
    throw problems.notFound(`Unknown valuation kind "${quoteForMessage(value)}"`);
  }
  return value as ValuationKind;
}

async function loadRow(pool: pg.Pool, id: string): Promise<NarrativePromptRow> {
  if (!isUlid(id)) throw problems.notFound();
  const row = await findNarrativePromptById(pool, id);
  if (!row) throw problems.notFound();
  return row;
}

/** `kind` NULL reads as the base library everywhere it is shown. */
function subjectLabel(row: NarrativePromptRow): string {
  return `${row.section_key} (${row.kind ?? 'base'})`;
}

export function registerNarrativePromptRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/admin/narrative-prompts', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    return { prompts: await listNarrativePrompts(deps.pool), kinds: VALUATION_KINDS };
  });

  // What a deliverable of this kind is actually drafted with, after the base
  // library and the kind's overrides have been reconciled.
  app.get('/api/v1/admin/narrative-prompts/preview/:kind', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { kind } = req.params as { kind: string };
    const parsed = parseKind(kind);
    const rows = await listNarrativePromptsForKind(deps.pool, parsed);
    return { kind: parsed, sections: resolveNarrativeSections(rows, parsed), rows };
  });

  app.get('/api/v1/admin/narrative-prompts/:id', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    return { prompt: await loadRow(deps.pool, id) };
  });

  app.patch('/api/v1/admin/narrative-prompts/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    await loadRow(deps.pool, id);

    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      throw invalidBody('Invalid narrative prompt', parsed.error);
    }
    const updated = await patchNarrativePrompt(deps.pool, id, parsed.data, principal.id);
    if (!updated) throw problems.notFound();
    await recordAdminEvent(deps.pool, {
      type: 'narrative_prompt_updated',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'narrative_prompt',
      subjectId: updated.id,
      subjectLabel: subjectLabel(updated),
      payload: { fields: Object.keys(parsed.data), kind: updated.kind },
    });
    return { prompt: updated };
  });

  // Back to the seeded text. Distinct from a patch that happens to restore it,
  // because `default_guidance` is the only copy of what the row shipped as.
  app.post('/api/v1/admin/narrative-prompts/:id/reset', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    await loadRow(deps.pool, id);

    const row = await resetNarrativePrompt(deps.pool, id, principal.id);
    if (!row) throw problems.notFound();
    await recordAdminEvent(deps.pool, {
      type: 'narrative_prompt_reset',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'narrative_prompt',
      subjectId: row.id,
      subjectLabel: subjectLabel(row),
      payload: { kind: row.kind },
    });
    return { prompt: row };
  });
}
