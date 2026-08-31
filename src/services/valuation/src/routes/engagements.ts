import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { listEvents } from '../events/record.js';
import { requirePrincipal } from '../plugins/auth.js';
import { sendTransactionalEmail } from '../email/transactional.js';
import type { EmailTransport } from '../hooks/stateChange.js';
import {
  analystChaseBlock,
  analystIsChasable,
  ENGAGEMENT_EVENT_TYPES,
  ENGAGEMENT_STAGES,
  planStageTransition,
  slaStatus,
  stageDurations,
  type StageTransitionRefusal,
} from '../domain/engagement.js';
import {
  advanceStage,
  assignAnalyst,
  eachActiveEngagement,
  ENGAGEMENT_PAGE_LIMIT,
  ensureEngagement,
  findEngagement,
  listActiveEngagements,
  stageHistory,
  type EngagementRow,
} from '../repos/engagements.js';
import { findUserById } from '../repos/users.js';
import { recordEvent } from '../events/record.js';
import { withTransaction } from '../db/pool.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody, invalidQuery } from '../domain/validationProblem.js';
import type { SupportEmailSource } from '../hooks/autoEmails.js';

/**
 * Engagement lifecycle management (feature 8). Ops-only: track the stage an
 * engagement is in, its SLA status, expected-vs-actual per-stage timing, an
 * activity feed, and a pipeline dashboard across all active engagements. Also
 * emails the assigned analyst when a stage is overdue.
 */

const AdvanceBody = z.object({
  stage: z.string().max(60).optional(),
  /**
   * Say that this move is taking the engagement back out of `complete`.
   * Required for that direction and meaningless in any other — see
   * `planStageTransition` for why the flag exists rather than a flat refusal.
   */
  reopen: z.boolean().optional(),
});
const AssignBody = z.object({ analyst_id: z.string().nullable() });

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('Engagement management is operations-only');
}

async function loadValuation(pool: pg.Pool, id: string): Promise<ValuationRow> {
  if (!isUlid(id)) throw problems.notFound();
  const valuation = await findValuationById(pool, id);
  if (!valuation) throw problems.notFound();
  return valuation;
}

/** Rows in the engagement panel's activity feed. */
const ACTIVITY_FEED_LIMIT = 40;

async function engagementView(pool: pg.Pool, engagement: EngagementRow, now: Date) {
  const { history, truncated: historyTruncated } = await stageHistory(pool, engagement.id);
  // The cap belongs in the query, not after it. `.slice(-40)` on an unbounded
  // read selected every event the engagement had ever recorded — payload JSONB
  // and all — and then discarded all but the newest forty, on a table nothing
  // prunes. `listEvents` keeps the newest N in ascending order, which is what
  // the slice was asking for.
  const events = await listEvents(pool, engagement.valuation_id, { limit: ACTIVITY_FEED_LIMIT });
  return {
    engagement,
    sla: slaStatus(engagement.current_stage, engagement.stage_entered_at, now),
    stages: ENGAGEMENT_STAGES,
    durations: stageDurations(history, now),
    // Time-in-stage summed over a page of the trail, so a trail that ran past
    // the cap understates every stage after it.
    durations_truncated: historyTruncated,
    // Activity feed: most-recent-first, capped for the panel.
    activity: events.reverse(),
  };
}

/** The refusal a transition plan turns into on the wire. */
function refuseTransition(reason: StageTransitionRefusal): Error {
  switch (reason) {
    case 'unknown_stage':
      return problems.unprocessable('Unknown engagement stage');
    case 'already_final':
      return problems.conflict('The engagement is already at its final stage');
    case 'same_stage':
      return problems.conflict('The engagement is already at that stage');
    case 'reopen_required':
      return problems.conflict(
        'This engagement is complete. Reopening it puts it back on the pipeline board and back ' +
          'into the overdue-reminder sweep, so it has to be asked for: send "reopen": true.',
      );
  }
}

/**
 * Who may be made the analyst on an engagement.
 *
 * Two things were wrong with accepting any ULID. A non-existent one reached the
 * `assigned_analyst_id` foreign key and came back as a bare 500 — a
 * well-signalled failure answered with nothing a caller can act on. And a real
 * id belonging to a *client* was accepted, which is not a typo the operator
 * gets to find out about later: the overdue sweep emails whoever is assigned,
 * by name, with the company and the internal SLA state — "Overdue: OtherCo is
 * past SLA in Analysis" — so a mis-assignment sends one client's engagement
 * status to an unrelated one.
 *
 * Stricter than the reviewer check on `POST /workflow/reassign`, which only
 * asks that the user exist, and deliberately so: nothing automatically mails a
 * reviewer their queue, and this sweep runs on a timer.
 */
async function assertAssignableAnalyst(pool: pg.Pool, analystId: string): Promise<void> {
  const invalid = (detail: string): Error =>
    problems.unprocessable(detail, { errors: [{ path: ['analyst_id'] }] });
  if (!isUlid(analystId)) throw invalid('Invalid analyst id');
  const user = await findUserById(pool, analystId);
  if (!user) throw invalid('Unknown analyst');
  // `isOps` rather than the role set directly: a suspended (`ignored`) account
  // keeps its `admin`/`reviewer` row, so the bare set says yes to somebody who
  // cannot open the engagement they would be assigned — and the overdue sweep
  // would then mail them a client's SLA state by name every day.
  if (!isOps({ id: user.id, roles: user.roles, partnerId: user.partner_id })) {
    throw invalid('That user is not on the operations team and cannot be assigned as the analyst');
  }
}

/**
 * The engagement panel for a retired valuation whose engagement was never
 * started. `engagement` and `sla` are null rather than a fabricated kickoff:
 * there is no stage, so there is no SLA, and no clock to have been running.
 * The activity feed is still the valuation's, which is the part there is
 * something to look at.
 */
async function unstartedEngagementView(pool: pg.Pool, valuationId: string) {
  return {
    engagement: null,
    sla: null,
    stages: ENGAGEMENT_STAGES,
    durations: [],
    durations_truncated: false,
    activity: (await listEvents(pool, valuationId, { limit: ACTIVITY_FEED_LIMIT })).reverse(),
  };
}

export function registerEngagementRoutes(
  app: FastifyInstance,
  deps: {
    pool: pg.Pool;
    transport?: EmailTransport;
    /** Answers `{{support_email}}` in an ops-authored override of the copy below. */
    settings?: SupportEmailSource;
  },
): void {
  // Pipeline dashboard: every active engagement with stage, SLA + analyst.
  app.get('/api/v1/engagements', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const now = new Date();
    const parsedQuery = z
      .object({
        limit: z.coerce.number().int().min(1).max(ENGAGEMENT_PAGE_LIMIT).default(ENGAGEMENT_PAGE_LIMIT),
      })
      .safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      throw invalidQuery(parsedQuery.error);
    }
    const { engagements: rows, truncated } = await listActiveEngagements(deps.pool, {
      limit: parsedQuery.data.limit,
    });
    return {
      engagements: rows.map((r) => ({
        valuation_id: r.valuation_id,
        company_name: r.company_name,
        kind: r.kind,
        valuation_state: r.valuation_state,
        current_stage: r.current_stage,
        assigned_analyst_id: r.assigned_analyst_id,
        analyst_email: r.analyst_email,
        // Whether the assignment is still one the overdue sweep will act on.
        // An engagement can sit here with an analyst named against it and be
        // chased by nobody, because the account was closed, suspended or
        // moved off the operations team after it was assigned — see
        // `analystIsChasable`. The board is where that gets noticed and
        // reassigned, so it is shown rather than quietly worked around.
        analyst_active: analystIsChasable(r),
        stage_entered_at: r.stage_entered_at,
        sla: slaStatus(r.current_stage, r.stage_entered_at, now),
      })),
      stages: ENGAGEMENT_STAGES,
      truncated,
      page_limit: ENGAGEMENT_PAGE_LIMIT,
    };
  });

  // Engagement detail for one valuation (creates it on first view).
  app.get('/api/v1/valuations/:id/engagement', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(deps.pool, id);
    /*
     * `ensureEngagement` INSERTs, and this is a GET.
     *
     * On a live valuation that is the intended behaviour and stays: an
     * engagement begins the first time somebody opens the panel, which is the
     * moment the kickoff clock should start. On a *retired* one it is a write
     * to withdrawn work, reached by a read — the shape `refuseIfRetired`
     * exists for, and the one R89's sweep could not see, because it drove the
     * mutating routes and this is not one of them. It stamped an `engagements`
     * row and an `engagement_started` event onto a file the firm had already
     * put down.
     *
     * The read stays open, per the doctrine in `domain/retiredEngagement.ts` —
     * a firm that has withdrawn work still has to be able to look at it. What
     * it no longer does is bring an engagement into being while looking. A
     * retired valuation nobody ever opened the panel on has no engagement, and
     * the view says so rather than inventing a kickoff that never happened.
     */
    if (valuation.archived_at !== null) {
      const existing = await findEngagement(deps.pool, id);
      if (!existing) return unstartedEngagementView(deps.pool, id);
      return engagementView(deps.pool, existing, new Date());
    }
    const engagement = await ensureEngagement(deps.pool, id, {
      actorType: 'human',
      actorId: principal.id,
    });
    return engagementView(deps.pool, engagement, new Date());
  });

  // Advance to a named stage, or to the next stage when unspecified.
  app.post('/api/v1/valuations/:id/engagement/advance', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    refuseIfRetired(await loadValuation(deps.pool, id), 'accepting stage advances');
    const parsed = AdvanceBody.safeParse(req.body ?? {});
    if (!parsed.success) throw invalidBody('Invalid stage', parsed.error);

    const engagement = await ensureEngagement(deps.pool, id, {
      actorType: 'human',
      actorId: principal.id,
    });
    const plan = planStageTransition(engagement.current_stage, parsed.data.stage, {
      reopen: parsed.data.reopen,
    });
    if (!plan.ok) throw refuseTransition(plan.reason);

    const updated = await advanceStage(
      deps.pool,
      engagement,
      plan.to,
      { actorType: 'human', actorId: principal.id },
      { reopen: plan.reopen },
    );
    return engagementView(deps.pool, updated, new Date());
  });

  // Assign (or clear) the analyst on the engagement.
  app.post('/api/v1/valuations/:id/engagement/assign', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    refuseIfRetired(await loadValuation(deps.pool, id), 'accepting engagement changes');
    const parsed = AssignBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid analyst', parsed.error);
    if (parsed.data.analyst_id !== null) await assertAssignableAnalyst(deps.pool, parsed.data.analyst_id);
    const engagement = await ensureEngagement(deps.pool, id, {
      actorType: 'human',
      actorId: principal.id,
    });
    const updated = await assignAnalyst(deps.pool, engagement, parsed.data.analyst_id, {
      actorType: 'human',
      actorId: principal.id,
    });
    return engagementView(deps.pool, updated, new Date());
  });

  // Scan active engagements and email the assigned analyst for each overdue
  // stage. Runnable on demand (schedulable like the auto-email drip).
  app.post('/api/v1/admin/engagements/remind-overdue', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const now = new Date();
    const reminded: string[] = [];
    /**
     * Overdue engagements whose assigned analyst is no longer someone this
     * sweep may write to. Reported rather than skipped in silence: an
     * engagement that is past SLA and has nobody being chased about it is
     * precisely what a reminder sweep exists to surface, and dropping it
     * quietly leaves the endpoint reporting a clean run over work nobody was
     * told about. Engagements with no analyst at all are not in this list —
     * that is an unassigned engagement, which the board already shows as one.
     */
    const unreachable: { valuation_id: string; analyst_id: string; reason: string }[] = [];
    let scanned = 0;
    // Paged rather than capped: a missed reminder is the whole point of the
    // sweep going unsent, and it would report success either way.
    for await (const r of eachActiveEngagement(deps.pool)) {
      scanned++;
      const sla = slaStatus(r.current_stage, r.stage_entered_at, now);
      if (!sla.overdue) continue;
      // The guard stays the predicate — it narrows the row for the send below
      // — and the reason is asked separately for the alert.
      if (!analystIsChasable(r)) {
        const block = analystChaseBlock(r);
        // With the reason, because the three causes are three different things
        // to do about it: a closed account has to be reassigned, a suspension
        // usually lifts, and a role taken away means the account is live and
        // the person is at their desk. One message over all three leaves
        // whoever reads the alert to go and find out which — see R258, where
        // a terminal failure and a retrying one logged identically.
        if (r.assigned_analyst_id) {
          unreachable.push({
            valuation_id: r.valuation_id,
            analyst_id: r.assigned_analyst_id,
            reason: block ?? 'unknown',
          });
        }
        continue;
      }
      await sendTransactionalEmail(
        { pool: deps.pool, transport: deps.transport, log: app.log, settings: deps.settings },
        {
          toUserId: r.assigned_analyst_id,
          toEmail: r.analyst_email,
          templateKey: 'engagement_overdue',
          subject: `Overdue: ${r.company_name} is past SLA in ${sla.label}`,
          body:
            `The engagement for ${r.company_name} has been in the "${sla.label}" stage for ` +
            `${Math.round(sla.elapsedHours)}h, past its ${sla.expectedHours}h SLA. ` +
            `Please move it forward.`,
          vars: { company_name: r.company_name, stage: sla.label },
        },
      );
      await withTransaction(deps.pool, (client) =>
        recordEvent(client, {
          valuationId: r.valuation_id,
          type: ENGAGEMENT_EVENT_TYPES.overdueReminded,
          actor: { actorType: 'human', actorId: principal.id },
          payload: { stage: r.current_stage, analyst_email: r.analyst_email },
        }),
      );
      reminded.push(r.valuation_id);
    }
    if (unreachable.length > 0) {
      app.log.warn(
        { unreachable, alert: true },
        'engagements are past SLA with an analyst assigned who can no longer be reminded',
      );
    }
    return {
      reminded_count: reminded.length,
      reminded,
      unreachable_count: unreachable.length,
      unreachable,
      scanned,
    };
  });
}
