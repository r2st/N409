import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * Every outbound call to one of our own back-tier services carries the shared
 * secret (R308, methodology M5).
 *
 * The AI, engine and report services have no user-facing auth: this service is
 * their only legitimate caller, and `internal_auth.py` / `internalAuth.ts`
 * require an `X-Internal-Token` on every route that is not `/`, `/health` or
 * `/ready` whenever `INTERNAL_SERVICE_TOKEN` is configured — which is every
 * deployment, because the Python side refuses to boot in production without it.
 *
 * A caller that forgets the header therefore fails **only** where it matters. A
 * developer machine has no secret configured, the middleware lets everything
 * through, and the call works; production answers `401` every single time. And
 * because these call sites are all written to degrade rather than throw — an
 * empty model list, an `unknown` engine version — the symptom is not an error
 * but a feature that quietly does nothing, forever, in exactly one environment.
 *
 * `routes/prompts.ts` was that caller: the Bot Prompts model picker had been
 * empty in production since it shipped, and the only trace was a `warn` line
 * carrying `status: 401`.
 *
 * A source scan rather than a behavioural test because the property is "no call
 * site anywhere omits it", and the behavioural version of that is one test per
 * call site that nobody writes for the next one. Same shape as
 * `httpsUrlCensus`: the existing routes are exercised by their own tests, and
 * this covers the ones not written yet.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');

/**
 * How a URL in this service names one of our own back-tier processes.
 *
 * The route namespace rather than the config variable that supplies the host:
 * `AI_URL`/`ENGINE_URL`/`REPORT_URL` reach their call sites under half a dozen
 * parameter names (`url`, `baseUrl`, `deps.aiUrl`, `engineUrl`), and a census
 * keyed on those names misses whichever spelling the next caller picks. The
 * path is the part that cannot vary: these three prefixes are what the Python
 * and report tiers mount their token-checked routes under, and `/health` and
 * `/ready` — the only unauthenticated paths — are not under any of them.
 */
const INTERNAL_URL = /\/(ai|engine|render)\/v1\//;

/** The helper that supplies the header, however it is spread into an init. */
const CARRIES_TOKEN = /internalAuthHeaders\(\)|x-internal-token/i;

/**
 * The window a `fetch(` call's options are looked for in.
 *
 * Long enough for the header block plus a comment or two, short enough that the
 * next unrelated call cannot vouch for this one.
 */
const OPTIONS_LINES = 40;

interface Hit {
  file: string;
  line: number;
  text: string;
}

function scan(): { calls: Hit[]; missing: Hit[] } {
  const calls: Hit[] = [];
  const missing: Hit[] = [];
  for (const file of sourceFiles(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\bfetch(Fn|Impl)?\s*\(/.test(line)) return;
      if (!INTERNAL_URL.test(line)) return;
      const rel = path.relative(SRC, file);
      const hit: Hit = { file: rel, line: i + 1, text: line.trim() };
      calls.push(hit);
      const window = lines.slice(i, i + OPTIONS_LINES).join('\n');
      if (!CARRIES_TOKEN.test(window)) missing.push(hit);
    });
  }
  return { calls, missing };
}

describe('internal service calls carry the shared secret', () => {
  const { calls, missing } = scan();

  it('finds the call sites it claims to be checking', () => {
    // The vacuity guard every census here carries: a matcher that stopped
    // matching passes silently, and this one would then be reporting that a
    // property holds over nothing. Three is the count at R308 — the engine
    // health probe, the AI model list, and the report render POST — and a
    // regression that hides one of them fails here rather than going green.
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('leaves no internal call without an X-Internal-Token', () => {
    expect(
      missing.map((h) => `${h.file}:${h.line} ${h.text}`),
      'these outbound calls target a back-tier service and would be 401 in any ' +
        'deployment with INTERNAL_SERVICE_TOKEN set — add internalAuthHeaders()',
    ).toEqual([]);
  });
});
