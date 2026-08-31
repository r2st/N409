import type { FastifyInstance } from 'fastify';

/**
 * `METHOD /path` for every mutating route Fastify has registered whose path
 * matches `under`.
 *
 * Fastify does not expose its route table, so this is parsed out of the tree
 * it prints. Each line carries its own indentation and its segment is relative
 * to the last shallower one, so the full path is rebuilt from a stack rather
 * than read off the line.
 *
 * Three sweeps drive their route lists from this rather than from a hand-kept
 * list — `retiredEngagementWrites.test.ts` for the session API,
 * `partnerApiRetired.test.ts` for the partner API, and
 * `measurementRetiredWrites.test.ts` for the fund and debt surfaces — which is
 * what makes a route added tomorrow get swept the day it is registered. It
 * lives here, in support, rather than being exported from one of them:
 * importing a `.test.ts` file from another registers its suites a second time,
 * and the session sweep is a two-minute one.
 *
 * WHY A PATTERN RATHER THAN THE ONE HARD-CODED SHAPE it had until R282. The
 * valuation-scoped filter was written into this helper, so the census it
 * powers could only ever see routes addressed by an engagement id — and R279
 * found the whole ASC 820 measurement surface sitting outside that shape,
 * unguarded, because a fund and a debt instrument are addressed by their own
 * ids. Handing the shape in at the call site is what lets a second surface be
 * swept by the same machinery instead of by a hand-kept list that drifts.
 */
export function mutatingRoutesUnder(app: FastifyInstance, under: RegExp): string[] {
  const stack: Array<{ indent: number; seg: string }> = [];
  const found = new Set<string>();
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = /^([\s│├└─]*)(\S[^(]*?)\s*\(([A-Z, ]+)\)\s*$/u.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const full = stack.map((s) => s.seg).join('') + m[2].trim();
    stack.push({ indent, seg: m[2].trim() });
    if (!under.test(full)) continue;
    for (const method of m[3].split(',').map((x) => x.trim())) {
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        found.add(`${method} ${full}`);
      }
    }
  }
  return [...found].sort();
}

/** Every mutating route registered under a valuation id. */
export function mutatingValuationRoutes(app: FastifyInstance): string[] {
  return mutatingRoutesUnder(app, /\/valuations\/:id\b/u);
}

/**
 * Every mutating route on the ASC 820 measurement surface.
 *
 * Both subjects are addressed by their own ids — migrations 0086/0087 built
 * them as standalone ops tools keyed to nothing, and 0110 gave them an
 * engagement link afterwards — which is exactly why the valuation-scoped sweep
 * above could never see them.
 */
export function mutatingMeasurementRoutes(app: FastifyInstance): string[] {
  return mutatingRoutesUnder(app, /^\/api\/v1\/(funds|debt\/instruments)\/:id\b/u);
}
