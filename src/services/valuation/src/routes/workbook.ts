import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canEditWorkingData, canReadValuation } from '../auth/rbac.js';
import { computeWorkbook, validateCellRef } from '../domain/workbook.js';
import { findValuationById } from '../repos/valuations.js';
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
