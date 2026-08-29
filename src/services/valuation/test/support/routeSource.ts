import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Every route registration in `src/routes`, read out of the source.
 *
 * Three censuses audit the route table this way — `privilegedRouteAuthorization`,
 * `resourceScopeAuthorization` and `authorizationCoverageCensus` — and each
 * carried its own copy of the scan. The copies agreed on the part that was
 * wrong.
 *
 * ## What the copies could not see
 *
 * All three matched `app.get(` / `app.post(` and nothing else, so a route
 * registered on an *encapsulated* instance was invisible to every one of them.
 * That is not a hypothetical spelling: five routes were already registered that
 * way before this file existed — the Stripe webhook, the billing webhook, the
 * email-delivery webhook, `POST /api/v1/unsubscribe` and the SAML assertion
 * consumer — each inside a `app.register(async (scope) => …)` that exists to
 * give the route its own raw-body or urlencoded parser. A sweep whose stated
 * job is "no route on a privileged surface escapes a guard" was reporting a
 * clean result over a table with the payment and identity webhooks missing
 * from it.
 *
 * The second half is the prefix. `registerScimRoutes` registers under
 * `{ prefix: '/scim/v2' }`, so its handlers read `scope.get('/Users')` in the
 * source and answer at `/scim/v2/Users` in the service. A scan that took the
 * literal would file them under `/Users` — which matches no prefix any census
 * knows, so the whole SCIM surface would drop out of all three at once and
 * `PRIVILEGED_PREFIXES`' `/scim/v2` entry would go stale on the same commit.
 *
 * So the scan resolves both: it accepts either receiver, and it prepends the
 * prefix of the `register` call a route is lexically inside. The receiver names
 * are an allow-list rather than "any identifier" because `\w+\.get(` also
 * matches every `Map.get` in a route file; `RECEIVERS` is asserted against the
 * source by `routeSourceScan.test.ts`, so a fourth spelling has to be added
 * here rather than silently shrinking the table.
 *
 * It stays a source scan, and inherits that shape's limits: it sees what is
 * written, not what is mounted. `mutatingValuationRoutes` (routeTable.ts) reads
 * the live tree for the sweeps that need the real thing.
 */

/** The identifiers a Fastify route is registered on in `src/routes`. */
export const RECEIVERS = ['app', 'scope'] as const;

export interface SourceRoute {
  file: string;
  /** 1-based line of the registration. */
  line: number;
  method: string;
  /** The URL as the service answers it — prefix resolved. */
  url: string;
  /** Source text of the handler, from the registration to its closing `});`. */
  body: string;
}

const VERB = new RegExp(`\\b(?:${RECEIVERS.join('|')})\\.(get|post|put|patch|delete)[<(]`);

/**
 * The line ranges covered by an encapsulated `register(..., { prefix: '/x' })`.
 *
 * The options object is the last argument of the call it belongs to, so the
 * call opened on the nearest preceding `.register(` and everything between the
 * two is inside it. Pairing that way rather than by brace-matching keeps this a
 * line scan; the cost is that a `prefix:` written anywhere other than a
 * `register` call would attach to the wrong range, which `routeSourceScan`
 * checks by asserting the resolved URLs of the prefixed surface.
 */
function prefixRanges(lines: string[]): Array<{ from: number; to: number; prefix: string }> {
  const ranges: Array<{ from: number; to: number; prefix: string }> = [];
  lines.forEach((line, i) => {
    const declared = /\bprefix:\s*['"`](\/[^'"`]*)['"`]/.exec(line);
    if (!declared) return;
    for (let j = i; j >= 0; j--) {
      if (/\.register[<(]/.test(lines[j] ?? '')) {
        ranges.push({ from: j, to: i, prefix: declared[1]! });
        return;
      }
    }
  });
  return ranges;
}

/**
 * The handler's source, from its registration to the `});` that closes it.
 *
 * Terminated on the registration line's own indentation rather than on a fixed
 * two or four spaces: a route inside a `register` callback is indented one
 * level deeper than one registered at the top of the function, and a hard-coded
 * column truncates its body at the first nested closing brace — which reads as
 * a handler that calls no guard.
 */
function bodyFrom(lines: string[], start: number, maxLines: number): string {
  const indent = /^\s*/.exec(lines[start] ?? '')![0];
  const closes = new RegExp(`^${indent}\\}\\);\\s*$`);
  let body = '';
  for (let j = start; j < Math.min(lines.length, start + maxLines); j++) {
    body += `${lines[j]}\n`;
    if (j > start && closes.test(lines[j] ?? '')) break;
  }
  return body;
}

/** Every route registration under `routesDir`, prefix resolved. */
export function scanRoutes(routesDir: string, opts: { maxBodyLines?: number } = {}): SourceRoute[] {
  const maxBodyLines = opts.maxBodyLines ?? 250;
  const found: SourceRoute[] = [];
  for (const file of readdirSync(routesDir).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(path.join(routesDir, file), 'utf8');
    const lines = source.split('\n');
    const ranges = prefixRanges(lines);

    lines.forEach((line, i) => {
      const verb = VERB.exec(line);
      if (!verb) return;
      // The URL may wrap onto the next line when the options object is long.
      const url = /["'`](\/[^"'`]*)["'`]/.exec(lines.slice(i, i + 3).join(' '));
      if (!url?.[1]) return;
      const range = ranges.find((r) => i >= r.from && i <= r.to);
      const resolved = range && !url[1].startsWith(`${range.prefix}/`) ? `${range.prefix}${url[1]}` : url[1];
      found.push({
        file,
        line: i + 1,
        method: verb[1]!.toUpperCase(),
        url: resolved,
        body: bodyFrom(lines, i, maxBodyLines),
      });
    });
  }
  return found;
}
