import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { InternalServiceError, postJson, toProblem } from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { findParams } from '../repos/params.js';
import { listOverwrites } from '../repos/overwrites.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import {
  deleteComparableItem,
  findComparableItem,
  insertComparableItem,
  listComparableItems,
  replaceMachineComparables,
  updateComparableItem,
  type ComparableItemRow,
} from '../repos/comparableItems.js';
import {
  ComparableInputError,
  impliedMultiples,
  isDeletableSource,
  multipleKeyFor,
  resolveExcludeReason,
  summarizeSet,
} from '../domain/comparables.js';

/**
 * Network Items — the guideline-company peer set (design §4.5).
 *
 * The engine has screened, scored and quartiled comparables for as long as
 * `engine/comparables.py` has existed; what the platform stored was the
 * aggregate it produced. This is the record of the set itself: which companies
 * were considered, which are in, and — the row an auditor actually asks about —
 * why anything is out.
 *
 * Reading is available to anyone who can read the engagement, for the same
 * reason the research citations are: "where did this multiple come from" is a
 * fair question from the client whose report rests on the answer. Writing is
 * operations-only, because a client editing their own peer set is not a screen.
 */

/** Wall clock for one screen. The engine's universe is in-process, so this is generous. */
const SCREEN_TIMEOUT_MS = 20_000;

const TICKER = z
  .string()
  .trim()
  .min(1)
  .max(12)
  .regex(/^[A-Za-z0-9.-]+$/, 'A ticker is letters, digits, dots and hyphens')
  .transform((t) => t.toUpperCase());

const Money = z.number().finite().min(-1e15).max(1e15);

const CreateBody = z
  .object({
    ticker: TICKER.nullish(),
    name: z.string().trim().min(1).max(200),
    sic: z.string().trim().max(12).nullish(),
    included: z.boolean().default(true),
    exclude_reason: z.string().trim().max(500).nullish(),
    revenue_ltm: Money.nullish(),
    revenue_ntm: Money.nullish(),
    ebitda_ltm: Money.nullish(),
    ebitda_ntm: Money.nullish(),
    ev: Money.nullish(),
  })
  .strict();

const PatchBody = CreateBody.partial().strict();

const ScreenBody = z
  .object({
    min_score: z.number().min(0).max(1).optional(),
    limit: z.number().int().min(1).max(12).optional(),
  })
  .strict();

/** What `engine/v1/comparables` returns for one ranked candidate. */
interface ScreenedCandidate {
  ticker?: unknown;
  name?: unknown;
  sic_code?: unknown;
  market_cap?: unknown;
  revenue?: unknown;
  ebitda_margin?: unknown;
  score?: unknown;
  breakdown?: unknown;
}

interface ScreenResponse {
  selected?: ScreenedCandidate[];
  screened_out?: Array<{ ticker?: unknown; name?: unknown; score?: unknown; reason?: unknown }>;
  universe_size?: unknown;
  target?: Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function fin(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The row as the tab and the exhibit read it: stored columns plus the four quotients. */
export function presentComparable(row: ComparableItemRow) {
  return { ...row, multiples: impliedMultiples(row) };
}

export function registerComparableRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; engineUrl: string },
): void {
  const loadReadable = async (id: string, principal: Principal): Promise<ValuationRow> => {
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (
      !valuation ||
      !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
    ) {
      throw problems.notFound();
    }
    return valuation;
  };

  const loadOps = async (id: string, principal: Principal): Promise<ValuationRow> => {
    if (!isOps(principal)) throw problems.forbidden('Editing the comparable set is operations-only');
    return loadReadable(id, principal);
  };

  const audit = async (
    valuation: ValuationRow,
    principal: Principal,
    type: string,
    payload: Record<string, unknown>,
  ) =>
    recordAdminEvent(deps.pool, {
      type,
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'valuation',
      subjectId: valuation.id,
      subjectLabel: valuation.company_name,
      payload,
    });

  /**
   * The set, its derived statistics, and which multiple the market approach
   * would strike from it under the engagement's current params.
   */
  app.get('/api/v1/valuations/:id/comparables', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadReadable(id, principal);

    const [items, paramsRow] = await Promise.all([
      listComparableItems(deps.pool, valuation.id),
      findParams(deps.pool, valuation.id),
    ]);
    const primary = multipleKeyFor(paramsRow?.market_method, paramsRow?.market_horizon);
    return {
      comparables: items.map(presentComparable),
      statistics: summarizeSet(items),
      // Named rather than left for the reader to infer from params: the whole
      // point of the summary is that it previews the number the engine will
      // select, and which of the four it is depends on two params fields that
      // live on a different tab.
      primary_multiple: primary,
      market_method: paramsRow?.market_method ?? null,
      market_horizon: paramsRow?.market_horizon ?? null,
      can_edit: isOps(principal),
    };
  });

  app.post('/api/v1/valuations/:id/comparables', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadOps(id, principal);

    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) throw problems.unprocessable('Invalid comparable', { errors: parsed.error.issues });
    const body = parsed.data;

    let excludeReason: string | null;
    try {
      excludeReason = resolveExcludeReason(body.included, body.exclude_reason);
    } catch (err) {
      if (err instanceof ComparableInputError) throw problems.unprocessable(err.message);
      throw err;
    }

    // The unique index is the authority on duplicates; this is the friendly
    // half of the same rule, so an analyst gets a sentence rather than a 500.
    if (body.ticker) {
      const existing = await listComparableItems(deps.pool, valuation.id);
      if (existing.some((r) => r.ticker === body.ticker)) {
        throw problems.conflict(`${body.ticker} is already in this peer set`);
      }
    }

    const row = await insertComparableItem(deps.pool, {
      valuationId: valuation.id,
      ticker: body.ticker ?? null,
      name: body.name,
      sic: body.sic ?? null,
      source: 'analyst',
      included: body.included,
      excludeReason,
      revenueLtm: body.revenue_ltm ?? null,
      revenueNtm: body.revenue_ntm ?? null,
      ebitdaLtm: body.ebitda_ltm ?? null,
      ebitdaNtm: body.ebitda_ntm ?? null,
      ev: body.ev ?? null,
      createdBy: principal.id,
    });
    await audit(valuation, principal, 'comparable_added', {
      item_id: row.id,
      ticker: row.ticker,
      name: row.name,
    });
    return reply.status(201).send({ comparable: presentComparable(row) });
  });

  app.patch('/api/v1/valuations/:id/comparables/:itemId', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id, itemId } = req.params as { id: string; itemId: string };
    const valuation = await loadOps(id, principal);
    if (!isUlid(itemId)) throw problems.notFound();

    const parsed = PatchBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw problems.unprocessable('Invalid comparable', { errors: parsed.error.issues });
    }
    const body = parsed.data;
    const current = await findComparableItem(deps.pool, valuation.id, itemId);
    if (!current) throw problems.notFound();

    // The reason is validated against the *resulting* inclusion, not the
    // requested one: `{included: false}` alone has to fail, and so does
    // `{exclude_reason: ''}` on a row that is already excluded.
    const included = body.included ?? current.included;
    const reasonSupplied = 'exclude_reason' in body ? body.exclude_reason : current.exclude_reason;
    let excludeReason: string | null;
    try {
      excludeReason = resolveExcludeReason(included, reasonSupplied);
    } catch (err) {
      if (err instanceof ComparableInputError) throw problems.unprocessable(err.message);
      throw err;
    }

    if (body.ticker && body.ticker !== current.ticker) {
      const existing = await listComparableItems(deps.pool, valuation.id);
      if (existing.some((r) => r.ticker === body.ticker && r.id !== itemId)) {
        throw problems.conflict(`${body.ticker} is already in this peer set`);
      }
    }

    const row = await updateComparableItem(deps.pool, valuation.id, itemId, {
      ...('ticker' in body ? { ticker: body.ticker ?? null } : {}),
      ...('name' in body && body.name !== undefined ? { name: body.name } : {}),
      ...('sic' in body ? { sic: body.sic ?? null } : {}),
      ...('revenue_ltm' in body ? { revenueLtm: body.revenue_ltm ?? null } : {}),
      ...('revenue_ntm' in body ? { revenueNtm: body.revenue_ntm ?? null } : {}),
      ...('ebitda_ltm' in body ? { ebitdaLtm: body.ebitda_ltm ?? null } : {}),
      ...('ebitda_ntm' in body ? { ebitdaNtm: body.ebitda_ntm ?? null } : {}),
      ...('ev' in body ? { ev: body.ev ?? null } : {}),
      included,
      excludeReason,
    });
    if (!row) throw problems.notFound();

    if (row.included !== current.included) {
      await audit(valuation, principal, row.included ? 'comparable_included' : 'comparable_excluded', {
        item_id: row.id,
        ticker: row.ticker,
        name: row.name,
        reason: row.exclude_reason,
      });
    }
    return { comparable: presentComparable(row) };
  });

  /**
   * Delete — analyst rows only.
   *
   * A machine-sourced row is excluded, never removed: it is the evidence of
   * what the screen proposed, and a set an analyst can prune without trace is
   * a selection wearing a screen's clothes. The 409 says so rather than 403,
   * because the caller has the permission and the row has the wrong provenance.
   */
  app.delete(
    '/api/v1/valuations/:id/comparables/:itemId',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id, itemId } = req.params as { id: string; itemId: string };
      const valuation = await loadOps(id, principal);
      if (!isUlid(itemId)) throw problems.notFound();

      const current = await findComparableItem(deps.pool, valuation.id, itemId);
      if (!current) throw problems.notFound();
      if (!isDeletableSource(current.source)) {
        throw problems.conflict(
          'A screened comparable is excluded with a reason, not deleted — the set has to show what was considered',
        );
      }
      await deleteComparableItem(deps.pool, valuation.id, itemId);
      await audit(valuation, principal, 'comparable_deleted', {
        item_id: current.id,
        ticker: current.ticker,
        name: current.name,
      });
      return reply.status(204).send();
    },
  );

  /**
   * Re-screen: run the engine over the reference universe for this engagement's
   * target profile, and write the result as the machine half of the set.
   *
   * The engagement's own include/exclude decisions ride through the rewrite
   * (see `replaceMachineComparables`) — a re-screen refreshes the data, it does
   * not overrule the analyst.
   */
  app.post(
    '/api/v1/valuations/:id/comparables/screen',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id } = req.params as { id: string };
      const valuation = await loadOps(id, principal);

      const parsed = ScreenBody.safeParse(req.body ?? {});
      if (!parsed.success) throw problems.unprocessable('Invalid screen', { errors: parsed.error.issues });

      const overwrites = await listOverwrites(deps.pool, valuation.id);
      const value = (key: string): number | null => {
        const row = overwrites.find((o) => o.field_key === key);
        return row === undefined ? null : fin(row.value);
      };
      const revenue = value('ltm_revenue');
      const ebitda = value('ltm_ebitda');
      const industry = value('industry_id');
      const target = {
        sic_code: industry === null ? null : String(Math.trunc(industry)),
        revenue,
        revenue_growth: value('revenue_growth_rate'),
        // Derived rather than stored: a margin typed independently of the two
        // figures it comes from is a third number that eventually disagrees
        // with both. Same reasoning as `Company.ebitda_margin` in the engine.
        ebitda_margin: revenue !== null && revenue > 0 && ebitda !== null ? ebitda / revenue : null,
      };
      if (Object.values(target).every((v) => v === null)) {
        throw problems.unprocessable(
          'The screen needs at least one target attribute — set the industry ID, LTM revenue, ' +
            'growth rate or LTM EBITDA on the Overwrites tab first',
        );
      }

      // The current set steers the screen rather than being discarded by it:
      // an analyst's kept comps are forced in and scored alongside the rest,
      // and their exclusions stay out of the ranking entirely.
      const existing = await listComparableItems(deps.pool, valuation.id);
      const include_tickers = existing.filter((r) => r.included && r.ticker).map((r) => r.ticker!);
      const exclude_tickers = existing.filter((r) => !r.included && r.ticker).map((r) => r.ticker!);

      let screen: ScreenResponse;
      try {
        screen = await postJson<ScreenResponse>(
          'engine',
          `${deps.engineUrl}/engine/v1/comparables`,
          {
            inputs: {
              ...Object.fromEntries(Object.entries(target).filter(([, v]) => v !== null)),
              ...(parsed.data.min_score !== undefined ? { min_score: parsed.data.min_score } : {}),
              ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
              ...(include_tickers.length > 0 ? { include_tickers } : {}),
              ...(exclude_tickers.length > 0 ? { exclude_tickers } : {}),
            },
          },
          {
            timeoutMs: SCREEN_TIMEOUT_MS,
            record: { valuationId: valuation.id, name: 'engine comparables' },
          },
        );
      } catch (err) {
        if (err instanceof InternalServiceError) {
          req.log.warn({ err }, 'comparable screen failed');
          throw toProblem(err);
        }
        throw err;
      }

      // Market cap stands in for enterprise value in the engine's snapshot (see
      // `Company.revenue`), so it is what the stored EV column holds — storing
      // it under any other name would suggest a precision the snapshot has not
      // got, and the implied multiples reproduce the engine's own exactly.
      const selected = (screen.selected ?? []).map((c) => {
        const revenueLtm = fin(c.revenue);
        const margin = fin(c.ebitda_margin);
        return {
          ticker: str(c.ticker),
          name: str(c.name) ?? str(c.ticker) ?? 'Unnamed comparable',
          sic: str(c.sic_code),
          included: true,
          revenueLtm,
          ebitdaLtm: revenueLtm !== null && margin !== null ? revenueLtm * margin : null,
          ev: fin(c.market_cap),
          score: fin(c.score),
          scoreBreakdown: c.breakdown ?? {},
        };
      });
      const rejected = (screen.screened_out ?? []).map((c) => ({
        ticker: str(c.ticker),
        name: str(c.name) ?? str(c.ticker) ?? 'Unnamed comparable',
        included: false,
        excludeReason: str(c.reason) ?? 'screened out below the score threshold',
        score: fin(c.score),
      }));

      const written = await replaceMachineComparables(deps.pool, valuation.id, 'market_feed', [
        ...selected,
        ...rejected,
      ]);
      await audit(valuation, principal, 'comparables_screened', {
        selected: selected.length,
        screened_out: rejected.length,
        universe_size: fin(screen.universe_size),
      });

      const items = await listComparableItems(deps.pool, valuation.id);
      return reply.status(201).send({
        comparables: items.map(presentComparable),
        statistics: summarizeSet(items),
        screened: written.length,
        target: screen.target ?? target,
      });
    },
  );
}
