import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isIsoCalendarDate, isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { postJson, toProblem, InternalServiceError } from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import { todayLocal } from '../domain/calendarDate.js';
import { CurrencyCode } from '../domain/currency.js';
import { DEBT_FAIR_VALUE, requireStorableFigure } from '../domain/numericColumn.js';
import {
  createInstrument,
  createValuation,
  deleteInstrument,
  findCreditTerms,
  findInstrument,
  linkInstrumentToValuation,
  listInstruments,
  listValuations,
  updateInstrument,
  upsertCreditTerms,
  type InstrumentType,
} from '../repos/debtInstruments.js';
import { MeasurementLinkConflict } from '../domain/measurementLink.js';
import { findValuationById } from '../repos/valuations.js';
import { invalidBody } from '../domain/validationProblem.js';

/**
 * Debt / credit instrument valuation (feature: Debt Valuation Engine). A new
 * engine domain — bonds, term loans, convertible notes and SAFEs priced by
 * discounting contractual cash flows at a market yield (benchmark + credit
 * spread), embedded-option instruments bridging to equity. The valuation
 * service owns CRUD + valuation history; the Python engine (debt_valuation.py)
 * does the maths. Ops-only.
 */

const DateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(isIsoCalendarDate, 'Not a real calendar date');

const InstrumentBody = z.object({
  name: z.string().trim().min(1).max(200),
  instrument_type: z.enum(['bond', 'term_loan', 'convertible', 'safe', 'credit_spread']),
  currency: CurrencyCode.default('USD'),
  params: z.record(z.unknown()).default({}),
});

const UpdateBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  params: z.record(z.unknown()).optional(),
});

const CreditTermsBody = z.object({
  rating: z.string().trim().min(1).max(4).nullish(),
  benchmark_yield: z.number().min(-1).max(5).nullish(),
  spread: z.number().min(0).max(5).nullish(),
  seniority: z.enum(['senior_secured', 'senior', 'subordinated', 'mezzanine']).default('senior'),
  secured: z.boolean().default(false),
});

/** `null` detaches — the measurement tools are usable without an engagement. */
const LinkBody = z.object({ valuation_id: z.string().trim().min(1).max(26).nullable() });

const ValueBody = z.object({
  valuation_date: DateStr.optional(),
  // Per-run overrides merged over the stored params (e.g. a fresh market_yield,
  // benchmark_yield, stock_price or next-round assumptions).
  overrides: z.record(z.unknown()).default({}),
  /**
   * Whether the run is a measurement or a question.
   *
   * Every call used to write a `debt_valuations` row, and the sensitivity
   * walk is five calls: shocking a yield by ±100bp and ±200bp left four
   * hypothetical prices in the instrument's record beside the real one, all
   * carrying today's date. `listValuations` is newest-first and
   * `loadDebtReport` takes its head as the measurement the report is about,
   * so the last shock of the walk — the rate 200bp *above* the market —
   * became the instrument's fair value, on the page, in the history table and
   * in the measurement report. A what-if is not a mark.
   *
   * Defaults to true, so the flag is only ever asserted by a caller that
   * knows it is asking a question. The row a scenario would have written is
   * also the one most likely to be unstorable — `requireStorableFigure`
   * bounds the column, and a shocked price is what reaches the bound first —
   * so not writing it removes a way for the walk to fail halfway.
   */
  persist: z.boolean().default(true),
});

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('Debt valuation is operations-only');
}

/** Fields on the engine result that represent the headline fair value. */
function extractFairValue(result: Record<string, unknown>): number | null {
  for (const key of ['fair_value', 'dirty_price']) {
    const v = result[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

export function registerDebtRoutes(app: FastifyInstance, deps: { pool: pg.Pool; engineUrl: string }): void {
  const engine = async <T>(path: string, body: unknown): Promise<T> => {
    try {
      return await postJson<T>('engine', `${deps.engineUrl}${path}`, body, { timeoutMs: 30_000 });
    } catch (err) {
      if (err instanceof InternalServiceError) throw toProblem(err);
      throw err;
    }
  };

  const loadInstrument = async (id: string) => {
    if (!isUlid(id)) throw problems.notFound();
    const instrument = await findInstrument(deps.pool, id);
    if (!instrument) throw problems.notFound();
    return instrument;
  };

  app.post('/api/v1/debt/instruments', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const parsed = InstrumentBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid instrument', parsed.error);
    const b = parsed.data;
    const instrument = await createInstrument(deps.pool, {
      name: b.name,
      instrumentType: b.instrument_type as InstrumentType,
      currency: b.currency.toUpperCase(),
      params: b.params,
      createdBy: principal.id,
    });
    return reply.status(201).send({ instrument });
  });

  app.get('/api/v1/debt/instruments', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    return listInstruments(deps.pool);
  });

  /**
   * Delete an instrument, its credit terms and its whole measurement history.
   *
   * Refused while the instrument is linked to an engagement, for the same
   * reason as `DELETE /funds/:id`: those measurements are the price a report we
   * have issued speaks for, and 0110's `ON DELETE SET NULL` protects the link
   * in the other direction on exactly that ground. Detach first.
   */
  app.delete('/api/v1/debt/instruments/:id', { preHandler: app.authenticate }, async (req, reply) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    const instrument = await loadInstrument(id);
    if (instrument.valuation_id !== null) {
      throw problems.conflict(
        'This instrument is linked to an engagement — detach it from the engagement before deleting',
      );
    }
    if (!(await deleteInstrument(deps.pool, id))) throw problems.notFound();
    return reply.status(204).send();
  });

  app.get('/api/v1/debt/instruments/:id', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    const instrument = await loadInstrument(id);
    const { valuations, truncated } = await listValuations(deps.pool, id);
    return {
      instrument,
      credit_terms: await findCreditTerms(deps.pool, id),
      valuations,
      truncated,
    };
  });

  app.put('/api/v1/debt/instruments/:id', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    await loadInstrument(id);
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid update', parsed.error);
    const instrument = await updateInstrument(deps.pool, id, {
      name: parsed.data.name,
      params: parsed.data.params,
    });
    return { instrument };
  });

  /**
   * Attach the instrument to the `debt` engagement it is priced for, so the
   * report renderer can find it (0109). Detach with `valuation_id: null`.
   */
  app.put('/api/v1/debt/instruments/:id/valuation', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    await loadInstrument(id);
    const parsed = LinkBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid link', parsed.error);

    const valuationId = parsed.data.valuation_id;
    if (valuationId !== null) {
      const valuation = isUlid(valuationId) ? await findValuationById(deps.pool, valuationId) : null;
      if (!valuation) throw problems.notFound();
      if (valuation.kind !== 'debt')
        throw problems.unprocessable(
          `A debt instrument can only be linked to a 'debt' engagement; ${valuationId} is a '${valuation.kind}'`,
        );
    }

    try {
      const instrument = await linkInstrumentToValuation(deps.pool, id, valuationId);
      return { instrument };
    } catch (err) {
      if (err instanceof MeasurementLinkConflict) throw problems.conflict(err.message);
      throw err;
    }
  });

  app.put('/api/v1/debt/instruments/:id/credit-terms', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    await loadInstrument(id);
    const parsed = CreditTermsBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid credit terms', parsed.error);
    const b = parsed.data;
    const creditTerms = await upsertCreditTerms(deps.pool, id, {
      rating: b.rating ?? null,
      benchmarkYield: b.benchmark_yield ?? null,
      spread: b.spread ?? null,
      seniority: b.seniority,
      secured: b.secured,
    });
    return { credit_terms: creditTerms };
  });

  app.post('/api/v1/debt/instruments/:id/value', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const instrument = await loadInstrument(id);
    const parsed = ValueBody.safeParse(req.body ?? {});
    if (!parsed.success) throw invalidBody('Invalid value request', parsed.error);

    // Engine params = stored instrument params + credit terms (for the credit-
    // spread path) + the caller's per-run overrides.
    const params: Record<string, unknown> = { ...instrument.params };
    if (instrument.instrument_type === 'credit_spread') {
      const terms = await findCreditTerms(deps.pool, id);
      if (terms?.benchmark_yield != null) params.benchmark_yield = Number(terms.benchmark_yield);
      if (terms?.spread != null) params.spread = Number(terms.spread);
      else if (terms?.rating) params.rating = terms.rating;
    }
    Object.assign(params, parsed.data.overrides);

    const result = await engine<Record<string, unknown>>('/engine/v1/debt-valuation', {
      instrument_type: instrument.instrument_type,
      params,
    });

    if (!parsed.data.persist) return { valuation: null, result };

    const valuation = await createValuation(deps.pool, {
      instrumentId: id,
      valuationDate: parsed.data.valuation_date ?? todayLocal(),
      inputs: { instrument_type: instrument.instrument_type, params },
      result,
      fairValue: requireStorableFigure(extractFairValue(result), 'Fair value', DEBT_FAIR_VALUE),
      createdBy: principal.id,
    });
    return { valuation, result };
  });

  app.get('/api/v1/debt/instruments/:id/valuations', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const { id } = req.params as { id: string };
    await loadInstrument(id);
    return listValuations(deps.pool, id);
  });

  app.post('/api/v1/debt/rating-spread', { preHandler: app.authenticate }, async (req) => {
    requireOps(requirePrincipal(req));
    const rating = z.object({ rating: z.string().trim().min(1).max(4) }).safeParse(req.body);
    if (!rating.success) throw problems.unprocessable('Provide a rating');
    return engine('/engine/v1/debt-rating-spread', { rating: rating.data.rating });
  });
}
