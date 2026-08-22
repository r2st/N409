import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { renderReportPdf, type ReportPdfSection, type ReportPdfSummary } from '@n409/report/pdf';
import { canEditWorkingData, canReadReport, canReadValuation } from '../auth/rbac.js';
import {
  contentFromManagedTemplate,
  DELIVERED_REPORT_STATES,
  instantiateTemplate,
  sanitizeContent,
  templateForKind,
  visibleSections,
  type ReportContent,
} from '../domain/report.js';
import { todayLocal } from '../domain/calendarDate.js';
import { parseIfMatch, versionEtag } from '../domain/concurrency.js';
import { isUniqueViolation } from '../db/pgError.js';
import { findActiveTemplateForKind, templateLabel } from '../repos/reportTemplates.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import {
  createReport,
  findReportByValuation,
  getVersion,
  listVersions,
  saveVersion,
  storeRenderedPdf,
  type ReportRow,
  type ReportVersionRow,
} from '../repos/reports.js';
import { buildReportSummary } from '../domain/reportSummary.js';
import { fillFigures, reportFigures, type ReportFigures } from '../domain/reportFigures.js';
import { applyNarrative, draftedSectionsFrom } from '../domain/narrativeApply.js';
import { latestSucceededJob } from '../repos/aiJobs.js';
import { runAiPipeline, type AiPipelineDeps } from './ai.js';
import { InternalServiceError, toProblem } from '../clients/internal.js';
import { buildExhibits } from '../domain/reportExhibits.js';
import { listComparableItems } from '../repos/comparableItems.js';
import { listWorkbookCells } from '../repos/workbook.js';
import { computeWorkbook } from '../domain/workbook.js';
import { impliedMultiples } from '../domain/comparables.js';
import { researchSourcesExhibit } from '../domain/researchExhibit.js';
import { listMarketResearch } from '../repos/marketResearch.js';
import { hmrcFormExhibit } from '../domain/specialtyExhibits.js';
import { loadHmrcForm } from '../repos/hmrcForms.js';
import { loadDebtReport, loadFundReport } from '../repos/measurementReport.js';
import { buildDebtExhibits, buildFundExhibits } from '../domain/navExhibits.js';
import { resolveExhibitReferences } from '../domain/reportExhibitIndex.js';
import { resolveSignatures } from '../domain/reportSignatures.js';
import { listSignatures } from '../repos/signatures.js';
import { findParams } from '../repos/params.js';
import { findCurrentVolatilityEstimate } from '../repos/volatilityEstimates.js';
import { findCurrentProjection } from '../repos/projections.js';
import { findAppliedRollforwardRun } from '../repos/rollforwardRuns.js';
import { sameCompanyFilter } from '../domain/valuationHistory.js';
import { fitsInt4, int4Version } from '../domain/int4.js';
import { latestSucceededCalculation } from '../repos/calculations.js';
import { findPartnerById } from '../repos/adminUsers.js';
import { fetchPartnerLogoCached } from '../clients/partnerLogoCache.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';
import { contentDisposition } from './documents.js';
import type { Principal } from '../auth/rbac.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';

const SectionSchema = z
  .object({
    key: z.string().min(1).max(100),
    heading: z.string().min(1).max(300),
    html: z.string().max(100_000),
    /**
     * Optional so every client that predates the toggle keeps saving valid
     * bodies, and so a section the analyst has never touched carries no key at
     * all rather than an explicit `false` per chapter.
     */
    hidden: z.boolean().optional(),
  })
  .strict();

const PutBody = z
  .object({
    content: z
      .object({
        title: z.string().min(1).max(300),
        sections: z.array(SectionSchema).min(1).max(50),
      })
      .strict(),
  })
  .strict();

const RevertBody = z.object({ version: int4Version() }).strict();

function actorFor(principal: Principal): EventActor {
  return { actorType: 'human', actorId: principal.id, source: 'api' };
}

function toRef(v: ValuationRow) {
  return { userId: v.user_id, partnerId: v.partner_id, state: v.state };
}

async function loadValuation(pool: pg.Pool, principal: Principal, id: string): Promise<ValuationRow> {
  if (!isUlid(id)) throw problems.notFound();
  const valuation = await findValuationById(pool, id);
  if (!valuation || !canReadValuation(principal, toRef(valuation))) throw problems.notFound();
  return valuation;
}

/** Ops-only load for editing operations. */
async function loadForEdit(pool: pg.Pool, principal: Principal, id: string): Promise<ValuationRow> {
  if (!canEditWorkingData(principal)) throw problems.forbidden();
  return loadValuation(pool, principal, id);
}

/**
 * The report version an editor is asserting it loaded, from `If-Match`.
 *
 * Opt-in, like the same header on the valuation: a client with no opinion sends
 * nothing and keeps the old last-write-wins behaviour. `*` asserts the report
 * exists, which the caller has already established by loading it, so it is not
 * a version check. A header that is present but unreadable is refused rather
 * than dropped — a typo'd validator that is silently ignored is a lost update
 * wearing a seatbelt that was never buckled.
 */
function expectedReportVersion(raw: string | string[] | undefined): number | undefined {
  const ifMatch = parseIfMatch(raw);
  if (ifMatch.kind === 'invalid') {
    throw problems.unprocessable(`Malformed If-Match header: ${ifMatch.raw}`);
  }
  return ifMatch.kind === 'version' ? ifMatch.version : undefined;
}

/**
 * The valuation date of this engagement, as the analyst stated it.
 *
 * Two places hold it and they are written at different times. The financial
 * model (`valuation_params.engine_inputs`) carries it from the moment the
 * analyst fills the inputs form; a calculation freezes a copy of the whole
 * payload when it runs. The calculation is preferred because a report states
 * what the run it reports on was computed as of, and the model can move
 * afterwards.
 */
async function valuationDateFor(pool: pg.Pool, valuationId: string): Promise<string | null> {
  const calculation = await latestSucceededCalculation(pool, valuationId);
  const payload = calculation?.inputs as { inputs?: { valuation_date?: unknown } } | undefined;
  const fromRun = payload?.inputs?.valuation_date;
  if (typeof fromRun === 'string' && fromRun) return fromRun.slice(0, 10);

  const params = await findParams(pool, valuationId);
  const model = params?.engine_inputs as { valuation_date?: unknown } | null | undefined;
  const fromModel = model?.valuation_date;
  return typeof fromModel === 'string' && fromModel ? fromModel.slice(0, 10) : null;
}

/**
 * `date` is the *valuation* date, not today's.
 *
 * It reads `{{date}}` in the skeleton and lands in the sentence that opens the
 * report ("as of {{date}}") and the one that concludes it. Filling it with the
 * clock made a §409A deliverable state a date that was merely when someone
 * first opened the report tab — while the summary page, which has always read
 * the engine payload, printed the real one a page earlier. The two disagreed on
 * paper, and the date on a 409A is not decorative: it starts the twelve months
 * of Treas. Reg. §1.409A-1(b)(5)(iv)(B)(1) over which grants may rely on the
 * appraisal.
 *
 * The clock remains the fallback for a report created before any valuation date
 * has been entered, which is the only case where there is nothing better; the
 * cover page and Exhibit H state the date from the calculation either way, so
 * the deliverable itself is right even then.
 */
function templateVars(valuation: ValuationRow, valuationDate: string | null) {
  return {
    company_name: valuation.company_name,
    kind: valuation.kind,
    valuation_ref: valuation.id,
    date: valuationDate ?? todayLocal(),
    currency: valuation.currency,
  };
}

/** Loads the report, creating it from the kind's template on first ops access. */
async function loadOrCreateReport(
  pool: pg.Pool,
  principal: Principal,
  valuation: ValuationRow,
): Promise<ReportRow> {
  const existing = await findReportByValuation(pool, valuation.id);
  if (existing) return existing;
  if (!canEditWorkingData(principal)) throw problems.notFound('No report yet');

  // Gap 6 — an ACTIVE managed template for this kind supplies the body of a
  // new report; the built-in skeleton is only the fallback.
  const managed = await findActiveTemplateForKind(pool, valuation.kind);
  const vars = templateVars(valuation, await valuationDateFor(pool, valuation.id));
  const { templateVersion, content } = managed
    ? { templateVersion: templateLabel(managed), content: contentFromManagedTemplate(managed, vars) }
    : (() => {
        const builtin = templateForKind(valuation.kind);
        return { templateVersion: builtin.version, content: instantiateTemplate(builtin, vars) };
      })();

  try {
    const created = await createReport(pool, {
      valuationId: valuation.id,
      templateVersion,
      content,
      actor: actorFor(principal),
    });
    return created.report;
  } catch (err) {
    /*
     * Somebody else opened the tab first.
     *
     * `reports.valuation_id` is UNIQUE, and the read above is a round trip: two
     * people opening the same engagement together — the analyst and the
     * reviewer, or one person and their second tab — both see no report, both
     * instantiate the template, and the second INSERT is refused. That surfaced
     * as a 500 on a read-only action, on an engagement where nothing was wrong.
     *
     * The constraint did its job: there is exactly one report and the loser
     * wants it, not an error. Re-read rather than retry the insert, and let a
     * violation of any other constraint through as the failure it is.
     */
    if (!isUniqueViolation(err, 'reports_valuation_id_key')) throw err;
    const winner = await findReportByValuation(pool, valuation.id);
    if (!winner) throw err;
    return winner;
  }
}

/** White-label branding for partner engagements (improvement 8). */
async function brandingFor(
  pool: pg.Pool,
  valuation: ValuationRow,
): Promise<{ partner_name: string; brand_color: string | null; logo: Buffer | null } | undefined> {
  if (!valuation.partner_id) return undefined;
  const partner = await findPartnerById(pool, valuation.partner_id);
  if (!partner || partner.archived_at) return undefined;
  return {
    partner_name: partner.name,
    brand_color: partner.brand_color,
    // Cached for a beat: the logo is the same bytes on every render, and
    // fetching it is a DNS lookup plus an HTTP GET on the render's critical
    // path. See clients/partnerLogoCache.ts.
    logo: await fetchPartnerLogoCached(partner.logo_url),
  };
}

/**
 * Concluded FMV of every prior valuation of the same company, oldest first —
 * the trend chart on the summary page.
 *
 * Scoped by `sameCompanyFilter`, shared with the analytics endpoint so the two
 * cannot answer "the same client" differently — which they did, both of them
 * wrongly, for a firm whose engagements are spread across its members. Only
 * runs strictly before this one count: a report states what was known on the
 * day it was drawn, and a later revision appearing in its own history chart
 * would be a document that changes after signature.
 */
async function historyFor(
  pool: pg.Pool,
  valuation: ValuationRow,
  before: Date,
): Promise<Array<{ as_of: string; fmv_per_share: number }>> {
  const scope = sameCompanyFilter(valuation);
  const { rows } = await pool.query<{ as_of: Date; fmv_per_share: string | null }>(
    `SELECT c.created_at AS as_of, c.fmv_per_share
       FROM valuations v
       JOIN LATERAL (
         SELECT created_at, fmv_per_share
           FROM calculations
          WHERE valuation_id = v.id
            AND status = 'succeeded'
            AND fmv_per_share IS NOT NULL
            AND created_at <= $3
          ORDER BY created_at DESC
          LIMIT 1
       ) c ON true
      WHERE ${scope.clause}
      ORDER BY c.created_at ASC`,
    [...scope.params, before],
  );
  return rows
    .map((r) => ({ as_of: new Date(r.as_of).toISOString(), fmv_per_share: Number(r.fmv_per_share) }))
    .filter((p) => Number.isFinite(p.fmv_per_share));
}

/**
 * Executive summary for this valuation, from its latest successful engine run.
 * A report drafted before the engine has produced a value renders without one.
 */
export async function summaryFor(
  pool: pg.Pool,
  valuation: ValuationRow,
): Promise<{
  summary: ReportPdfSummary | undefined;
  exhibits: ReportPdfSection[];
  valuationDate: string | null;
  /**
   * The concluded figures, for the `{{placeholders}}` the authored body carries.
   * Empty when no calculation has succeeded, which leaves them unresolved — see
   * domain/reportFigures.ts for why that is the right failure.
   */
  figures: ReportFigures;
}> {
  /*
   * Every loader below reads a different table keyed on the same valuation, and
   * not one of them takes an argument the others produce — yet they used to run
   * strictly one after another, so rendering a report cost nine sequential
   * round trips to Postgres before the first byte of PDF existed. Only the
   * price-history query genuinely depends on anything: it is cut off at the
   * adopted calculation's timestamp, so it has to see that row first.
   *
   * So: one wave for the calculation, then one wave for everything else. The
   * loaders are unchanged and so is the order the exhibits are assembled in
   * below — this is purely about not waiting for a query to answer a question
   * the next query never asks.
   */
  const calculation = await latestSucceededCalculation(pool, valuation.id);
  const payload = calculation?.inputs as { inputs?: { valuation_date?: unknown } } | undefined;
  const rawDate = payload?.inputs?.valuation_date;
  const valuationDate = typeof rawDate === 'string' && rawDate ? rawDate.slice(0, 10) : null;
  const [
    history,
    peerRows,
    paramsRow,
    workbookCells,
    volatility,
    projection,
    hmrcForm,
    fundReport,
    debtReport,
    research,
    rollforward,
  ] = await Promise.all([
    calculation ? historyFor(pool, valuation, calculation.created_at) : Promise.resolve([]),
    // The peer set behind the market approach (design §4.5). Empty for every
    // engagement nobody has screened, and Exhibit D-1 then does not render.
    listComparableItems(pool, valuation.id),
    // The analyst's concluded stage of enterprise development, from the
    // methodology params. Absent until they have concluded one — it is never
    // inferred, so a report with no stage on it is one where nobody has said.
    findParams(pool, valuation.id),
    // The reported financial statements behind the Financial Analysis chapter
    // (Appendix II). Resolved rather than read below: the derived rows —
    // margins, subtotals, growth — are recomputed exactly as the workbook UI
    // computes them, so the appendix cannot print a margin the workbook
    // disagrees with. Empty for an engagement whose financials nobody has
    // entered, and the appendix is then not rendered.
    listWorkbookCells(pool, valuation.id),
    // Where sigma came from (migration 0134). The *adopted* run where there is
    // one, so Exhibit F-1 describes the derivation the allocation actually ran
    // on; null for every engagement whose analyst selected sigma by judgement,
    // and the exhibit is then not rendered.
    findCurrentVolatilityEstimate(pool, valuation.id),
    // Where the DCF's cash flows came from (migration 0136). The *adopted* run
    // where there is one, so Exhibit C-1 describes the forecast the income
    // approach actually ran on; null for every engagement whose stream was
    // entered by hand, and the exhibit is then not rendered.
    findCurrentProjection(pool, valuation.id),
    // UK option-scheme deliverables carry the HMRC agreement request as a final
    // appendix. Null for every other kind, so nothing changes for a 409A.
    loadHmrcForm(pool, valuation),
    // The two measurement kinds keep their figures outside `calculations` — a
    // fund in its marks, an instrument in its valuation history — so their
    // schedules are loaded rather than derived from the run above. Both return
    // null for every other kind.
    loadFundReport(pool, valuation),
    loadDebtReport(pool, valuation),
    // The public sources behind the market discussion (migration 0116). Live
    // rows only: a superseded answer is not what this report was drafted from.
    listMarketResearch(pool, valuation.id),
    // The bridge from the prior 409A (migration 0150). The *applied* run only,
    // so Exhibit B-2 describes the anchor the allocation actually ran on; null
    // for every engagement valued from scratch, and the exhibit is then not
    // rendered.
    findAppliedRollforwardRun(pool, valuation.id),
  ]);
  // `.cells` only: the page is bounded well above every address the workbook
  // model defines (see WORKBOOK_CELL_LIMIT), and `computeWorkbook` reads only
  // those addresses — so the appendix this feeds cannot be built from a partial
  // model by way of the cap.
  const financials = computeWorkbook(workbookCells.cells);
  const peers = peerRows.map((row) => ({
    ticker: row.ticker,
    name: row.name,
    included: row.included,
    exclude_reason: row.exclude_reason,
    source: row.source,
    score: row.score,
    multiples: impliedMultiples(row),
    // Where the figures behind the multiples came from — Exhibit D-1 states it,
    // and cannot state it if the row is not carried this far.
    figures_source: row.figures_source,
    figures_as_of: row.figures_as_of,
  }));
  const context = {
    currency: valuation.currency,
    companyName: valuation.company_name,
    valuationDate,
    peers,
    financials,
    developmentStage: paramsRow?.development_stage ?? null,
    // A firm's own required-return ladder, where it has supplied one; the
    // built-in literature ranges otherwise (Appendix III).
    requiredReturnTable: paramsRow?.required_return_table ?? null,
    volatility,
    projection,
    rollforward,
  };
  return {
    summary: buildReportSummary(calculation, { ...context, history }) ?? undefined,
    // Built from the same calculation the summary is, so a figure on the
    // summary page and the schedule behind it cannot come from different runs.
    exhibits: [
      ...buildExhibits(calculation, context),
      ...buildFundExhibits(fundReport, context),
      ...buildDebtExhibits(debtReport, context),
      // After the schedules, because the form restates figures the exhibits
      // derive and a reader should meet the derivation first.
      ...(hmrcForm ? [hmrcFormExhibit(hmrcForm)] : []),
      // Last: it is the bibliography, and a reader looks for one at the end.
      ...[researchSourcesExhibit(research)].filter((s): s is ReportPdfSection => s !== null),
    ],
    valuationDate,
    figures: reportFigures(calculation, valuation.currency),
  };
}

/**
 * The stamp a render of this engagement's report should carry, or null once the
 * document is the deliverable.
 *
 * The report is readable outside ops from `drafted` (`REPORT_VISIBLE_STATES`),
 * which is several steps before the QA review closes, the signature lands and
 * the engagement publishes. Until this existed, the PDF a client downloaded at
 * `drafted` was byte-identical to the signed deliverable — and it does not stay
 * with the person who downloaded it. It goes to an auditor, into a board pack,
 * into a data room, and every reader downstream takes an unmarked valuation
 * report as final.
 *
 * Keyed on the same set the "do not re-render a delivered deliverable" guard
 * uses, so the two cannot drift into disagreeing about what "delivered" means.
 */
export function reportWatermarkFor(valuation: Pick<ValuationRow, 'state'>): string | null {
  return DELIVERED_REPORT_STATES.has(valuation.state) ? null : 'Draft';
}

async function renderVersionPdf(
  pool: pg.Pool,
  valuation: ValuationRow,
  report: ReportRow,
  version: number,
  content: ReportContent,
  actor: EventActor,
  opts: { watermark?: string | null; store?: boolean } = {},
): Promise<Buffer> {
  const watermark = opts.watermark ?? null;
  // One instant for both the cover's "Rendered" line and the PDF's own
  // CreationDate, so a reader comparing the two never sees them disagree.
  const renderedAt = new Date();
  // Branding is a partner lookup plus, on a white-labelled engagement, a logo
  // fetch over the network. It has nothing to say about the figures, so it has
  // no reason to wait behind them.
  const [{ summary, exhibits, valuationDate, figures }, branding, signatories] = await Promise.all([
    summaryFor(pool, valuation),
    brandingFor(pool, valuation),
    // Who signed. Not part of `summaryFor`, which loads what the *calculation*
    // needs — a signature is a fact about the engagement's approval and moves
    // on its own clock, after the figures have stopped changing. Alongside the
    // branding fetch for the same reason: it has nothing to say about any
    // number on the page and no reason to wait behind one.
    listSignatures(pool, valuation.id),
  ]);
  // The authored body states the conclusion, and only the calculation knows it.
  // Resolved here rather than at instantiation, and never written back: the
  // stored version keeps its placeholders, so a re-render after a recalculation
  // restates the prose instead of leaving a stale number in it. See
  // domain/reportFigures.ts.
  // Which exhibits this report contains is a fact about the calculation, so the
  // index of them and the body's pointers into them are resolved here, from the
  // very list about to be rendered — never written back, exactly as the figures
  // below are. See domain/reportExhibitIndex.ts.
  // The whole sections rather than their headings: an exhibit assembled from
  // separately-conditional blocks declares what it actually printed, and a
  // pointer at one of those blocks resolves against that. See
  // `renderedScheduleIds`.
  // The certification is signed at render for the same reason the figures are
  // filled at render: the stored body must keep its marker so that re-rendering
  // after a concurring reviewer signs — or after a signature is replaced —
  // restates the block rather than leaving the previous one in place. See
  // domain/reportSignatures.ts.
  const body = fillFigures(
    resolveSignatures(resolveExhibitReferences(content, exhibits), signatories),
    figures,
  );
  const pdf = await renderReportPdf({
    title: body.title,
    company_name: valuation.company_name,
    meta: [
      { label: 'Engagement', value: valuation.id },
      { label: 'Kind', value: valuation.kind },
      // Ahead of "Rendered", and stated separately from it. A reader who takes
      // the cover date as the valuation date takes the wrong one otherwise, and
      // on a §409A the valuation date is what a grant's safe harbour is measured
      // from. Only shown when the engagement has one — an unrun valuation has no
      // date to state and inventing one would be worse than the omission.
      ...(valuationDate ? [{ label: 'Valuation date', value: valuationDate }] : []),
      { label: 'Template', value: report.template_version },
      { label: 'Version', value: `v${version}` },
      { label: 'Currency', value: valuation.currency },
      { label: 'Rendered', value: renderedAt.toISOString().slice(0, 10) },
    ],
    // The authored body first, then the computed schedules it refers to.
    // Hidden chapters are dropped here, at the render boundary, so a hidden one
    // is genuinely absent rather than blank: the numbering, the contents, the
    // bookmarks and the running heads are all derived from this list.
    sections: [...visibleSections(body).map((s) => ({ heading: s.heading, html: s.html })), ...exhibits],
    summary,
    branding,
    generated_at: renderedAt,
    keywords: [
      valuation.company_name,
      valuation.kind,
      'valuation',
      `v${version}`,
      // In the keywords as well as on the page: a data room and a document
      // management system index this dictionary and never look at the cover, so
      // a draft filed alongside finals is findable as one.
      ...(watermark ? [watermark.toLowerCase()] : []),
    ],
    watermark,
  });
  if (opts.store !== false) await storeRenderedPdf(pool, { report, version, pdf, actor });
  return pdf;
}

/**
 * The bytes to serve for a stored version — the deliverable, stamped if the
 * engagement has not yet delivered it.
 *
 * The rule this settles on: *the store holds the deliverable, and the stamp is
 * a property of the moment the document is served.* `report_versions.pdf` is
 * the canonical, unstamped render, and every read path decides for itself
 * whether the reader is being handed a draft.
 *
 * The obvious alternative — stamp the render and cache that — was written first
 * and is wrong, because the cache is not a cache in the ordinary sense. Nothing
 * re-renders at publication, deliberately: the exhibits are derived at render
 * time from the latest calculation, so re-rendering a delivered version in
 * place would put a different concluded value under a version number the client
 * is already holding, and nobody outside this system could tell. Stored bytes
 * are therefore *frozen*, and a stamp baked into frozen bytes outlives the
 * draft it described — a published 409A that says DRAFT forever, which is the
 * failure this whole change exists to prevent, arrived at from the other side.
 *
 * So a draft download renders fresh and stores nothing. It costs a render per
 * download, which is the right way round: a draft is the version somebody is
 * still editing, and the delivered one — the version read over and over by
 * auditors and boards for the next year — is the one that stays cached.
 */
export async function deliverablePdf(
  pool: pg.Pool,
  valuation: ValuationRow,
  report: ReportRow,
  version: Pick<ReportVersionRow, 'version' | 'content' | 'pdf'>,
  actor: EventActor,
): Promise<Buffer> {
  const watermark = reportWatermarkFor(valuation);
  if (watermark) {
    return renderVersionPdf(pool, valuation, report, version.version, version.content, actor, {
      watermark,
      store: false,
    });
  }
  return version.pdf ?? renderVersionPdf(pool, valuation, report, version.version, version.content, actor);
}

const NarrativeBody = z
  .object({
    /** Replace chapters an analyst has already written. Deliberate, never default. */
    overwrite: z.boolean().default(false),
    /** Reuse the last successful draft instead of paying for a new one. */
    reuse: z.boolean().default(true),
  })
  .default({ overwrite: false, reuse: true });

export function registerReportRoutes(
  app: FastifyInstance,
  /**
   * The AI half is optional so the many tests that mount reports alone keep
   * working; without it the narrative route reports itself unavailable rather
   * than failing at the first fetch.
   */
  deps: { pool: pg.Pool; ai?: AiPipelineDeps },
): void {
  app.get('/api/v1/valuations/:id/report', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(deps.pool, principal, id);
    if (!canReadReport(principal, toRef(valuation))) throw problems.notFound();
    const report = await loadOrCreateReport(deps.pool, principal, valuation);
    const version = await getVersion(deps.pool, report.id, report.current_version);
    // The validator an editor sends back as If-Match when it saves. The report
    // pointer, not the valuation's `version` — the two move independently and
    // an analyst editing prose is racing other prose, not the engagement's
    // fields.
    reply.header('ETag', versionEtag(report.current_version));
    return {
      report,
      version: version
        ? { version: version.version, content: version.content, rendered_at: version.rendered_at }
        : null,
    };
  });

  app.put('/api/v1/valuations/:id/report', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadForEdit(deps.pool, principal, id);
    refuseIfRetired(valuation, 'accepting report edits');

    // Parsed before the body so a malformed header fails the same way whatever
    // the editor is trying to save.
    const expectedVersion = expectedReportVersion(req.headers['if-match']);

    const parsed = PutBody.safeParse(req.body);
    if (!parsed.success)
      throw problems.unprocessable('Invalid report content', { errors: parsed.error.issues });

    const report = await loadOrCreateReport(deps.pool, principal, valuation);
    const content = sanitizeContent(parsed.data.content);
    const saved = await saveVersion(deps.pool, {
      report,
      content,
      actor: actorFor(principal),
      origin: 'editor',
      expectedVersion,
    });
    reply.header('ETag', versionEtag(saved.report.current_version));
    return {
      report: saved.report,
      version: { version: saved.version.version, content: saved.version.content, rendered_at: null },
    };
  });

  app.get('/api/v1/valuations/:id/report/versions', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadForEdit(deps.pool, principal, id);
    const report = await findReportByValuation(deps.pool, valuation.id);
    if (!report) return { versions: [] };
    return { versions: await listVersions(deps.pool, report.id) };
  });

  app.get(
    '/api/v1/valuations/:id/report/versions/:version',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      const { id, version: versionParam } = req.params as { id: string; version: string };
      const valuation = await loadForEdit(deps.pool, principal, id);
      const versionNumber = Number(versionParam);
      // A version past int4 cannot name a stored row, so it is a 404 like any
      // other missing version — never a 500 from the driver.
      if (!fitsInt4(versionNumber) || versionNumber < 1) throw problems.notFound();
      const report = await findReportByValuation(deps.pool, valuation.id);
      const version = report ? await getVersion(deps.pool, report.id, versionNumber) : null;
      if (!version) throw problems.notFound();
      return {
        version: {
          version: version.version,
          content: version.content,
          rendered_at: version.rendered_at,
          created_by: version.created_by,
          created_at: version.created_at,
        },
      };
    },
  );

  app.post('/api/v1/valuations/:id/report/revert', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadForEdit(deps.pool, principal, id);
    refuseIfRetired(valuation, 'accepting report edits');
    const expectedVersion = expectedReportVersion(req.headers['if-match']);

    const parsed = RevertBody.safeParse(req.body);
    if (!parsed.success)
      throw problems.unprocessable('Invalid revert request', { errors: parsed.error.issues });

    const report = await findReportByValuation(deps.pool, valuation.id);
    const target = report ? await getVersion(deps.pool, report.id, parsed.data.version) : null;
    if (!report || !target) throw problems.notFound('Version not found');
    if (parsed.data.version === report.current_version) {
      throw problems.conflict('Already at this version');
    }

    // Revert = append the old content as a NEW version; history is never rewritten.
    const saved = await saveVersion(deps.pool, {
      report,
      content: target.content,
      actor: actorFor(principal),
      origin: { revertedFrom: target.version },
      expectedVersion,
    });
    reply.header('ETag', versionEtag(saved.report.current_version));
    return {
      report: saved.report,
      version: { version: saved.version.version, content: saved.version.content, rendered_at: null },
    };
  });

  /**
   * Re-draft the body from the kind's current template.
   *
   * `GET /report` creates a report from the template on first ops access and
   * never touches it again, which is right — the body is authored, and an
   * analyst's prose must not be overwritten by a deployment. But it left no way
   * to *adopt* a newer skeleton on an engagement that already has a report, and
   * that is what a template version is for: v56 states the concluded figures
   * and carries four chapters v55 did not, and every open engagement was stuck
   * on whatever skeleton existed the day someone first opened its report tab.
   *
   * Appends a new version rather than replacing the current one, so the
   * analyst's existing draft stays in the history and a revert is one call
   * away. Ops-only, like every other write here.
   */
  app.post('/api/v1/valuations/:id/report/draft', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadForEdit(deps.pool, principal, id);
    // Before `loadOrCreateReport`, which would otherwise *create* a report row
    // for a withdrawn engagement on the way to refusing the request.
    refuseIfRetired(valuation, 'accepting report edits');
    const report = await loadOrCreateReport(deps.pool, principal, valuation);

    const managed = await findActiveTemplateForKind(deps.pool, valuation.kind);
    const vars = templateVars(valuation, await valuationDateFor(deps.pool, valuation.id));
    const { templateVersion, content } = managed
      ? { templateVersion: templateLabel(managed), content: contentFromManagedTemplate(managed, vars) }
      : (() => {
          const builtin = templateForKind(valuation.kind);
          return { templateVersion: builtin.version, content: instantiateTemplate(builtin, vars) };
        })();

    const saved = await saveVersion(deps.pool, {
      report,
      content,
      actor: actorFor(principal),
      origin: { redraftedFrom: templateVersion },
      templateVersion,
    });
    return {
      report: saved.report,
      version: { version: saved.version.version, content: saved.version.content, rendered_at: null },
      template_version: templateVersion,
    };
  });

  /**
   * Draft the report's prose from the finished calculation, and put it in.
   *
   * Every piece of this existed and none of it reached the deliverable. The
   * `report_narrative` agent drafts the chapters from the run and from whatever
   * grounded research the engagement has retrieved; its output landed in
   * `ai_jobs.result`, and the only writes to the report body were the editor
   * and a revert. An analyst read the draft in one tab and retyped it into
   * another — and when nobody did, the 409A shipped with the skeleton's
   * instructional text where its Company Overview belonged.
   *
   * The safety property is that written prose is never overwritten: a chapter
   * is replaced only where it still holds the skeleton's fill-me marker.
   * `overwrite` is available and is a deliberate act, because a re-run silently
   * discarding an afternoon's editing is the failure that would stop anyone
   * using this.
   */
  app.post('/api/v1/valuations/:id/report/narrative', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadForEdit(deps.pool, principal, id);
    refuseIfRetired(valuation, 'accepting report edits');
    if (!deps.ai) throw problems.unprocessable('The narrative agent is not configured');

    const parsed = NarrativeBody.safeParse(req.body ?? {});
    if (!parsed.success) throw problems.unprocessable('Invalid options', { errors: parsed.error.issues });

    const report = await loadOrCreateReport(deps.pool, principal, valuation);
    const version = await getVersion(deps.pool, report.id, report.current_version);
    if (!version) throw problems.notFound('No report content to draft into');
    if (DELIVERED_REPORT_STATES.has(valuation.state)) {
      throw problems.conflict('This engagement is published — save a new version before drafting into it');
    }

    /*
     * Reuse a recent draft rather than paying for a new one.
     *
     * The agent is expensive and the answer only moves when the calculation
     * does. `reuse: false` forces a fresh run, which is what an analyst who has
     * just changed the research or the params wants.
     */
    let job = parsed.data.reuse ? await latestSucceededJob(deps.pool, id, 'report_narrative') : null;
    if (!job) {
      try {
        ({ job } = await runAiPipeline(deps.ai, {
          valuation,
          pipeline: 'report_narrative',
          anonymize: false,
          autoApply: false,
          createdBy: principal.id,
          actor: { actorType: 'ai', actorId: principal.id, source: 'ai-service' },
          includeDocuments: false,
        }));
      } catch (err) {
        if (err instanceof InternalServiceError) throw toProblem(err);
        throw err;
      }
    }

    const drafted = draftedSectionsFrom(job.result);

    /*
     * Re-read the body the draft is applied to, after the agent has run.
     *
     * `version` above was read before `runAiPipeline`, and that call is a round
     * trip to the AI service that takes minutes. An analyst saving a chapter in
     * that window is the ordinary case, not the exotic one — the button that
     * starts this is in the same tab as the editor, and a run is exactly the
     * length of time somebody uses to write while they wait. Applying to the
     * body as it was read would carry the pre-edit text back over the top of
     * their work, and because the agent's whole contract is "fills the chapters
     * nobody has written" the result reads as if it had honoured that.
     *
     * Applying to the current body loses nothing: `applyNarrative` decides what
     * is unwritten by comparing against v1, so a chapter saved during the run is
     * a written one and is left alone, exactly as it would have been had it been
     * saved a minute earlier.
     */
    const current = (await findReportByValuation(deps.pool, valuation.id)) ?? report;
    const target = (await getVersion(deps.pool, current.id, current.current_version)) ?? version;

    /*
     * Version 1 is the template as instantiated for this engagement, and
     * `saveVersion` appends rather than rewrites — so it is still the pristine
     * skeleton however many edits followed, and a chapter identical to its v1
     * text is one nobody has written. That is the whole overwrite rule.
     */
    const baseline = target.version === 1 ? target : await getVersion(deps.pool, current.id, 1);
    const calculation = await latestSucceededCalculation(deps.pool, valuation.id);
    const outcome = applyNarrative(target.content, drafted, {
      overwrite: parsed.data.overwrite,
      baseline: baseline?.content ?? null,
      // Which chapter each drafted section belongs in is a property of the
      // deliverable, not of the agent's vocabulary: an ASC 820 hierarchy
      // section has no home in a 409A's chapter list and vice versa.
      kind: valuation.kind,
      // Only consulted when there is no baseline to compare against.
      figures: reportFigures(calculation, valuation.currency),
    });

    // No new version when nothing moved: a run that wrote nothing should not
    // leave a version in the history claiming it did.
    if (!outcome.changed) {
      return { version: target.version, job_id: job.id, applied: outcome.applied, changed: false };
    }

    const saved = await saveVersion(deps.pool, {
      report: current,
      content: sanitizeContent(outcome.content),
      actor: actorFor(principal),
      origin: { redraftedFrom: `ai:report_narrative:${job.id}` },
      // Closes the last gap: a save landing between the read just above and
      // this write. Refused rather than applied to a body that has moved again.
      expectedVersion: current.current_version,
    });
    return {
      version: saved.version.version,
      job_id: job.id,
      applied: outcome.applied,
      changed: true,
    };
  });

  app.post('/api/v1/valuations/:id/report/render', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadForEdit(deps.pool, principal, id);
    // Same as the draft route: refuse before `loadOrCreateReport` writes a row.
    refuseIfRetired(valuation, 'available for rendering');
    const report = await loadOrCreateReport(deps.pool, principal, valuation);
    const version = await getVersion(deps.pool, report.id, report.current_version);
    if (!version) throw problems.notFound('No report content to render');
    /*
     * A delivered deliverable is not re-rendered in place.
     *
     * The exhibits are computed at render time from the latest calculation —
     * which is what keeps them agreeing with the summary page, and equally what
     * means a recalculation moves every figure a re-render would produce. On a
     * published engagement the client already holds the PDF: it is in board
     * minutes and in an auditor's file. Overwriting it would put a different
     * document under the same "v3", with a different concluded value, and
     * nobody outside this system could tell.
     *
     * Saving the report creates a new version, and that version renders
     * normally — so the way to publish revised figures is the way that leaves
     * both documents in the history.
     */
    if (DELIVERED_REPORT_STATES.has(valuation.state) && version.pdf) {
      throw problems.conflict(
        `Version ${version.version} has already been delivered — save a new version to publish revised figures`,
      );
    }
    const pdf = await renderVersionPdf(
      deps.pool,
      valuation,
      report,
      version.version,
      version.content,
      actorFor(principal),
    );
    return { version: version.version, size_bytes: pdf.length, rendered_at: new Date().toISOString() };
  });

  // The deliverable. Ops always; clients/partners once drafted (canReadReport).
  app.get('/api/v1/valuations/:id/report.pdf', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(deps.pool, principal, id);
    if (!canReadReport(principal, toRef(valuation))) throw problems.notFound();

    const report = await findReportByValuation(deps.pool, valuation.id);
    const version = report ? await getVersion(deps.pool, report.id, report.current_version) : null;
    if (!report || !version) throw problems.notFound('No report yet');

    const pdf = await deliverablePdf(deps.pool, valuation, report, version, {
      actorType: 'system',
      actorId: principal.id,
      source: 'report.pdf',
    });

    const filename = `${valuation.company_name}_${valuation.kind}_v${version.version}.pdf`;
    return reply
      .type('application/pdf')
      .header('content-disposition', contentDisposition(filename, 'inline'))
      .send(pdf);
  });
}
