import type pg from 'pg';
import type { ValuationKind } from '../domain/valuation.js';

/**
 * The narrative prompt library (migration 0114) — the per-section guidance the
 * report_narrative agent drafts against.
 *
 * Distinct from `ai_prompts`, which holds one *system* prompt per pipeline.
 * That prompt says who the model is; these say what each section must cover. A
 * firm editing "be more conservative about forward multiples" is editing a
 * section, not a persona.
 *
 * Persistence only. Resolving the two layers into the list an agent actually
 * receives is `domain/narrativePrompts.ts`, and the audit write is the route's
 * (`recordAdminEvent`), the same split `repos/aiPrompts.ts` uses.
 */
export interface NarrativePromptRow {
  id: string;
  /** NULL = the base library, applying to any kind without an override. */
  kind: ValuationKind | null;
  section_key: string;
  label: string;
  guidance: string;
  sort_order: number;
  enabled: boolean;
  /** The seeded text, preserved so an edited row can be reset. */
  default_guidance: string;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function listNarrativePrompts(pool: pg.Pool): Promise<NarrativePromptRow[]> {
  const { rows } = await pool.query<NarrativePromptRow>(
    `SELECT * FROM narrative_prompts
      ORDER BY kind NULLS FIRST, sort_order ASC, section_key ASC`,
  );
  return rows;
}

export async function findNarrativePromptById(pool: pg.Pool, id: string): Promise<NarrativePromptRow | null> {
  const { rows } = await pool.query<NarrativePromptRow>('SELECT * FROM narrative_prompts WHERE id = $1', [
    id,
  ]);
  return rows[0] ?? null;
}

/**
 * Every row that could apply to `kind`: the base library plus that kind's
 * overrides. Resolution into one list belongs to the domain
 * (domain/narrativePrompts.ts) — this returns both layers so the caller can
 * see what was overridden rather than only the winner.
 */
export async function listNarrativePromptsForKind(
  pool: pg.Pool,
  kind: ValuationKind,
): Promise<NarrativePromptRow[]> {
  const { rows } = await pool.query<NarrativePromptRow>(
    `SELECT * FROM narrative_prompts
      WHERE kind IS NULL OR kind = $1
      ORDER BY sort_order ASC, section_key ASC`,
    [kind],
  );
  return rows;
}

export interface NarrativePromptPatch {
  guidance?: string;
  label?: string;
  enabled?: boolean;
  sort_order?: number;
}

/** Columns a patch may touch — the allow-list the SET clause is built from. */
const PATCHABLE = new Set(['guidance', 'label', 'enabled', 'sort_order']);

/**
 * Update one library row. `default_guidance` is deliberately not patchable —
 * it is the record of what the row shipped as, and a "reset" that resets to
 * whatever someone last saved is not a reset.
 */
export async function patchNarrativePrompt(
  pool: pg.Pool,
  id: string,
  patch: NarrativePromptPatch,
  updatedBy: string | null,
): Promise<NarrativePromptRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [column, value] of Object.entries(patch)) {
    // Interpolated into SQL, so the column name comes from the allow-list and
    // never from the request body, whatever Zod let through.
    if (value === undefined || !PATCHABLE.has(column)) continue;
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length === 0) return findNarrativePromptById(pool, id);

  values.push(updatedBy);
  sets.push(`updated_by = $${values.length}`);

  const { rows } = await pool.query<NarrativePromptRow>(
    `UPDATE narrative_prompts SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $1 RETURNING *`,
    values,
  );
  return rows[0] ?? null;
}

/** Restore a row's guidance to what it shipped as. */
export async function resetNarrativePrompt(
  pool: pg.Pool,
  id: string,
  updatedBy: string | null,
): Promise<NarrativePromptRow | null> {
  const { rows } = await pool.query<NarrativePromptRow>(
    `UPDATE narrative_prompts
        SET guidance = default_guidance, enabled = true, updated_by = $2, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, updatedBy],
  );
  return rows[0] ?? null;
}
