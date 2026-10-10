import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import type { TagSource, TagStatus } from '../domain/valuationTags.js';

/**
 * Engagement tags (migration 0153).
 *
 * `confidence` is `numeric`, which the pg driver hands back as a string, so it
 * is converted at this boundary once — the same rule `comparableItems` states
 * for its metric legs, and for the same reason: a confidence compared as
 * `'0.9' > 0.8` is a bug that only shows up on some values.
 */

export interface ValuationTagRow {
  id: string;
  valuation_id: string;
  slug: string;
  source: TagSource;
  status: TagStatus;
  confidence: number | null;
  rationale: string | null;
  evidence: string[];
  created_by: string | null;
  created_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
}

type RawValuationTagRow = Omit<ValuationTagRow, 'confidence' | 'evidence'> & {
  confidence: string | number | null;
  evidence: unknown;
};

function hydrate(row: RawValuationTagRow): ValuationTagRow {
  return {
    ...row,
    confidence: row.confidence === null ? null : Number(row.confidence),
    // jsonb round-trips as whatever was written; a row written before a bound
    // existed, or by hand, must not hand a caller a non-array to map over.
    evidence: Array.isArray(row.evidence)
      ? row.evidence.filter((e): e is string => typeof e === 'string')
      : [],
  };
}

/**
 * Lock class for the exclusivity invariant, keyed on the engagement.
 *
 * Distinct from `PUBLISH_GATE_LOCK`, `OVERWRITE_CELL_LOCK`, `TEMPLATE_NAME_LOCK`
 * and `SCENARIO_CAP_LOCK` — `pg_advisory_xact_lock(key1, key2)` shares one
 * namespace across the database, so two unrelated subsystems picking the same
 * pair would block each other for no reason.
 */
const TAG_CATEGORY_LOCK = 0x7461_6773; // 'tags'

/**
 * Serialises "at most one accepted tag from an exclusive category" against
 * itself.
 *
 * The rule is enforced by reading the engagement's tags, demoting whichever
 * accepted row shares the incoming tag's category, and then writing the new
 * one. Those are three statements, and until this lock they ran on the pool
 * with nothing holding the list still between them: two accepts of mutually
 * exclusive tags arriving together — a double-click on two rows, or a client
 * sending both — each read a list in which the other had not landed yet, each
 * found nothing to demote, and the engagement ended up carrying `seed` and
 * `series_a` at once. That is the exact state the demotion exists to prevent,
 * and every reader downstream (the list filter, the precedent query,
 * `acceptedTagSlugs`) is written as if it cannot happen.
 *
 * Advisory rather than a row lock, for `lockPublishGate`'s reason: the rows
 * that decide the answer may not exist yet. Both racers are *inserting* the tag
 * they want accepted, so there is nothing to lock in the direction that
 * matters; an advisory lock keyed on the engagement is held whether or not the
 * rows it protects exist.
 *
 * Keyed on the valuation rather than on the category: a lock per category would
 * be correct for this invariant alone, but categories are catalogue data and
 * the engagement is the unit every other tag write already names. The
 * contention it costs is two operators tagging the same engagement in the same
 * instant.
 *
 * Transaction-scoped, so COMMIT or ROLLBACK releases it and no failure path can
 * leak it — which also means it must be taken on a client inside a transaction.
 */
export async function lockTagCategories(client: pg.PoolClient, valuationId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [TAG_CATEGORY_LOCK, valuationId]);
}

/**
 * Every tag on one engagement, decided ones first.
 *
 * Accepted, then suggested, then rejected — the order an analyst works the list
 * in. Within a status, the strongest suggestion first, because the top of a
 * suggestion list is where attention goes and a null confidence (every manual
 * tag) belongs below a model's 0.9 rather than above it.
 */
const TAG_LIST_LIMIT = 200;

export async function listValuationTags(
  pool: pg.Pool | pg.PoolClient,
  valuationId: string,
): Promise<ValuationTagRow[]> {
  const { rows } = await pool.query<RawValuationTagRow>(
    `SELECT * FROM valuation_tags
      WHERE valuation_id = $1
      ORDER BY array_position(ARRAY['accepted','suggested','rejected']::valuation_tag_status[], status),
               confidence DESC NULLS LAST,
               slug
      LIMIT $2`,
    [valuationId, TAG_LIST_LIMIT],
  );
  return rows.map(hydrate);
}

/** The accepted slugs only — what a filter, an export or a precedent query reads. */
export async function acceptedTagSlugs(
  pool: pg.Pool | pg.PoolClient,
  valuationId: string,
): Promise<string[]> {
  const { rows } = await pool.query<{ slug: string }>(
    `SELECT slug FROM valuation_tags WHERE valuation_id = $1 AND status = 'accepted' ORDER BY slug`,
    [valuationId],
  );
  return rows.map((r) => r.slug);
}

/** Accepted slugs for many engagements at once — one query for a whole page. */
export async function acceptedTagsFor(
  pool: pg.Pool | pg.PoolClient,
  valuationIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (valuationIds.length === 0) return out;
  const { rows } = await pool.query<{ valuation_id: string; slug: string }>(
    `SELECT valuation_id, slug FROM valuation_tags
      WHERE valuation_id = ANY($1) AND status = 'accepted'
      ORDER BY valuation_id, slug`,
    [[...valuationIds]],
  );
  for (const row of rows) {
    const list = out.get(row.valuation_id);
    if (list) list.push(row.slug);
    else out.set(row.valuation_id, [row.slug]);
  }
  return out;
}

export interface TagUpsert {
  slug: string;
  source: TagSource;
  status: TagStatus;
  confidence?: number | null;
  rationale?: string | null;
  evidence?: readonly string[];
}

/**
 * Write one tag, or move the one that is already there.
 *
 * The conflict clause is the whole design of this function, and it is
 * deliberately asymmetric: a *human* decision is never overwritten by a
 * machine one. An `ai` upsert onto a row an analyst has already accepted or
 * rejected refreshes the model's reasoning and leaves the status alone; a
 * `manual` upsert sets the status it was asked for.
 *
 * Without that, re-running the agent after a review would silently reopen every
 * question the review had closed — a tag an analyst rejected in March comes
 * back as a suggestion in April, and one they accepted with a note reverts to
 * the model's wording. That is the failure that makes people stop re-running
 * agents, and stopping is worse than the drift.
 *
 * `source` IS NOT IN THE UPDATE SET AT ALL: it is written once, by the INSERT,
 * and never moved. It records who *originated* the tag, and both halves of this
 * subsystem say that fact is load-bearing — `TAG_SOURCES` ("only the first is
 * evidence of independent judgement") and the PATCH route, which carries the
 * existing source through an acceptance so that "the model proposed this and an
 * analyst agreed" is not rewritten into "an analyst concluded this".
 *
 * It used to be `source = EXCLUDED.source`, unconditionally, which broke that in
 * the other direction and much more easily: an analyst tags an engagement
 * `series_a` by hand, the tagging agent runs and reaches the same conclusion,
 * and the row is relabelled the model's. The status guard below held — it stays
 * `accepted` — so nothing looked wrong. Two things were: the file no longer
 * shows an independent human judgement where one was made, and the tag has
 * become undeletable, because `DELETE /tags/:slug` refuses an `ai`-sourced row
 * and tells the analyst to reject their own tag instead.
 *
 * Write-once rather than "an ai upsert may not overwrite a manual origin",
 * because the other direction is the same fact: a `manual` upsert onto a row
 * the model proposed is an analyst agreeing, which is what `status` and
 * `decided_by` are for. There is no upsert that changes where a tag came from.
 */
export async function upsertValuationTag(
  pool: pg.Pool | pg.PoolClient,
  valuationId: string,
  tag: TagUpsert,
  actorId: string | null,
): Promise<ValuationTagRow> {
  const decided = tag.status === 'suggested' ? null : actorId;
  const { rows } = await pool.query<RawValuationTagRow>(
    `INSERT INTO valuation_tags
       (id, valuation_id, slug, source, status, confidence, rationale, evidence,
        created_by, decided_by, decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10, CASE WHEN $10::ulid IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (valuation_id, slug) DO UPDATE SET
       confidence = EXCLUDED.confidence,
       rationale  = EXCLUDED.rationale,
       evidence   = EXCLUDED.evidence,
       status     = CASE
                      WHEN EXCLUDED.source = 'ai' AND valuation_tags.status <> 'suggested'
                        THEN valuation_tags.status
                      ELSE EXCLUDED.status
                    END,
       decided_by = CASE
                      WHEN EXCLUDED.source = 'ai' AND valuation_tags.status <> 'suggested'
                        THEN valuation_tags.decided_by
                      ELSE EXCLUDED.decided_by
                    END,
       decided_at = CASE
                      WHEN EXCLUDED.source = 'ai' AND valuation_tags.status <> 'suggested'
                        THEN valuation_tags.decided_at
                      WHEN EXCLUDED.decided_by IS NULL THEN NULL
                      ELSE now()
                    END
     RETURNING *`,
    [
      newUlid(),
      valuationId,
      tag.slug,
      tag.source,
      tag.status,
      tag.confidence ?? null,
      tag.rationale ?? null,
      JSON.stringify(tag.evidence ?? []),
      actorId,
      decided,
    ],
  );
  return hydrate(rows[0]!);
}

/**
 * Record an operator's decision on a tag that is already there.
 *
 * Separate from {@link upsertValuationTag} because that function's conflict
 * clause reads `source` as *who is writing* when the column means *where the
 * tag came from*, and the two are only the same thing on the agent's own door.
 * `source` is write-once, so an AI-proposed tag an analyst has accepted keeps
 * `source = 'ai'` forever — and the decision doors carry that value back in on
 * every later write, which made the clause refuse the writes it was never
 * about:
 *
 *   * `PATCH /tags/:slug` on an already-decided AI tag was inert. Accepting is
 *     the transition it is for, and once accepted the analyst could not reject
 *     it again — while `DELETE` refuses an AI row and tells them to do exactly
 *     that. The tag was stuck accepted with no transition out of it, and the
 *     route answered 200 either way.
 *   * The exclusivity demotion is the same write one caller over, so an
 *     accepted `seed` that had come from the agent survived the promotion of
 *     `series_a` and the engagement carried two stages at once — the state the
 *     category lock exists to make impossible, reached without a race.
 *
 * So the origin is left alone and the decision lands whatever the origin says.
 * Every caller is a human acting through an ops-only door; the machine door
 * writes `suggested` through the upsert above and is still refused by its
 * clause.
 *
 * WHAT IT DOES NOT DO IS LAND A DECISION THAT WAS ALREADY MADE (R448,
 * methodology M3). `status = $3` by key alone re-stamped `decided_by` and
 * `decided_at` with whoever pressed the control last, and the route put a
 * second `valuation_tag_decided` on the admin trail for it. The console's
 * accept/reject controls are drawn from each analyst's own copy of the tag
 * list, so two people triaging the same engagement's suggestions — or one
 * double-click — was enough to re-attribute a decision that had already been
 * taken. `status <> $3` in the predicate makes the write and the "is this a
 * change" test one statement, and `changed` is what the route records on:
 * the same shape as `setSupportMessageStatus`.
 *
 * Returns null when the row is gone — deleted between the caller's read and
 * this write — which is the caller's signal that there was nothing to decide.
 */
export interface TagDecisionWrite {
  tag: ValuationTagRow;
  /** False when the tag was already in the status the caller asked for. */
  changed: boolean;
}

export async function decideValuationTag(
  pool: pg.Pool | pg.PoolClient,
  valuationId: string,
  slug: string,
  status: Exclude<TagStatus, 'suggested'>,
  actorId: string | null,
): Promise<TagDecisionWrite | null> {
  const { rows } = await pool.query<RawValuationTagRow>(
    `UPDATE valuation_tags
        SET status = $3, decided_by = $4, decided_at = now()
      WHERE valuation_id = $1 AND slug = $2 AND status <> $3
      RETURNING *`,
    [valuationId, slug, status, actorId],
  );
  if (rows[0]) return { tag: hydrate(rows[0]), changed: true };
  const standing = await findValuationTag(pool, valuationId, slug);
  return standing ? { tag: standing, changed: false } : null;
}

/**
 * Write a whole run's worth of suggestions in one transaction.
 *
 * All or nothing: a partially applied tagging run leaves an engagement
 * classified by the first half of a list, which is a worse state than the
 * unclassified one it started in because it looks finished.
 */
export async function upsertValuationTags(
  pool: pg.Pool,
  valuationId: string,
  tags: readonly TagUpsert[],
  actorId: string | null,
): Promise<ValuationTagRow[]> {
  if (tags.length === 0) return [];
  return withTransaction(pool, async (client) => {
    const decidedIds = tags.map((t) => (t.status === 'suggested' ? null : actorId));
    const { rows } = await client.query<RawValuationTagRow>(
      `INSERT INTO valuation_tags
         (id, valuation_id, slug, source, status, confidence, rationale, evidence,
          created_by, decided_by, decided_at)
       SELECT v.id, v.valuation_id, v.slug, v.source, v.status,
              v.confidence, v.rationale, v.evidence,
              v.created_by, v.decided_by,
              CASE WHEN v.decided_by IS NULL THEN NULL ELSE now() END
       FROM unnest(
         $1::ulid[], $2::ulid[], $3::text[],
         $4::valuation_tag_source[], $5::valuation_tag_status[],
         $6::numeric[], $7::text[], $8::jsonb[], $9::text[], $10::ulid[]
       ) AS v(id, valuation_id, slug, source, status,
              confidence, rationale, evidence, created_by, decided_by)
       ON CONFLICT (valuation_id, slug) DO UPDATE SET
         confidence = EXCLUDED.confidence,
         rationale  = EXCLUDED.rationale,
         evidence   = EXCLUDED.evidence,
         status     = CASE
                        WHEN EXCLUDED.source = 'ai' AND valuation_tags.status <> 'suggested'
                          THEN valuation_tags.status
                        ELSE EXCLUDED.status
                      END,
         decided_by = CASE
                        WHEN EXCLUDED.source = 'ai' AND valuation_tags.status <> 'suggested'
                          THEN valuation_tags.decided_by
                        ELSE EXCLUDED.decided_by
                      END,
         decided_at = CASE
                        WHEN EXCLUDED.source = 'ai' AND valuation_tags.status <> 'suggested'
                          THEN valuation_tags.decided_at
                        WHEN EXCLUDED.decided_by IS NULL THEN NULL
                        ELSE now()
                      END
       RETURNING *`,
      [
        tags.map(() => newUlid()),
        tags.map(() => valuationId),
        tags.map((t) => t.slug),
        tags.map((t) => t.source),
        tags.map((t) => t.status),
        tags.map((t) => t.confidence ?? null),
        tags.map((t) => t.rationale ?? null),
        tags.map((t) => JSON.stringify(t.evidence ?? [])),
        tags.map(() => actorId),
        decidedIds,
      ],
    );
    return rows.map(hydrate);
  });
}

/**
 * Drop a tag entirely.
 *
 * Only ever used on a tag a human put there. An AI-sourced row is rejected
 * rather than deleted — see the `rejected` note in migration 0153 — and the
 * route is what enforces that, the same way `DELETABLE_SOURCES` does for the
 * peer set.
 */
export async function deleteValuationTag(
  pool: pg.Pool | pg.PoolClient,
  valuationId: string,
  slug: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM valuation_tags WHERE valuation_id = $1 AND slug = $2`, [
    valuationId,
    slug,
  ]);
  return (rowCount ?? 0) > 0;
}

export async function findValuationTag(
  pool: pg.Pool | pg.PoolClient,
  valuationId: string,
  slug: string,
): Promise<ValuationTagRow | null> {
  const { rows } = await pool.query<RawValuationTagRow>(
    `SELECT * FROM valuation_tags WHERE valuation_id = $1 AND slug = $2`,
    [valuationId, slug],
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

/**
 * How often each tag is accepted across the readable book of work.
 *
 * The precedent query's index page: a tag with two engagements behind it is not
 * yet a comparison, and one with forty is where a firm's house view actually
 * lives. Scoped by the caller passing the ids it may read — this repo does not
 * know the RBAC rules and must not appear to.
 */
export async function tagUsageCounts(
  pool: pg.Pool | pg.PoolClient,
  valuationIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (valuationIds.length === 0) return out;
  const { rows } = await pool.query<{ slug: string; count: string }>(
    `SELECT slug, count(*)::text AS count FROM valuation_tags
      WHERE valuation_id = ANY($1) AND status = 'accepted'
      GROUP BY slug`,
    [[...valuationIds]],
  );
  for (const row of rows) out.set(row.slug, Number(row.count));
  return out;
}
