import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { logUnretried } from '@n409/shared';
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
    if (deps.log) {
      logUnretried(
        deps.log,
        err,
        { valuationId: valuation.id, commentId: comment.id, kind: comment.kind },
        'comment notification failed; the comment stands and nobody was told',
      );
    }
  }
}

/** The user ids this comment is addressed to, before liveness and preferences. */
function fromClient(valuation: CommentedValuation, comment: PostedComment): boolean {
  return comment.kind === 'email' || comment.author_id === valuation.user_id;
}

function audienceFor(valuation: CommentedValuation, comment: PostedComment): Set<string> {
  const reviewerId = valuation.assigned_reviewer_id;
  if (comment.kind === 'note') return new Set(reviewerId ? [reviewerId] : []);
  if (!fromClient(valuation, comment)) return new Set([valuation.user_id]);
  if (reviewerId) return new Set([reviewerId]);
  return new Set();
}

/**
 * The addressees that can actually be written to, and the author's row with
 * them.
 *
 * `findUsersByIds` subtracts both of this platform's ways of taking an account
 * away — the soft delete and the `ignored` suspension — so an id read off the
 * engagement row can resolve to nobody. That is the point: neither kind of
 * account should be sent an excerpt of what a client wrote, and a suspended one
 * can still sign in and read the notification list, which is authenticated and
 * nothing more.
 */
async function liveRecipients(
  pool: pg.Pool,
  audience: Set<string>,
  authorId: string | null,
): Promise<{
  ids: string[];
  users: Map<string, { first_name: string | null; last_name: string | null; email: string }>;
}> {
  // After the branches, not inside them: see the note above on self-notification.
  const wanted = [...audience].filter((id) => id !== authorId);
  if (wanted.length === 0) return { ids: [], users: new Map() };
  const users = await findUsersByIds(pool, authorId ? [...wanted, authorId] : wanted);
  return { ids: wanted.filter((id) => users.has(id)), users };
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
  const authorId = comment.author_id ?? null;
  // One read for the recipients and the author's display name.
  let { ids: live, users } = await liveRecipients(deps.pool, audienceFor(valuation, comment), authorId);

  /**
   * The client's message must not land nowhere.
   *
   * `CLIENT_MESSAGE_ROLES` was reached only when the engagement named no
   * reviewer at all, which reads the assignment column as the answer to "is
   * there somebody to tell". It is not: the column records who was assigned,
   * not whether they still work here or still have access. A reviewer who has
   * been deactivated or suspended since resolves to an empty set, and the
   * branch that exists precisely for "an unassigned file must not be the case
   * where a client's message lands nowhere" never ran — so the file with a
   * departed reviewer was exactly that case, and silently.
   *
   * Asked after liveness rather than before, because the assignment is still
   * the right answer whenever the assignee can be reached; this is the fallback
   * for when they cannot. Deliberately not extended to a `note`: an internal
   * note goes to the reviewer or to nobody, and widening it to the three
   * administrative roles would put a comment the API refuses to show the owner
   * in front of a larger audience on the strength of an account being closed.
   */
  if (live.length === 0 && fromClient(valuation, comment)) {
    const fallback = new Set(await listUserIdsWithRoles(deps.pool, CLIENT_MESSAGE_ROLES));
    ({ ids: live, users } = await liveRecipients(deps.pool, fallback, authorId));
  }
  /*
   * Nobody left to tell, said out loud (round 360, methodology M5).
   *
   * The fallback above exists because "a client's message must not land
   * nowhere" — and when the fallback *itself* resolves to nobody, this returned
   * in exactly the silence that rule was written against. `POST /comments`
   * still answered 201, the SSE frame still went out to whoever had the tab
   * open, and the only record that a client's question reached no human at all
   * was its absence from a notification list.
   *
   * Reachable in one deployment shape and one accident: every `admin` / `god` /
   * `supervisor` account soft-deleted or `ignored` (`findUsersByIds` subtracts
   * both), and an engagement whose owner has been closed since. The first is
   * the small firm whose one administrator left; the second is ordinary.
   *
   * `alert` only for a client's message, which is the half with somebody
   * waiting on the other end. An internal `note` on a file whose reviewer has
   * gone reaching nobody is the documented behaviour of the branch above — it
   * is still worth a line, because the note's author believes it was
   * delivered, but it is not worth waking anyone.
   */
  if (live.length === 0) {
    deps.log?.warn(
      {
        valuationId: valuation.id,
        commentId: comment.id,
        kind: comment.kind,
        fromClient: fromClient(valuation, comment),
        alert: fromClient(valuation, comment),
      },
      'comment notification reached nobody — every intended recipient is closed or suspended',
    );
    return;
  }

  const prefs = await preferenceOverrides(deps.pool, live);
  const recipients = live.filter((id) => channelsFor(prefs, id, COMMENT_NOTIFICATION_TYPE).in_app);
  if (recipients.length === 0) return;

  const author = authorId ? users.get(authorId) : undefined;
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
