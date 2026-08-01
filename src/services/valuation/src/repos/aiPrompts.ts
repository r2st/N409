import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import type { AiPipeline } from '../domain/pipeline.js';

export interface AiPromptRow {
  id: string;
  pipeline: AiPipeline;
  label: string;
  description: string | null;
  system_prompt: string;
  model: string | null;
  /** On/off toggle (migration 0060). A disabled pipeline is refused before any
   * LLM call. Defaults to true for every existing pipeline. */
  enabled: boolean;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AiPromptVersionRow {
  id: string;
  prompt_id: string;
  version: number;
  system_prompt: string;
  model: string | null;
  created_by: string | null;
  created_at: Date;
}

/** Version rows joined with the editor's email for the history view. */
export interface AiPromptVersionListRow extends AiPromptVersionRow {
  created_by_email: string | null;
}

export async function listPrompts(pool: pg.Pool): Promise<AiPromptRow[]> {
  const { rows } = await pool.query<AiPromptRow>('SELECT * FROM ai_prompts ORDER BY pipeline ASC');
  return rows;
}

export async function findPromptById(pool: pg.Pool, id: string): Promise<AiPromptRow | null> {
  const { rows } = await pool.query<AiPromptRow>('SELECT * FROM ai_prompts WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function findPromptByPipeline(pool: pg.Pool, pipeline: AiPipeline): Promise<AiPromptRow | null> {
  const { rows } = await pool.query<AiPromptRow>('SELECT * FROM ai_prompts WHERE pipeline = $1', [pipeline]);
  return rows[0] ?? null;
}

/** Latest version number for a prompt — recorded on ai_jobs as provenance. */
export async function latestPromptVersion(pool: pg.Pool, promptId: string): Promise<number | null> {
  const { rows } = await pool.query<{ version: number | null }>(
    'SELECT max(version)::int AS version FROM ai_prompt_versions WHERE prompt_id = $1',
    [promptId],
  );
  return rows[0]?.version ?? null;
}

export async function listPromptVersions(pool: pg.Pool, promptId: string): Promise<AiPromptVersionListRow[]> {
  const { rows } = await pool.query<AiPromptVersionListRow>(
    `SELECT v.*, u.email AS created_by_email
     FROM ai_prompt_versions v
     LEFT JOIN users u ON u.id = v.created_by
     WHERE v.prompt_id = $1
     ORDER BY v.version DESC`,
    [promptId],
  );
  return rows;
}

export async function findPromptVersion(
  pool: pg.Pool,
  promptId: string,
  version: number,
): Promise<AiPromptVersionRow | null> {
  const { rows } = await pool.query<AiPromptVersionRow>(
    'SELECT * FROM ai_prompt_versions WHERE prompt_id = $1 AND version = $2',
    [promptId, version],
  );
  return rows[0] ?? null;
}

async function insertNextVersion(
  client: pg.PoolClient,
  prompt: { id: string; system_prompt: string; model: string | null },
  createdBy: string,
): Promise<AiPromptVersionRow> {
  const { rows } = await client.query<AiPromptVersionRow>(
    `INSERT INTO ai_prompt_versions (id, prompt_id, version, system_prompt, model, created_by)
     SELECT $1::text, $2::text, coalesce(max(version), 0) + 1, $3::text, $4::text, $5::text
     FROM ai_prompt_versions WHERE prompt_id = $2
     RETURNING *`,
    [newUlid(), prompt.id, prompt.system_prompt, prompt.model, createdBy],
  );
  return rows[0]!;
}

/**
 * Applies the patch and, when the content the AI service consumes changed
 * (system_prompt or model), appends the next numbered version. Label/
 * description edits are cosmetic and don't version.
 */
export async function updatePrompt(
  pool: pg.Pool,
  id: string,
  fields: {
    label?: string;
    description?: string | null;
    system_prompt?: string;
    model?: string | null;
    enabled?: boolean;
  },
  updatedBy: string,
): Promise<AiPromptRow | null> {
  return withTransaction(pool, async (client) => {
    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (fields.label !== undefined) set('label', fields.label);
    if (fields.description !== undefined) set('description', fields.description);
    if (fields.system_prompt !== undefined) set('system_prompt', fields.system_prompt);
    if (fields.model !== undefined) set('model', fields.model);
    // The on/off toggle is operational state, not prompt content — it does not
    // append a version (unlike system_prompt/model below).
    if (fields.enabled !== undefined) set('enabled', fields.enabled);
    set('updated_by', updatedBy);
    params.push(id);
    const { rows } = await client.query<AiPromptRow>(
      `UPDATE ai_prompts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    const updated = rows[0] ?? null;
    if (updated && (fields.system_prompt !== undefined || fields.model !== undefined)) {
      await insertNextVersion(client, updated, updatedBy);
    }
    return updated;
  });
}

/**
 * Restores an old version's content as a NEW version — history is append-only,
 * never rewritten. Returns null when the prompt or version doesn't exist.
 */
export async function revertPrompt(
  pool: pg.Pool,
  id: string,
  version: number,
  revertedBy: string,
): Promise<AiPromptRow | null> {
  return withTransaction(pool, async (client) => {
    const { rows: versions } = await client.query<AiPromptVersionRow>(
      'SELECT * FROM ai_prompt_versions WHERE prompt_id = $1 AND version = $2',
      [id, version],
    );
    const target = versions[0];
    if (!target) return null;
    const { rows } = await client.query<AiPromptRow>(
      `UPDATE ai_prompts
       SET system_prompt = $2, model = $3, updated_by = $4, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, target.system_prompt, target.model, revertedBy],
    );
    const updated = rows[0] ?? null;
    if (updated) await insertNextVersion(client, updated, revertedBy);
    return updated;
  });
}
