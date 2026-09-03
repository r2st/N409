import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, type Principal } from '../auth/rbac.js';
import { canEditComment, canIngestEmail, canPostComment, visibleCommentKinds } from '../auth/operations.js';
import { parseEmailSubjectRef, type CommentKind } from '../domain/operations.js';
import {
  COMMENT_PAGE_LIMIT,
  createComment,
  deleteComment,
  findCommentById,
  listComments,
  updateComment,
  type CommentRow,
} from '../repos/comments.js';
import {
  findLatestValuationByOwnerEmail,
  findValuationById,
  findValuationByNumber,
  type ValuationRow,
} from '../repos/valuations.js';
import { createSupportMessage } from '../repos/support.js';
import { EmailAddress } from '../domain/email.js';
import { requirePrincipal } from '../plugins/auth.js';
import { sliceChars } from '../domain/textSlice.js';
import type { EventActor } from '../events/record.js';
import type { ValuationHub } from '../realtime/hub.js';
import { refuseIfRetired, refuseIfSubjectRetired } from '../domain/retiredEngagement.js';
import { notifyCommentPosted } from '../hooks/commentNotifications.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { forbidden } from '../domain/accessProblem.js';
import { ulidField } from '../domain/ulidField.js';

const PostBody = z.object({
  kind: z.enum(['chat', 'note']),
  body: z.string().min(1).max(20_000),
  pinned: z.boolean().optional(),
});

const PatchBody = z
  .object({
    body: z.string().min(1).max(20_000),
    pinned: z.boolean(),
  })
  .partial()
  .strict();

const InboxBody = z.object({
  from: EmailAddress,
  subject: z.string().max(1000).default(''),
  body: z.string().min(1).max(100_000),
  message_id: z.string().max(500).optional(),
  /** Explicit routing wins over subject/sender matching. */
  valuation_id: ulidField().optional(),
});

function actorFor(principal: Principal): EventActor {
  return { actorType: 'human', actorId: principal.id, source: 'api' };
}

async function loadReadable(pool: pg.Pool, principal: Principal, id: string): Promise<ValuationRow> {
  if (!isUlid(id)) throw problems.notFound();
  const valuation = await findValuationById(pool, id);
  if (
    !valuation ||
    !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
  )
    throw problems.notFound();
  return valuation;
}

/** Strip internal metadata for non-ops readers (author email stays: it's their thread). */
function toPublicComment(c: CommentRow) {
  return {
    id: c.id,
    valuation_id: c.valuation_id,
    kind: c.kind,
    author_id: c.author_id,
    author_name: c.author_name ?? null,
    author_email: c.author_email ?? null,
    body: c.body,
    email_meta: c.email_meta,
    pinned: c.pinned,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

/**
 * M3 features 10 + 11: per-valuation client chat, internal sticky notes, and
 * inbound-email threading.
 */
export function registerCommentRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; hub?: ValuationHub },
): void {
  app.get('/api/v1/valuations/:id/comments', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await loadReadable(deps.pool, principal, id);

    const query = z
      .object({
        kind: z.enum(['chat', 'note', 'email']).optional(),
        limit: z.coerce.number().int().min(1).max(COMMENT_PAGE_LIMIT).default(COMMENT_PAGE_LIMIT),
      })
      .safeParse(req.query ?? {});
    if (!query.success) throw invalidQuery(query.error);

    let kinds = visibleCommentKinds(principal);
    if (query.data.kind) {
      if (!kinds.has(query.data.kind)) throw forbidden('Reading that comment thread', 'ops');
      kinds = new Set<CommentKind>([query.data.kind]);
    }
    const { comments, truncated } = await listComments(deps.pool, id, kinds, {
      limit: query.data.limit,
    });
    return { comments: comments.map(toPublicComment), truncated, page_limit: COMMENT_PAGE_LIMIT };
  });

  app.post('/api/v1/valuations/:id/comments', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(deps.pool, principal, id);
    refuseIfRetired(valuation, 'accepting comments');

    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid comment', parsed.error);
    const { kind, body, pinned } = parsed.data;

    if (!canPostComment(principal, { userId: valuation.user_id, partnerId: valuation.partner_id }, kind))
      throw forbidden('Posting that kind of comment', 'ops');
    if (pinned && kind !== 'note') throw problems.unprocessable('Only sticky notes can be pinned');

    const { comment } = await createComment(
      deps.pool,
      { valuationId: id, kind, authorId: principal.id, body, pinned },
      actorFor(principal),
    );
    // Improvement 4 — live thread updates on open detail pages. Only the id
    // and kind ride on the wire; each viewer re-fetches through its own
    // RBAC'd comment list, so nothing invisible leaks.
    deps.hub?.broadcast(id, 'comment', { comment_id: comment.id, kind: comment.kind });
    // The SSE frame reaches whoever already has this page open; the
    // notification reaches the person who does not.
    await notifyCommentPosted({ pool: deps.pool, log: req.log }, valuation, comment);
    return reply.status(201).send({ comment: toPublicComment(comment) });
  });

  app.patch('/api/v1/comments/:commentId', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { commentId } = req.params as { commentId: string };
    const comment = await loadEditable(deps.pool, principal, commentId);
    // Same pair, same gap as `PATCH /tasks/:id`: posting a comment is under a
    // valuation id and has been refused on withdrawn work since R89, while
    // editing one is addressed by the comment's own id and was not. Deleting
    // stays open by the standing cleanup exemption.
    await refuseIfSubjectRetired(deps.pool, comment, 'accepting changes to its comments');

    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid patch', parsed.error);
    if (parsed.data.pinned !== undefined && comment.kind !== 'note')
      throw problems.unprocessable('Only sticky notes can be pinned');

    const updated = await updateComment(deps.pool, commentId, parsed.data);
    // The same frame the post above sends, for the same reason (R396, M3).
    // Three doors *create* a comment and all three broadcast; the two that
    // change one after the fact broadcast from nowhere, and the thread is the
    // one surface on this platform that is pushed rather than polled. So an
    // edit reached only the tab that made it: every other open workspace went
    // on showing the superseded body, with no tick to re-fetch on and nothing
    // to say it was stale — until a navigation, which on a page people leave
    // open all day is measured in hours.
    //
    // Carries no body, exactly as the post's frame carries none: consumers
    // re-fetch the thread through their own RBAC'd list, so a viewer entitled
    // to the id is not thereby handed the text.
    deps.hub?.broadcast(comment.valuation_id, 'comment', {
      comment_id: commentId,
      kind: comment.kind,
    });
    return { comment: toPublicComment(updated ?? comment) };
  });

  app.delete('/api/v1/comments/:commentId', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { commentId } = req.params as { commentId: string };
    const comment = await loadEditable(deps.pool, principal, commentId);
    const removed = await deleteComment(deps.pool, commentId);
    // Worse than the edit above, and the reason this pair is one fix: a
    // withdrawn sticky note stayed *readable* on every other open workspace,
    // and a note is withdrawn precisely when it should stop being read —
    // wrong, superseded, or said in front of the wrong audience. The frame is
    // what removes it; the row being gone does nothing on its own, because
    // nothing re-asks.
    //
    // Gated on the delete having removed a row: two operators deleting the
    // same comment must not put two ticks on every open thread, and the second
    // one is reporting nothing that happened.
    if (removed) {
      deps.hub?.broadcast(comment.valuation_id, 'comment', {
        comment_id: commentId,
        kind: comment.kind,
      });
    }
    return reply.status(204).send();
  });

  async function loadEditable(pool: pg.Pool, principal: Principal, commentId: string): Promise<CommentRow> {
    if (!isUlid(commentId)) throw problems.notFound();
    const comment = await findCommentById(pool, commentId);
    if (!comment) throw problems.notFound();
    // must still be able to see the valuation AND this comment kind
    await loadReadable(pool, principal, comment.valuation_id);
    if (!visibleCommentKinds(principal).has(comment.kind)) throw problems.notFound();
    if (!canEditComment(principal, comment)) throw forbidden('Editing this comment', 'own-record');
    return comment;
  }

  /**
   * Feature 10 — email inbox → comment threading. The mail relay (an ops
   * 'auto' service account) posts parsed inbound mail here; the valuation is
   * resolved from an explicit id, a ULID or "#123" in the subject, or the
   * sender's most recent engagement. Replays of the same message_id are
   * idempotent, and only a first arrival notifies.
   */
  app.post('/api/v1/inbox/email', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    if (!canIngestEmail(principal)) throw forbidden('Ingesting an inbound email', 'ops');

    const parsed = InboxBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid email', parsed.error);
    const email = parsed.data;

    let valuation: ValuationRow | null = null;
    if (email.valuation_id) {
      valuation = isUlid(email.valuation_id) ? await findValuationById(deps.pool, email.valuation_id) : null;
    } else {
      const ref = parseEmailSubjectRef(email.subject);
      if (ref.id) valuation = await findValuationById(deps.pool, ref.id);
      else if (ref.number) valuation = await findValuationByNumber(deps.pool, ref.number);
      if (!valuation) valuation = await findLatestValuationByOwnerEmail(deps.pool, email.from);
    }
    // Catch-all (gap 3): an unmatched email lands in the support inbox for
    // manual routing instead of bouncing with a 422.
    if (!valuation) {
      const ticket = await createSupportMessage(deps.pool, {
        userId: principal.id,
        // `sliceChars`, not `slice`: an inbound subject is remote text that
        // reached here whole — the boundary hook refuses an unpaired surrogate
        // in a request body — and a cut at 300 UTF-16 units is this service
        // creating one of its own, which `support_messages.subject` then
        // stores as `U+FFFD`. See domain/textSlice.ts.
        subject: sliceChars(`Unmatched inbound email: ${email.subject}`, 300),
        body:
          `From: ${email.from}\n` +
          (email.message_id ? `Message-Id: ${email.message_id}\n` : '') +
          `\n${email.body}`,
        pagePath: 'inbox:email',
      });
      return reply.status(202).send({ matched: false, support_message_id: ticket.id });
    }

    const { comment, created } = await createComment(
      deps.pool,
      {
        valuationId: valuation.id,
        kind: 'email',
        authorId: null,
        body: email.body,
        emailMeta: {
          from: email.from,
          subject: email.subject,
          ...(email.message_id ? { message_id: email.message_id } : {}),
        },
      },
      { actorType: 'system', actorId: principal.id, source: 'inbox' },
    );
    // Both guarded on `created`: an ingest replay of the same `message_id`
    // returns the row it already stored, and re-announcing it would notify the
    // reviewer once per redelivery of a mail the client sent once.
    if (created) {
      deps.hub?.broadcast(valuation.id, 'comment', { comment_id: comment.id, kind: comment.kind });
      await notifyCommentPosted({ pool: deps.pool, log: req.log }, valuation, comment);
    }
    return reply.status(created ? 201 : 200).send({
      comment: toPublicComment(comment),
      valuation_id: valuation.id,
      created,
    });
  });
}
