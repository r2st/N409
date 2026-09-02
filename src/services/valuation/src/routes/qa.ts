import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { runQaChecks, worstStatus, type QaStatus } from '../domain/qaChecks.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { findParams } from '../repos/params.js';
import { latestSucceededCalculation, listCalculationResults } from '../repos/calculations.js';
import { createQaReview, listQaReviews } from '../repos/qaReviews.js';
import { findReportByValuation, getVersionContent } from '../repos/reports.js';
import { reportReadiness } from '../domain/reportReadiness.js';
import { reviewReport } from '../domain/reportReview.js';
import { templateForKind } from '../domain/report.js';
import { summaryFor } from './reports.js';
import { reportFigures } from '../domain/reportFigures.js';
import { resolveExhibitReferences } from '../domain/reportExhibitIndex.js';
import { resolveSignatures } from '../domain/reportSignatures.js';
import { listSignatures } from '../repos/signatures.js';
import { assertRunStood, calculationPayload, runAiPipeline, type AiPipelineDeps } from './ai.js';
import { InternalServiceError, toProblem } from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import { refuseIfRetired, refuseIfRetiredNow } from '../domain/retiredEngagement.js';
import { invalidBody } from '../domain/validationProblem.js';

/**
 * Quality-assurance gate (IMPROVEMENTS_RESEARCH §4.3): deterministic
 * reasonableness checks over the latest successful calculation, optionally
 * augmented by the 'qa' AI pipeline reviewing the outputs. The resulting
 * review is what the publish gate consults — a valuation with a failing (or
 * missing) review of its latest calculation cannot enter 'published'.
 */

const RunBody = z
  .object({
    // Also run the AI reviewer (needs the AI service; deterministic checks
    // alone never leave the process).
    ai: z.boolean().default(false),
  })
  .default({ ai: false });

const QA_STATUSES: ReadonlySet<string> = new Set(['pass', 'warn', 'fail']);

/** The AI verdict only ever tightens the outcome — never overrides a fail. */
export function combineWithAiVerdict(deterministic: QaStatus, verdict: unknown): QaStatus {
  if (typeof verdict === 'string' && QA_STATUSES.has(verdict)) {
    return worstStatus([deterministic, verdict as QaStatus]);
  }
  return deterministic;
}

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('QA reviews are operations-only');
}

export function registerQaRoutes(app: FastifyInstance, deps: AiPipelineDeps): void {
  const loadValuation = async (id: string): Promise<ValuationRow> => {
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    return valuation;
  };

  app.post('/api/v1/valuations/:id/qa', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(id);
    refuseIfRetired(valuation, 'accepting changes');

    const body = RunBody.safeParse(req.body ?? {});
    if (!body.success) throw invalidBody('Invalid options', body.error);

    const calculation = await latestSucceededCalculation(deps.pool, valuation.id);
    if (!calculation) {
      throw problems.unprocessable('No completed calculation to review — run a calculation first');
    }
    const params = await findParams(deps.pool, valuation.id);
    const deterministic = runQaChecks({ calculation, params });

    /*
     * The deliverable itself, not just the arithmetic behind it.
     *
     * Every check above grades a number. None of them opens the report, and the
     * report is the thing that leaves the building — so a 409A whose Conclusion
     * of Value chapter still read "is $ … per share", three pages after an
     * executive summary stating $1.2242, passed QA and published. The skeletons
     * are right to ship fill-me markers; what was missing was anything that
     * noticed one survived to the deliverable.
     *
     * Folded into the same review the publish gate already consults, rather
     * than added as a second gate: one place says whether this valuation may
     * go out, and a reviewer reads one list.
     */
    const report = await findReportByValuation(deps.pool, valuation.id);
    const reportVersion = report
      ? await getVersionContent(deps.pool, report.id, report.current_version)
      : null;
    /*
     * The exhibits this calculation produces, and the body with its index and
     * its exhibit pointers resolved against them — the same two steps, in the
     * same order, that `renderVersionPdf` performs.
     *
     * Both checks below have to read the *resolved* body or they grade a
     * document nobody receives: `{{exhibit_index}}` and `{{signatures}}` are
     * render-time markers and would otherwise be counted as unfilled holes, and
     * neither the index's list of schedules nor the certification's signature
     * block exists until it is built — the first from this very array, the
     * second from the rows on file.
     */
    const [{ exhibits, issues }, signatories] = await Promise.all([
      summaryFor(deps.pool, valuation, req.log),
      listSignatures(deps.pool, valuation.id),
    ]);
    const exhibitHeadings = exhibits.map((s) => s.heading);
    // The sections rather than the headings, for the reason `renderedScheduleIds`
    // gives: an exhibit built from separately-conditional blocks declares which
    // of them printed, and a body pointer at one resolves against that.
    //
    // Signed last, exactly as `renderVersionPdf` does it. A QA run before the
    // signature lands — which is every QA run, since the signature is what
    // closes the review this grades — sees the unsigned block, which is what the
    // deliverable would carry if it were rendered at that moment.
    const reportContent = reportVersion?.content
      ? resolveSignatures(resolveExhibitReferences(reportVersion.content, exhibits), signatories)
      : null;
    // Checked against what this calculation can actually fill in. A computed
    // marker the run supplies is not a hole; one it does not is a set of literal
    // braces on the deliverable, and is graded as such.
    const figures = reportFigures(calculation, valuation.currency);
    const readiness = reportReadiness(reportContent, figures);
    deterministic.checks.push({
      key: 'report_placeholders',
      label: 'Report body has no unfilled template placeholders',
      status: readiness.status,
      detail: readiness.detail,
    });
    deterministic.status = worstStatus([deterministic.status, readiness.status]);

    /*
     * The document as a reader meets it, rather than as a marker search sees it.
     *
     * A chapter can hold no placeholder at all and still send the reader to an
     * exhibit that was never built, leave a weighted approach unexplained, or
     * have quietly stopped restating its own conclusion. None of that shows up
     * in a figure, so none of the checks above can find it.
     *
     * Graded against the exhibits *this* calculation actually produces, built
     * from the same call the renderer makes — so the check reads the report
     * that would be delivered right now, not a second opinion about it.
     */
    /*
     * What this engagement concluded before, so `stale_figure` can tell a
     * frozen conclusion from any other number in the prose. Formatted through
     * the same `reportFigures` the render substitutes with, because the check
     * matches the string on the page rather than a value.
     *
     * Only runs that are *not* the one being reviewed, and only succeeded ones:
     * a failed run concluded nothing, and the current run's own figures are
     * what the body is supposed to be stating.
     *
     * The same bounded twenty-run window the calculation history and the
     * evidence bundle read, so the runs this check can see are the runs a
     * reviewer can see — through `listCalculationResults`, which is that window
     * carrying only the two columns `reportFigures` reads. It used to be
     * `listCalculations`, which carries `inputs` as well: twenty engine request
     * payloads, cap table and all, pulled across the wire per review for a
     * caller that never opens one.
     */
    const supersededFigures = (await listCalculationResults(deps.pool, valuation.id)).calculations
      .filter((run) => run.id !== calculation.id && run.status === 'succeeded')
      .map((run) => reportFigures(run, valuation.currency));

    const coherence = reviewReport({
      content: reportContent,
      exhibitHeadings,
      approaches: (calculation.results ?? {}).approaches,
      template: templateForKind(valuation.kind),
      figures,
      supersededFigures,
    });
    deterministic.checks.push({
      key: 'report_coherence',
      label: 'Report body agrees with its schedules and the calculation',
      status: coherence.status,
      detail: coherence.detail,
    });
    deterministic.status = worstStatus([deterministic.status, coherence.status]);

    /*
     * A schedule that failed to build, told to the one person who can do
     * anything about it (R345, methodology M11).
     *
     * R344 gave that failure a reader after it had none: `buildExhibits`
     * returns the sections it built and keeps no record of what it did not, so
     * a schedule that threw was indistinguishable from one that never applied,
     * and the deliverable shipped an appendix short with the render reporting
     * success. The reader it got is `req.log`, which is right for the three
     * render call sites — a render is a machine finishing a document and
     * nobody is standing over it.
     *
     * This route is the fourth caller and it is not that. It exists to hand a
     * reviewer everything wrong with this deliverable before it leaves, its own
     * docstring says "one place says whether this valuation may go out, and a
     * reviewer reads one list" — and it was building the exhibits, being told
     * which of them failed, and putting that in a channel the reviewer does not
     * read. The one failure that can happen here is a stored
     * `required_return_table` that will not parse, whose remedy is a row in
     * this firm's own params that somebody has to fix; the log line goes to an
     * operator who does not know it is missing from anything.
     *
     * `warn`, not `fail`, matching the level R344 argued for the log line and
     * for the same reason: the report is delivered and correct in everything it
     * prints. What it is missing is an appendix, and whether that is worth
     * holding publication for is the reviewer's call — which is the whole point
     * of putting it in front of them.
     *
     * Not folded into `report_coherence`. That check grades the body against
     * the schedules that exist, and it would find this one only if a chapter
     * happened to point at the missing appendix. A schedule nothing points at
     * fails just as completely and would stay invisible.
     */
    const scheduleStatus: QaStatus = issues.length > 0 ? 'warn' : 'pass';
    deterministic.checks.push({
      key: 'report_schedules',
      label: 'Every applicable schedule was built',
      status: scheduleStatus,
      detail:
        issues.length > 0
          ? `${issues.length === 1 ? 'A schedule' : `${issues.length} schedules`} could not be built and ${issues.length === 1 ? 'is' : 'are'} missing from the deliverable: ${issues
              .map((i) => `${i.schedule} (${i.reason})`)
              .join('; ')}`
          : 'No schedule failed to build.',
    });
    deterministic.status = worstStatus([deterministic.status, scheduleStatus]);

    let aiFindings: Record<string, unknown> | null = null;
    let aiModel: string | null = null;
    let status = deterministic.status;
    if (body.data.ai) {
      try {
        const { job } = await runAiPipeline(deps, {
          valuation,
          pipeline: 'qa',
          anonymize: false,
          autoApply: false,
          createdBy: principal.id,
          actor: { actorType: 'ai', actorId: principal.id, source: 'ai-service' },
          // The reviewer judges outputs, not source documents.
          includeDocuments: false,
          extraPayload: {
            calculation: calculationPayload(calculation),
            qa_checks: deterministic.checks,
          },
        });
        // The reviewer has to have actually spoken. A run settled out from
        // under its worker comes back carrying no result at all, and filing
        // that as the AI half of the review is the same thing as filing an
        // outage — see `assertRunStood`, and the comment on the catch below.
        assertRunStood(job);
        aiFindings = job.result;
        aiModel = job.model;
        status = combineWithAiVerdict(deterministic.status, job.result?.verdict);
      } catch (err) {
        // No review row on an AI outage — a half-run must not open the gate.
        if (err instanceof InternalServiceError) throw toProblem(err);
        throw err;
      }
    }

    // The engagement as it stands now. `refuseIfRetired` fired on the request,
    // and the AI reviewer above is given up to three minutes — see
    // `refuseIfRetiredNow`. A review filed against withdrawn work is a gate
    // artifact for a file the firm has closed, and it survives the withdrawal.
    await refuseIfRetiredNow(deps.pool, valuation.id, 'accepting changes');

    const review = await createQaReview(
      deps.pool,
      {
        valuationId: valuation.id,
        calculationId: calculation.id,
        /*
         * Which body was graded, so the publish gate can tell whether the
         * document has moved since. `report.current_version` rather than
         * `reportVersion.version`: they are the same row here, and the pointer
         * is what the gate compares against — reading the version off the
         * content row would make the two halves of the comparison come from
         * different places for no reason.
         *
         * Null when there is no report at all. That is not "unknown"; it is
         * "there was nothing to grade", and the gate treats an engagement with
         * no report the same way.
         */
        reportVersion: report?.current_version ?? null,
        status,
        checks: deterministic.checks,
        aiFindings,
        aiModel,
        createdBy: principal.id,
      },
      { actorType: body.data.ai ? 'ai' : 'system', actorId: principal.id, source: 'qa-gate' },
    );
    return reply.status(201).send({ review });
  });

  app.get('/api/v1/valuations/:id/qa', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    await loadValuation(id);
    const [{ reviews, truncated }, calculation, report] = await Promise.all([
      listQaReviews(deps.pool, id),
      latestSucceededCalculation(deps.pool, id),
      findReportByValuation(deps.pool, id),
    ]);
    // Which review (if any) currently satisfies the publish gate.
    const current = calculation ? (reviews.find((r) => r.calculation_id === calculation.id) ?? null) : null;
    /*
     * The body rule, reported here as well as enforced in `assertPublishGate`.
     *
     * This banner is the only place an analyst is told whether the engagement
     * can publish, and a banner that says "gate satisfied" over a gate that
     * returns 409 is worse than no banner. The two readings are deliberately
     * the same expression as rule 3 there — a report that exists, and a review
     * that either does not say which body it graded or graded an older one.
     */
    const bodyStale =
      report !== null &&
      current !== null &&
      (current.report_version === null || report.current_version > current.report_version);
    return {
      reviews,
      truncated,
      latest_calculation_id: calculation?.id ?? null,
      report_version: report?.current_version ?? null,
      gate: {
        satisfied: calculation ? current !== null && current.status !== 'fail' && !bodyStale : true,
        review_id: current?.id ?? null,
        status: current?.status ?? null,
        body_stale: bodyStale,
      },
    };
  });
}
