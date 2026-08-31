/**
 * Request cost model for the weighted throttle.
 *
 * The session limiter counts requests, which treats `GET /valuations` and
 * `POST /valuations/:id/report.pdf` as equals. They are not: a PDF render, an
 * evidence bundle, a workbook export, an engine calculation or an AI job each
 * cost seconds of CPU and tens of megabytes, and a user comfortably inside the
 * per-minute request budget can still saturate the box with them.
 *
 * So expensive routes draw from a second, much smaller budget measured in
 * cost units rather than requests. Costs are deliberately coarse — the point
 * is the order of magnitude, not precision.
 */

export interface CostRule {
  /** Matched against the request path (query string already stripped). */
  pattern: RegExp;
  /** Restrict to specific methods; omit to match any. */
  methods?: readonly string[];
  cost: number;
}

/** Ordinary requests cost nothing against the heavy budget. */
export const DEFAULT_COST = 0;

/**
 * First match wins, so order matters: put the narrower pattern first.
 * Costs are relative — a render is ~10x a list, a bundle ~30x.
 *
 * Every pattern here has to match a URL this service actually registers, and
 * most of them used not to. The table was written from the shape the routes
 * were expected to take rather than the shape they took: there is no
 * `/ai/jobs`, no `/ai/run`, no `/backsolve`, no `/agents/…`, no
 * `/scenarios/:id/run`, no `/asc718/expense`, and no `/documents/:id/content`.
 * Seven of eighteen rules could not fire, and among them was the one the
 * comment called "the most expensive thing the platform does per request" — so
 * a 90-second LLM pipeline, a scenario that runs the engine, and a bulk export
 * were all charged nothing while the budget dutifully throttled a PDF
 * download. The budget looked configured and enforced exactly one thing it was
 * written to stop.
 *
 * `routeAudit.all()` now exposes the registered set, and the cost test asserts
 * every rule below matches something in it, so a rule cannot go dead again
 * when a route is renamed.
 */
export const COST_RULES: readonly CostRule[] = [
  // Anonymization, above the `/ai/:pipeline` rule below because it would
  // otherwise be swept up by it and charged as an LLM call. It is not one:
  // there is no model behind it, only a regex sweep. It is not free either —
  // it reads, decrypts and base64-encodes up to ten documents on the way — so
  // it sits at a render, which is the other thing this service does that is
  // all I/O and no upstream inference.
  { pattern: /\/ai\/anonymize$/, methods: ['POST'], cost: 10 },
  // AI pipelines — the most expensive thing the platform does per request.
  // POST /valuations/:id/ai/:pipeline. Matching a single trailing segment is
  // deliberate: /ai/extract/apply only re-reads a stored job's result.
  { pattern: /\/ai\/[^/]+$/, methods: ['POST'], cost: 25 },
  { pattern: /\/admin\/prompts\/[^/]+\/test$/, methods: ['POST'], cost: 25 },
  { pattern: /\/qa$/, methods: ['POST'], cost: 20 },

  // Market research — the second LLM surface, and the one the table never knew
  // about. `runOne` posts to the AI service's `/ai/v1/research`, which is a
  // model call with a web search behind it, on the same timeout budget as a
  // pipeline. Priced level with `/ai/:pipeline` because it is the same kind of
  // work reached by a different door.
  //
  // `refresh-all` before it, because it is not one of these: it runs every
  // non-subject topic in a loop — five of them, `RESEARCH_TOPIC_LIST` filtered
  // on `acceptsSubject` — from a single request. Charging it as one call is the
  // shape the budget exists to stop, so it is charged as what it is. The count
  // is pinned by `requestCost.test.ts`, so growing the registry cannot quietly
  // leave this number describing a smaller fan-out than the route performs.
  { pattern: /\/research\/refresh-all$/, methods: ['POST'], cost: 125 },
  { pattern: /\/research$/, methods: ['POST'], cost: 25 },
  // Comparable screening is an LLM call that returns a candidate peer set.
  { pattern: /\/comparables\/screen$/, methods: ['POST'], cost: 25 },
  // …and the refresh beside it is a fan-out of a different kind: one market
  // feed request per included comp carrying a ticker. No model, but a request
  // that leaves the process once per row of a set the caller controls.
  { pattern: /\/comparables\/refresh$/, methods: ['POST'], cost: 12 },

  // Ingest — the other direction, and the one the table used to miss entirely.
  //
  // Every other rule here prices work the *server* initiates on request. These
  // two price work the *caller* hands it, which is cheaper to ask for and no
  // cheaper to do: a cap-table upload inflates a ZIP and parses its XML in
  // process, and a document upload buffers up to 25 MB, sniffs it, hashes it,
  // encrypts it and writes it to disk. Both were free, so the budget that
  // throttles a 10-unit PDF download let the same user replay 25 MB uploads
  // without limit.
  //
  // The document rule matters twice over, because an extractable upload starts
  // the auto-pipeline (extract → param fill → draft calculation). That is the
  // same LLM work `POST /ai/:pipeline` is charged 25 for; reaching it by
  // uploading a file instead charged nothing. The cost sits below a direct AI
  // call because the pipeline is conditional — it only fires for kinds the
  // extractor handles, and only when AUTO_PIPELINE is on.
  { pattern: /\/cap-table\/upload$/, methods: ['POST'], cost: 12 },
  { pattern: /\/documents$/, methods: ['POST'], cost: 15 },

  // Document/report rendering and bundling — CPU plus large buffers.
  { pattern: /\/evidence-bundle$/, methods: ['POST'], cost: 30 },
  // The subject-access export: seventeen capped queries across the corpus, one
  // of them the whole valuations table for an owner. Above `/export` because it
  // fans out further, and priced at all because it is the rare heavy route a
  // signed-in user can hit without owning anything.
  //
  // The count is not load-bearing — costs here are order-of-magnitude and
  // eleven sections and seventeen are the same order — but it is written down,
  // so it is kept true. `personalDataCensus` is what will keep growing it.
  { pattern: /\/data-export$/, methods: ['GET'], cost: 20 },
  { pattern: /\/export$/, methods: ['GET'], cost: 15 },
  { pattern: /\.xlsx$/, cost: 15 },
  { pattern: /\/report\/render$/, methods: ['POST'], cost: 10 },
  { pattern: /\.pdf$/, cost: 10 },
  { pattern: /\/invoices\/[^/]+\/pdf$/, methods: ['GET'], cost: 10 },
  { pattern: /\.csv$/, cost: 8 },
  { pattern: /\/documents\/[^/]+\/download$/, methods: ['GET'], cost: 5 },

  // Engine round-trips.
  // The validator, not the run: `/calculations/preflight` posts to the engine's
  // `/engine/v1/validate`, which checks the inputs it would compute from
  // without computing. Above `/calculations$` for legibility; the anchors keep
  // them from overlapping.
  { pattern: /\/calculations\/preflight$/, methods: ['POST'], cost: 5 },
  { pattern: /\/calculations$/, methods: ['POST'], cost: 12 },
  { pattern: /\/specialty$/, methods: ['POST'], cost: 12 },
  { pattern: /\/projection\/run$/, methods: ['POST'], cost: 12 },
  // Anchored on the engagement rather than written as a bare `/rollforward$`,
  // which would also charge `/funds/:id/positions/:pid/rollforward` — a mark
  // carried forward in the database, which reaches nothing outside the process.
  { pattern: /\/valuations\/[^/]+\/rollforward$/, methods: ['POST'], cost: 12 },
  { pattern: /\/volatility\/estimate$/, methods: ['POST'], cost: 12 },
  { pattern: /\/wacc\/preview$/, methods: ['POST'], cost: 10 },
  { pattern: /\/sensitivity(\/model)?$/, methods: ['POST'], cost: 12 },
  { pattern: /\/scenarios(\/preview)?$/, methods: ['POST'], cost: 12 },
  { pattern: /\/asc718$/, methods: ['POST'], cost: 10 },
  { pattern: /\/waterfall$/, methods: ['POST'], cost: 10 },
  { pattern: /\/calibrate$/, methods: ['POST'], cost: 10 },
  { pattern: /\/instruments\/[^/]+\/value$/, methods: ['POST'], cost: 10 },
  { pattern: /\/rating-spread$/, methods: ['POST'], cost: 10 },

  // Bulk reads that fan out across the corpus.
  { pattern: /\/search$/, methods: ['GET'], cost: 3 },
  { pattern: /\/audit-trail$/, methods: ['GET'], cost: 3 },
];

/** Strip the query string and any trailing slash before matching. */
export function normalizePath(url: string): string {
  const path = url.split('?')[0] ?? '';
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** Cost units this request draws from the heavy budget (0 for ordinary ones). */
export function costOfRequest(method: string, url: string): number {
  const path = normalizePath(url);
  const upper = method.toUpperCase();
  for (const rule of COST_RULES) {
    if (rule.methods && !rule.methods.includes(upper)) continue;
    if (rule.pattern.test(path)) return rule.cost;
  }
  return DEFAULT_COST;
}

/** True when the request should be charged against the heavy budget at all. */
export function isHeavyRequest(method: string, url: string): boolean {
  return costOfRequest(method, url) > 0;
}
