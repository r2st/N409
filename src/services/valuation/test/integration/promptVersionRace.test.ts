import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { findPromptByPipeline, listPromptVersions, updatePrompt } from '../../src/repos/aiPrompts.js';
import { createUser } from '../../src/repos/users.js';
import { hashPassword } from '../../src/auth/password.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Two edits of one AI prompt, arriving together.
 *
 * `ai_prompt_versions` is append-only and numbered by `coalesce(max(version),
 * 0) + 1` taken inside the statement that inserts — which is atomic against
 * nothing. Under READ COMMITTED each transaction's `max` is evaluated against
 * the snapshot its own statement started with, so two concurrent edits both
 * read the same highest version and both aim at the same next number.
 * `UNIQUE (prompt_id, version)` (migration 0045) stops that becoming two rows
 * claiming to be version 4, but only by raising 23505 at the loser — inside the
 * transaction that also carries the `UPDATE ai_prompts`, so the losing admin's
 * edit is rolled back whole and answered with a 500. That is the shape
 * `createTemplateVersion` needed an advisory lock for, one table over.
 *
 * It does not happen here, and the reason is an ordering rather than a lock:
 * `updatePrompt` and `revertPrompt` both UPDATE the `ai_prompts` row *before*
 * appending, and that row-level exclusive lock — on the single row every racing
 * edit of one prompt shares — is held to COMMIT. The second transaction is
 * still waiting on it when it would have counted, and by the time it counts it
 * is a new statement with a new snapshot.
 *
 * Which makes this file a pin on the ordering, not a reproduction: hoisting the
 * append above the UPDATE fails the first case below with duplicate-key errors,
 * which is how the reasoning above was checked rather than argued.
 */
describe.skipIf(!dbUp)('concurrent AI prompt edits', () => {
  let db: TestDb;
  let pool: pg.Pool;
  let promptId: string;
  let editor: string;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    const user = await createUser(pool, {
      email: 'prompt-editor@example.com',
      passwordDigest: await hashPassword('correct horse battery staple'),
      roles: [],
    });
    editor = user.id;
    // Any seeded prompt; the extraction one ships in migration 0045's seed.
    const prompt = await findPromptByPipeline(pool, 'report_narrative');
    if (!prompt) throw new Error('no seeded report_narrative prompt to edit');
    promptId = prompt.id;
  });

  afterAll(async () => {
    await db?.teardown();
  });

  const versions = async () => {
    const { versions: rows } = await listPromptVersions(pool, promptId);
    return rows.map((v) => v.version).sort((a, b) => a - b);
  };

  it('numbers a burst of simultaneous edits without dropping any of them', async () => {
    const before = await versions();
    const edits = Array.from({ length: 6 }, (_, i) =>
      updatePrompt(pool, promptId, { system_prompt: `revision ${i}` }, editor),
    );
    const settled = await Promise.allSettled(edits);

    const failed = settled.filter((r) => r.status === 'rejected');
    expect(
      failed.map((r) => String((r as PromiseRejectedResult).reason)),
      'an edit was rejected rather than queued behind the others',
    ).toEqual([]);

    // Six edits, six new numbers, no gaps and no repeats — the history is what
    // makes a prompt change auditable, and a number that never landed is an
    // edit the register cannot account for.
    const after = await versions();
    expect(after.length).toBe(before.length + 6);
    expect(after).toEqual(after.map((_, i) => i + 1));
  });

  it('leaves the live prompt agreeing with the newest version it recorded', async () => {
    // The version row and the `ai_prompts` row are written in one transaction.
    // A loser rolled back by the unique violation takes its own UPDATE with it,
    // which is the *safe* half of the failure; the unsafe half is the other
    // ordering, where the edit lands and the history does not.
    const prompt = await findPromptByPipeline(pool, 'report_narrative');
    const { versions: rows } = await listPromptVersions(pool, promptId);
    expect(rows[0]!.system_prompt).toBe(prompt!.system_prompt);
  });
});
