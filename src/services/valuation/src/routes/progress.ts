import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { isUlid, problems } from '@n409/shared';
import { canReadReport, canReadValuation } from '../auth/rbac.js';
import {
  CLIENT_TIMELINE_EVENTS,
  HALTED_STATES,
  PROGRESS_STAGES,
  PROGRESS_TIMELINE_LIMIT,
  REQUIRED_DOCUMENT_KINDS,
  TYPICAL_STAGE_DAYS,
  daysBetween,
  estimatedDeliveryAt,
  nextClientAction,
  percentComplete,
  stageDurations,
  stageIndexOf,
} from '../domain/progress.js';
import type { ValuationState } from '../domain/valuation.js';
import { findValuationById } from '../repos/valuations.js';
import { documentCoverage } from '../repos/documents.js';
import { currentExplanation } from './ai.js';
import { findReportByValuation } from '../repos/reports.js';
import { firstEntryPerState, latestEventAt, listEvents } from '../events/record.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Client self-service progress tracker (IMPROVEMENTS_RESEARCH §5.6): one call
 * returns everything the portal needs — the stage stepper, the document
 * checklist with upload status, the client-safe timeline, and whether the
 * report / plain-English explanation are ready. Readable by anyone who can
 * read the valuation; internal analyst events never appear here.
 */
export function registerProgressRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/valuations/:id/progress', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    const ref = valuation
      ? { userId: valuation.user_id, partnerId: valuation.partner_id, state: valuation.state }
      : null;
    if (!valuation || !ref || !canReadValuation(principal, ref)) throw problems.notFound();

    /*
     * Two reads of the spine rather than one, because the stepper and the
     * timeline want opposite ends of it.
     *
     * They used to share a single type-filtered read with no `LIMIT` at all —
     * "thousands of rows we would immediately discard", as the comment here
     * said, which was an accurate description of an unbounded read rather than
     * a bound. Capping that shared read would not have produced a short
     * answer: the stepper needs the *first* entry into each stage and
     * `listEvents` keeps the *newest* rows, so a cap would have moved
     * `entered_at` rather than shortened anything.
     *
     * So the stepper asks a question whose answer the enum bounds
     * (`firstEntryPerState`), and the timeline takes an ordinary page.
     */
    const timelineTypes = Object.keys(CLIENT_TIMELINE_EVENTS);
    // Counts, not rows: the checklist and `documents_uploaded` below are
    // arithmetic over every live file, and `listDocuments` is a capped page.
    // See `documentCoverage` — a checklist built from a page under-reports the
    // buckets past the cap and asks the client to upload them again.
    const [coverage, stateEntries, timelinePage, lastActivityAt, report, explainJob] = await Promise.all([
      documentCoverage(deps.pool, valuation.id),
      firstEntryPerState(deps.pool, valuation.id),
      // One over the cap, so a full page can be told from a short one.
      listEvents(deps.pool, valuation.id, {
        types: timelineTypes,
        limit: PROGRESS_TIMELINE_LIMIT + 1,
      }),
      latestEventAt(deps.pool, valuation.id),
      findReportByValuation(deps.pool, valuation.id),
      // The same reading `GET /explanation` serves — an explanation of a run
      // the engagement has since superseded is not offered, so the tracker
      // must not announce one. Two readers disagreeing about whether a card
      // exists is how a client is told to look for something that is not there.
      currentExplanation(deps.pool, valuation),
    ]);
    const timelineTruncated = timelinePage.length > PROGRESS_TIMELINE_LIMIT;
    const events = timelinePage.slice(-PROGRESS_TIMELINE_LIMIT);

    // ── Stage stepper ───────────────────────────────────────────────────────
    const halted = HALTED_STATES.has(valuation.state);
    const currentIndex = stageIndexOf(valuation.state);
    // First time the valuation entered any of a stage's states. One row per
    // state, so the earliest transition into a stage is the earliest of the
    // states that make it up.
    const enteredAt = new Map<number, Date>();
    enteredAt.set(0, valuation.created_at);
    for (const [state, occurredAt] of stateEntries) {
      const idx = stageIndexOf(state as ValuationState);
      if (idx < 0) continue;
      const known = enteredAt.get(idx);
      if (!known || occurredAt < known) enteredAt.set(idx, occurredAt);
    }
    const now = new Date();
    const durations = stageDurations(enteredAt, now);
    const stages = PROGRESS_STAGES.map((stage, idx) => ({
      key: stage.key,
      label: stage.label,
      description: stage.description,
      status: halted
        ? 'upcoming'
        : idx < currentIndex
          ? 'done'
          : idx === currentIndex
            ? 'current'
            : 'upcoming',
      entered_at: enteredAt.get(idx)?.toISOString() ?? null,
      duration_days: durations[idx] ?? null,
      typical_days: TYPICAL_STAGE_DAYS[stage.key],
    }));

    // ── Document checklist ──────────────────────────────────────────────────
    const uploadedByKind = coverage.byKind;
    const checklist = REQUIRED_DOCUMENT_KINDS.map(({ kind, label }) => ({
      kind,
      label,
      uploaded: (uploadedByKind.get(kind) ?? 0) > 0,
      count: uploadedByKind.get(kind) ?? 0,
    }));

    // ── Client-safe timeline (newest first) ─────────────────────────────────
    const timeline = events
      .filter((e) => e.type in CLIENT_TIMELINE_EVENTS)
      .map((e) => {
        const payload = e.payload as Record<string, unknown>;
        let detail: string | null = null;
        if (e.type === 'state_changed') {
          const idx = stageIndexOf(payload.to as ValuationState);
          detail = idx >= 0 ? PROGRESS_STAGES[idx]!.label : null;
        } else if (e.type === 'document_uploaded' && typeof payload.filename === 'string') {
          detail = payload.filename;
        } else if (e.type === 'scenario_saved' && typeof payload.name === 'string') {
          detail = payload.name;
        }
        return {
          type: e.type,
          label: CLIENT_TIMELINE_EVENTS[e.type]!,
          detail,
          occurred_at: e.occurred_at,
        };
      })
      .reverse();

    const reportVisible = canReadReport(principal, ref);
    const reportAvailable = reportVisible && report !== null && report.current_version > 0;
    const missingDocuments = checklist.filter((item) => !item.uploaded).length;

    return {
      state: valuation.state,
      halted,
      waiting_on_client: valuation.waiting_on_client,
      percent_complete: percentComplete({
        stageIndex: currentIndex,
        documentsUploaded: REQUIRED_DOCUMENT_KINDS.length - missingDocuments,
        documentsRequired: REQUIRED_DOCUMENT_KINDS.length,
      }),
      next_action: nextClientAction({
        halted,
        stageIndex: currentIndex,
        state: valuation.state,
        waitingOnClient: valuation.waiting_on_client,
        missingDocuments,
        reportAvailable,
      }),
      estimated_delivery_at:
        estimatedDeliveryAt({ stageIndex: currentIndex, halted, now })?.toISOString() ?? null,
      days_in_progress: daysBetween(valuation.created_at, now),
      last_activity_at: lastActivityAt?.toISOString() ?? null,
      stages,
      checklist,
      documents_uploaded: coverage.total,
      documents_missing: missingDocuments,
      report: { available: reportAvailable },
      explanation: { available: reportVisible && explainJob.job !== null },
      timeline,
      /** True when older entries exist beyond the page this response carries. */
      timeline_truncated: timelineTruncated,
      timeline_limit: PROGRESS_TIMELINE_LIMIT,
    };
  });
}
