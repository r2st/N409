import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canEditWorkingData, canReadValuation } from '../auth/rbac.js';
import { computeWorkbook, validateCellRef } from '../domain/workbook.js';
import {
  buildWorkbookTabs,
  type TabCompanyProfile,
  type TabParams,
  type TabValuation,
} from '../domain/workbookTabs.js';
import { findValuationById } from '../repos/valuations.js';
import { findCompanyProfile } from '../repos/companyProfiles.js';
import { findParams } from '../repos/params.js';
import { findCapTable } from '../repos/capTables.js';
import { listOverwrites } from '../repos/overwrites.js';
import { listWorkbookCells, patchWorkbookCells } from '../repos/workbook.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { Principal } from '../auth/rbac.js';

const PatchBody = z
  .object({
    cells: z
      .array(
        z
          .object({
            sheet: z.string().min(1).max(100),
            row_key: z.string().min(1).max(100),
            column_key: z.string().min(1).max(100),
            // finite input value, or null to clear the cell
            value: z.number().finite().nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

async function authorize(pool: pg.Pool, principal: Principal, id: string): Promise<void> {
  if (!canEditWorkingData(principal)) throw problems.forbidden();
  if (!isUlid(id)) throw problems.notFound();
  const valuation = await findValuationById(pool, id);
  if (
    !valuation ||
    !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
  ) {
    throw problems.notFound();
  }
}

export function registerWorkbookRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/valuations/:id/workbook', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await authorize(deps.pool, principal, id);
    const cells = await listWorkbookCells(deps.pool, id);
    return { sheets: computeWorkbook(cells) };
  });

  /**
   * The four-tab workbook view (domain/workbookTabs.ts).
   *
   * Read-only on purpose. It draws from five tables plus the override layer;
   * every field names the endpoint that owns its writes, so edits keep going to
   * the route with the validation and the audit event on it rather than this
   * becoming a second way to mutate a valuation.
   */
  app.get('/api/v1/valuations/:id/workbook/tabs', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await authorize(deps.pool, principal, id);

    // Loaded together rather than per-tab: the tabs cross-reference each other
    // (fully-diluted shares belong to the cap table, the price it prices is on
    // financials), so a per-tab fetch would read five tables four times.
    const [valuation, profile, params, capTable, cells, overwrites] = await Promise.all([
      findValuationById(deps.pool, id),
      findCompanyProfile(deps.pool, id),
      findParams(deps.pool, id),
      findCapTable(deps.pool, id),
      listWorkbookCells(deps.pool, id),
      listOverwrites(deps.pool, id),
    ]);
    // authorize() already resolved it; this is the type narrowing.
    if (!valuation) throw problems.notFound();

    const tabs = buildWorkbookTabs({
      valuation: valuation as unknown as TabValuation,
      profile: profile as TabCompanyProfile | null,
      params: params as unknown as TabParams | null,
      capTable: capTable?.entries ?? [],
      sheets: computeWorkbook(cells),
      overwrites: new Map(overwrites.map((o) => [o.field_key, o.value])),
    });

    return {
      tabs,
      // The per-class detail behind the cap-table tab's roll-up. Kept out of
      // the field model because it is a table, not a cell.
      cap_table_entries: capTable?.entries ?? [],
    };
  });

  app.patch('/api/v1/valuations/:id/workbook', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    await authorize(deps.pool, principal, id);

    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success)
      throw problems.unprocessable('Invalid workbook patch', { errors: parsed.error.issues });

    const errors = parsed.data.cells
      .map((c) => ({ cell: c, error: validateCellRef(c.sheet, c.row_key, c.column_key) }))
      .filter((e) => e.error !== null)
      .map((e) => `${e.cell.sheet}/${e.cell.row_key}/${e.cell.column_key}: ${e.error}`);
    if (errors.length > 0) throw problems.unprocessable('Invalid cell reference(s)', { errors });

    await patchWorkbookCells(deps.pool, id, parsed.data.cells, {
      actorType: 'human',
      actorId: principal.id,
      source: 'api',
    });
    const cells = await listWorkbookCells(deps.pool, id);
    return { sheets: computeWorkbook(cells) };
  });
}
