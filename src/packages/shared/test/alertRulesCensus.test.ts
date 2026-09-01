// The alert rules in infra/monitoring/alerts.yml, held to the metrics the code
// actually exports.
//
// The failure this exists against is the quiet one: a metric is renamed or an
// instrument is deleted, the rule referring to it keeps parsing perfectly well,
// and the expression simply matches nothing for ever after. Prometheus does not
// complain about a query that returns no series — that is what a healthy system
// looks like — so an alert can go from "watching the pool" to "watching
// nothing" with no signal anywhere. It is the same class of bug as a route
// guard that passes by having nothing left to ask.
//
// So: every metric name in the rules must be one this repository registers, and
// every rule must carry the two things that make it actionable — a severity and
// a summary. The reverse direction is deliberately *not* asserted: plenty of
// instruments are context to read during an incident rather than something to
// be woken by, and requiring an alert per metric would produce exactly the
// pageable noise this file's header argues against.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { readBuildInfo, UNKNOWN_BUILD } from '../src/build.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../../../..');
const RULES = readFileSync(path.join(REPO, 'infra/monitoring/alerts.yml'), 'utf8');

/** Every `.ts` under src, excluding build output and tests. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (full.endsWith('.ts') && !full.includes('.test.')) out.push(full);
  }
  return out;
}

/**
 * The metric names this estate registers.
 *
 * Read off the `counter(`/`histogram(`/`gauge(` calls rather than from a list,
 * for the reason the list would exist to avoid: a second copy of the inventory
 * drifts from the first, and the drift is invisible in exactly the direction
 * that matters.
 */
function registeredMetrics(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles(path.join(REPO, 'src'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\.(?:counter|histogram|gauge)\(\s*'([a-z_][a-z0-9_]*)'/g)) {
      names.add(m[1]!);
    }
  }
  return names;
}

/**
 * PromQL's own vocabulary, which shares the metric-name character set.
 *
 * `up` and the histogram suffixes are the interesting entries: `up` is the
 * scraper's synthetic series and belongs to no service, and `_bucket`/`_sum`/
 * `_count` are series Prometheus derives from a histogram we do register.
 */
const PROMQL_WORDS = new Set(['histogram_quantile', 'label_replace', 'clamp_max', 'clamp_min']);

/** `foo_seconds_bucket` → `foo_seconds`; anything else unchanged. */
function baseMetric(token: string): string {
  return token.replace(/_(bucket|sum|count)$/, '');
}

/**
 * Metric-looking identifiers in the rule expressions.
 *
 * Quoted strings go first: a label *value* (`state="open"`, `job=~"n409-.*"`)
 * is caller-chosen text and is not a metric, and matching one would make this
 * census fail on a rule that is perfectly correct. Label *names* in this file
 * carry no underscore, which is what keeps them out without a second list.
 */
function metricTokens(): string[] {
  const expressions = [...RULES.matchAll(/expr:\s*(\|[\s\S]*?\n(?=\s{8}\w)|.*)/g)].map((m) => m[1]!);
  const tokens = new Set<string>();
  for (const expr of expressions) {
    const withoutStrings = expr.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
    // Any identifier carrying an underscore. Deliberately case-insensitive and
    // greedy to the end of the run: a stricter lowercase pattern skips a
    // mistyped `..._stateX` entirely rather than reporting it, which is the one
    // failure mode a census must not have.
    for (const m of withoutStrings.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      if (m[0].includes('_') && !PROMQL_WORDS.has(m[0])) tokens.add(m[0]);
    }
  }
  return [...tokens];
}

describe('alert rules', () => {
  it('names only metrics this repository registers', () => {
    const registered = registeredMetrics();
    const referenced = metricTokens();

    // Non-vacuity: if the expression scan silently matched nothing, every
    // assertion below would pass for the wrong reason.
    expect(referenced.length).toBeGreaterThan(10);
    expect(registered.size).toBeGreaterThan(20);

    const unknown = referenced.filter((token) => !registered.has(baseMetric(token)));
    expect(unknown, 'alert rules referring to metrics nothing exports').toEqual([]);
  });

  it('uses the histogram suffixes only on metrics that are histograms', () => {
    const suffixed = metricTokens().filter((t) => /_(bucket|sum|count)$/.test(t));
    expect(suffixed.length).toBeGreaterThan(0);
    for (const token of suffixed) {
      expect(token, `${token} is not a duration histogram`).toMatch(/_seconds_(bucket|sum|count)$/);
    }
  });

  it('gives every alert a severity and a summary', () => {
    const alerts = [...RULES.matchAll(/- alert: (\w+)/g)].map((m) => m[1]!);
    expect(alerts.length).toBeGreaterThan(15);
    // One severity and one summary per alert, so neither can be inherited from
    // a neighbour by accident.
    expect([...RULES.matchAll(/severity: \w+/g)]).toHaveLength(alerts.length);
    expect([...RULES.matchAll(/summary: /g)]).toHaveLength(alerts.length);
    expect(new Set(alerts).size, 'duplicate alert names').toBe(alerts.length);
  });

  it('matches label values the source actually emits', () => {
    // R321. The census above catches a rule naming a metric nothing exports.
    // A rule naming a metric that exists and selecting a label value that
    // nothing ever sets fails in exactly the same way and is invisible to it:
    // it parses, it matches nothing, and a query returning no series is what a
    // healthy system looks like.
    //
    // `BuildProvenanceMissing` selects `source="unknown"`, which is the one
    // label value in this file whose spelling lives in a TypeScript constant
    // rather than in a metric name — so it is the one that can drift on a
    // rename without anything noticing. `readBuildInfo`'s other two values are
    // asserted with it so a rule written against either later has the same
    // guard already in place.
    expect(RULES).toContain('n409_build_info{source="unknown"}');
    expect(UNKNOWN_BUILD.source).toBe('unknown');
    expect(readBuildInfo({ BUILD_SHA: 'a'.repeat(40) }, { defaultFile: undefined }).source).toBe('env');
  });

  it('pages only on the severities it declares', () => {
    const severities = new Set([...RULES.matchAll(/severity: (\w+)/g)].map((m) => m[1]!));
    // Deliberately two. A third level is where "info" alerts come from, and an
    // alert nobody acts on trains people to close alerts.
    expect([...severities].sort()).toEqual(['page', 'ticket']);
  });
});
