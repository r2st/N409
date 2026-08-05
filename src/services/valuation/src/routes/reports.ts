import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { renderReportPdf, type ReportPdfSummary } from '@n409/report/pdf';
import { canEditWorkingData, canReadReport, canReadValuation } from '../auth/rbac.js';
import {
  contentFromManagedTemplate,
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

function templateVars(valuation: ValuationRow) {
  return {
    company_name: valuation.company_name,
    kind: valuation.kind,
    valuation_ref: valuation.id,
    date: new Date().toISOString().slice(0, 10),
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
  const vars = templateVars(valuation);
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
 * Scoped to the same owner and company name, exactly as the analytics endpoint
 * scopes its series, so a report can never plot another client's history. Only
 * runs strictly before this one count: a report states what was known on the
 * day it was drawn, and a later revision appearing in its own history chart
 * would be a document that changes after signature.
 */
async function historyFor(
  pool: pg.Pool,
  valuation: ValuationRow,
  before: Date,
): Promise<Array<{ as_of: string; fmv_per_share: number }>> {
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
      WHERE v.user_id = $1
        AND lower(trim(v.company_name)) = lower(trim($2))
      ORDER BY c.created_at ASC`,
    [valuation.user_id, valuation.company_name, before],
  );
  return rows
    .map((r) => ({ as_of: new Date(r.as_of).toISOString(), fmv_per_share: Number(r.fmv_per_share) }))
    .filter((p) => Number.isFinite(p.fmv_per_share));
}

/**
 * Executive summary for this valuation, from its latest successful engine run.
 * A report drafted before the engine has produced a value renders without one.
 */
async function summaryFor(pool: pg.Pool, valuation: ValuationRow): Promise<ReportPdfSummary | undefined> {
  const calculation = await latestSucceededCalculation(pool, valuation.id);
  const payload = calculation?.inputs as { inputs?: { valuation_date?: unknown } } | undefined;
  const rawDate = payload?.inputs?.valuation_date;
  const history = calculation ? await historyFor(pool, valuation, calculation.created_at) : [];
  return (
    buildReportSummary(calculation, {
      currency: valuation.currency,
      companyName: valuation.company_name,
      valuationDate: typeof rawDate === 'string' ? rawDate.slice(0, 10) : null,
      history,
    }) ?? undefined
  );
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
  const pdf = await renderReportPdf({
    title: content.title,
    company_name: valuation.company_name,
    meta: [
      { label: 'Engagement', value: valuation.id },
      { label: 'Kind', value: valuation.kind },
      { label: 'Template', value: report.template_version },
      { label: 'Version', value: `v${version}` },
      { label: 'Currency', value: valuation.currency },
      { label: 'Rendered', value: renderedAt.toISOString().slice(0, 10) },
    ],
    sections: content.sections.map((s) => ({ heading: s.heading, html: s.html })),
    summary: await summaryFor(pool, valuation),
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

  app.post('/api/v1/valuations/:id/report/render', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadForEdit(deps.pool, principal, id);
    const report = await loadOrCreateReport(deps.pool, principal, valuation);
    const version = await getVersion(deps.pool, report.id, report.current_version);
    if (!version) throw problems.notFound('No report content to render');
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
