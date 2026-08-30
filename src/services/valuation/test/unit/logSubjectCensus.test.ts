/**
 * A failure inside a valuation-scoped route names the valuation.
 *
 * Every line this service writes already carries the request id and, once the
 * request has authenticated, the actor — the mixin in `createLogger` puts them
 * there. What none of that answers is *what was being worked on*: eleven
 * `req.log.warn({ err }, …)` sites under `/api/v1/valuations/:id/…` reported an
 * engine compute, a projection, a roll-forward or a live stream failing and
 * named neither the engagement nor anything else.
 *
 * The join was not absent, which is why this survived so long. An engine call
 * writes a `network_items` row carrying both `request_id` and `valuation_id`,
 * so `requestId` on the log line could be walked to the engagement — through
 * the database, at incident time, and only for the calls that got far enough to
 * be recorded. A validation failure raised before the call, and the two stream
 * sites which make no engine call at all, had no row and therefore no answer.
 * "Is this one engagement or the whole book" is the first question asked of a
 * spike, and it should be answerable from the line.
 *
 * Phrased as a census over the route sources rather than a list of the eleven,
 * so the twelfth fails here instead of shipping anonymous. It reads sources
 * rather than running routes because the property is about every such site,
 * including the ones only an upstream outage reaches.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTES = join(dirname(fileURLToPath(import.meta.url)), '../../src/routes');

/** Comment-stripped, line structure preserved, so a prose `:id` is not a route. */
function code(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/([^:"'`\\])\/\/[^\n]*/g, (m, p1: string) => p1 + blank(m.slice(1)));
}

/**
 * Every `app.<verb>('<path>', …)` registration, as (path, body).
 *
 * Balanced on parens from the opening one of the call, which is what makes the
 * body the *registration's* rather than everything to the next `app.` — the
 * trap a route-boundary scan falls into when it splits on the next match and
 * quietly attributes a handler's contents to its predecessor.
 */
function registrations(src: string): Array<{ path: string; body: string; offset: number }> {
  const out: Array<{ path: string; body: string; offset: number }> = [];
  // `app.` and `scope.` both register here — the payments routes build an
  // encapsulated scope for the Stripe raw-body parser and hang eleven routes
  // off it. A scan that knew only about `app.` would read as covering them.
  const call = /\b(?:app|scope)\.(?:get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\1/g;
  for (const m of src.matchAll(call)) {
    const open = src.indexOf('(', m.index!);
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          out.push({ path: m[2]!, body: src.slice(open, i), offset: open });
          break;
        }
      }
    }
  }
  return out;
}

const files = readdirSync(ROUTES)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ name: f, code: code(readFileSync(join(ROUTES, f), 'utf8')) }));

describe('a failure logged from a valuation-scoped route', () => {
  const scoped = files.flatMap((f) =>
    registrations(f.code)
      .filter((r) => /\/valuations\/:id\b/.test(r.path))
      .map((r) => ({ file: f.name, ...r })),
  );

  it('finds the valuation-scoped routes at all — the vacuity guard', () => {
    // Without this a regex that stopped matching would leave the check below
    // passing over an empty set, which is how a census stops being one.
    expect(scoped.length).toBeGreaterThanOrEqual(30);
  });

  const identifies = (fields: string): boolean =>
    fields
      .split(',')
      .map((k) => k.trim().split(':')[0]!.trim())
      .filter(Boolean)
      // `err` is the failure, not the subject. Anything else identifying is
      // accepted: some of these routes work on a nested resource and naming
      // that is at least as useful as naming its parent.
      .some((k) => k !== 'err' && k !== 'error');

  it('names the valuation on every warn and error it writes', () => {
    const anonymous: string[] = [];
    for (const route of scoped) {
      const calls = route.body.matchAll(/req\.log\.(warn|error)\(\s*\{([^{}]*)\}/g);
      for (const call of calls) {
        if (!identifies(call[2]!)) anonymous.push(`${route.file} ${route.path}: ${call[0]!.slice(0, 60)}`);
      }
    }
    expect(anonymous).toEqual([]);
  });

  /**
   * The same rule where the logging goes through a helper.
   *
   * `req.log.warn({ … })` is not the only way one of these routes writes a
   * line any more, and every other way is invisible to the scan above.
   * `logFailure` and `logUnretried` (`shared/failure.ts`) take the logger and a
   * context object, `logConnectorSyncFailure` takes a subject — and a site
   * converted to one of them silently leaves this census rather than failing
   * it, which is the population blind spot in its purest form: the check goes
   * on passing over a set that is quietly shrinking.
   *
   * So the helpers are read too. The argument that carries the fields is found
   * by shape — the first object literal after the logger — because that is
   * what the three of them have in common and what a fourth will have.
   */
  const HELPERS = ['logFailure', 'logUnretried', 'logConnectorSyncFailure'];

  const helperCalls = scoped.flatMap((route) =>
    HELPERS.flatMap((helper) =>
      [
        ...route.body.matchAll(
          new RegExp(`(?<![\\w.])${helper}\\(\\s*(?:req\\.log|log)\\s*,[^{}]*\\{([^{}]*)\\}`, 'g'),
        ),
      ].map((m) => ({ route, helper, fields: m[1]!, text: m[0]! })),
    ),
  );

  it('finds the helper-logged failures at all — the vacuity guard', () => {
    // Without this the regex could stop matching and the check below would
    // pass over nothing, which is how the sites that left this census by being
    // converted would leave it again.
    expect(helperCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('names the valuation on those too', () => {
    const anonymous = helperCalls
      .filter((call) => !identifies(call.fields))
      .map((call) => `${call.route.file} ${call.route.path}: ${call.text.slice(0, 60)}`);
    expect(anonymous).toEqual([]);
  });
});
