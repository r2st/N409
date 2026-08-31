import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { likeContains } from '../db/like.js';
import type { Queryable } from '../db/pool.js';
import type { RetentionActionName, RetentionPolicy } from '../domain/retention.js';
import { EMAIL_MAX_ATTEMPTS } from '../domain/emailRetry.js';
import { invalidateValuation } from './valuations.js';

// ── Policies ─────────────────────────────────────────────────────────────────

export interface RetentionPolicyRow extends RetentionPolicy {
  updated_by: string | null;
  updated_at: Date;
}

export async function listPolicies(pool: pg.Pool): Promise<RetentionPolicyRow[]> {
  const { rows } = await pool.query<RetentionPolicyRow>(
    'SELECT * FROM retention_policies ORDER BY data_type',
  );
  return rows;
}

export async function upsertPolicy(
  pool: pg.Pool,
  input: {
    dataType: string;
    archiveAfterDays: number | null;
    retentionDays: number | null;
    enabled: boolean;
    updatedBy: string;
  },
): Promise<RetentionPolicyRow> {
  const { rows } = await pool.query<RetentionPolicyRow>(
    `INSERT INTO retention_policies (data_type, archive_after_days, retention_days, enabled, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (data_type) DO UPDATE SET
       archive_after_days = EXCLUDED.archive_after_days,
       retention_days = EXCLUDED.retention_days,
       enabled = EXCLUDED.enabled,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING *`,
    [input.dataType, input.archiveAfterDays, input.retentionDays, input.enabled, input.updatedBy],
  );
  return rows[0]!;
}

// ── Legal holds ──────────────────────────────────────────────────────────────

export interface LegalHoldRow {
  id: string;
  scope: 'global' | 'valuation' | 'user';
  reference_id: string | null;
  reason: string;
  active: boolean;
  placed_by: string | null;
  placed_at: Date;
  released_by: string | null;
  released_at: Date | null;
}

/** Ceiling on one page of the legal-hold ledger. */
export const HOLD_PAGE_LIMIT = 200;

/**
 * The legal-hold ledger, newest first — a page of it.
 *
 * Holds are never deleted, only released, so this table only grows. Capping it
 * is safe in a way capping a work queue is not: nothing *enforces* a hold from
 * this list. Every sweep checks `legal_holds` in SQL — `findArchivableValuations`
 * and `purgeExpiredOutbox` below — so a hold past the cut still blocks the
 * action even though it is not on
 * the page. Active holds are ordered ahead of released ones so the cap cannot
 * push a live hold off the end behind a year of released ones.
 */
export async function listHolds(
  pool: pg.Pool,
  opts: { limit?: number } = {},
): Promise<{ holds: LegalHoldRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? HOLD_PAGE_LIMIT, 1), HOLD_PAGE_LIMIT);
  const { rows } = await pool.query<LegalHoldRow>(
    'SELECT * FROM legal_holds ORDER BY active DESC, placed_at DESC LIMIT $1',
    [limit + 1],
  );
  return { holds: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function placeHold(
  pool: pg.Pool,
  input: {
    scope: 'global' | 'valuation' | 'user';
    referenceId: string | null;
    reason: string;
    placedBy: string;
  },
): Promise<LegalHoldRow> {
  const { rows } = await pool.query<LegalHoldRow>(
    `INSERT INTO legal_holds (id, scope, reference_id, reason, placed_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [newUlid(), input.scope, input.referenceId, input.reason, input.placedBy],
  );
  return rows[0]!;
}

export async function releaseHold(pool: pg.Pool, id: string, releasedBy: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE legal_holds SET active = false, released_at = now(), released_by = $2
      WHERE id = $1 AND active = true`,
    [id, releasedBy],
  );
  return (rowCount ?? 0) > 0;
}

// ── Retention actions (audit log) ────────────────────────────────────────────

export interface RetentionActionRow {
  id: string;
  data_type: string;
  action: RetentionActionName;
  reference_id: string | null;
  detail: Record<string, unknown>;
  created_at: Date;
}

export interface RetentionActionInput {
  dataType: string;
  action: RetentionActionName;
  referenceId: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Append to the decision log, however many decisions the pass made.
 *
 * Batched rather than one insert per decision: the sweep logs a row for every
 * candidate it looks at, and `findArchivableValuations` hands it up to 500 of
 * them. One INSERT per decision meant the log — which is pure audit bookkeeping
 * and nothing waits on it — cost more round trips than the archival it was
 * describing.
 *
 * A no-op on an empty batch: a loop that writes nothing is fine, a statement
 * with an empty VALUES list is a syntax error.
 */
export async function recordActions(
  client: pg.Pool | pg.PoolClient,
  inputs: readonly RetentionActionInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  const params: unknown[] = [];
  const tuples = inputs.map((input) => {
    params.push(
      newUlid(),
      input.dataType,
      input.action,
      input.referenceId,
      JSON.stringify(input.detail ?? {}),
    );
    const n = params.length;
    return `($${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
  });
  await client.query(
    `INSERT INTO retention_actions (id, data_type, action, reference_id, detail)
     VALUES ${tuples.join(', ')}`,
    params,
  );
}

/**
 * Whether any active legal hold freezes this one valuation.
 *
 * The same three-way test `findArchivableValuations` computes for a whole
 * batch, asked of a single row — and asked in SQL rather than by pulling
 * `listHolds` and running `isFrozen` over it, because that listing is paged.
 * A deployment past `HOLD_PAGE_LIMIT` holds would answer "not frozen" for a
 * valuation whose hold sits on page two, which is the quiet direction to be
 * wrong in: it is the answer that lets an action proceed.
 */
export async function isValuationFrozen(
  pool: pg.Pool,
  target: { valuationId: string; userId: string },
): Promise<boolean> {
  const { rows } = await pool.query<{ frozen: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM legal_holds h
        WHERE h.active
          AND (h.scope = 'global'
            OR (h.scope = 'valuation' AND h.reference_id = $1)
            OR (h.scope = 'user' AND h.reference_id = $2))
     ) AS frozen`,
    [target.valuationId, target.userId],
  );
  return rows[0]?.frozen ?? false;
}

/**
 * Every engagement that is currently withdrawn, by name.
 *
 * WHY THIS IS NOT THE AUDIT LOG. The restore control lived on the log, offered
 * against the `archived` entry it undoes, and that is a history: it is ordered
 * by when things happened and it is capped. A sweep that archives forty rows on
 * a Sunday pushes an engagement retired the week before off the end of it, and
 * what disappears with the row is the only route back — silently, because a
 * truncated list looks exactly like a complete one. R90 made retirement
 * reversible; a reversal you cannot find is not reversible.
 *
 * So the state gets its own read. It answers "what is withdrawn right now",
 * which is a question about `valuations.archived_at` and not about what the
 * sweep did, and it carries the company name because nobody knows an
 * engagement by its ULID.
 *
 * `retired_reason` and `retired_manually` come from the matching action row
 * when there is one. There need not be: the sweep's own archivals predate the
 * manual route and record no reason, and a NULL there reads correctly as "a
 * retention policy ran out" rather than as missing data.
 */
export interface RetiredValuationRow {
  id: string;
  number: number;
  company_name: string;
  kind: string;
  state: string;
  archived_at: Date;
  retired_reason: string | null;
  retired_manually: boolean;
}

export async function listRetiredValuations(
  pool: pg.Pool,
  opts: { q?: string; limit?: number } = {},
): Promise<{ rows: RetiredValuationRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const q = opts.q?.trim() ?? '';
  // `LIKE`-escaped: a company name is user input and `%` in it would otherwise
  // widen the search silently rather than fail. Escaping via `likeContains`
  // rather than a second copy of the character class, because a second copy is
  // how the inbox came to have none: the rule is only enforceable where it is
  // written once.
  const pattern = q === '' ? null : likeContains(q);

  // The page is taken first and the reason is looked up against it, rather than
  // the two being one flat select. A LATERAL is evaluated once per row on its
  // left, and `count(*) OVER ()` is a window over the *matched* set, so the
  // LIMIT cannot stop the scan early — written flat, the lookup ran once per
  // archived engagement on the platform to fill in fifty cells. Nesting it
  // makes the left side of the loop the page, which is the only side anything
  // reads. Measured at 4,444 archived rows, with the index migration 0177 adds:
  // 26.4 ms and 21,926 blocks flat against 8.8 ms and 4,397 nested, and 65x
  // that again on a database where the index is missing.
  //
  // The window still counts the whole matched set — it is inside the subquery,
  // where `WindowAgg` runs before `Limit` — so `total` means what it did.
  const { rows } = await pool.query<RetiredValuationRow & { total: string }>(
    `SELECT p.id, p.number, p.company_name, p.kind, p.state, p.archived_at, p.total,
            a.detail ->> 'reason' AS retired_reason,
            COALESCE((a.detail ->> 'manual')::boolean, false) AS retired_manually
       FROM (
         SELECT v.id, v.number, v.company_name, v.kind, v.state, v.archived_at,
                count(*) OVER () AS total
           FROM valuations v
          WHERE v.archived_at IS NOT NULL
            AND ($1::text IS NULL OR v.company_name ILIKE $1 ESCAPE '\\' OR v.id = $2)
          ORDER BY v.archived_at DESC
          LIMIT $3
       ) p
       -- The archival that is still the last word on this row. LATERAL rather
       -- than a join on max(created_at): two archivals of the same id (retired,
       -- restored, retired again) would otherwise multiply the valuation.
       LEFT JOIN LATERAL (
         SELECT ra.detail
           FROM retention_actions ra
          WHERE ra.data_type = 'valuation'
            AND ra.reference_id = p.id
            AND ra.action = 'archived'
          ORDER BY ra.created_at DESC
          LIMIT 1
       ) a ON true
      -- Repeated on the outside because a join does not promise to preserve its
      -- input's order, however reliably a nested loop happens to. Fifty rows,
      -- already in order, so it is a free assertion rather than a second sort.
      ORDER BY p.archived_at DESC`,
    [pattern, q, limit],
  );

  return {
    rows: rows.map(({ total: _total, ...row }) => row),
    // `count(*) OVER ()` counts the matched set before LIMIT, which is the
    // number the caller needs to know whether they are looking at all of it.
    total: rows.length === 0 ? 0 : Number(rows[0]!.total),
  };
}

export async function listActions(pool: pg.Pool, limit = 200): Promise<RetentionActionRow[]> {
  const { rows } = await pool.query<RetentionActionRow>(
    'SELECT * FROM retention_actions ORDER BY created_at DESC LIMIT $1',
    [limit],
  );
  return rows;
}

/**
 * The most outbox rows one pass will delete.
 *
 * The first pass after an operator enables the policy takes everything that
 * has accumulated since the table was created, which is not a statement to run
 * in one transaction against a table the send path writes to. Capping it makes
 * the backlog drain over successive ticks instead; the sweep runs every six
 * hours, so a deployment at the cap catches up within a day or two and the
 * count is in the log line the whole time.
 */
export const OUTBOX_PURGE_BATCH = 5_000;

export interface OutboxPurgeResult {
  /** Rows deleted this pass. */
  purged: number;
  /** Rows past their age that an active legal hold protected. */
  skippedHold: number;
}

/**
 * Delete correspondence older than the policy, unless a hold covers it.
 *
 * This is the storage-limitation half of feature 10 and it was missing: the
 * `email_outbox` policy has been settable from the console since the feature
 * shipped and no code read it, so a table of recipients, subjects and message
 * bodies grew without bound while a screen said it was governed.
 *
 * ## What is eligible
 *
 * Only rows that have finished. 'sent' and 'skipped' are terminal; 'failed' is
 * terminal once the ladder is out of attempts, and a failed row still inside
 * its attempts is a message the retry sweep is going to try again — deleting
 * that is losing mail, not ageing it out. A 'queued' row is not eligible at
 * all, whatever its age: it is either about to be sent or already stranded, and
 * the stranded case is what the retry sweep exists to pick up —
 * `claimRetryableEmails` while it still has attempts, and
 * `retireStrandedEmails` once it does not. Before R272 the second half of that
 * sentence was not true of anything, so a 'queued' row past the ceiling was
 * ineligible here and unclaimable there, and stayed in the table for ever.
 *
 * The age is `created_at`, not `sent_at`, so a row that never went anywhere
 * ages on the same clock as one that did — otherwise a permanently-failed
 * message would have a NULL `sent_at` and never expire.
 *
 * ## The hold
 *
 * Three ways to be frozen, matching `isFrozen` and `findArchivableValuations`:
 * a global hold stops everything, a `user` hold covers the recipient
 * (`to_user_id`), and a `valuation` hold covers the engagement the message is
 * about. Checked in SQL rather than against the paged `listHolds` for the
 * reason `isValuationFrozen` gives — a hold on page two would otherwise read as
 * no hold, and that is the direction that deletes.
 *
 * A message addressed to an address with no account (`to_user_id IS NULL`)
 * cannot be covered by a user hold. That is not a gap: a hold names an
 * aggregate this platform holds, and there is no user aggregate for a client
 * contact who was mailed an intake link. A global hold still covers them.
 *
 * Returns the deleted ids so the caller can log them, and counts the frozen
 * separately so "nothing was purged" can be told from "nothing was eligible".
 */
export async function purgeExpiredOutbox(
  pool: pg.Pool,
  retentionDays: number,
  limit = OUTBOX_PURGE_BATCH,
): Promise<{ ids: string[]; skippedHold: number }> {
  /** `$1` days, `$2` max attempts — the same numbering in both statements. */
  const eligible = `e.created_at < now() - ($1 || ' days')::interval
    AND e.status <> 'queued'
    -- Never a row the retry sweep could still take. Spelled as the negation of
    -- claimRetryableEmails' own conditions rather than as an age, because the
    -- ages are independent: retention is an operator's number and could be set
    -- to a day, while the ladder's own window is fixed. Deleting a message that
    -- was going to be tried again is losing mail, which is the one outcome an
    -- outbox exists to prevent.
    --
    -- A 'failed' row is therefore eligible only once it is out of attempts, or
    -- hard-bounced, or about an engagement that has been withdrawn — the three
    -- ways the ladder stops. That last one is the case a pure age would have
    -- missed in the other direction: those rows are never retried and never
    -- expire, so they would have been the residue nothing could ever remove.
    AND (
      e.status <> 'failed'
      OR e.attempts >= $2
      OR (e.bounce_kind IS NOT NULL AND e.bounce_kind <> 'soft')
      OR EXISTS (
        SELECT 1 FROM valuations v WHERE v.id = e.valuation_id AND v.archived_at IS NOT NULL
      )
    )`;
  /*
   * Whether a hold covers this message — and, for a user hold, by address as
   * well as by account.
   *
   * `to_user_id` is nullable and is null for every message the platform sent
   * to somebody who did not have an account at the time. The invitation mail
   * is the whole class: `sendInviteEmail` (routes/adminUsers.ts) addresses
   * `invitation.email`, because the account it invites them to make does not
   * exist yet. It is also the message that says who invited them, to what
   * role, and carries the link they used — and once they accept, it is
   * correspondence with a person who now has an id that a hold can name.
   *
   * Matched on `to_user_id` alone, no user-scoped hold reached it. "Freeze
   * everything about this person" deleted their invitation on the next sweep
   * while the hold sat there active, which is the one failure a legal hold
   * exists to prevent — and it did it silently, because the operator-facing
   * "how much is your hold holding" count is this same predicate.
   *
   * The address is the other half of the identity here, exactly as it is for
   * the access request: `email_suppressions` and `contact_submissions` are
   * both reached through it by `buildPersonalDataExport`, for the same reason.
   * `ON DELETE SET NULL` on the FK makes the point from the other side — the
   * column is explicitly allowed to stop naming the recipient while
   * `to_email` still does.
   *
   * `lower()` on both sides because neither is normalised: `users.email` is
   * matched case-insensitively everywhere (`findUserByEmail`), and
   * `enqueueEmail` stores `to_email` as the caller handed it over. The cost is
   * a primary-key lookup on `users` per active user-scoped hold per candidate
   * row, and only when such a hold exists at all — the outer EXISTS finds
   * nothing to expand when the hold list is empty, which is every deployment
   * that has not placed one.
   */
  const frozen = `EXISTS (
    SELECT 1 FROM legal_holds h
     WHERE h.active
       AND (h.scope = 'global'
         OR (h.scope = 'user' AND (
              h.reference_id = e.to_user_id
              OR EXISTS (
                SELECT 1 FROM users hu
                 WHERE hu.id = h.reference_id
                   AND lower(hu.email) = lower(e.to_email))))
         OR (h.scope = 'valuation' AND h.reference_id = e.valuation_id))
  )`;

  // Counted before the delete and over the whole eligible set rather than the
  // batch, because this number is the operator-facing one: "how much is your
  // hold holding" is not a question about how far through the backlog we are.
  const { rows: heldRows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM email_outbox e WHERE ${eligible} AND ${frozen}`,
    [String(retentionDays), EMAIL_MAX_ATTEMPTS],
  );

  const { rows } = await pool.query<{ id: string }>(
    `DELETE FROM email_outbox
      WHERE id IN (
        SELECT e.id FROM email_outbox e
         WHERE ${eligible}
           AND NOT ${frozen}
         ORDER BY e.created_at ASC
         LIMIT $3
      )
      RETURNING id`,
    [String(retentionDays), EMAIL_MAX_ATTEMPTS, Math.min(Math.max(limit, 1), OUTBOX_PURGE_BATCH)],
  );
  return { ids: rows.map((r) => r.id), skippedHold: Number(heldRows[0]!.count) };
}

/**
 * Candidate valuations for archival: older than `cutoffDays`, not already
 * archived, with each candidate's active-hold flag pre-computed so the sweep
 * can skip frozen records without a per-row query.
 */
export async function findArchivableValuations(
  pool: pg.Pool,
  cutoffDays: number,
  limit = 500,
): Promise<Array<{ id: string; user_id: string; frozen: boolean }>> {
  const { rows } = await pool.query<{ id: string; user_id: string; frozen: boolean }>(
    `SELECT v.id, v.user_id,
            EXISTS (
              SELECT 1 FROM legal_holds h
               WHERE h.active
                 AND (h.scope = 'global'
                   OR (h.scope = 'valuation' AND h.reference_id = v.id)
                   OR (h.scope = 'user' AND h.reference_id = v.user_id))
            ) AS frozen
       FROM valuations v
      WHERE v.archived_at IS NULL
        AND v.created_at < now() - ($1 || ' days')::interval
      ORDER BY v.created_at ASC
      LIMIT $2`,
    [String(cutoffDays), limit],
  );
  return rows;
}

/**
 * Archive a whole batch in one statement, and report which rows it actually
 * took — `RETURNING id` and not the input list, because `archived_at IS NULL`
 * can already have stopped being true for a candidate between the SELECT that
 * found it and this UPDATE. The sweep counts and logs what came back, so a row
 * archived by a concurrent pass is not counted twice.
 *
 * The cache is invalidated per returned id for the same reason: entries are
 * keyed by valuation, and a row this call did not change has not gone stale.
 *
 * `Queryable`, not `pg.Pool`: the sweep runs this and `recordActions` in one
 * transaction, because the action log is the record of exactly this change and
 * the standing rule for such a pair is that they land together. Hard-typing it
 * to the pool is what stopped that — see the note on `Queryable` itself. A
 * caller passing a client is also invalidating before its own COMMIT, which is
 * the conservative direction (a rollback leaves entries that were never stale
 * merely re-read) but leaves a commit-width window in which a concurrent read
 * can repopulate; the sweep closes it by invalidating again afterwards.
 */
export async function markValuationsArchived(db: Queryable, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<{ id: string }>(
    `UPDATE valuations SET archived_at = now()
      WHERE id = ANY($1) AND archived_at IS NULL
      RETURNING id`,
    [[...new Set(ids)]],
  );
  for (const row of rows) invalidateValuation(row.id);
  return rows.map((row) => row.id);
}
