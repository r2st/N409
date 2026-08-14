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
  ENGAGEMENT_EVENT_TYPES,
  ENGAGEMENT_STAGES,
  isEngagementStage,
  nextStage,
  slaStatus,
  stageDurations,
} from '../domain/engagement.js';
import {
  advanceStage,
  assignAnalyst,
  eachActiveEngagement,
  ENGAGEMENT_PAGE_LIMIT,
  ensureEngagement,
  listActiveEngagements,
  stageHistory,
  type EngagementRow,
} from '../repos/engagements.js';
import { recordEvent } from '../events/record.js';
import { withTransaction } from '../db/pool.js';

/**
 * Engagement lifecycle management (feature 8). Ops-only: track the stage an
 * engagement is in, its SLA status, expected-vs-actual per-stage timing, an
 * activity feed, and a pipeline dashboard across all active engagements. Also
 * emails the assigned analyst when a stage is overdue.
 */

const AdvanceBody = z.object({ stage: z.string().max(60).optional() });
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

async function engagementView(pool: pg.Pool, engagement: EngagementRow, now: Date) {
  const history = await stageHistory(pool, engagement.id);
  const events = await listEvents(pool, engagement.valuation_id);
  return {
    engagement,
    sla: slaStatus(engagement.current_stage, engagement.stage_entered_at, now),
    stages: ENGAGEMENT_STAGES,
    durations: stageDurations(history, now),
    // Activity feed: most-recent-first, capped for the panel.
    activity: events.slice(-40).reverse(),
  };
}

export function registerEngagementRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; transport?: EmailTransport },
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
      throw problems.badRequest('Invalid query', { errors: parsedQuery.error.issues });
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
    await loadValuation(deps.pool, id);
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
    await loadValuation(deps.pool, id);
    const parsed = AdvanceBody.safeParse(req.body ?? {});
    if (!parsed.success) throw problems.unprocessable('Invalid stage', { errors: parsed.error.issues });

    const engagement = await ensureEngagement(deps.pool, id, {
      actorType: 'human',
      actorId: principal.id,
    });
    let target = parsed.data.stage;
    if (!target) {
      const next = nextStage(engagement.current_stage);
      if (!next) throw problems.conflict('The engagement is already at its final stage');
      target = next.key;
    }
    if (!isEngagementStage(target)) throw problems.unprocessable('Unknown engagement stage');
    if (target === engagement.current_stage) {
      throw problems.conflict('The engagement is already at that stage');
    }

    const updated = await advanceStage(deps.pool, engagement, target, {
      actorType: 'human',
      actorId: principal.id,
    });
    return engagementView(deps.pool, updated, new Date());
  });

  // Assign (or clear) the analyst on the engagement.
  app.post('/api/v1/valuations/:id/engagement/assign', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    await loadValuation(deps.pool, id);
    const parsed = AssignBody.safeParse(req.body);
    if (!parsed.success) throw problems.unprocessable('Invalid analyst', { errors: parsed.error.issues });
    if (parsed.data.analyst_id && !isUlid(parsed.data.analyst_id)) {
      throw problems.unprocessable('Invalid analyst id');
    }
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
    let scanned = 0;
    // Paged rather than capped: a missed reminder is the whole point of the
    // sweep going unsent, and it would report success either way.
    for await (const r of eachActiveEngagement(deps.pool)) {
      scanned++;
      const sla = slaStatus(r.current_stage, r.stage_entered_at, now);
      if (!sla.overdue || !r.analyst_email) continue;
      await sendTransactionalEmail(
        { pool: deps.pool, transport: deps.transport, log: app.log },
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
    return { reminded_count: reminded.length, reminded, scanned };
  });
}
