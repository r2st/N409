import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';
import { OPERATIONS_EVENT_TYPES, type CommentKind } from '../domain/operations.js';
import type { ValuationEventType } from '../domain/auditTrail.js';
import { invalidateValuationAfter } from './valuations.js';

export interface CommentRow {
  id: string;
  valuation_id: string;
  kind: CommentKind;
  author_id: string | null;
  body: string;
  email_meta: { from?: string; subject?: string; message_id?: string } | null;
  pinned: boolean;
  created_at: Date;
  updated_at: Date;
  /** joined for display */
  author_name?: string | null;
  author_email?: string | null;
}

const SELECT_WITH_AUTHOR = `
  SELECT c.*,
         nullif(trim(concat(u.first_name, ' ', u.last_name)), '') AS author_name,
         u.email AS author_email
  FROM valuation_comments c
  LEFT JOIN users u ON u.id = c.author_id`;

/**
 * The cap on one engagement's thread.
 *
 * Comments are three things at once: the chat panel, the analyst's private
 * notes, and every inbound email ingested against the engagement. The last is
 * why this needed a bound — an auto-responder in a loop with a shared inbox
 * writes rows as fast as it can be replied to, and nothing here counted them.
 *
 * The cap takes the *newest* end while keeping the thread in reading order, and
 * pinned comments are exempt from the cut, because a pinned comment is the one
 * somebody marked as the thing not to lose. The evidence bundle reads this list
 * too and records when it was short, so an auditor is never handed a
 * correspondence file that quietly stops.
 */
export const COMMENT_PAGE_LIMIT = 5000;

export async function listComments(
  pool: pg.Pool,
  valuationId: string,
  kinds: ReadonlySet<CommentKind>,
  opts: { limit?: number } = {},
): Promise<{ comments: CommentRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? COMMENT_PAGE_LIMIT, 1), COMMENT_PAGE_LIMIT);
  // Newest first *in SQL*, so what the cap drops is the oldest end of the
  // thread. Ordering ascending and taking a LIMIT would do the opposite — keep
  // the first 5000 messages ever sent and lose the live conversation.
  const { rows } = await pool.query<CommentRow>(
    `${SELECT_WITH_AUTHOR}
     WHERE c.valuation_id = $1 AND c.kind = ANY($2)
     ORDER BY c.pinned DESC, c.created_at DESC
     LIMIT $3`,
    [valuationId, [...kinds], limit + 1],
  );
  // Re-sorted after the cut, not before it: the reading order the panel and the
  // bundle want is oldest-first, and re-sorting in SQL would put the row that
  // signals truncation somewhere in the middle of the page.
  const comments = rows.slice(0, limit).sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.created_at.getTime() - b.created_at.getTime();
  });
  return { comments, truncated: rows.length > limit };
}

export async function findCommentById(pool: pg.Pool, id: string): Promise<CommentRow | null> {
  const { rows } = await pool.query<CommentRow>(`${SELECT_WITH_AUTHOR} WHERE c.id = $1`, [id]);
  return rows[0] ?? null;
}

export interface CreateCommentInput {
  valuationId: string;
  kind: CommentKind;
  authorId: string | null;
  body: string;
  pinned?: boolean;
  emailMeta?: { from?: string; subject?: string; message_id?: string };
  /**
   * What the audit trail should call this, when the kind is not the whole story.
   *
   * `kind` says how the message reaches the thread — `email` is the vocabulary
   * for a correspondent with no account — and that is what decides visibility
   * and how the thread renders it. It is not always what *happened*: an
   * auditor's note arrives through the same accountless door as an inbound
   * email and is not one, and recording it as `email_received` would put "Email
   * received" in the audit trail of the engagement it was written about.
   *
   * Defaults to the kind's own type, so every existing caller is unchanged.
   */
  eventType?: ValuationEventType;
}

/**
 * Insert + bump valuations.last_comment_at + audit event, atomically.
 * Email ingestion is idempotent on (valuation, message_id): a replay returns
 * the existing row with `created: false` and writes nothing.
 */
export async function createComment(
  pool: pg.Pool,
  input: CreateCommentInput,
  actor: EventActor,
): Promise<{ comment: CommentRow; created: boolean }> {
  // Invalidated after the commit, not after the UPDATE — see
  // `invalidateValuationAfter`. Inside the transaction the drop leaves a window
  // in which a concurrent reader caches the pre-commit row for a full TTL.
  return invalidateValuationAfter(input.valuationId, () =>
    withTransaction(pool, async (client) => {
      const messageId = input.emailMeta?.message_id;
      if (input.kind === 'email' && messageId) {
        const { rows: existing } = await client.query<CommentRow>(
          `SELECT * FROM valuation_comments
         WHERE valuation_id = $1 AND kind = 'email' AND email_meta->>'message_id' = $2`,
          [input.valuationId, messageId],
        );
        if (existing[0]) return { comment: existing[0], created: false };
      }

      const { rows } = await client.query<CommentRow>(
        `INSERT INTO valuation_comments (id, valuation_id, kind, author_id, body, email_meta, pinned)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
        [
          newUlid(),
          input.valuationId,
          input.kind,
          input.authorId,
          input.body,
          input.emailMeta ? JSON.stringify(input.emailMeta) : null,
          input.pinned ?? false,
        ],
      );
      const comment = rows[0]!;
      await client.query('UPDATE valuations SET last_comment_at = now() WHERE id = $1', [input.valuationId]);
      await recordEvent(client, {
        valuationId: input.valuationId,
        type:
          input.eventType ??
          (input.kind === 'email'
            ? OPERATIONS_EVENT_TYPES.emailReceived
            : OPERATIONS_EVENT_TYPES.commentAdded),
        actor,
        payload: {
          comment_id: comment.id,
          kind: input.kind,
          ...(input.emailMeta?.from ? { from: input.emailMeta.from } : {}),
        },
      });
      return { comment, created: true };
    }),
  );
}

/**
 * Rewrite a comment, and say on the spine that it was rewritten (R416, M3).
 *
 * Three verbs act on a comment and two of them reached the audit trail.
 * `createComment` writes `comment_added`; R396 gave the hard `DELETE` its
 * `comment_removed`, on the argument that afterwards the spine names a
 * `comment_id` resolving to no row and does not say the comment was withdrawn
 * or by whom. This is the same act with the row left in place, and it wrote
 * nothing: a `body` of up to twenty thousand characters was replaced and the
 * trail went on showing one `comment_added` at the original time, with the new
 * text sitting beside it.
 *
 * Which is not confined to an analyst's private notes. `kind` decides who sees
 * the thread — the client reads `chat`, and the auditor portal is served the
 * same rows — so a message somebody has already acted on could be silently
 * replaced by a different one. R396's own sentence covers it: an editor "could
 * leave a trail indistinguishable from one where the note is simply not in the
 * page the reader is holding".
 *
 * A save that changes nothing is not an edit. The row is read under the lock
 * the UPDATE takes and the fields are compared first, so a PATCH re-sending the
 * body it already holds moves neither `updated_at` nor the trail — the reading
 * `archiveTemplate` and `setContactSubmissionStatus` take, and the one that
 * keeps a form which re-submits on blur from filling the spine.
 *
 * The event carries the comment's identity and which fields moved, and not the
 * text: `comment_added` has never carried a body, and the spine is not where a
 * superseded one is restored. `pinned` rides with its from/to, being a boolean
 * with nothing in it to withhold.
 *
 * Null when the row is gone — deleted between the caller's read and this write.
 */
export async function updateComment(
  pool: pg.Pool,
  id: string,
  fields: { body?: string; pinned?: boolean },
  actor: EventActor,
): Promise<CommentRow | null> {
  return withTransaction(pool, async (client) => {
    const { rows: locked } = await client.query<CommentRow>(
      'SELECT * FROM valuation_comments WHERE id = $1 FOR UPDATE',
      [id],
    );
    const before = locked[0];
    if (!before) return null;

    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [];
    const changed: string[] = [];
    if (fields.body !== undefined && fields.body !== before.body) {
      params.push(fields.body);
      sets.push(`body = $${params.length}`);
      changed.push('body');
    }
    if (fields.pinned !== undefined && fields.pinned !== before.pinned) {
      params.push(fields.pinned);
      sets.push(`pinned = $${params.length}`);
      changed.push('pinned');
    }
    if (changed.length === 0) return before;

    params.push(id);
    const { rows } = await client.query<CommentRow>(
      `UPDATE valuation_comments SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    const after = rows[0]!;
    await recordEvent(client, {
      valuationId: before.valuation_id,
      type: OPERATIONS_EVENT_TYPES.commentEdited,
      actor,
      payload: {
        comment_id: before.id,
        kind: before.kind,
        author_id: before.author_id,
        posted_at: before.created_at,
        fields: changed,
        ...(changed.includes('pinned')
          ? { changes: { pinned: { from: before.pinned, to: after.pinned } } }
          : {}),
      },
    });
    return after;
  });
}

/**
 * Withdraw a comment, and say on the spine that it was withdrawn (R396, M3).
 *
 * `createComment` records `comment_added` carrying the new row's id. This is a
 * hard `DELETE` — there is no `deleted_at` on this table — so afterwards the
 * spine named a `comment_id` that resolves to no row, and nothing said whether
 * that was a withdrawal or a reader looking at the wrong engagement. An
 * analyst could take their own internal note back out of the working papers
 * and leave a trail on which the removal had not happened.
 *
 * `board_member_removed` beside `board_member_added` is the pair this follows.
 *
 * The row is read under the lock the `DELETE` is about to take, and the event
 * carries what the row held rather than what the caller passed: the author, the
 * kind and when it was posted are exactly the facts nothing can answer once the
 * statement has run — the same reason `deleteOrganization` and
 * `upsertSignature` read before their writes. Not the body: the spine is not
 * where a deleted comment's text is restored, and `comment_added` never carried
 * it either.
 *
 * Returns false without writing anything when the row is already gone, which is
 * the ordinary racing case — two operators on one thread — and not a second
 * withdrawal to record.
 */
export async function deleteComment(pool: pg.Pool, id: string, actor: EventActor): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<CommentRow>(
      'SELECT * FROM valuation_comments WHERE id = $1 FOR UPDATE',
      [id],
    );
    const comment = rows[0];
    if (!comment) return false;
    await client.query('DELETE FROM valuation_comments WHERE id = $1', [id]);
    await recordEvent(client, {
      valuationId: comment.valuation_id,
      type: OPERATIONS_EVENT_TYPES.commentRemoved,
      actor,
      payload: {
        comment_id: comment.id,
        kind: comment.kind,
        author_id: comment.author_id,
        posted_at: comment.created_at,
      },
    });
    return true;
  });
}
