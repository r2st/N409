import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';
import { OPERATIONS_EVENT_TYPES, type CommentKind } from '../domain/operations.js';
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
          input.kind === 'email' ? OPERATIONS_EVENT_TYPES.emailReceived : OPERATIONS_EVENT_TYPES.commentAdded,
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

export async function updateComment(
  pool: pg.Pool,
  id: string,
  fields: { body?: string; pinned?: boolean },
): Promise<CommentRow | null> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  if (fields.body !== undefined) {
    params.push(fields.body);
    sets.push(`body = $${params.length}`);
  }
  if (fields.pinned !== undefined) {
    params.push(fields.pinned);
    sets.push(`pinned = $${params.length}`);
  }
  params.push(id);
  const { rows } = await pool.query<CommentRow>(
    `UPDATE valuation_comments SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );
  return rows[0] ?? null;
}

export async function deleteComment(pool: pg.Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM valuation_comments WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}
