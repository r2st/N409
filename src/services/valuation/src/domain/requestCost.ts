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
  // AI pipelines — the most expensive thing the platform does per request.
  // POST /valuations/:id/ai/:pipeline. Matching a single trailing segment is
  // deliberate: /ai/extract/apply only re-reads a stored job's result.
  { pattern: /\/ai\/[^/]+$/, methods: ['POST'], cost: 25 },
  { pattern: /\/admin\/prompts\/[^/]+\/test$/, methods: ['POST'], cost: 25 },
  { pattern: /\/qa$/, methods: ['POST'], cost: 20 },

  // Document/report rendering and bundling — CPU plus large buffers.
  { pattern: /\/evidence-bundle$/, methods: ['POST'], cost: 30 },
  { pattern: /\/export$/, methods: ['GET'], cost: 15 },
  { pattern: /\.xlsx$/, cost: 15 },
  { pattern: /\/report\/render$/, methods: ['POST'], cost: 10 },
  { pattern: /\.pdf$/, cost: 10 },
  { pattern: /\/invoices\/[^/]+\/pdf$/, methods: ['GET'], cost: 10 },
  { pattern: /\.csv$/, cost: 8 },
  { pattern: /\/documents\/[^/]+\/download$/, methods: ['GET'], cost: 5 },

  // Engine round-trips.
  { pattern: /\/calculations$/, methods: ['POST'], cost: 12 },
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
