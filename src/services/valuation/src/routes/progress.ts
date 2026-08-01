import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { isUlid, problems } from '@n409/shared';
import { canReadReport, canReadValuation } from '../auth/rbac.js';
import {
  CLIENT_TIMELINE_EVENTS,
  HALTED_STATES,
  PROGRESS_STAGES,
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
import { listDocuments } from '../repos/documents.js';
import { latestSucceededJob } from '../repos/aiJobs.js';
import { findReportByValuation } from '../repos/reports.js';
import { latestEventAt, listEvents } from '../events/record.js';
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

    // Only the event types this view actually renders — the stage stepper reads
    // state_changed, the timeline reads the client-safe catalog. A long-running
    // valuation's full spine is thousands of rows we would immediately discard.
    const relevantTypes = [...new Set(['state_changed', ...Object.keys(CLIENT_TIMELINE_EVENTS)])];
    const [documents, events, lastActivityAt, report, explainJob] = await Promise.all([
      listDocuments(deps.pool, valuation.id),
      listEvents(deps.pool, valuation.id, { types: relevantTypes }),
      latestEventAt(deps.pool, valuation.id),
      findReportByValuation(deps.pool, valuation.id),
      latestSucceededJob(deps.pool, valuation.id, 'explain'),
    ]);

    // ── Stage stepper ───────────────────────────────────────────────────────
    const halted = HALTED_STATES.has(valuation.state);
    const currentIndex = stageIndexOf(valuation.state);
    // First time the valuation entered any of a stage's states.
    const enteredAt = new Map<number, Date>();
    enteredAt.set(0, valuation.created_at);
    for (const event of events) {
      if (event.type !== 'state_changed') continue;
      const to = (event.payload as { to?: string }).to;
      const idx = to ? stageIndexOf(to as ValuationState) : -1;
      if (idx >= 0 && !enteredAt.has(idx)) enteredAt.set(idx, event.occurred_at);
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
    const uploadedByKind = new Map<string, number>();
    for (const doc of documents) {
      uploadedByKind.set(doc.kind, (uploadedByKind.get(doc.kind) ?? 0) + 1);
    }
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
      documents_uploaded: documents.length,
      documents_missing: missingDocuments,
      report: { available: reportAvailable },
      explanation: { available: reportVisible && explainJob !== null },
      timeline,
    };
  });
}
