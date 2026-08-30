import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { CommentKind } from '../domain/operations.js';
import { CLIENT_MESSAGE_ROLES } from '../domain/roles.js';
import { sliceChars } from '../domain/textSlice.js';
import { createNotifications } from '../repos/notifications.js';
import { channelsFor, preferenceOverrides } from '../repos/notificationPreferences.js';
import { findUsersByIds, listUserIdsWithRoles } from '../repos/users.js';

/**
 * Somebody has to be told a message arrived on an engagement thread.
 *
 * Every other inbound message on this platform announces itself. A state
 * change fires `onStateChanged`, an auditor's note fans out to the reviewer
 * and `AUDITOR_NOTE_ROLES`, a failed renewal reaches the billing admins. The
 * engagement thread — the one place a client and their analyst actually talk —
 * announced itself to nobody. `POST /valuations/:id/comments` wrote the row,
 * bumped `last_comment_at`, broadcast an SSE frame to whoever already had that
 * detail page open, and returned 201. `POST /inbox/email` did the same for a
 * client's *reply by email*.
 *
 * So the analyst's question sat in a tab the client had no reason to open, and
 * the client's answer sat in a thread the analyst had no reason to re-read.
 * The platform's own copy admits it: the `waiting_on_client` drip says "Open
 * the valuation and check the comments — the analyst has left the question
 * there", which is a message sent 48 hours later, gated on somebody having set
 * a flag, telling the client to go and look for the thing they should have
 * been told about. Two module docs — this route's own and the shared inbox's —
 * state that this endpoint "owns the mention parsing", and there is no mention
 * parsing anywhere in the service: migration 0089 created `comment_mentions`
 * and nothing has ever written a row to it. The @mention is still absent; what
 * is added here is the notification the plain message always owed.
 *
 * Who hears it is decided by which side spoke, and it is deliberately one
 * person rather than a group:
 *
 *   * A client's `chat` goes to the assigned reviewer, whose file it is. On an
 *     engagement with nobody assigned it goes to `CLIENT_MESSAGE_ROLES`, which
 *     is the same reasoning `AUDITOR_NOTE_ROLES` is built on — an unassigned
 *     file must not be the case where a client's message lands nowhere.
 *   * Anyone else's `chat` goes to the engagement owner. That is the analyst
 *     answering, and the owner is the person who asked.
 *   * A `note` is internal (`visibleCommentKinds`), so it goes to the assigned
 *     reviewer and to nobody else. Sending the owner a notification whose body
 *     quotes a comment the API would refuse to show them is a disclosure, not
 *     a courtesy.
 *   * An inbound `email` is also ops-only, and is routed like a client `chat`:
 *     the client wrote it, so it goes to the reviewer or the fallback roles.
 *
 * The author is removed from the set afterwards rather than special-cased in
 * each branch. An analyst who is also the engagement's owner — which internal
 * engagements routinely are — would otherwise be notified about their own
 * message, and a self-notification is how a reader learns to ignore the whole
 * list.
 */

export const COMMENT_NOTIFICATION_TYPE = 'comment_posted';

/** How much of the message rides on the notification body. */
const EXCERPT_CHARS = 300;

export interface CommentedValuation {
  id: string;
  number: string;
  company_name: string;
  user_id: string;
  assigned_reviewer_id: string | null;
}

export interface PostedComment {
  id: string;
  kind: CommentKind;
  author_id: string | null;
  body: string;
  email_meta?: { from?: string } | null;
}

export interface CommentNotificationDeps {
  pool: pg.Pool;
  log?: FastifyBaseLogger;
}

/**
 * Announce a comment that has already been written.
 *
 * Contained for the reason every other post-commit announcement on this
 * service is: the row is durable and the SSE frame has gone out by the time
 * this runs, so a failure here cannot un-write the message — but returning it
 * to the caller would answer 5xx for a comment that was in fact stored, and
 * the obvious response to that is to post it again.
 */
export async function notifyCommentPosted(
  deps: CommentNotificationDeps,
  valuation: CommentedValuation,
  comment: PostedComment,
): Promise<void> {
  try {
    await deliver(deps, valuation, comment);
  } catch (err) {
    deps.log?.warn(
      { err, valuationId: valuation.id, commentId: comment.id, kind: comment.kind },
      'comment notification failed; the comment stands and nobody was told',
    );
  }
}

/** The user ids this comment is addressed to, before liveness and preferences. */
async function audienceFor(
  pool: pg.Pool,
  valuation: CommentedValuation,
  comment: PostedComment,
): Promise<Set<string>> {
  const reviewerId = valuation.assigned_reviewer_id;
  const fromClient = comment.kind === 'email' || comment.author_id === valuation.user_id;

  if (comment.kind === 'note') return new Set(reviewerId ? [reviewerId] : []);
  if (!fromClient) return new Set([valuation.user_id]);
  if (reviewerId) return new Set([reviewerId]);
  return new Set(await listUserIdsWithRoles(pool, CLIENT_MESSAGE_ROLES));
}

function titleFor(kind: CommentKind, label: string): string {
  if (kind === 'note') return `New internal note on ${label}`;
  if (kind === 'email') return `New email on ${label}`;
  return `New message on ${label}`;
}

async function deliver(
  deps: CommentNotificationDeps,
  valuation: CommentedValuation,
  comment: PostedComment,
): Promise<void> {
  const audience = await audienceFor(deps.pool, valuation, comment);
  // After the branches, not inside them: see the note above on self-notification.
  if (comment.author_id) audience.delete(comment.author_id);
  if (audience.size === 0) return;

  // One read for the recipients and the author's display name. Deactivated
  // accounts drop out here — `findUsersByIds` applies the soft delete, which is
  // the whole point of deactivating an account.
  const wanted = [...audience];
  const users = await findUsersByIds(deps.pool, comment.author_id ? [...wanted, comment.author_id] : wanted);
  const live = wanted.filter((id) => users.has(id));
  if (live.length === 0) return;

  const prefs = await preferenceOverrides(deps.pool, live);
  const recipients = live.filter((id) => channelsFor(prefs, id, COMMENT_NOTIFICATION_TYPE).in_app);
  if (recipients.length === 0) return;

  const author = comment.author_id ? users.get(comment.author_id) : undefined;
  const authorName =
    [author?.first_name, author?.last_name].filter(Boolean).join(' ').trim() ||
    author?.email ||
    comment.email_meta?.from ||
    null;

  // `sliceChars` and not `slice`: a message ending in an emoji is a message,
  // and a cut through its surrogate pair is a string Postgres stores as U+FFFD
  // (domain/textSlice.ts).
  const excerpt = sliceChars(comment.body.trim().replace(/\s+/g, ' '), EXCERPT_CHARS);
  const label = `${valuation.number} — ${valuation.company_name}`;
  const title = titleFor(comment.kind, label);
  const body = authorName ? `${authorName}: ${excerpt}` : excerpt;

  await createNotifications(
    deps.pool,
    recipients.map((userId) => ({
      userId,
      valuationId: valuation.id,
      type: COMMENT_NOTIFICATION_TYPE,
      title,
      body,
    })),
  );
}
