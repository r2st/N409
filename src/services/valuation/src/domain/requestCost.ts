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
 */
export const COST_RULES: readonly CostRule[] = [
  // Document/report rendering and bundling — CPU plus large buffers.
  { pattern: /\/evidence(-bundle)?(\.zip)?$/, cost: 30 },
  { pattern: /\/exports?\/.+$/, cost: 15 },
  { pattern: /\.zip$/, cost: 30 },
  { pattern: /\.xlsx$/, cost: 15 },
  { pattern: /\.pdf$/, cost: 10 },
  { pattern: /\.csv$/, cost: 8 },

  // Engine round-trips.
  { pattern: /\/calculations$/, methods: ['POST'], cost: 12 },
  { pattern: /\/sensitivity/, cost: 12 },
  { pattern: /\/scenarios\/.+\/run$/, methods: ['POST'], cost: 12 },
  { pattern: /\/backsolve$/, methods: ['POST'], cost: 12 },
  { pattern: /\/waterfall$/, cost: 10 },
  { pattern: /\/asc718\/(expense|forecast)/, methods: ['POST'], cost: 10 },

  // AI pipelines — the most expensive thing the platform does per request.
  { pattern: /\/ai\/(jobs|run)/, methods: ['POST'], cost: 25 },
  { pattern: /\/qa$/, methods: ['POST'], cost: 20 },
  { pattern: /\/agents?\//, methods: ['POST'], cost: 25 },

  // Bulk reads that fan out across the corpus.
  { pattern: /\/documents\/.+\/content$/, cost: 5 },
  { pattern: /\/search$/, cost: 3 },
  { pattern: /\/audit-trail/, cost: 3 },
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
