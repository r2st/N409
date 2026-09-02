import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import type { ReportPdfSection, ReportPdfSummary } from '@n409/report/pdf';
import { renderReportPdf } from '../clients/reportRender.js';
import { canEditWorkingData, canReadReport, canReadValuation, isOps } from '../auth/rbac.js';
import {
  contentFromManagedTemplate,
  DELIVERED_REPORT_STATES,
  instantiateTemplate,
  reportStatusFor,
  sanitizeContent,
  templateForKind,
  visibleSections,
  type ReportContent,
} from '../domain/report.js';
import { todayLocal } from '../domain/calendarDate.js';
import { malformedIfMatch, parseIfMatch, versionEtag } from '../domain/concurrency.js';
import { isUniqueViolation } from '../db/pgError.js';
import { findActiveTemplateForKind, templateLabel } from '../repos/reportTemplates.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import {
  createReport,
  findReportByValuation,
  getVersionContent,
  getVersionPdf,
  deliverableVersion,
  listVersions,
  REPORT_VERSION_PAGE_LIMIT,
  reportView,
  saveVersion,
  storeRenderedPdf,
  type ReportRow,
  type ReportVersionContent,
} from '../repos/reports.js';
import { buildReportSummary } from '../domain/reportSummary.js';
import { fillFigures, reportFigures, type ReportFigures } from '../domain/reportFigures.js';
import { applyNarrative, draftedSectionsFrom } from '../domain/narrativeApply.js';
import { latestSucceededJob } from '../repos/aiJobs.js';
import { assertRunStood, calculationPayload, runAiPipeline, type AiPipelineDeps } from './ai.js';
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
import { FMV_TREND_KINDS, sameCompanyFilter } from '../domain/valuationHistory.js';
import { kindLabel } from '../domain/valuationSelector.js';
import { fitsInt4, int4Version } from '../domain/int4.js';
import { latestCalculationForKind } from '../repos/calculations.js';
import { findBrandingByPartnerId } from '../repos/branding.js';
import { liveBrand } from '../domain/branding.js';
import { fetchPartnerLogoCached } from '../clients/partnerLogoCache.js';
import { requirePrincipal } from '../plugins/auth.js';
import { recordEvent, type EventActor } from '../events/record.js';
import { withTransaction } from '../db/pool.js';
import { contentDisposition } from './documents.js';
import type { Principal } from '../auth/rbac.js';
import { refuseIfRetired, refuseIfRetiredNow } from '../domain/retiredEngagement.js';
import { invalidBody } from '../domain/validationProblem.js';
import { nonBlankText } from '../domain/nonBlankText.js';
import { forbidden } from '../domain/accessProblem.js';

const SectionSchema = z
  .object({
    key: z.string().min(1).max(100),
    heading: nonBlankText(1, 300),
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
        title: nonBlankText(1, 300),
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
  if (!canEditWorkingData(principal)) throw forbidden('Editing the report', 'working-data');
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
    throw malformedIfMatch(ifMatch);
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
async function valuationDateFor(pool: pg.Pool, valuation: ValuationRow): Promise<string | null> {
  const calculation = await latestCalculationForKind(pool, valuation.id, valuation.kind);
  const payload = calculation?.inputs as { inputs?: { valuation_date?: unknown } } | undefined;
  const fromRun = payload?.inputs?.valuation_date;
  if (typeof fromRun === 'string' && fromRun) return fromRun.slice(0, 10);

  const params = await findParams(pool, valuation.id);
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
  const vars = templateVars(valuation, await valuationDateFor(pool, valuation));
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

/**
 * White-label branding for partner engagements (improvement 8).
 *
 * Resolved through `resolveBranding`, the same function the SPA, the login page
 * and the client intake read — because a firm's brand has to be one brand. This
 * read used to go to `findPartnerById`, whose column list predates migration
 * 0091 and stops at `name`/`brand_color`/`logo_url`, so the cover was rendering
 * from the pre-white-label fields alone. Two things followed from that.
 *
 * The cover named the firm by `partners.name`, which 0091 is explicit about
 * being "the internal label ops picked for the channel and is not necessarily
 * what clients should read". A firm that set `brand_name` saw it in the
 * product, on its login page and in its client intake, and then read its ops
 * channel label on the one artefact that leaves the building.
 *
 * And the brand assets ignored `white_label_enabled` entirely. That switch is
 * the whole staging story — a firm loads its colour and logo, checks the
 * preview, and goes live in one flip — so a brand that was deliberately *not*
 * live was going out on every client-facing report, and turning the switch off
 * again reverted everything except the deliverable.
 *
 * The attribution line itself is not gated: naming the firm that prepared the
 * report is a fact about the engagement and predates white label (0047). What
 * is gated is the firm's colour and mark, which are the brand.
 */
export async function brandingFor(
  pool: pg.Pool,
  valuation: ValuationRow,
): Promise<{ partner_name: string; brand_color: string | null; logo: Buffer | null } | undefined> {
  if (!valuation.partner_id) return undefined;
  // Archived partners resolve to null here, the same rule every other branding
  // read applies — a closed firm stops branding anything.
  const source = await findBrandingByPartnerId(pool, valuation.partner_id);
  if (!source) return undefined;
  // `liveBrand`: the firm's public name either way, and its colour and mark
  // only once white label is live. The accent is the resolved one rather than
  // the raw column — a colour that cannot be seen on a light ground is lifted
  // until it can, and the cover band and rule are drawn on one, so a report and
  // the application it came from are the same green.
  const brand = liveBrand(source);
  return {
    partner_name: brand.name,
    brand_color: brand.accent,
    // Cached for a beat: the logo is the same bytes on every render, and
    // fetching it is a DNS lookup plus an HTTP GET on the render's critical
    // path. See clients/partnerLogoCache.ts.
    logo: await fetchPartnerLogoCached(brand.logo_url),
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
 *
 * And only the kinds that conclude the figure this chart is named after —
 * `FMV_TREND_KINDS`. `fmv_per_share` is a 409A column that every specialty
 * engine also writes into, so without the restriction an EMI scheme valuation
 * put its *actual* (restricted) market value on a line labelled "Concluded FMV
 * of each prior valuation of this company".
 *
 * Each point is dated by the run's own **measurement date** — `valuation_date`
 * off the inputs the calculation was made from — and not by `created_at`, the
 * moment the engine happened to run. The two agree only while nobody
 * recalculates, and a 409A is recalculated for ordinary reasons: a review
 * finding, a corrected share count, an approach re-weighted. Once one is, the
 * run timestamp says when the arithmetic was redone and the chart printed that
 * under a point captioned as a prior valuation.
 *
 * It is wrong in two ways at once. The label under each marker is a date the
 * valuation it names was not made as of — including this valuation's own last
 * point, whose date then disagrees with the measurement date on the cover of
 * the same PDF. And the *order* follows the timestamps: an engagement dated
 * last December but recalculated after this one's run sorts to the right of it,
 * so a line captioned "oldest first" plots the client's history out of
 * sequence and the trend a board reads off it is not the client's.
 *
 * `created_at` still bounds the series — a report states what was known on the
 * day it was drawn — because that is a question about when a run existed, which
 * is the one question the timestamp is the right answer to.
 */
async function historyFor(
  pool: pg.Pool,
  valuation: ValuationRow,
  before: Date,
): Promise<Array<{ as_of: string; fmv_per_share: number }>> {
  const scope = sameCompanyFilter(valuation);
  const { rows } = await pool.query<{ as_of: string; fmv_per_share: string | null }>(
    // The measurement date is a free-form JSON field, so it is taken only when
    // it is spelled as a calendar day and `created_at` stands in otherwise —
    // the pre-`valuation_date` runs, and any row whose blob holds something
    // else. Both legs come back as `YYYY-MM-DD` text rather than as a `date`,
    // which the driver would hand back as midnight *local* (domain/calendarDate).
    `SELECT COALESCE(
              NULLIF(substring(c.inputs->>'valuation_date' from '^\\d{4}-\\d{2}-\\d{2}'), ''),
              to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
            ) AS as_of,
            c.created_at, c.fmv_per_share
       FROM valuations v
       JOIN LATERAL (
         SELECT created_at, fmv_per_share, inputs
           FROM calculations
          WHERE valuation_id = v.id
            AND status = 'succeeded'
            AND fmv_per_share IS NOT NULL
            AND created_at <= $3
          ORDER BY created_at DESC
          LIMIT 1
       ) c ON true
      WHERE ${scope.clause}
        AND v.kind = ANY($4)
      ORDER BY as_of ASC, c.created_at ASC`,
    [...scope.params, before, FMV_TREND_KINDS],
  );
  return rows
    .map((r) => ({ as_of: r.as_of, fmv_per_share: Number(r.fmv_per_share) }))
    .filter((p) => Number.isFinite(p.fmv_per_share));
}

/**
 * The reader for a schedule that could not be built. Structurally typed rather
 * than `FastifyBaseLogger`, so the sample renderer and the tests can pass one.
 */
export type ReportIssueLog = { warn: (obj: object, msg: string) => void };

/**
 * A schedule that failed to build, as `ExhibitContext.onIssue` reports it.
 *
 * `schedule` is the identifier the exhibit index and the body's pointers use,
 * so a reviewer reading this in a QA list is reading the same name the report
 * would have used for it.
 */
export interface ScheduleIssue {
  schedule: string;
  reason: string;
}

/**
 * Executive summary for this valuation, from its latest successful engine run.
 * A report drafted before the engine has produced a value renders without one.
 */
export async function summaryFor(
  pool: pg.Pool,
  valuation: ValuationRow,
  /**
   * Where a schedule that could not be built says so (R344, M5).
   *
   * Optional because the three test callers and the sample renderer have no
   * request behind them; every route that builds a real engagement's report
   * passes `req.log`. See `ExhibitContext.onIssue`.
   */
  log?: ReportIssueLog,
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
  /**
   * The schedules that could not be built, for a caller that has a reader other
   * than the journal (R345, methodology M11).
   *
   * R344 gave the failure a log line, which is the right channel for the three
   * render call sites: a render is a machine finishing a document, and the
   * person who has to fix the stored row is not standing over it. The QA route
   * is the fourth caller and it is not that — it exists to hand a reviewer the
   * list of everything wrong with this deliverable before it leaves, and it was
   * building the exhibits, seeing the failure and putting it in a channel the
   * reviewer does not read. So the issues come back as well as being logged.
   *
   * Empty for the overwhelmingly common case, which is every report whose
   * schedules all built or did not apply.
   */
  issues: ScheduleIssue[];
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
  // The run this engagement is *reported in*, not merely the newest one.
  // `buildExhibits` dispatches on the run's shape, so a 409A compute pressed
  // after a specialty run replaced an EMI report's UMV/AMV and Schedule 5
  // schedules with a §409A allocation waterfall — under that report's own
  // chapter headings, and contradicting the VAL231 appendix beneath it.
  const calculation = await latestCalculationForKind(pool, valuation.id, valuation.kind);
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
  const peers = peerRows.items.map((row) => ({
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
  // Collected as well as logged. See the `issues` field on this function's
  // return: the QA route is a caller with a reader the journal is not.
  const issues: ScheduleIssue[] = [];
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
    // A schedule that failed rather than one that did not apply. `warn`, not
    // `error`: the report is rendered, delivered and correct in everything it
    // does print — what it is missing is an appendix, and the remedy is a
    // stored row somebody has to fix.
    onIssue: (issue: ScheduleIssue) => {
      issues.push(issue);
      log?.warn(
        { valuationId: valuation.id, schedule: issue.schedule, reason: issue.reason },
        'a report schedule could not be built and was left out of the deliverable',
      );
    },
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
      ...[researchSourcesExhibit(research.research)].filter((s): s is ReportPdfSection => s !== null),
    ],
    valuationDate,
    figures: reportFigures(calculation, valuation.currency),
    // The same array `onIssue` pushes into, so ordering inside this literal
    // cannot matter — every builder above has run by the time a caller reads it.
    issues,
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
  opts: { watermark?: string | null; store?: boolean; log?: ReportIssueLog } = {},
): Promise<Buffer> {
  const watermark = opts.watermark ?? null;
  // One instant for both the cover's "Rendered" line and the PDF's own
  // CreationDate, so a reader comparing the two never sees them disagree.
  const renderedAt = new Date();
  // Branding is a partner lookup plus, on a white-labelled engagement, a logo
  // fetch over the network. It has nothing to say about the figures, so it has
  // no reason to wait behind them.
  const [{ summary, exhibits, valuationDate, figures }, branding, signatories] = await Promise.all([
    summaryFor(pool, valuation, opts.log),
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
      // The product's own name for the kind, not the enum key. The cover of a
      // 718 engagement read `Kind: 718` — a database value on the front of a
      // document that goes to an auditor and a board, while every other surface
      // in the product, down to the picker the engagement was created from,
      // calls it "ASC 718 stock-based compensation". `kindLabel` echoes an
      // unmapped key, so a kind added to the enum and not to the map degrades
      // to exactly what was printed before rather than to a blank.
      { label: 'Kind', value: kindLabel(valuation.kind) },
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
  version: Pick<ReportVersionContent, 'version' | 'content'>,
  actor: EventActor,
  /** See `ExhibitContext.onIssue`: where a schedule that failed to build says so. */
  log?: ReportIssueLog,
): Promise<Buffer> {
  const watermark = reportWatermarkFor(valuation);
  if (watermark) {
    // A draft renders fresh and the stored bytes are never consulted, so they
    // are never fetched. This is the whole reason the bytes are loaded here
    // rather than handed in: every caller had to read a megabyte off the row to
    // reach this branch, which then discards it.
    return renderVersionPdf(pool, valuation, report, version.version, version.content, actor, {
      watermark,
      store: false,
      log,
    });
  }
  const stored = await getVersionPdf(pool, report.id, version.version);
  return (
    stored ?? renderVersionPdf(pool, valuation, report, version.version, version.content, actor, { log })
  );
}

const NarrativeBody = z
  .object({
    /** Replace chapters an analyst has already written. Deliberate, never default. */
    overwrite: z.boolean().default(false),
    /** Reuse the last successful draft instead of paying for a new one. */
    reuse: z.boolean().default(true),
  })
  .strict()
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
    /*
     * Ops get the body they are editing; everybody else gets the one that was
     * issued.
     *
     * The report tab renders whatever content this hands back, and on a
     * published engagement the newest saved body is not the deliverable — see
     * `deliverableVersion`. So a client or a partner reading the report on
     * screen was shown an edit made after publication, while the PDF download
     * beside it correctly served the signed version. Two answers to one
     * question, on one screen.
     *
     * An analyst must keep seeing `current_version` or the editor would load a
     * body over their own unsaved work; the `If-Match` below is the same
     * pointer for the same reason, and no non-ops caller can reach `PUT`.
     */
    const version = await getVersionContent(
      deps.pool,
      report.id,
      isOps(principal)
        ? report.current_version
        : await deliverableVersion(deps.pool, report, valuation.state),
    );
    // The validator an editor sends back as If-Match when it saves. The report
    // pointer, not the valuation's `version` — the two move independently and
    // an analyst editing prose is racing other prose, not the engagement's
    // fields.
    reply.header('ETag', versionEtag(report.current_version));
    return {
      // The editorial status the tab prints, derived from the engagement rather
      // than read off a column nothing writes — see `reportStatusFor`.
      report: reportView(report, valuation.state),
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
    if (!parsed.success) throw invalidBody('Invalid report content', parsed.error);

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
      report: reportView(saved.report, valuation.state),
      version: { version: saved.version.version, content: saved.version.content, rendered_at: null },
    };
  });

  app.get('/api/v1/valuations/:id/report/versions', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadForEdit(deps.pool, principal, id);
    const report = await findReportByValuation(deps.pool, valuation.id);
    if (!report) return { versions: [], truncated: false, page_limit: REPORT_VERSION_PAGE_LIMIT };
    // `truncated` because a version picker that quietly stops reads as the
    // whole history of the report — see REPORT_VERSION_PAGE_LIMIT.
    const { versions, truncated } = await listVersions(deps.pool, report.id);
    return { versions, truncated, page_limit: REPORT_VERSION_PAGE_LIMIT };
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
      const version = report ? await getVersionContent(deps.pool, report.id, versionNumber) : null;
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
    if (!parsed.success) throw invalidBody('Invalid revert request', parsed.error);

    const report = await findReportByValuation(deps.pool, valuation.id);
    const target = report ? await getVersionContent(deps.pool, report.id, parsed.data.version) : null;
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
      report: reportView(saved.report, valuation.state),
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
    const vars = templateVars(valuation, await valuationDateFor(deps.pool, valuation));
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
      report: reportView(saved.report, valuation.state),
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
    if (!parsed.success) throw invalidBody('Invalid options', parsed.error);

    const report = await loadOrCreateReport(deps.pool, principal, valuation);
    const version = await getVersionContent(deps.pool, report.id, report.current_version);
    if (!version) throw problems.notFound('No report content to draft into');
    if (DELIVERED_REPORT_STATES.has(valuation.state)) {
      throw problems.conflict('This engagement is published — save a new version before drafting into it');
    }

    /*
     * The run this narrative is written about.
     *
     * Read here, before the agent, rather than only afterwards for the figure
     * fallback — because the agent needs it and was not being given it. Every
     * other caller of `report_narrative` attaches the calculation:
     * `CALCULATION_DEPENDENT_PIPELINES` makes the generic AI route refuse to
     * run this agent without one and ship `calculation` in the payload. This
     * route, the only one whose output reaches the deliverable, shipped params
     * and research and nothing else, so `_calculation_summary` on the far side
     * substituted "(no calculation provided)" and the model drafted a
     * Conclusion of Value, an approach discussion and a reconciliation against
     * an instruction to "use the actual figures above" with no figures above
     * it. What came back read like a report and stated nobody's numbers.
     *
     * Refused rather than drafted from nothing, for the same reason the generic
     * route refuses: prose about a valuation that has not been computed is not
     * a cheaper draft, it is a fabricated one, and this is the path that writes
     * it into the report body.
     */
    const calculation = await latestCalculationForKind(deps.pool, valuation.id, valuation.kind);
    if (!calculation) {
      throw problems.unprocessable('Run a calculation before drafting the report narrative');
    }

    /*
     * Reuse a recent draft rather than paying for a new one.
     *
     * The agent is expensive and the answer only moves when the calculation
     * does. `reuse: false` forces a fresh run, which is what an analyst who has
     * just changed the research or the params wants.
     *
     * "The answer only moves when the calculation does" was the whole
     * justification and nothing checked it. A stored draft is reused however
     * many runs have landed since it was written, so the ordinary sequence —
     * draft, notice a wrong input, fix it, recompute, redraft — put the prose
     * of the *superseded* run back into the report, quoting the old equity
     * value and the old per-share against the new schedules. The reader of the
     * deliverable has no way to see that; the QA gate's `stale_figure` check
     * would catch a frozen conclusion only if it happened to still be in the
     * body it grades.
     *
     * So the cached draft is used only while it is at least as new as the run
     * it purports to describe. Comparing against `created_at` rather than the
     * job's completion is deliberate: what the agent saw is the calculation
     * that existed when the payload was assembled.
     */
    const cached = parsed.data.reuse ? await latestSucceededJob(deps.pool, id, 'report_narrative') : null;
    let job = cached && cached.created_at > calculation.created_at ? cached : null;
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
          extraPayload: { calculation: calculationPayload(calculation) },
        }));
      } catch (err) {
        if (err instanceof InternalServiceError) throw toProblem(err);
        throw err;
      }
    }

    // The run has to have stood. A job the reaper closed — or one whose
    // engagement went away underneath it — comes back with a null result, from
    // which `draftedSectionsFrom` reads nothing and this route would answer
    // `changed: false, applied: []`: the sentence an analyst reads as "the
    // agent had nothing to add", over a run that never delivered an answer.
    assertRunStood(job);
    // And the engagement still has to be one this route may write to. The
    // pre-flight `refuseIfRetired` read the row the request loaded, and the
    // agent has had up to three minutes since — see `refuseIfRetiredNow`.
    await refuseIfRetiredNow(deps.pool, valuation.id, 'accepting report edits');
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
    const target = (await getVersionContent(deps.pool, current.id, current.current_version)) ?? version;

    /*
     * Version 1 is the template as instantiated for this engagement, and
     * `saveVersion` appends rather than rewrites — so it is still the pristine
     * skeleton however many edits followed, and a chapter identical to its v1
     * text is one nobody has written. That is the whole overwrite rule.
     */
    const baseline = target.version === 1 ? target : await getVersionContent(deps.pool, current.id, 1);
    // `calculation` above: the same reading as the render below it —
    // `applyNarrative` is told the kind, and the figures it falls back on must
    // come from the run that kind is reported in, not from a compute of the
    // other shape run afterwards. It is also the run the drafted prose was
    // written against, which is the one the substituted figures must agree with.
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
    const version = await getVersionContent(deps.pool, report.id, report.current_version);
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
     * both documents in the history. Rendering it is a deliberate act by an
     * analyst; what `GET /report.pdf` had to stop doing is reaching the same
     * outcome on its own, on a client's download. See the note there.
     */
    if (DELIVERED_REPORT_STATES.has(valuation.state) && version.has_pdf) {
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
      { log: req.log },
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
    /*
     * The version that was delivered, not the newest one somebody has typed.
     *
     * On a published engagement these are different questions, and this door
     * was the only one of the three that asked the wrong one. Saving a new
     * report version after publication is allowed on purpose — it is what the
     * "already delivered" refusal on `POST /report/render` points at — and the
     * publish gate, which is what makes a body signed and QA'd prose, runs only
     * on the transition *into* `published`. `published` has no outgoing edges,
     * so it never runs again.
     *
     * What that produced: an analyst edits a published 409A, the next reader to
     * pull `report.pdf` finds no stored bytes for the new version, and the
     * lazy render fills them in — unwatermarked, because the engagement is
     * published, with the certification block resolved from the signature rows
     * on file. The document the board and the auditor download is then the
     * edited body under the original signer's name and the original signing
     * date, and the version number in the filename has moved without anybody
     * asking for a new deliverable. That is precisely the defect the gate's
     * rule 4 exists to refuse before publication, reached after it.
     *
     * The evidence bundle and the partner API both take the newest version
     * carrying stored bytes; this now asks the same question of the same table.
     * Only on a published engagement: a draft renders its current body fresh
     * and stamped on every read, which is the whole point of the stamp.
     */
    const version = report
      ? await getVersionContent(
          deps.pool,
          report.id,
          await deliverableVersion(deps.pool, report, valuation.state),
        )
      : null;
    if (!report || !version) throw problems.notFound('No report yet');

    // `human`, not `system`. A person asked for this file; the mechanism they
    // asked through is what `source` is for, and the activity log's actor
    // filter is the reader that cannot tell the difference — a download filed
    // under `system` is absent from "what did people do" and present in "what
    // did the platform do on its own", which is the wrong answer twice.
    const actor: EventActor = { actorType: 'human', actorId: principal.id, source: 'report.pdf' };
    const pdf = await deliverablePdf(deps.pool, valuation, report, version, actor, req.log);
    // The read itself, which nothing recorded.
    //
    // `report_rendered` fires when a version is *produced*. A published report
    // is served from the stored bytes, so a deliverable pulled fifty times over
    // a year left one row, dated the day it was made — while an unpublished one
    // renders a stamped copy per download and so happened to leave a trail. The
    // silent path was the published document, which is the one auditors and
    // boards actually read.
    await withTransaction(deps.pool, (client) =>
      recordEvent(client, {
        valuationId: valuation.id,
        type: 'report_downloaded',
        actor,
        payload: {
          version: version.version,
          size_bytes: pdf.length,
          report_status: reportStatusFor(valuation.state),
        },
      }),
    );

    const filename = `${valuation.company_name}_${valuation.kind}_v${version.version}.pdf`;
    return reply
      .type('application/pdf')
      .header('content-disposition', contentDisposition(filename, 'inline'))
      .send(pdf);
  });
}
