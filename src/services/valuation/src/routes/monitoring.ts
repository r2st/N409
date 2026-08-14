import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import {
  cloneValuation,
  findValuationById,
  findValuationsByIds,
  type ValuationRow,
} from '../repos/valuations.js';
import {
  latestSucceededCalculation,
  latestSucceededCalculationsByValuationIds,
  type CalculationRow,
} from '../repos/calculations.js';
import { findParams, findParamsByValuationIds, type ValuationParamsRow } from '../repos/params.js';
import { findCapTable, findCapTablesByValuationIds, type CapTableRow } from '../repos/capTables.js';
import { findUsersByIds } from '../repos/users.js';
import {
  findResolutionByValuation,
  findResolutionsByValuationIds,
  type BoardResolutionRow,
} from '../repos/boardApprovals.js';
import { requirePrincipal } from '../plugins/auth.js';
import { sendTransactionalEmail } from '../email/transactional.js';
import type { EmailTransport } from '../hooks/stateChange.js';
import {
  evaluateTriggers,
  MONITOR_EVENT_TYPES,
  overallStatus,
  type MonitorSnapshot,
} from '../domain/monitoring.js';
import {
  disableMonitor,
  eachEnabledMonitor,
  enableMonitor,
  findMonitor,
  listEnabledMonitors,
  markCheckedMany,
  MONITOR_PAGE_LIMIT,
  notifiedSignaturesFor,
  recordAlert,
} from '../repos/monitors.js';
import { recordEvent } from '../events/record.js';
import { withTransaction } from '../db/pool.js';

/**
 * Real-time valuation monitoring (feature 10). Ops enable monitoring on a
 * completed valuation, which snapshots a baseline; a scan compares live data to
 * the baseline and fires revaluation triggers (funding round, revenue >25%,
 * cap-table change, 12-month expiry), emails newly-fired alerts, and offers a
 * one-click roll-forward into a fresh valuation.
 */

const MONITORABLE_STATES = new Set([
  'completed',
  'paid',
  'review',
  'reviewed',
  'drafted',
  'draft_accepted',
  'draft_changes',
  'published',
]);

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('Monitoring is operations-only');
}

async function loadValuation(pool: pg.Pool, id: string): Promise<ValuationRow> {
  if (!isUlid(id)) throw problems.notFound();
  const valuation = await findValuationById(pool, id);
  if (!valuation) throw problems.notFound();
  return valuation;
}

/** The four rows a snapshot reads, however they were fetched. */
interface SnapshotSources {
  calc: CalculationRow | null;
  params: ValuationParamsRow | null;
  capTable: CapTableRow | null;
  resolution: BoardResolutionRow | null;
}

/**
 * Assemble a snapshot from rows already in hand. Pure — the fetching lives in
 * {@link buildSnapshot} (one valuation) and {@link buildSnapshots} (a list), so
 * the two paths cannot drift in what a snapshot means.
 */
function assembleSnapshot(valuation: ValuationRow, sources: SnapshotSources): MonitorSnapshot {
  const { calc, params, capTable, resolution } = sources;

  const revenueCents = params?.last_year_revenue_cents ?? params?.ytd_revenue_cents ?? null;
  const annualRevenue = revenueCents !== null ? Number(revenueCents) / 100 : null;

  // Valuation date for the safe-harbor clock: adopted resolution date, else the
  // published/completed timestamp, else today. completed_at rides the row's
  // index signature (typed unknown), so coerce defensively.
  const toIso = (v: unknown): string | null => {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'string' && v) return v.slice(0, 10);
    return null;
  };
  const valuationDate =
    (resolution?.valuation_date ? String(resolution.valuation_date).slice(0, 10) : null) ??
    toIso(valuation.published_at) ??
    toIso(valuation.completed_at) ??
    new Date().toISOString().slice(0, 10);

  return {
    valuation_date: valuationDate,
    fmv_per_share: calc?.fmv_per_share ? Number(calc.fmv_per_share) : null,
    annual_revenue: annualRevenue,
    fully_diluted_shares: capTable?.validation?.summary?.fully_diluted_shares ?? null,
    last_round_date: params?.last_round_date ? String(params.last_round_date).slice(0, 10) : null,
  };
}

/** Build a monitoring snapshot from live data (calc FMV, revenue, cap table, rounds). */
async function buildSnapshot(pool: pg.Pool, valuation: ValuationRow): Promise<MonitorSnapshot> {
  const [calc, params, capTable, resolution] = await Promise.all([
    latestSucceededCalculation(pool, valuation.id),
    findParams(pool, valuation.id),
    findCapTable(pool, valuation.id),
    findResolutionByValuation(pool, valuation.id),
  ]);
  return assembleSnapshot(valuation, { calc, params, capTable, resolution });
}

/**
 * Snapshots for a whole list of valuations in four queries rather than four
 * per valuation. The dashboard and the scan both walk every enabled monitor,
 * so the per-valuation form made those handlers cost 4N round trips; batching
 * makes them constant.
 */
async function buildSnapshots(
  pool: pg.Pool,
  valuations: ValuationRow[],
): Promise<Map<string, MonitorSnapshot>> {
  const ids = valuations.map((v) => v.id);
  const [calcs, params, capTables, resolutions] = await Promise.all([
    latestSucceededCalculationsByValuationIds(pool, ids),
    findParamsByValuationIds(pool, ids),
    findCapTablesByValuationIds(pool, ids),
    findResolutionsByValuationIds(pool, ids),
  ]);
  return new Map(
    valuations.map((valuation) => [
      valuation.id,
      assembleSnapshot(valuation, {
        calc: calcs.get(valuation.id) ?? null,
        params: params.get(valuation.id) ?? null,
        capTable: capTables.get(valuation.id) ?? null,
        resolution: resolutions.get(valuation.id) ?? null,
      }),
    ]),
  );
}

export function registerMonitoringRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; transport?: EmailTransport },
): void {
  // Monitoring dashboard: every enabled monitor with its live trigger status.
  app.get('/api/v1/monitors', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const now = new Date();
    const parsedQuery = z
      .object({
        limit: z.coerce.number().int().min(1).max(MONITOR_PAGE_LIMIT).default(MONITOR_PAGE_LIMIT),
      })
      .safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      throw problems.unprocessable('Invalid query', { errors: parsedQuery.error.issues });
    }
    const { monitors, truncated } = await listEnabledMonitors(deps.pool, {
      limit: parsedQuery.data.limit,
    });
    // One query for every monitored valuation instead of one per monitor.
    const valuations = await findValuationsByIds(
      deps.pool,
      monitors.map((m) => m.valuation_id),
    );
    // ...and one batch of snapshot reads for the whole page, rather than four
    // queries per monitor.
    const snapshots = await buildSnapshots(deps.pool, [...valuations.values()]);
    const out = [];
    for (const m of monitors) {
      const valuation = valuations.get(m.valuation_id);
      if (!valuation) continue;
      const current = snapshots.get(valuation.id)!;
      const triggers = evaluateTriggers(m.baseline, current, now);
      out.push({
        valuation_id: m.valuation_id,
        company_name: m.company_name,
        kind: m.kind,
        last_checked_at: m.last_checked_at,
        status: overallStatus(triggers),
        triggers,
      });
    }
    return { monitors: out, truncated, page_limit: MONITOR_PAGE_LIMIT };
  });

  // Monitor state + live triggers for one valuation.
  app.get('/api/v1/valuations/:id/monitor', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(deps.pool, id);
    const monitor = await findMonitor(deps.pool, id);
    if (!monitor || !monitor.enabled) {
      return {
        monitor: null,
        status: 'green',
        triggers: [],
        monitorable: MONITORABLE_STATES.has(valuation.state),
      };
    }
    const current = await buildSnapshot(deps.pool, valuation);
    const triggers = evaluateTriggers(monitor.baseline, current, new Date());
    return { monitor, current, status: overallStatus(triggers), triggers };
  });

  // Enable monitoring — snapshots the baseline from current data.
  app.post('/api/v1/valuations/:id/monitor', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(deps.pool, id);
    const hasCalc = (await latestSucceededCalculation(deps.pool, id)) !== null;
    if (!MONITORABLE_STATES.has(valuation.state) && !hasCalc) {
      throw problems.conflict('Only a completed valuation can be monitored');
    }
    const baseline = await buildSnapshot(deps.pool, valuation);
    const monitor = await enableMonitor(
      deps.pool,
      { valuationId: id, baseline, createdBy: principal.id },
      { actorType: 'human', actorId: principal.id },
    );
    return reply.status(201).send({ monitor });
  });

  // Disable monitoring.
  app.delete('/api/v1/valuations/:id/monitor', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    await loadValuation(deps.pool, id);
    const monitor = await findMonitor(deps.pool, id);
    if (!monitor) throw problems.notFound();
    await disableMonitor(deps.pool, monitor, { actorType: 'human', actorId: principal.id });
    return reply.status(204).send();
  });

  // Scan all monitors, email newly-fired alerts to the assigned reviewer.
  app.post('/api/v1/admin/monitors/scan', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const now = new Date();
    let alertsSent = 0;
    let scanned = 0;
    // Paged, not capped: a trigger that fires and is never emailed is the
    // failure the monitor exists to prevent, and a capped scan would still
    // report a healthy-looking count.
    for await (const monitors of eachEnabledMonitor(deps.pool)) {
      scanned += monitors.length;
      const valuations = await findValuationsByIds(
        deps.pool,
        monitors.map((m) => m.valuation_id),
      );
      const snapshots = await buildSnapshots(deps.pool, [...valuations.values()]);
      // Both of these were read inside the loop below, once per monitor and
      // once per firing trigger respectively. Batched per page: the dedupe sets
      // for every monitor in one query, and every assigned reviewer in one more
      // — the reviewer lookup was also re-reading the same user for each
      // trigger on the same engagement.
      const notified = await notifiedSignaturesFor(
        deps.pool,
        monitors.map((m) => m.id),
      );
      const reviewers = await findUsersByIds(
        deps.pool,
        [...valuations.values()].map((v) => v.assigned_reviewer_id).filter((id): id is string => !!id),
      );
      await markCheckedMany(
        deps.pool,
        monitors.filter((m) => valuations.has(m.valuation_id)).map((m) => m.id),
      );

      for (const m of monitors) {
        const valuation = valuations.get(m.valuation_id);
        if (!valuation) continue;
        const current = snapshots.get(valuation.id)!;
        const triggers = evaluateTriggers(m.baseline, current, now);
        if (triggers.length === 0) continue;

        const alreadyNotified = notified.get(m.id) ?? new Set<string>();
        const fresh = triggers.filter((t) => !alreadyNotified.has(t.signature));
        // Alert the assigned reviewer if there is one with an email. Read once
        // per engagement from the batch, not once per trigger.
        const reviewer = valuation.assigned_reviewer_id
          ? (reviewers.get(valuation.assigned_reviewer_id) ?? null)
          : null;

        for (const t of fresh) {
          const inserted = await recordAlert(deps.pool, {
            monitorId: m.id,
            valuationId: m.valuation_id,
            triggerType: t.type,
            level: t.level,
            signature: t.signature,
          });
          if (!inserted) continue;
          await withTransaction(deps.pool, (client) =>
            recordEvent(client, {
              valuationId: m.valuation_id,
              type: MONITOR_EVENT_TYPES.triggerFired,
              actor: { actorType: 'human', actorId: principal.id },
              payload: { trigger: t.type, level: t.level, signature: t.signature },
            }),
          );
          if (reviewer) {
            await sendTransactionalEmail(
              { pool: deps.pool, transport: deps.transport, log: app.log },
              {
                toUserId: reviewer.id,
                toEmail: reviewer.email,
                templateKey: 'monitoring_alert',
                subject: `Revaluation trigger: ${m.company_name}`,
                body: `A monitoring trigger fired for ${m.company_name}:\n\n${t.message}\n\nConsider a fresh valuation.`,
                vars: { company_name: m.company_name, message: t.message },
              },
            );
            alertsSent++;
          }
        }
      }
    }
    return { scanned, alerts_sent: alertsSent };
  });

  // One-click roll-forward into a fresh valuation pre-populated from this one.
  app.post(
    '/api/v1/valuations/:id/monitor/new-valuation',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      requireOps(principal);
      const { id } = req.params as { id: string };
      const valuation = await loadValuation(deps.pool, id);
      const clone = await cloneValuation(
        deps.pool,
        valuation,
        { rollForward: true, userId: valuation.user_id },
        { actorType: 'human', actorId: principal.id },
      );
      return reply.status(201).send({ valuation: clone });
    },
  );
}
