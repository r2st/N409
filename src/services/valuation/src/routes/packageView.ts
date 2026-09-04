import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { isUlid, problems } from '@n409/shared';
import { isOps } from '../auth/rbac.js';
import { findValuationById } from '../repos/valuations.js';
import { findParams } from '../repos/params.js';
import { findCompanyProfile } from '../repos/companyProfiles.js';
import { listDocuments } from '../repos/documents.js';
import { listAiJobSummaries } from '../repos/aiJobs.js';
import { listCalculationSummaries } from '../repos/calculations.js';
import { listOverwrites } from '../repos/overwrites.js';
import { findReportByValuation, listVersions } from '../repos/reports.js';
import { reportStatusFor } from '../domain/report.js';
import { listTasks } from '../repos/tasks.js';
import { listRounds, listTransactions } from '../repos/transactions.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Package explorer (remaining-gaps §3 #7): one hierarchical view of everything
 * a valuation engagement contains — profile, documents, params, AI runs,
 * calculations, overwrites, report + versions, tasks, rounds & transactions.
 * Read-only aggregate over the existing repos; ops-only because it exposes
 * the full working set.
 */
export function registerPackageRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/valuations/:id/package', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('The package explorer is operations-only');
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();

    const [
      profile,
      params,
      documentPage,
      aiJobPage,
      calculationPage,
      overwrites,
      report,
      tasks,
      roundPage,
      transactionPage,
    ] = await Promise.all([
      findCompanyProfile(deps.pool, id),
      findParams(deps.pool, id),
      listDocuments(deps.pool, id),
      listAiJobSummaries(deps.pool, id),
      listCalculationSummaries(deps.pool, id),
      listOverwrites(deps.pool, id),
      findReportByValuation(deps.pool, id),
      listTasks(deps.pool, { valuationId: id, page: 1, perPage: 100 }),
      listRounds(deps.pool, id),
      listTransactions(deps.pool, id),
    ]);
    const versionPage = report
      ? await listVersions(deps.pool, report.id)
      : { versions: [], truncated: false };
    const reportVersions = versionPage.versions;
    const { jobs: aiJobs, truncated: aiJobsTruncated } = aiJobPage;
    const { documents, truncated: documentsTruncated } = documentPage;
    const { rounds, truncated: roundsTruncated } = roundPage;
    const { transactions, truncated: transactionsTruncated } = transactionPage;
    const { calculations, truncated: calculationsTruncated } = calculationPage;

    // Calculations without result payloads — the explorer shows summaries,
    // the Calculations tab has the full breakdown. Narrowed in SQL, not here:
    // this map used to be handed the two jsonb documents of every run and drop
    // them (see `listCalculationSummaries`).
    const calculationSummaries = calculations.map((c) => ({
      id: c.id,
      status: c.status,
      engine_version: c.engine_version,
      equity_value: c.equity_value,
      fmv_per_share: c.fmv_per_share,
      error: c.error,
      created_at: c.created_at,
    }));
    // AI runs without their result documents — the explorer shows the run, not
    // what the model said. Narrowed in SQL for the same reason the calculations
    // arm above is, and it was the one arm of this pair that still dropped a
    // document in JS after the driver had already parsed it.
    const aiJobSummaries = aiJobs;

    return {
      package: {
        valuation,
        company_profile: profile,
        params,
        documents,
        ai_jobs: aiJobSummaries,
        calculations: calculationSummaries,
        // The explorer's section headings carry counts taken from these two
        // arrays, so the caps they came from travel with them.
        ai_jobs_truncated: aiJobsTruncated,
        calculations_truncated: calculationsTruncated,
        // Same reason, three more badges: the explorer counts the files, the
        // financings and the secondary trades in its headings too.
        documents_truncated: documentsTruncated,
        funding_rounds_truncated: roundsTruncated,
        transactions_truncated: transactionsTruncated,
        overwrites,
        report: report
          ? {
              id: report.id,
              status: reportStatusFor(valuation.state),
              template_version: report.template_version,
              current_version: report.current_version,
              versions: reportVersions,
            }
          : null,
        tasks: tasks.items,
        funding_rounds: rounds,
        transactions,
      },
    };
  });
}
