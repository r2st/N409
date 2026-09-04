import type { FastifyInstance } from 'fastify';
import { stateLabel } from '../domain/valuation.js';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { decisionTarget, REVIEW_DECISIONS } from '../domain/workflow.js';
import { withTransaction } from '../db/pool.js';
import { recordEvent } from '../events/record.js';
import { createComment } from '../repos/comments.js';
import { listReviewQueue } from '../repos/reviews.js';
import { findValuationById, patchValuation } from '../repos/valuations.js';
import { assertPublishGate, assertPublishGateForWrite } from '../domain/publishGate.js';
import { onStateChanged, type EmailTransport, type TransitionRenderDeps } from '../hooks/stateChange.js';
import { requirePrincipal } from '../plugins/auth.js';
import { assigneeFilter } from '../domain/assignee.js';
import { pageParam } from '../domain/pagination.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';

/**
 * P1 #6 — the review workflow's verbs. "Approve" and "request changes" wrap
 * the workflow engine's legal transitions so the decision, the optional
 * comment, and the audit event land together instead of as three separate
 * calls a reviewer has to know to compose.
 */

const DecisionBody = z.object({
  decision: z.enum(REVIEW_DECISIONS),
  comment: z.string().min(1).max(20_000).optional(),
});

const QueueQuery = z.object({
  assignee: assigneeFilter().optional(),
  page: pageParam(),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('Review actions are operations-only');
}

export function registerReviewRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; transport?: EmailTransport } & TransitionRenderDeps,
): void {
  /** The queue of valuations awaiting a review decision, with signature rollups. */
  app.get('/api/v1/reviews', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const parsed = QueueQuery.safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error);
    const q = parsed.data;

    const { items, total } = await listReviewQueue(deps.pool, {
      reviewerId: q.assignee === 'me' ? principal.id : q.assignee,
      page: q.page,
      perPage: q.per_page,
    });
    return { reviews: items, page: q.page, per_page: q.per_page, total };
  });

  app.post('/api/v1/valuations/:id/review/decision', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    refuseIfRetired(valuation, 'accepting review decisions');

    const parsed = DecisionBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid decision', parsed.error);
    const { decision, comment } = parsed.data;

    const target = decisionTarget(valuation.state, decision);
    if (!target) {
      throw problems.conflict(
        `This valuation is “${stateLabel(valuation.state)}”, which is not awaiting a review ` +
          'decision. Only one in review can be accepted or sent back.',
      );
    }

    await assertPublishGate(deps.pool, valuation.id, target);
    const actor = { actorType: 'human' as const, actorId: principal.id, source: 'review' };
    /*
     * `target` was derived from the state this route read, so the write has to
     * be conditional on the row still being at it — the same rule, and the same
     * one line, as every other derived transition (`applyValuationState`).
     *
     * A review decision is the transition most likely to be issued twice. The
     * button is on a queue two reviewers work at once, the decision carries a
     * comment so the request is slow enough to overlap, and both duplicates
     * looked like successes: two reviewers approving one `drafted` file both
     * read `drafted`, both wrote `draft_accepted`, and the spine recorded two
     * `state_changed` events and two `review_decision`s for one move, with
     * `onStateChanged` firing the client's email twice. The sharper version is
     * the disagreement — an approve and a request-changes crossing — where the
     * later write silently overwrote the earlier decision at whatever state it
     * had reached.
     */
    const updated = await patchValuation(deps.pool, valuation, { state: target }, actor, {
      expectedVersion: valuation.version,
      preCommit: assertPublishGateForWrite(valuation.id, target),
    });

    let commentId: string | null = null;
    if (comment) {
      const { comment: created } = await createComment(
        deps.pool,
        { valuationId: id, kind: 'note', authorId: principal.id, body: comment },
        actor,
      );
      commentId = created.id;
    }
    await withTransaction(deps.pool, (client) =>
      recordEvent(client, {
        valuationId: id,
        type: 'review_decision',
        actor,
        payload: {
          decision,
          from: valuation.state,
          to: target,
          ...(commentId ? { comment_id: commentId } : {}),
        },
      }),
    );
    await onStateChanged(
      {
        pool: deps.pool,
        transport: deps.transport,
        log: app.log,
        publicBaseUrl: deps.publicBaseUrl,
        settings: deps.settings,
      },
      updated,
      target,
    );
    return { valuation: updated, decision };
  });
}
