import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AdminEventType } from '../domain/auditTrail.js';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { describeForUser, InternalServiceError, postJson, toProblem } from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { findParams } from '../repos/params.js';
import { listOverwrites } from '../repos/overwrites.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import {
  deleteComparableItem,
  COMPARABLE_PAGE_LIMIT,
  findComparableByTicker,
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
  type ComparableFiguresSource,
} from '../domain/comparables.js';
import { isRetiredNow, refuseIfRetired, refuseIfRetiredNow } from '../domain/retiredEngagement.js';
import { invalidBody } from '../domain/validationProblem.js';

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

/**
 * Wall clock for one live-feed fetch. Shorter than the screen and per ticker,
 * not per set: this one leaves the process for a third-party API, and a refresh
 * of a dozen comps must not be able to hold a request open for minutes because
 * the far end is slow. A timeout here is a `unavailable` row, not a failure.
 */
const FEED_TIMEOUT_MS = 8_000;

/**
 * Tickers one refresh will fetch, however many the set holds.
 *
 * The comment above states the rule this number is what actually enforces. A
 * per-ticker timeout bounds one fetch and says nothing about the request: the
 * loop is sequential, so a set of N holds the connection for up to N x 8s while
 * the far end is slow, and `COMPARABLE_PAGE_LIMIT` - the only ceiling there was
 * - puts that at 500 tickers and sixty-six minutes. Node destroys the socket at
 * five, by which time every row the loop had already committed is invisible:
 * the analyst gets a gateway timeout and no way to know which comps carry live
 * figures and which still carry their old ones.
 *
 * Comfortably above any real peer set - the screener offers at most twelve, and
 * `ScreenBody.limit` caps a run there - so this is a ceiling on the pathological
 * set, not a limit an analyst meets. Twenty-five worst-case fetches is 200s,
 * which fits inside the request timeout with room for the rest of the handler.
 *
 * Ordered by staleness rather than the set's display order, which is
 * `included DESC, score DESC, name ASC` and has nothing to do with when a row
 * was last fetched. Slicing the display order would refresh the same
 * twenty-five on every press and never reach the twenty-sixth; oldest-first
 * means a second press picks up where the first stopped.
 */
const REFRESH_BATCH = 25;

/** The `financials` shape of `engine/v1/market-feed` (engine market_feed.py). */
interface MarketFeedResponse {
  /** `"yfinance"` when observed; `"fallback"` when the live source could not answer. */
  source?: unknown;
  warning?: unknown;
  market_cap?: unknown;
  total_revenue?: unknown;
  ebitda?: unknown;
}

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
  enterprise_value?: unknown;
  revenue?: unknown;
  ebitda_margin?: unknown;
  score?: unknown;
  breakdown?: unknown;
  figures_source?: unknown;
  figures_as_of?: unknown;
}

interface ScreenResponse {
  selected?: ScreenedCandidate[];
  screened_out?: Array<{ ticker?: unknown; name?: unknown; score?: unknown; reason?: unknown }>;
  universe_size?: unknown;
  /** Whether the engine ranked observed figures, the snapshot, or a mix of both. */
  universe?: {
    source?: unknown;
    as_of?: unknown;
    live_count?: unknown;
    snapshot_count?: unknown;
    warning_count?: unknown;
  };
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
    type: AdminEventType,
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

    const [itemPage, paramsRow] = await Promise.all([
      listComparableItems(deps.pool, valuation.id),
      findParams(deps.pool, valuation.id),
    ]);
    const { items, truncated } = itemPage;
    const primary = multipleKeyFor(paramsRow?.market_method, paramsRow?.market_horizon);
    return {
      comparables: items.map(presentComparable),
      // Multiples over a page, so a peer set past the cap states a median the
      // whole set does not have. The flag rides beside it for that reason.
      statistics: summarizeSet(items),
      truncated,
      page_limit: COMPARABLE_PAGE_LIMIT,
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
    refuseIfRetired(valuation, 'accepting changes');

    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) throw invalidBody('Invalid comparable', parsed.error);
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
      if (await findComparableByTicker(deps.pool, valuation.id, body.ticker)) {
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
      figuresSource: 'analyst',
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
    refuseIfRetired(valuation, 'accepting changes');
    if (!isUlid(itemId)) throw problems.notFound();

    const parsed = PatchBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw invalidBody('Invalid comparable', parsed.error);
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
      const clash = await findComparableByTicker(deps.pool, valuation.id, body.ticker);
      if (clash && clash.id !== itemId) {
        throw problems.conflict(`${body.ticker} is already in this peer set`);
      }
    }

    // Editing a figure by hand makes the row an analyst's figure, whatever it
    // was before. A row that still reported "Observed market data" after
    // somebody typed over the EV would be the provenance columns actively
    // lying, which is worse than not having them — include/exclude and the
    // labelling fields are judgement, not figures, and leave it alone.
    const FIGURE_FIELDS = ['revenue_ltm', 'revenue_ntm', 'ebitda_ltm', 'ebitda_ntm', 'ev'] as const;
    const figuresEdited = FIGURE_FIELDS.some((f) => f in body);

    const row = await updateComparableItem(deps.pool, valuation.id, itemId, {
      ...('ticker' in body ? { ticker: body.ticker ?? null } : {}),
      ...('name' in body && body.name !== undefined ? { name: body.name } : {}),
      ...('sic' in body ? { sic: body.sic ?? null } : {}),
      ...('revenue_ltm' in body ? { revenueLtm: body.revenue_ltm ?? null } : {}),
      ...('revenue_ntm' in body ? { revenueNtm: body.revenue_ntm ?? null } : {}),
      ...('ebitda_ltm' in body ? { ebitdaLtm: body.ebitda_ltm ?? null } : {}),
      ...('ebitda_ntm' in body ? { ebitdaNtm: body.ebitda_ntm ?? null } : {}),
      ...('ev' in body ? { ev: body.ev ?? null } : {}),
      ...(figuresEdited ? { figuresSource: 'analyst' as const, figuresAsOf: new Date() } : {}),
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
      refuseIfRetired(valuation, 'accepting new runs');

      const parsed = ScreenBody.safeParse(req.body ?? {});
      if (!parsed.success) throw invalidBody('Invalid screen', parsed.error);

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
      const { items: existing } = await listComparableItems(deps.pool, valuation.id);
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
          req.log.warn({ err, valuationId: valuation.id }, 'comparable screen failed');
          throw toProblem(err);
        }
        throw err;
      }

      // The stored EV column takes the engine's `enterprise_value`, which is
      // the one the row's own multiples are struck on: exactly the market cap
      // for a snapshot row (where market cap stands in for EV — see
      // `Company.revenue`) and the real, net-debt-inclusive figure for a row
      // refreshed from the market. Storing market cap in both cases would
      // reproduce the engine's multiples only in the first, and understate the
      // multiple by the net debt in the second.
      //
      // Provenance is taken per row rather than assumed for the set. The
      // engine screens against live figures where its feed answered and the
      // curated snapshot where it did not, so a screen can legitimately return
      // both, and Exhibit D-1 already knows how to say so. Hard-coding
      // `snapshot` here — which is what this did while the engine had no live
      // universe — would now be the columns actively lying.
      const screenedAt = new Date();
      const selected = (screen.selected ?? []).map((c) => {
        const revenueLtm = fin(c.revenue);
        const margin = fin(c.ebitda_margin);
        const live = str(c.figures_source) === 'live';
        const asOf = live ? new Date(String(c.figures_as_of ?? '')) : null;
        return {
          ticker: str(c.ticker),
          name: str(c.name) ?? str(c.ticker) ?? 'Unnamed comparable',
          sic: str(c.sic_code),
          included: true,
          revenueLtm,
          ebitdaLtm: revenueLtm !== null && margin !== null ? revenueLtm * margin : null,
          ev: fin(c.enterprise_value) ?? fin(c.market_cap),
          score: fin(c.score),
          scoreBreakdown: c.breakdown ?? {},
          figuresSource: (live ? 'live' : 'snapshot') as ComparableFiguresSource,
          // A live figure is only live at the moment it was observed, so the
          // engine's stamp is the one that counts; the screen's own clock is
          // the right answer only for a row whose figures have no other date.
          figuresAsOf: asOf !== null && !Number.isNaN(asOf.getTime()) ? asOf : screenedAt,
        };
      });
      const rejected = (screen.screened_out ?? []).map((c) => ({
        ticker: str(c.ticker),
        name: str(c.name) ?? str(c.ticker) ?? 'Unnamed comparable',
        included: false,
        excludeReason: str(c.reason) ?? 'screened out below the score threshold',
        score: fin(c.score),
      }));

      // The engagement the guard above read is `SCREEN_TIMEOUT_MS` old by now,
      // and a screen is exactly the length of time in which somebody decides a
      // piece of work is over. Rewriting the machine half of the peer set of a
      // withdrawn engagement is not a note in the margin: the comparable
      // approach reads these rows, retirement is reversible (R90), and the set
      // comes back with the engagement bearing multiples nobody asked for.
      await refuseIfRetiredNow(deps.pool, valuation.id, 'accepting new runs');
      const written = await replaceMachineComparables(deps.pool, valuation.id, 'market_feed', [
        ...selected,
        ...rejected,
      ]);
      // Recorded on the event, not only on the rows: "which universe was this
      // screened against" is a question asked months later about a set whose
      // rows have since been edited, and by then the row-level stamps have been
      // overwritten by whoever touched them.
      const universe = {
        source: str(screen.universe?.source) ?? 'snapshot',
        as_of: str(screen.universe?.as_of),
        live_count: fin(screen.universe?.live_count) ?? 0,
        snapshot_count: fin(screen.universe?.snapshot_count) ?? fin(screen.universe_size),
        warning_count: fin(screen.universe?.warning_count) ?? 0,
      };
      await audit(valuation, principal, 'comparables_screened', {
        selected: selected.length,
        screened_out: rejected.length,
        universe_size: fin(screen.universe_size),
        universe,
      });

      const { items, truncated } = await listComparableItems(deps.pool, valuation.id);
      return reply.status(201).send({
        comparables: items.map(presentComparable),
        statistics: summarizeSet(items),
        truncated,
        page_limit: COMPARABLE_PAGE_LIMIT,
        screened: written.length,
        target: screen.target ?? target,
        universe,
      });
    },
  );

  /**
   * Replace the peer set's figures with observed market data.
   *
   * `engine/v1/market-feed` has served live yfinance financials, with a
   * documented graceful fallback, since it was written — and had no caller, so
   * every multiple on the platform traced back to the engine's static
   * reference snapshot however old that snapshot was. This is that endpoint's
   * caller.
   *
   * Three rules the shape follows from:
   *
   *   * A row is refreshed or it is left exactly as it was. The feed answers
   *     per ticker and can answer for some and not others; half-updating a row
   *     from a partial response would produce an EV from today against a
   *     revenue from the snapshot, and the implied multiple would be a number
   *     that never existed anywhere.
   *   * A fallback is reported, not swallowed. The engine returns
   *     `source: "fallback"` with a warning precisely so a caller can say the
   *     figures are estimates; the response carries that per ticker, and the
   *     rows keep the provenance they already had.
   *   * Analyst rows are not touched. Somebody typed those on purpose.
   */
  app.post(
    '/api/v1/valuations/:id/comparables/refresh',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { id } = req.params as { id: string };
      const valuation = await loadOps(id, principal);
      refuseIfRetired(valuation, 'accepting changes');

      const { items } = await listComparableItems(deps.pool, valuation.id);
      // Included rows only: the excluded half is kept as the record of what was
      // considered, and re-fetching figures for a comp somebody screened out
      // spends the quota to update a number no approach reads.
      const targets = items.filter((r) => r.included && r.ticker !== null && r.figures_source !== 'analyst');
      if (targets.length === 0) {
        throw problems.unprocessable(
          'No included comparable in this set carries a ticker to refresh — screen the set, ' +
            'or add a comp with a ticker first',
        );
      }

      // Never fetched sorts first; after that, longest ago first. The column is
      // nullable and the sentinel has to sort below every real timestamp.
      const byStaleness = [...targets].sort(
        (a, b) => (a.figures_as_of?.getTime() ?? -1) - (b.figures_as_of?.getTime() ?? -1),
      );
      const batch = byStaleness.slice(0, REFRESH_BATCH);
      const remaining = targets.length - batch.length;

      const refreshed: Array<{ ticker: string; as_of: string }> = [];
      const unavailable: Array<{ ticker: string; warning: string }> = [];
      // Comps that stopped existing between the read that built this batch and
      // the write that was meant to land on them. See the `dropped` push below.
      const dropped: string[] = [];

      /** Set when a withdrawal landed mid-loop; the refusal is raised below. */
      let retired = false;

      for (const row of batch) {
        const ticker = row.ticker!;
        let feed: MarketFeedResponse;
        try {
          feed = await postJson<MarketFeedResponse>(
            'engine',
            `${deps.engineUrl}/engine/v1/market-feed`,
            { kind: 'financials', ticker },
            {
              timeoutMs: FEED_TIMEOUT_MS,
              record: { valuationId: valuation.id, name: 'engine market-feed' },
            },
          );
        } catch (err) {
          if (err instanceof InternalServiceError) {
            // One unreachable ticker is not a failed refresh. The loop is the
            // unit of work an analyst pressed the button for, and reporting
            // "the feed is down for BADCO" beside four updated rows is more
            // use than a 502 that leaves them guessing which.
            req.log.warn({ err, ticker }, 'market feed fetch failed');
            // Composed rather than quoted: `err.message` is the raw feed body
            // whenever `opaque` is set, and this warning is drawn beside the
            // ticker in the comparables table.
            unavailable.push({ ticker, warning: describeForUser(err) });
            continue;
          }
          throw err;
        }

        const marketCap = fin(feed.market_cap);
        const revenue = fin(feed.total_revenue);
        const ebitda = fin(feed.ebitda);
        // `source` is the engine's own word for whether this was observed. A
        // payload that fell back carries the caller's estimates, not a quote,
        // and writing it as `live` is the one thing these columns exist to
        // prevent.
        if (feed.source !== 'yfinance' || marketCap === null || revenue === null) {
          unavailable.push({
            ticker,
            warning: str(feed.warning) ?? 'the live source returned no usable figures',
          });
          continue;
        }

        // Asked once per row, on the far side of that row's fetch, for the
        // reason the overdue sweep asks it once per engagement: this loop is
        // sweep-shaped. `refuseIfRetired` above read the engagement the request
        // came in with, and the loop then spends up to `REFRESH_BATCH` x
        // `FEED_TIMEOUT_MS` — over three minutes — leaving the process before it
        // stops writing. A withdrawal landing inside that window is the
        // ordinary case, not the exotic one, and every row after it carried
        // observed market figures onto a file the firm had closed, changing the
        // multiples of an approach a report already rests on. Retirement is
        // reversible since R90, so those figures come back with the engagement.
        //
        // After the fetch and immediately before the write, not at the top of
        // the iteration: asked at the top it settles the eight seconds that
        // follow it and says nothing about the write on the other side of them,
        // which is the gap it exists to close.
        //
        // Broken rather than continued: unlike a sweep, the rows behind this
        // one belong to the same withdrawn engagement, so there is nothing to
        // carry on to. The audit below still runs, so what this press did
        // before the withdrawal is recorded, and the refusal is raised after it
        // — a 409 that reports nothing would be the discarded record this
        // codebase keeps finding.
        if (await isRetiredNow(deps.pool, valuation.id)) {
          retired = true;
          break;
        }

        const asOf = new Date();
        const written = await updateComparableItem(deps.pool, valuation.id, row.id, {
          ev: marketCap,
          revenueLtm: revenue,
          ebitdaLtm: ebitda,
          figuresSource: 'live',
          figuresAsOf: asOf,
        });
        // THE UPDATE'S OUTCOME IS THE ONLY EVIDENCE THIS ROW WAS WRITTEN, and
        // the loop it sits in is long enough for the answer to be "it was
        // not". `batch` is a snapshot taken before the first fetch, and this
        // handler then leaves the process once per ticker with an eight-second
        // budget each — up to `REFRESH_BATCH` of them — so minutes separate the
        // read that named `row.id` from the write aimed at it. `id` is a ULID
        // and nothing reissues one, so a statement that matches no row means
        // the comp is gone, and both ways of removing one are ops actions
        // taken from the same screen: `DELETE /comparables/:itemId`, and a
        // re-screen, which is worse because `replaceMachineComparables` drops
        // *every* machine row and inserts new ids in their place. One
        // re-screen landing mid-refresh therefore invalidates the whole rest of
        // the batch at once.
        //
        // Pushed to `refreshed` regardless, this was a response that contradicted
        // itself in the same body: `refreshed` naming a ticker with an `as_of`
        // of seconds ago, `comparables` — re-read after the loop — either not
        // holding that row at all or holding a new one still carrying snapshot
        // figures, and `comparables_refreshed` recording the claim on the admin
        // trail where it outlives the request. An analyst reading "refreshed
        // AAA" and a peer set whose AAA is stale has no way to tell which half
        // is true, and the multiples struck from that set go into a filed 409A.
        //
        // Reported rather than skipped, for the reason `unavailable` is: a row
        // this press was asked to update and did not is exactly what the note
        // above the table exists to say. A bucket of its own because the two
        // are not the same fact — `unavailable` means the row kept the figures
        // it had, and there is no row here to have kept anything.
        if (!written) {
          req.log.warn(
            { ticker, itemId: row.id, valuationId: valuation.id },
            'comparable row disappeared mid-refresh',
          );
          dropped.push(ticker);
          continue;
        }
        refreshed.push({ ticker, as_of: asOf.toISOString() });
      }

      await audit(valuation, principal, 'comparables_refreshed', {
        refreshed: refreshed.map((r) => r.ticker),
        unavailable: unavailable.map((r) => r.ticker),
        dropped,
      });

      // The loop's own break, raised now that the trail carries the rows that
      // did land. A no-op on every press that ran to the end, and it also
      // closes the gap between the last write and this response.
      if (retired) await refuseIfRetiredNow(deps.pool, valuation.id, 'accepting changes');

      const { items: after, truncated } = await listComparableItems(deps.pool, valuation.id);
      return reply.status(200).send({
        comparables: after.map(presentComparable),
        statistics: summarizeSet(after),
        truncated,
        page_limit: COMPARABLE_PAGE_LIMIT,
        refreshed,
        unavailable,
        dropped,
        // What this press did not reach, so the tab can say so rather than
        // presenting a partial refresh as a complete one. Zero on every set
        // smaller than the batch, which is every real one.
        remaining,
        refresh_batch: REFRESH_BATCH,
      });
    },
  );
}
