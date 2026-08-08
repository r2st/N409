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
import { listCalculations } from '../repos/calculations.js';
import { listDocuments } from '../repos/documents.js';
import { listComments } from '../repos/comments.js';
import { listSignatures } from '../repos/signatures.js';
import { listAiJobs } from '../repos/aiJobs.js';
import { listDecisions } from '../repos/methodologyDecisions.js';
import { listQaReviews } from '../repos/qaReviews.js';
import { listScenarios } from '../repos/scenarios.js';
import { findReportByValuation, getVersion, listVersions } from '../repos/reports.js';
import { findUserById } from '../repos/users.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { CommentKind } from '../domain/operations.js';

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

    const [events, calculations, documents, comments, signatures, aiJobs, report, generator] =
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
    const [decisions, qaReviews, scenarios, research] = await Promise.all([
      listDecisions(deps.pool, id),
      listQaReviews(deps.pool, id),
      listScenarios(deps.pool, id),
      // Every research row including superseded ones (migration 0116). An
      // auditor asking "what did you read, and what did you read before that"
      // is asking exactly what the supersede chain records; a bundle that
      // shipped only the live rows would answer half the question.
      listMarketResearch(deps.pool, id, { includeSuperseded: true }),
    ]);

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

    const entries: ZipEntry[] = [
      { name: 'events.json', data: toJson(events) },
      { name: 'audit-trail.json', data: toJson({ summary: auditSummary, entries: auditEntries }) },
      { name: 'change-log.csv', data: changeLogCsv(auditEntries) },
      { name: 'calculations.json', data: toJson(calculations) },
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
        report_versions: versions.length,
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
