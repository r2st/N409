import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import {
  findPromptById,
  listPrompts,
  listPromptVersions,
  revertPrompt,
  updatePrompt,
  type AiPromptRow,
} from '../repos/aiPrompts.js';
import { InternalServiceError, postJson, toProblem } from '../clients/internal.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Bot Prompts management (remaining-gaps §3 #4, §6 P1 #8): the DB-backed
 * prompt registry behind the AI pipelines. Ops can edit each pipeline's
 * system prompt, pin an OpenRouter model, and dry-run the prompt against the
 * AI service without touching a valuation.
 */

const PatchBody = z
  .object({
    label: z.string().min(1).max(120),
    description: z.string().max(2000).nullable(),
    system_prompt: z.string().min(1).max(20_000),
    model: z.string().min(1).max(200).nullable(),
    // Per-agent on/off toggle (migration 0060).
    enabled: z.boolean(),
  })
  .partial()
  .strict();

const TestBody = z.object({
  input: z.string().min(1).max(20_000),
});

const RevertBody = z.object({
  version: z.number().int().min(1),
});

export interface AiTestResponse {
  model: string;
  content: string;
}

export interface AiModelsResponse {
  models: string[];
}

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('Bot prompts are operations-only');
}

async function loadPrompt(pool: pg.Pool, id: string): Promise<AiPromptRow> {
  if (!isUlid(id)) throw problems.notFound();
  const prompt = await findPromptById(pool, id);
  if (!prompt) throw problems.notFound();
  return prompt;
}

export function registerPromptRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; aiUrl: string },
): void {
  app.get('/api/v1/admin/prompts', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    return { prompts: await listPrompts(deps.pool) };
  });

  // Model options for the picker — proxied so the AI service stays the single
  // source of truth for its fallback chain.
  app.get('/api/v1/admin/prompts/models', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    try {
      const res = await fetch(`${deps.aiUrl}/ai/v1/models`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return (await res.json()) as AiModelsResponse;
    } catch {
      /* fall through to the empty list — the UI accepts free-text models */
    }
    return { models: [] };
  });

  app.get('/api/v1/admin/prompts/:id', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    return { prompt: await loadPrompt(deps.pool, id) };
  });

  app.patch('/api/v1/admin/prompts/:id', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    await loadPrompt(deps.pool, id);

    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid prompt', { errors: parsed.error.issues });
    const updated = await updatePrompt(deps.pool, id, parsed.data, principal.id);
    if (!updated) throw problems.notFound();
    await recordAdminEvent(deps.pool, {
      type: 'prompt_updated',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'prompt',
      subjectId: updated.id,
      subjectLabel: `${updated.label} (${updated.pipeline})`,
      payload: { fields: Object.keys(parsed.data) },
    });
    return { prompt: updated };
  });

  // Version history (P1 #8): every content edit appends a numbered version.
  app.get(
    '/api/v1/admin/prompts/:id/versions',
    { preHandler: app.authenticate },
    async (req) => {
      requireOps(requirePrincipal(req));
      const { id } = req.params as { id: string };
      await loadPrompt(deps.pool, id);
      return { versions: await listPromptVersions(deps.pool, id) };
    },
  );

  // Revert = re-apply an old version's content as a NEW version, so history
  // stays append-only and the AI service picks the content up on the next run.
  app.post('/api/v1/admin/prompts/:id/revert', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    await loadPrompt(deps.pool, id);

    const parsed = RevertBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid revert', { errors: parsed.error.issues });
    const prompt = await revertPrompt(deps.pool, id, parsed.data.version, principal.id);
    if (!prompt) throw problems.notFound(`No version ${parsed.data.version} for this prompt`);
    await recordAdminEvent(deps.pool, {
      type: 'prompt_reverted',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'prompt',
      subjectId: prompt.id,
      subjectLabel: `${prompt.label} (${prompt.pipeline})`,
      payload: { restored_version: parsed.data.version },
    });
    return { prompt };
  });

  // Dry-run: send the stored system prompt + a sample user message straight to
  // the LLM. Nothing is persisted — this is for iterating on prompt wording.
  app.post('/api/v1/admin/prompts/:id/test', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    const prompt = await loadPrompt(deps.pool, id);

    const parsed = TestBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid test input', { errors: parsed.error.issues });

    try {
      const response = await postJson<AiTestResponse>('ai-service', `${deps.aiUrl}/ai/v1/test`, {
        system: prompt.system_prompt,
        user: parsed.data.input,
        model: prompt.model,
      });
      return { test: response };
    } catch (err) {
      if (err instanceof InternalServiceError) throw toProblem(err);
      throw err;
    }
  });
}
