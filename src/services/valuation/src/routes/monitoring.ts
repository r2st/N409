import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, logFailure, logUnretried, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import {
  cloneValuation,
  findValuationById,
  findValuationsByIds,
  type ValuationRow,
} from '../repos/valuations.js';
import {
  latestSucceededCalculation,
  latestSucceededCalculationHeadsByValuationIds,
  type CalculationHead,
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
  reconcileBaselineShares,
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
  unrecordAlert,
  type MonitorRow,
} from '../repos/monitors.js';
import { recordEvent } from '../events/record.js';
import { withTransaction } from '../db/pool.js';
import { calendarDate } from '../domain/calendarDate.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { specialtyRunKind } from '../domain/specialty.js';
import { invalidQuery } from '../domain/validationProblem.js';
import type { SupportEmailSource } from '../hooks/autoEmails.js';

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
  /**
   * The *head* of the run history rather than the run.
   *
   * Narrowed to the two facts `assembleSnapshot` reads (R298). It used to be the
   * whole `CalculationRow`, and the batch reader behind it therefore shipped an
   * engine result document per valuation — 5.45 MB a page at 500 — so that this
   * function could take a number off one column and a string off one key of
   * another. The type is what keeps it narrow: a later reader that wants
   * `inputs` or the approaches has to widen the reader deliberately rather than
   * find them already fetched.
   */
  calc: CalculationHead | null;
  params: ValuationParamsRow | null;
  capTable: CapTableRow | null;
  resolution: BoardResolutionRow | null;
}

/**
 * A snapshot of live data, plus the one thing about how it was assembled that
 * the baseline comparison needs: when the cap table behind it was last written.
 * {@link reconcileBaselineShares} uses that to tell a stale stored count from a
 * cap table that genuinely moved.
 */
interface LiveState {
  snapshot: MonitorSnapshot;
  cap_table_changed_at: Date | null;
}

/** The baseline to compare against, healed of the stale as-converted count. */
function baselineOf(monitor: MonitorRow, live: LiveState): MonitorSnapshot {
  return reconcileBaselineShares(
    monitor.baseline,
    {
      fully_diluted_shares: live.snapshot.fully_diluted_shares,
      changed_at: live.cap_table_changed_at,
    },
    monitor.updated_at,
  );
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

  // Valuation date for the safe-harbor clock: board resolution date, else the
  // published/completed timestamp, else today. completed_at rides the row's
  // index signature (typed unknown), so coerce defensively.
  //
  // Every one of these is coerced rather than interpolated, including the two
  // that are `date` columns. `String(aDate).slice(0, 10)` yields "Mon Jan 05",
  // not "2026-01-05"
  // — pg hands a `date` back as a Date object and no type parser is registered
  // — and `monthsBetween` parses that to an Invalid Date and returns 0, which
  // silently disables the 12-month staleness trigger for exactly the
  // engagements that have a board resolution. A malformed date here does not
  // fail, it just stops alerting.
  //
  // Two readings, because these are two column types and the difference is not
  // cosmetic (domain/calendarDate.ts). `board_resolutions.valuation_date` and
  // `last_round_date` are `date` columns — the driver hands those back as
  // midnight *local*, so the day is read from the local parts or it lands a day
  // early east of UTC. `published_at` and `completed_at` are timestamptz, real
  // instants whose UTC day is the convention already in use everywhere else
  // here; reading *those* locally would make the answer depend on the server's
  // zone, which is the failure being fixed rather than a second instance of it.
  const isoDay = (v: unknown): string | null => {
    if (v instanceof Date) return calendarDate(v);
    if (typeof v === 'string' && v) return v.slice(0, 10);
    return null;
  };
  const isoInstant = (v: unknown): string | null => {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'string' && v) return v.slice(0, 10);
    return null;
  };
  // The last fallback stays on the UTC day rather than moving to `todayLocal`
  // with the other eleven clock readings. It is reached only when an engagement
  // has no resolution, no publication and no completion — there is no day to be
  // right about — and it sits between two deliberate UTC-instant readings and
  // feeds a twelve-month window, where agreeing with its neighbours is worth
  // more than a boundary that moves by four hours.
  const valuationDate =
    isoDay(resolution?.valuation_date) ??
    isoInstant(valuation.published_at) ??
    isoInstant(valuation.completed_at) ??
    new Date().toISOString().slice(0, 10);

  return {
    valuation_date: valuationDate,
    // Which engine wrote the run being monitored. `null` is a 409A-engine run,
    // and it is what decides whether the expiry trigger may call the twelve
    // months a §409A safe-harbor window (domain/monitoring.ts). Asked of the
    // run rather than the engagement's kind, for the reason
    // `POST /valuations/:id/board` asks it that way: it is this row's
    // conclusion the sentence is about.
    run_kind: calc?.run_kind ?? null,
    fmv_per_share: calc?.fmv_per_share ? Number(calc.fmv_per_share) : null,
    annual_revenue: annualRevenue,
    fully_diluted_shares: capTable?.validation?.summary?.fully_diluted_shares ?? null,
    // Same column type, same trap: the funding-round trigger compares this
    // string against the baseline's, and two malformed strings compare wrong.
    last_round_date: isoDay(params?.last_round_date),
  };
}

/** Build a monitoring snapshot from live data (calc FMV, revenue, cap table, rounds). */
async function buildSnapshot(pool: pg.Pool, valuation: ValuationRow): Promise<LiveState> {
  const [calc, params, capTable, resolution] = await Promise.all([
    latestSucceededCalculation(pool, valuation.id),
    findParams(pool, valuation.id),
    findCapTable(pool, valuation.id),
    findResolutionByValuation(pool, valuation.id),
  ]);
  // The single-valuation path keeps reading the whole run — it is one row, and
  // `latestSucceededCalculation` is what every other caller uses — and narrows
  // it here, so both paths hand `assembleSnapshot` the same shape and the
  // specialty rule is applied by the same function either way.
  const head: CalculationHead | null = calc
    ? { fmv_per_share: calc.fmv_per_share, run_kind: specialtyRunKind(calc.results ?? null) }
    : null;
  return {
    snapshot: assembleSnapshot(valuation, { calc: head, params, capTable, resolution }),
    cap_table_changed_at: capTable?.updated_at ?? null,
  };
}

/**
 * Snapshots for a whole list of valuations in four queries rather than four
 * per valuation. The dashboard and the scan both walk every enabled monitor,
 * so the per-valuation form made those handlers cost 4N round trips; batching
 * makes them constant.
 */
async function buildSnapshots(pool: pg.Pool, valuations: ValuationRow[]): Promise<Map<string, LiveState>> {
  const ids = valuations.map((v) => v.id);
  const [calcs, params, capTables, resolutions] = await Promise.all([
    latestSucceededCalculationHeadsByValuationIds(pool, ids),
    findParamsByValuationIds(pool, ids),
    findCapTablesByValuationIds(pool, ids),
    findResolutionsByValuationIds(pool, ids),
  ]);
  return new Map(
    valuations.map((valuation) => {
      const capTable = capTables.get(valuation.id) ?? null;
      return [
        valuation.id,
        {
          snapshot: assembleSnapshot(valuation, {
            calc: calcs.get(valuation.id) ?? null,
            params: params.get(valuation.id) ?? null,
            capTable,
            resolution: resolutions.get(valuation.id) ?? null,
          }),
          cap_table_changed_at: capTable?.updated_at ?? null,
        },
      ];
    }),
  );
}

export function registerMonitoringRoutes(
  app: FastifyInstance,
  deps: {
    pool: pg.Pool;
    transport?: EmailTransport;
    /** Answers `{{support_email}}` in an ops-authored override of the copy below. */
    settings?: SupportEmailSource;
  },
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
      throw invalidQuery(parsedQuery.error);
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
      const live = snapshots.get(valuation.id)!;
      const triggers = evaluateTriggers(baselineOf(m, live), live.snapshot, now);
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
    const live = await buildSnapshot(deps.pool, valuation);
    // The reconciled baseline is what the triggers were evaluated against, so
    // it is also the one to show beside them — returning the stored figure
    // would put a difference on screen that the trigger list denies.
    const baseline = baselineOf(monitor, live);
    const triggers = evaluateTriggers(baseline, live.snapshot, new Date());
    return {
      monitor: { ...monitor, baseline },
      current: live.snapshot,
      status: overallStatus(triggers),
      triggers,
    };
  });

  // Enable monitoring — snapshots the baseline from current data.
  app.post('/api/v1/valuations/:id/monitor', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(deps.pool, id);
    refuseIfRetired(valuation, 'accepting monitoring changes');
    const hasCalc = (await latestSucceededCalculation(deps.pool, id)) !== null;
    if (!MONITORABLE_STATES.has(valuation.state) && !hasCalc) {
      throw problems.conflict('Only a completed valuation can be monitored');
    }
    const { snapshot: baseline } = await buildSnapshot(deps.pool, valuation);
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
    /**
     * Triggers that fired and whose reviewer was not told, because something
     * threw while this pass was telling them.
     *
     * Reported rather than counted away, for the reason the overdue sweep
     * reports its own: `alerts_sent` on its own is indistinguishable from a
     * scan on which nothing fired, and this is the endpoint whose entire job is
     * that a trigger which fires is announced.
     */
    const unsent: Array<{ valuation_id: string; trigger: string; failure_reason: string }> = [];
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
      // Triggers are evaluated for the whole page before anything is read
      // about them, so the dedupe query can be asked about the signatures that
      // actually fired rather than about the monitors. Reading it the other way
      // round pulled every alert those monitors had ever sent — see
      // `notifiedSignaturesFor`, where the bound now lives.
      const fired = new Map<string, ReturnType<typeof evaluateTriggers>>();
      for (const m of monitors) {
        const valuation = valuations.get(m.valuation_id);
        if (!valuation) continue;
        const live = snapshots.get(valuation.id)!;
        const triggers = evaluateTriggers(baselineOf(m, live), live.snapshot, now);
        if (triggers.length > 0) fired.set(m.id, triggers);
      }

      // Both of these were read inside the loop below, once per monitor and
      // once per firing trigger respectively. Batched per page: the dedupe sets
      // for every monitor in one query, and every assigned reviewer in one more
      // — the reviewer lookup was also re-reading the same user for each
      // trigger on the same engagement.
      const notified = await notifiedSignaturesFor(
        deps.pool,
        [...fired].flatMap(([monitorId, triggers]) =>
          triggers.map((t) => ({ monitorId, signature: t.signature })),
        ),
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
        const triggers = fired.get(m.id);
        if (!triggers) continue;

        const alreadyNotified = notified.get(m.id) ?? new Set<string>();
        const fresh = triggers.filter((t) => !alreadyNotified.has(t.signature));
        // Alert the assigned reviewer if there is one with an email. Read once
        // per engagement from the batch, not once per trigger.
        const reviewer = valuation.assigned_reviewer_id
          ? (reviewers.get(valuation.assigned_reviewer_id) ?? null)
          : null;

        for (const t of fresh) {
          /*
           * THE ALERT ROW IS THE SUPPRESSOR, and it was committed before
           * anybody was told. `notifiedSignaturesFor` reads exactly this table
           * and `recordAlert` is `ON CONFLICT DO NOTHING`, so the row this
           * INSERT commits is what makes every later scan report the signature
           * as already handled. Everything after it — the spine event, and the
           * outbox write inside `sendTransactionalEmail` — is a separate
           * statement on a pool this scan has been paging through for minutes,
           * and any one of them losing a deadlock left the alert recorded, the
           * reviewer never told, and no scan willing to look at it again.
           *
           * That is the one failure a revaluation monitor exists to prevent,
           * arrived at silently: `alerts_sent` counts the sends that happened
           * and this one simply is not in it.
           *
           * Undone rather than reported, because it can be. `enqueueEmail` is
           * the first database write `sendTransactionalEmail` makes and every
           * failure after it is contained there, so a throw out of that call
           * means nothing was queued and nobody has been told — and this scan
           * knows it inserted the row itself, because `inserted` says so. So
           * the suppressor comes back off and the next scan owes the alert
           * again. `unrecordAlert` states both preconditions.
           *
           * Contained per trigger for the reason the overdue sweep's loop is:
           * one row's bad minute must not cost the rows behind it, and this
           * scan pages the entire enabled book.
           */
          let inserted: boolean;
          try {
            inserted = await recordAlert(deps.pool, {
              monitorId: m.id,
              valuationId: m.valuation_id,
              triggerType: t.type,
              level: t.level,
              signature: t.signature,
            });
          } catch (err) {
            // Nothing committed, so nothing to undo: the next scan sees the
            // trigger still firing and records it then.
            const failure = logFailure(
              app.log,
              err,
              { monitorId: m.id, valuationId: m.valuation_id, trigger: t.type },
              'monitor alert could not be recorded; the rest of the scan continues',
            );
            unsent.push({ valuation_id: m.valuation_id, trigger: t.type, failure_reason: failure.reason });
            continue;
          }
          if (!inserted) continue;
          try {
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
                { pool: deps.pool, transport: deps.transport, log: app.log, settings: deps.settings },
                {
                  valuationId: m.valuation_id,
                  toUserId: reviewer.id,
                  toEmail: reviewer.email,
                  recipientName: reviewer.first_name,
                  templateKey: 'monitoring_alert',
                  subject: `Revaluation trigger: ${m.company_name}`,
                  body: `A monitoring trigger fired for ${m.company_name}:\n\n${t.message}\n\nConsider a fresh valuation.`,
                  vars: { company_name: m.company_name, message: t.message },
                },
              );
              alertsSent++;
            }
          } catch (err) {
            // `logUnretried` only if the suppressor could not be taken back
            // off: with the row gone this alert is owed again and the next scan
            // pays it, which is a delay rather than a loss. With the row still
            // there it is a loss, and nothing else will ever say so.
            const undone = await unrecordAlert(deps.pool, {
              monitorId: m.id,
              signature: t.signature,
            }).catch((undoErr: unknown) => {
              app.log.error(
                { err: undoErr, monitorId: m.id, signature: t.signature },
                'could not take back an unannounced monitor alert',
              );
              return false;
            });
            const context = { monitorId: m.id, valuationId: m.valuation_id, trigger: t.type };
            const failure = undone
              ? logFailure(
                  app.log,
                  err,
                  context,
                  'monitor alert was not announced; the record of it has been taken back so the next scan re-fires it',
                )
              : logUnretried(
                  app.log,
                  err,
                  context,
                  'monitor alert was recorded and never announced, and the record could not be taken back — no scan will fire it again',
                );
            unsent.push({ valuation_id: m.valuation_id, trigger: t.type, failure_reason: failure.reason });
          }
        }
      }
    }
    return { scanned, alerts_sent: alertsSent, unsent_count: unsent.length, unsent };
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
      refuseIfRetired(valuation, 'accepting monitoring changes');
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
