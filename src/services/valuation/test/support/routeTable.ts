import type { FastifyInstance } from 'fastify';

/**
 * `METHOD /path` for every mutating route registered under a valuation id.
 *
 * Fastify does not expose its route table, so this is parsed out of the tree
 * it prints. Each line carries its own indentation and its segment is relative
 * to the last shallower one, so the full path is rebuilt from a stack rather
 * than read off the line.
 *
 * Two sweeps drive their route lists from this rather than from a hand-kept
 * list — `retiredEngagementWrites.test.ts` for the session API and
 * `partnerApiRetired.test.ts` for the partner API — which is what makes a
 * route added tomorrow get swept the day it is registered. It lives here, in
 * support, rather than being exported from one of them: importing a `.test.ts`
 * file from another registers its suites a second time, and the session sweep
 * is a two-minute one.
 */
export function mutatingValuationRoutes(app: FastifyInstance): string[] {
  const stack: Array<{ indent: number; seg: string }> = [];
  const found = new Set<string>();
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = /^([\s│├└─]*)(\S[^(]*?)\s*\(([A-Z, ]+)\)\s*$/u.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const full = stack.map((s) => s.seg).join('') + m[2].trim();
    stack.push({ indent, seg: m[2].trim() });
    if (!/\/valuations\/:id\b/u.test(full)) continue;
    for (const method of m[3].split(',').map((x) => x.trim())) {
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        found.add(`${method} ${full}`);
      }
    }
  }
  return [...found].sort();
}
