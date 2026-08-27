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
import type { EventActor } from '../events/record.js';
import type { ValuationHub } from '../realtime/hub.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import { forbidden } from '../domain/accessProblem.js';

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
  valuation_id: z.string().optional(),
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
    return reply.status(201).send({ comment: toPublicComment(comment) });
  });

  app.patch('/api/v1/comments/:commentId', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { commentId } = req.params as { commentId: string };
    const comment = await loadEditable(deps.pool, principal, commentId);

    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid patch', parsed.error);
    if (parsed.data.pinned !== undefined && comment.kind !== 'note')
      throw problems.unprocessable('Only sticky notes can be pinned');

    const updated = await updateComment(deps.pool, commentId, parsed.data);
    return { comment: toPublicComment(updated ?? comment) };
  });

  app.delete('/api/v1/comments/:commentId', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { commentId } = req.params as { commentId: string };
    await loadEditable(deps.pool, principal, commentId);
    await deleteComment(deps.pool, commentId);
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
   * idempotent.
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
        subject: `Unmatched inbound email: ${email.subject}`.slice(0, 300),
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
    if (created) deps.hub?.broadcast(valuation.id, 'comment', { comment_id: comment.id, kind: comment.kind });
    return reply.status(created ? 201 : 200).send({
      comment: toPublicComment(comment),
      valuation_id: valuation.id,
      created,
    });
  });
}
