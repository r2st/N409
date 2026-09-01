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
          new RegExp(
            `(?<![\\w.])${helper}\\(\\s*(?:req\\.log|app\\.log|deps\\.log|log)\\s*,[^{}]*\\{([^{}]*)\\}`,
            'g',
          ),
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
  /**
   * The same rule over the population the registration scan cannot see.
   *
   * `registrations` slices the balanced parens of one `app.post('…', …)` call,
   * so what it hands to the check above is the *inline handler* and nothing
   * else. Every route file of any size moves work out of that handler into a
   * module-level helper — `ai.ts` runs a whole pipeline in one, `debt.ts`
   * shapes an engine answer in another, `monitoring.ts` settles an alert in a
   * third — and those helpers are where the failures are logged. Measured, the
   * registration bodies hold a minority of the warn/error sites in the files
   * that serve these routes; the rest were outside the census entirely, which
   * is the population blind spot this estate keeps rediscovering (R305,
   * methodology M11; and R267's note on `glob` versus `rglob` two tiers over).
   *
   * The property is weaker here on purpose. Outside a registration there is no
   * `:id` in scope to prove the line *could* have named the engagement, and a
   * few of these files also serve routes that have no valuation at all — so
   * what is asked is that the line name *something*: a valuation, an
   * instrument, a job, a monitor. A bare `{ err }` is the shape that cannot be
   * joined to anything, and it is the one this refuses.
   *
   * `deps.log` and `app.log` are read alongside `req.log`: outside a request
   * handler `req` does not exist, so a helper necessarily holds one of the
   * other two, and a census that knew only `req.log` would have found nothing
   * out here even if it had looked.
   */
  const servingFiles = files.filter((f) =>
    registrations(f.code).some((r) => /\/valuations\/:id\b/.test(r.path)),
  );

  const moduleWide = servingFiles.flatMap((f) =>
    [...f.code.matchAll(/(?:req|app|deps)\.log\.(warn|error)\(\s*\{([^{}]*)\}/g)].map((m) => ({
      file: f.name,
      fields: m[2]!,
      text: m[0]!,
    })),
  );

  it('finds the whole file, not only the handler bodies — the vacuity guard', () => {
    // The number that says this is looking wider than the block above. If a
    // refactor moves every site back inside a handler this can fall honestly,
    // but it must never fall because the scan stopped matching.
    expect(servingFiles.length).toBeGreaterThanOrEqual(15);
    expect(moduleWide.length).toBeGreaterThanOrEqual(30);
  });

  it('names something on every failure a valuation-serving route file logs', () => {
    const anonymous = moduleWide
      .filter((call) => !identifies(call.fields))
      .map((call) => `${call.file}: ${call.text.slice(0, 70)}`);
    expect(anonymous).toEqual([]);
  });
});
