import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { isUlid, problems } from '@n409/shared';
import { isOps } from '../auth/rbac.js';
import { buildZip, type ZipEntry } from '../export/zip.js';
import { listMarketResearch } from '../repos/marketResearch.js';
import { changeLogCsv, describeEvent, summarizeAuditTrail } from '../domain/auditTrail.js';
import { listEvents, recordEvent } from '../events/record.js';
import { withTransaction } from '../db/pool.js';
import { findValuationById } from '../repos/valuations.js';
import { listCalculations, listCalculationTraces } from '../repos/calculations.js';
import { listWorkbookCells, WORKBOOK_CELL_LIMIT } from '../repos/workbook.js';
import { computeWorkbook } from '../domain/workbook.js';
import { detectFinancialAnomalies } from '../domain/financialAnomalies.js';
import { listDocuments } from '../repos/documents.js';
import { COMMENT_PAGE_LIMIT, listComments } from '../repos/comments.js';
import { listSignatures } from '../repos/signatures.js';
import { listAiJobs } from '../repos/aiJobs.js';
import { listDecisions } from '../repos/methodologyDecisions.js';
import { listQaReviews } from '../repos/qaReviews.js';
import { listScenarios } from '../repos/scenarios.js';
import { listComparableItems } from '../repos/comparableItems.js';
import { impliedMultiples } from '../domain/comparables.js';
import { findReportByValuation, getVersion, listVersions } from '../repos/reports.js';
import { findUserById } from '../repos/users.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { CommentKind } from '../domain/operations.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';

/**
 * Audit-defense evidence bundle: one-click ZIP of everything an IRS/auditor
 * challenge would ask for — the append-only event timeline, every calculation
 * snapshot, the document manifest (sha256 fingerprints), review decisions,
 * comments, signature records, admin events, AI-run provenance (including the
 * exact prompt versions used), the report version history, and the latest
 * rendered report PDF. Everything already lives in the audit spine and the
 * version tables; this endpoint is packaging, not new state.
 */

const ALL_COMMENT_KINDS: ReadonlySet<CommentKind> = new Set(['chat', 'note', 'email']);

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

export function registerEvidenceRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.post('/api/v1/valuations/:id/evidence-bundle', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Evidence bundles are operations-only');
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    // A bundle is a new artifact assembled from the file, not a view of it, so
    // it falls on the write side of the read/write line the rest of these
    // guards draw.
    refuseIfRetired(valuation, 'producing evidence bundles');

    const [events, calculations, documents, commentPage, signatures, aiJobs, report, generator] =
      await Promise.all([
        listEvents(deps.pool, id),
        listCalculations(deps.pool, id),
        listDocuments(deps.pool, id),
        listComments(deps.pool, id, ALL_COMMENT_KINDS),
        listSignatures(deps.pool, id),
        listAiJobs(deps.pool, id),
        findReportByValuation(deps.pool, id),
        findUserById(deps.pool, principal.id),
      ]);
    // Audit-defense additions (IMPROVEMENTS_RESEARCH §5.3/§4.3/§5.7): the
    // methodology decision log, QA review history, and saved scenarios.
    const [decisions, qaReviews, scenarios, research, comparables, traces, workbookCells] = await Promise.all(
      [
        listDecisions(deps.pool, id),
        listQaReviews(deps.pool, id),
        listScenarios(deps.pool, id),
        // Every research row including superseded ones (migration 0116). An
        // auditor asking "what did you read, and what did you read before that"
        // is asking exactly what the supersede chain records; a bundle that
        // shipped only the live rows would answer half the question.
        listMarketResearch(deps.pool, id, { includeSuperseded: true }),
        // The peer set behind the market approach (migration 0119), included and
        // excluded rows alike. The excluded ones are the half an auditor asks
        // about, so a bundle carrying only the retained comps would be answering
        // the easy question.
        listComparableItems(deps.pool, id),
        // The engine's own step record for each run (migration 0126). It is the
        // only artifact that answers "how" rather than "what", and it says the
        // two things `results` structurally cannot: which approaches were
        // skipped, and which carried a figure reused from an earlier run.
        listCalculationTraces(deps.pool, id),
        // The entered workbook. `calculations.inputs` holds the engine payload
        // derived from it, not the grid an analyst typed and Appendix II prints
        // — an auditor reconciling the report to the source has been given the
        // derived figures and never the ones they were derived from.
        listWorkbookCells(deps.pool, id),
      ],
    );

    // Review tasks carry the approve / request-changes workflow; decisions
    // themselves are `review_decision` events (already in events.json).
    const { rows: reviewTasks } = await deps.pool.query(
      'SELECT * FROM review_tasks WHERE valuation_id = $1 ORDER BY created_at ASC',
      [id],
    );
    // Admin events whose subject is this valuation (rare but possible).
    const { rows: adminEvents } = await deps.pool.query(
      'SELECT * FROM admin_events WHERE subject_id = $1 ORDER BY occurred_at ASC',
      [id],
    );
    // Provenance: the exact prompt versions the valuation's AI runs used.
    const { rows: promptVersions } = await deps.pool.query(
      `SELECT DISTINCT v.id, p.pipeline, v.version, v.system_prompt, v.model, v.created_at
         FROM ai_prompt_versions v
         JOIN ai_prompts p ON p.id = v.prompt_id
         JOIN ai_jobs j ON j.pipeline = p.pipeline AND j.prompt_version = v.version
         WHERE j.valuation_id = $1
         ORDER BY p.pipeline, v.version`,
      [id],
    );

    const versions = report ? await listVersions(deps.pool, report.id) : [];
    // The most recent rendered PDF is the deliverable an auditor wants.
    let renderedPdf: { name: string; data: Buffer } | null = null;
    const latestRendered = versions.find((v) => v.has_pdf);
    if (report && latestRendered) {
      const full = await getVersion(deps.pool, report.id, latestRendered.version);
      if (full?.pdf) renderedPdf = { name: `report-v${full.version}.pdf`, data: full.pdf };
    }

    const generatedAt = new Date();
    // A bundle is read by somebody looking for what is *not* in it, so a list
    // that came back short has to say so on the manifest rather than end
    // quietly. Reaching COMMENT_PAGE_LIMIT on one engagement takes an email
    // loop, and this is what tells the auditor that is what they are looking at.
    const { comments, truncated: commentsTruncated } = commentPage;
    const documentManifest = documents.map((d) => ({
      id: d.id,
      kind: d.kind,
      filename: d.filename,
      content_type: d.content_type,
      size_bytes: d.size_bytes,
      sha256: d.sha256,
      uploaded_by: d.uploaded_by,
      created_at: d.created_at,
    }));

    // The spine, enriched: every event carries its category, severity and
    // field-level before/after, plus a flat CSV of just the changes.
    const auditEntries = events.map(describeEvent);
    const auditSummary = summarizeAuditTrail(auditEntries);

    /*
     * The workbook as the analyst left it, resolved through the same reader the
     * workbook route and Appendix II use, with the data-quality pass over it.
     *
     * The findings are not a grade and are not being published to the client:
     * several of them are ordinary for an early-stage company, and the severity
     * says how loudly to ask rather than whether to proceed (see
     * domain/financialAnomalies.ts). What they answer here is the question an
     * auditor actually asks about the statements a valuation rests on — was
     * anything about them queried, and by what — which is unanswerable from a
     * bundle that carries the grid without the checks that ran over it.
     */
    const workbook = computeWorkbook(workbookCells.cells);
    const anomalies = detectFinancialAnomalies(workbook);

    const entries: ZipEntry[] = [
      { name: 'events.json', data: toJson(events) },
      { name: 'audit-trail.json', data: toJson({ summary: auditSummary, entries: auditEntries }) },
      { name: 'change-log.csv', data: changeLogCsv(auditEntries) },
      { name: 'calculations.json', data: toJson(calculations) },
      { name: 'calculation-traces.json', data: toJson(traces) },
      {
        name: 'workbook.json',
        data: toJson({ sheets: workbook, anomalies, truncated: workbookCells.truncated }),
      },
      { name: 'documents.json', data: toJson(documentManifest) },
      { name: 'comments.json', data: toJson(comments) },
      { name: 'signatures.json', data: toJson(signatures) },
      { name: 'review-tasks.json', data: toJson(reviewTasks) },
      { name: 'admin-events.json', data: toJson(adminEvents) },
      { name: 'ai-jobs.json', data: toJson(aiJobs) },
      { name: 'ai-prompt-versions.json', data: toJson(promptVersions) },
      { name: 'decisions.json', data: toJson(decisions) },
      { name: 'qa-reviews.json', data: toJson(qaReviews) },
      { name: 'scenarios.json', data: toJson(scenarios) },
      { name: 'market-research.json', data: toJson(research) },
      {
        name: 'comparables.json',
        data: toJson(comparables.map((row) => ({ ...row, multiples: impliedMultiples(row) }))),
      },
      {
        name: 'report-versions.json',
        data: toJson({ report: report ?? null, versions }),
      },
      ...(renderedPdf ? [renderedPdf] : []),
    ];
    const manifest = {
      format: 'n409-evidence-bundle/1',
      generated_at: generatedAt.toISOString(),
      generated_by: { id: principal.id, email: generator?.email ?? null },
      valuation: {
        id: valuation.id,
        number: valuation.number,
        workflow_id: valuation.workflow_id,
        kind: valuation.kind,
        state: valuation.state,
        company_name: valuation.company_name,
        currency: valuation.currency,
        created_at: valuation.created_at,
        published_at: valuation.published_at,
      },
      /** What changed over the life of the valuation, at a glance. */
      audit_summary: {
        critical_changes: auditSummary.critical_changes,
        by_category: auditSummary.by_category,
        by_severity: auditSummary.by_severity,
        by_actor_type: auditSummary.by_actor_type,
        changed_fields: auditSummary.changed_fields,
        first_at: auditSummary.first_at,
        last_at: auditSummary.last_at,
      },
      counts: {
        events: events.length,
        field_changes: auditEntries.reduce((n, e) => n + e.changes.length, 0),
        calculations: calculations.length,
        // Runs that carry one, not steps: a bundle whose trace count exceeds
        // its calculation count would read as a mismatch rather than as depth.
        calculation_traces: traces.length,
        workbook_cells: workbookCells.cells.length,
        workbook_anomalies: anomalies.anomalies.length,
        documents: documents.length,
        comments: comments.length,
        signatures: signatures.length,
        review_tasks: reviewTasks.length,
        admin_events: adminEvents.length,
        ai_jobs: aiJobs.length,
        decisions: decisions.length,
        qa_reviews: qaReviews.length,
        scenarios: scenarios.length,
        market_research: research.length,
        comparables: comparables.length,
        comparables_excluded: comparables.filter((c) => !c.included).length,
        report_versions: versions.length,
      },
      /** Lists this bundle carries only a page of, and the page size. */
      truncated: {
        ...(commentsTruncated ? { comments: COMMENT_PAGE_LIMIT } : {}),
        // Same reason as comments: a grid that came back at the cap is a grid
        // with rows the auditor is not being shown, and a bundle that says
        // nothing about it reads as complete.
        ...(workbookCells.truncated ? { workbook_cells: WORKBOOK_CELL_LIMIT } : {}),
      },
      files: ['manifest.json', ...entries.map((e) => e.name)],
    };
    entries.unshift({ name: 'manifest.json', data: toJson(manifest) });
    for (const entry of entries) entry.mtime = generatedAt;

    const zip = buildZip(entries);

    // The export itself is an auditable act.
    await withTransaction(deps.pool, (client) =>
      recordEvent(client, {
        valuationId: id,
        type: 'evidence_bundle_exported',
        actor: { actorType: 'human', actorId: principal.id, source: 'api' },
        payload: { files: manifest.files, size_bytes: zip.length },
      }),
    );

    const stamp = generatedAt.toISOString().slice(0, 10);
    return reply
      .header('content-type', 'application/zip')
      .header(
        'content-disposition',
        `attachment; filename="evidence-bundle-${valuation.number}-${stamp}.zip"`,
      )
      .send(zip);
  });
}
