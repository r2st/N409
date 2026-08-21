import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AI_PIPELINES, NON_RUNNABLE_PIPELINES, type AiPipeline } from '../../src/domain/pipeline.js';

/**
 * The Bot Prompts registry is seeded by SQL migrations, one `ai_prompts` row per
 * pipeline, while the pipeline vocabulary itself is a TypeScript constant. Two
 * lists, two files, no compiler between them — and the only thing that had ever
 * checked they agreed was a hardcoded array inside an *integration* test, which
 * needs Postgres and so does not run in a unit-only pass.
 *
 * That gap is not hypothetical. `company_profile` (0151/0152) and `tagging`
 * (0153/0154) were each added to `AI_PIPELINES` and seeded correctly, and both
 * times the integration test's literal list was left behind — so the suite that
 * was supposed to be guarding the registry failed for having been right
 * yesterday, and took the coverage report down with it (Vitest does not emit
 * coverage for a failing run). A drift guard that only fires when a database is
 * up is a drift guard that fires after the fact.
 *
 * So: derive both sides. Adding a pipeline without its seed migration fails
 * here, on a laptop, with no database, and names the pipeline it wants.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/**
 * Pipelines that deliberately have no registry row.
 *
 * These two are not prompts an admin edits — they are code paths. 'qa' runs the
 * deterministic output checks and only reaches a model through the QA route;
 * 'explain' renders the plain-English methodology from the calculation it is
 * handed. Neither reads a seeded system prompt, so neither has a row to seed.
 *
 * Note this is *not* `NON_RUNNABLE_PIPELINES`: the six research topics are
 * non-runnable through the generic AI route and still very much have registry
 * rows — routes/research.ts reads their system prompt and tier from exactly
 * those rows. Non-runnable and unseeded are different properties, and the
 * assertion below pins that they are.
 */
const UNSEEDED_PIPELINES: ReadonlySet<AiPipeline> = new Set(['qa', 'explain']);

/**
 * Every `ai_prompts` seed tuple across the migration history, as
 * `(pipeline, id)`.
 *
 * Keyed off the seed-id convention rather than tuple position: every seeded row
 * carries a hand-assigned `01N409PR0MPT…` id (0040, 0042, 0061, 0117, 0152,
 * 0154 all follow it), and the pipeline is the literal immediately after it.
 * Matching the id first means an `INSERT` into some *other* table that happens
 * to start with two quoted strings cannot be mistaken for a prompt seed.
 */
function seededPrompts(): Map<string, string> {
  const seeds = new Map<string, string>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
    // Only look inside statements that actually insert into ai_prompts —
    // ai_prompt_versions rows reference the same ids and must not double-count.
    if (!/INSERT\s+INTO\s+ai_prompts\s*\(/i.test(sql)) continue;
    const tuple = /'(01N409PR0MPT[A-Z0-9]+)'\s*,\s*'([a-z_]+)'/g;
    for (const [, id, pipeline] of sql.matchAll(tuple)) {
      expect(seeds.has(pipeline), `${pipeline} is seeded twice (${file})`).toBe(false);
      seeds.set(pipeline, id);
    }
  }
  return seeds;
}

describe('bot prompt registry seeds', () => {
  it('seeds exactly one row per pipeline that has a prompt', () => {
    const seeded = [...seededPrompts().keys()].sort();
    const expected = AI_PIPELINES.filter((p) => !UNSEEDED_PIPELINES.has(p))
      .slice()
      .sort();
    expect(seeded).toEqual(expected);
  });

  it('names only pipelines the vocabulary knows', () => {
    // The other direction: a migration seeding a row for a pipeline that was
    // later renamed or removed leaves a row the admin UI shows and no code can
    // ever run.
    const vocabulary = new Set<string>(AI_PIPELINES);
    for (const pipeline of seededPrompts().keys()) {
      expect(vocabulary.has(pipeline), `seeded prompt '${pipeline}' is not in AI_PIPELINES`).toBe(true);
    }
  });

  it('gives every seed a distinct id', () => {
    // The ids are hand-assigned two-letter suffixes, which is exactly the kind
    // of scheme that collides on the eighteenth entry. A duplicate would make
    // the second `INSERT` fail on the primary key at migration time — in
    // deployment, not here — so catch it here.
    const ids = [...seededPrompts().values()];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('seeds the research topics, which are non-runnable but not unseeded', () => {
    // Pins the distinction the UNSEEDED_PIPELINES comment draws. If someone
    // "simplifies" this file by swapping that set for NON_RUNNABLE_PIPELINES,
    // the six research rows would silently become optional — and research.ts
    // reads its system prompt and Sonar tier from them.
    const seeded = seededPrompts();
    for (const pipeline of NON_RUNNABLE_PIPELINES) {
      if (pipeline === 'qa') continue;
      expect(seeded.has(pipeline), `research topic '${pipeline}' has no seeded prompt`).toBe(true);
    }
    expect(seeded.has('qa')).toBe(false);
    expect(seeded.has('explain')).toBe(false);
  });

  it('gives every seeded prompt a version-1 row', () => {
    // A prompt with no version row shows an empty history in the Bot Prompts
    // view and records no `prompt_version` provenance on the ai_jobs it drives.
    //
    // Version history arrived in 0045, which created `ai_prompt_versions` and
    // backfilled version 1 for every row already in `ai_prompts` — so the two
    // seed migrations that predate it (0040, 0042) are covered by that
    // backfill, and every seed migration *after* it has to carry its own
    // version insert, as 0061/0117/0152/0154 each do. That is the invariant
    // worth pinning: a new seed migration added tomorrow gets no backfill.
    const backfill = readFileSync(`${MIGRATIONS_DIR}/0045_prompt_versions.sql`, 'utf8');
    expect(/INSERT\s+INTO\s+ai_prompt_versions[\s\S]*FROM\s+ai_prompts/i.test(backfill)).toBe(true);

    const seedFiles = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) => /INSERT\s+INTO\s+ai_prompts\s*\(/i.test(readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8')));
    expect(seedFiles.length).toBeGreaterThan(0);

    for (const file of seedFiles) {
      // Migration files are `NNNN_name.sql`; the numeric prefix is the order.
      if (Number(file.slice(0, 4)) < 45) continue;
      const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
      expect(
        /INSERT\s+INTO\s+ai_prompt_versions\s*\(/i.test(sql),
        `${file} seeds a prompt after 0045 and so must seed its own version row`,
      ).toBe(true);
    }
  });
});
