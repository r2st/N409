import type pg from 'pg';
import type { AiPipeline } from '../domain/pipeline.js';

export interface AiPromptRow {
  id: string;
  pipeline: AiPipeline;
  label: string;
  description: string | null;
  system_prompt: string;
  model: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function listPrompts(pool: pg.Pool): Promise<AiPromptRow[]> {
  const { rows } = await pool.query<AiPromptRow>('SELECT * FROM ai_prompts ORDER BY pipeline ASC');
  return rows;
}

export async function findPromptById(pool: pg.Pool, id: string): Promise<AiPromptRow | null> {
  const { rows } = await pool.query<AiPromptRow>('SELECT * FROM ai_prompts WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function findPromptByPipeline(
  pool: pg.Pool,
  pipeline: AiPipeline,
): Promise<AiPromptRow | null> {
  const { rows } = await pool.query<AiPromptRow>('SELECT * FROM ai_prompts WHERE pipeline = $1', [
    pipeline,
  ]);
  return rows[0] ?? null;
}

export async function updatePrompt(
  pool: pg.Pool,
  id: string,
  fields: { label?: string; description?: string | null; system_prompt?: string; model?: string | null },
  updatedBy: string,
): Promise<AiPromptRow | null> {
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
  set('updated_by', updatedBy);
  params.push(id);
  const { rows } = await pool.query<AiPromptRow>(
    `UPDATE ai_prompts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );
  return rows[0] ?? null;
}
