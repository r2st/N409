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
  type ReportContent,
} from '../domain/report.js';
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
} from '../repos/reports.js';
import { buildReportSummary } from '../domain/reportSummary.js';
import { fillFigures, reportFigures, type ReportFigures } from '../domain/reportFigures.js';
import { buildExhibits } from '../domain/reportExhibits.js';
import { listComparableItems } from '../repos/comparableItems.js';
import { impliedMultiples } from '../domain/comparables.js';
import { researchSourcesExhibit } from '../domain/researchExhibit.js';
import { listMarketResearch } from '../repos/marketResearch.js';
import { hmrcFormExhibit } from '../domain/specialtyExhibits.js';
import { loadHmrcForm } from '../repos/hmrcForms.js';
import { loadDebtReport, loadFundReport } from '../repos/measurementReport.js';
import { buildDebtExhibits, buildFundExhibits } from '../domain/navExhibits.js';
import { findParams } from '../repos/params.js';
import { sameCompanyFilter } from '../domain/valuationHistory.js';
import { fitsInt4, int4Version } from '../domain/int4.js';
import { latestSucceededCalculation } from '../repos/calculations.js';
import { findPartnerById } from '../repos/adminUsers.js';
import { fetchPartnerLogo } from '../clients/partnerLogo.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';
import { contentDisposition } from './documents.js';
import type { Principal } from '../auth/rbac.js';

const SectionSchema = z
  .object({
    key: z.string().min(1).max(100),
    heading: z.string().min(1).max(300),
    html: z.string().max(100_000),
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
    date: valuationDate ?? new Date().toISOString().slice(0, 10),
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

  const created = await createReport(pool, {
    valuationId: valuation.id,
    templateVersion,
    content,
    actor: actorFor(principal),
  });
  return created.report;
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
    logo: await fetchPartnerLogo(partner.logo_url),
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
async function summaryFor(
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
  const calculation = await latestSucceededCalculation(pool, valuation.id);
  const payload = calculation?.inputs as { inputs?: { valuation_date?: unknown } } | undefined;
  const rawDate = payload?.inputs?.valuation_date;
  const valuationDate = typeof rawDate === 'string' && rawDate ? rawDate.slice(0, 10) : null;
  const history = calculation ? await historyFor(pool, valuation, calculation.created_at) : [];
  // The peer set behind the market approach (design §4.5). Empty for every
  // engagement nobody has screened, and Exhibit D-1 then does not render.
  const peerRows = await listComparableItems(pool, valuation.id);
  const peers = peerRows.map((row) => ({
    ticker: row.ticker,
    name: row.name,
    included: row.included,
    exclude_reason: row.exclude_reason,
    source: row.source,
    score: row.score,
    multiples: impliedMultiples(row),
  }));
  const context = {
    currency: valuation.currency,
    companyName: valuation.company_name,
    valuationDate,
    peers,
  };
  // UK option-scheme deliverables carry the HMRC agreement request as a final
  // appendix. Null for every other kind, so nothing changes for a 409A.
  const hmrcForm = await loadHmrcForm(pool, valuation);
  // The two measurement kinds keep their figures outside `calculations` — a
  // fund in its marks, an instrument in its valuation history — so their
  // schedules are loaded rather than derived from the run above. Both return
  // null for every other kind.
  const [fundReport, debtReport, research] = await Promise.all([
    loadFundReport(pool, valuation),
    loadDebtReport(pool, valuation),
    // The public sources behind the market discussion (migration 0116). Live
    // rows only: a superseded answer is not what this report was drafted from.
    listMarketResearch(pool, valuation.id),
  ]);
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

async function renderVersionPdf(
  pool: pg.Pool,
  valuation: ValuationRow,
  report: ReportRow,
  version: number,
  content: ReportContent,
  actor: EventActor,
): Promise<Buffer> {
  // One instant for both the cover's "Rendered" line and the PDF's own
  // CreationDate, so a reader comparing the two never sees them disagree.
  const renderedAt = new Date();
  const { summary, exhibits, valuationDate, figures } = await summaryFor(pool, valuation);
  // The authored body states the conclusion, and only the calculation knows it.
  // Resolved here rather than at instantiation, and never written back: the
  // stored version keeps its placeholders, so a re-render after a recalculation
  // restates the prose instead of leaving a stale number in it. See
  // domain/reportFigures.ts.
  const body = fillFigures(content, figures);
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
    sections: [...body.sections.map((s) => ({ heading: s.heading, html: s.html })), ...exhibits],
    summary,
    branding: await brandingFor(pool, valuation),
    generated_at: renderedAt,
    keywords: [valuation.company_name, valuation.kind, 'valuation', `v${version}`],
  });
  await storeRenderedPdf(pool, { report, version, pdf, actor });
  return pdf;
}

export function registerReportRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/valuations/:id/report', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(deps.pool, principal, id);
    if (!canReadReport(principal, toRef(valuation))) throw problems.notFound();
    const report = await loadOrCreateReport(deps.pool, principal, valuation);
    const version = await getVersion(deps.pool, report.id, report.current_version);
    return {
      report,
      version: version
        ? { version: version.version, content: version.content, rendered_at: version.rendered_at }
        : null,
    };
  });

  app.put('/api/v1/valuations/:id/report', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadForEdit(deps.pool, principal, id);

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
    });
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

  app.post('/api/v1/valuations/:id/report/revert', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadForEdit(deps.pool, principal, id);

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
    });
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

  app.post('/api/v1/valuations/:id/report/render', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadForEdit(deps.pool, principal, id);
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

    // Lazy render: reuse the stored PDF when this version was already rendered.
    const pdf =
      version.pdf ??
      (await renderVersionPdf(deps.pool, valuation, report, version.version, version.content, {
        actorType: 'system',
        actorId: principal.id,
        source: 'report.pdf',
      }));

    const filename = `${valuation.company_name}_${valuation.kind}_v${version.version}.pdf`;
    return reply
      .type('application/pdf')
      .header('content-disposition', contentDisposition(filename, 'inline'))
      .send(pdf);
  });
}
