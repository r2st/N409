import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { problems } from '@n409/shared';
import { VALUATION_KINDS } from '../domain/valuation.js';
import { sampleReportOutline } from '../domain/sampleReport.js';

/**
 * "See a sample report" (`/sample-report`). Public: it is the page that shows
 * a prospect what they would receive, and one behind a login shows nothing.
 *
 * Pure computation over the report templates — no database, nothing per-caller,
 * and in particular no client's report. `missingBlurbs` is deliberately part of
 * the response rather than filtered out: the marketing page renders headings
 * whether or not copy exists for them, so a new chapter shows up as an
 * unexplained heading instead of silently vanishing from the outline.
 */

export function registerSampleReportRoutes(app: FastifyInstance): void {
  app.get('/api/v1/sample-report', async (req) => {
    const parsed = z.object({ kind: z.enum(VALUATION_KINDS).default('409a') }).safeParse(req.query ?? {});
    if (!parsed.success) {
      throw problems.badRequest('Invalid kind', { errors: parsed.error.issues });
    }
    return { outline: sampleReportOutline(parsed.data.kind), kinds: VALUATION_KINDS };
  });
}
