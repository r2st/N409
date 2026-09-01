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

/**
 * The labels each metric registers, read off the same `counter(`/`histogram(`/
 * `gauge(` calls the names come from.
 *
 * The label array is the last argument that is an array *of quoted strings* —
 * histograms carry a bucket array after theirs, and it is numeric, which is
 * what keeps the two apart without a second inventory to drift.
 */
function registeredLabels(): Map<string, string[]> {
  const labels = new Map<string, string[]>();
  for (const file of sourceFiles(path.join(REPO, 'src'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\.(?:counter|histogram|gauge)\(\s*'([a-z_][a-z0-9_]*)'/g)) {
      // Paren-balanced to the end of the call, for the same reason the webhook
      // census brace-matches its scopes: a `gauge(` whose `collect` runs for
      // twenty lines would otherwise be read to the wrong closing bracket.
      const open = src.indexOf('(', m.index!);
      let depth = 0;
      let end = src.length;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')' && --depth === 0) {
          end = i;
          break;
        }
      }
      const arrays = [...src.slice(open, end).matchAll(/\[\s*(?:'[^']*'\s*,\s*)*'[^']*'\s*,?\s*\]/g)];
      const last = arrays.at(-1);
      labels.set(m[1]!, last ? [...last[0].matchAll(/'([^']*)'/g)].map((q) => q[1]!) : []);
    }
  }
  return labels;
}

/**
 * Each metric's help text, from the same registration the names come from.
 *
 * Only the ones whose help says the gauge reads zero for something other than
 * a measurement are interesting here, and saying so in the help is the
 * convention this estate already follows — see `n409_cgroup_memory_max_bytes`.
 */
function registeredHelp(): Map<string, string> {
  const help = new Map<string, string>();
  for (const file of sourceFiles(path.join(REPO, 'src'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(
      /\.(?:counter|histogram|gauge)\(\s*'([a-z_][a-z0-9_]*)'\s*,\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g,
    )) {
      help.set(m[1]!, m[2] ?? m[3] ?? '');
    }
  }
  return help;
}

/** One rule: its expression, and the whole block including its annotations. */
interface Rule {
  name: string;
  expr: string;
  block: string;
}

function parsedRules(): Rule[] {
  const blocks: Rule[] = [];
  const starts = [...RULES.matchAll(/- alert: (\w+)/g)];
  for (const [i, start] of starts.entries()) {
    const block = RULES.slice(start.index!, starts[i + 1]?.index ?? RULES.length);
    const expr = /expr:\s*(\|[\s\S]*?\n(?=\s{8}\w)|.*)/.exec(block)?.[1] ?? '';
    blocks.push({ name: start[1]!, expr, block });
  }
  return blocks;
}

/**
 * Labels the *scraper* attaches rather than the source, plus PromQL's own.
 *
 * `job` and `instance` come from the scrape config's `job_name` and target
 * address and are on every series Prometheus collects; `le` is the bucket
 * boundary a histogram query groups by. Nothing in `src/` registers any of
 * them, and a rule that groups by one is correct.
 */
const SCRAPER_LABELS = new Set(['job', 'instance', 'le']);

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

  it('never divides by a gauge whose zero means "there is no such limit"', () => {
    /*
     * R337, and the fourth direction this file watches. The three above are
     * about a rule that matches *nothing*: a metric nothing exports, a label
     * value nothing sets, a label name nothing carries. This one is the
     * opposite failure and is worse for the same reason — a rule that matches
     * *everything*, permanently, and says the opposite of the truth.
     *
     * Several gauges here report 0 for a state that is not a measurement, and
     * that is a deliberate choice each of them argues: `cgroupMemory.ts` says
     * "a ceiling of zero is impossible, so the value is unambiguous, and it
     * makes 'this unit has no limit' something an alert can match on rather
     * than an absent series that looks the same as a service that is down".
     * True — and it makes the same gauge lethal as a divisor.
     * `MemoryNearCgroupLimit` divided by `n409_cgroup_memory_max_bytes`, so a
     * unit with no ceiling produced `current / 0` = `+Inf`, which is greater
     * than 0.9, and raised a ticket that could not be closed for a condition
     * that did not exist.
     *
     * `(metric > 0)` as the denominator is the fix and the thing held here: it
     * is a filter, so it keeps the value and drops only the reading that means
     * "there is nothing to be near".
     */
    const zeroMeansAbsent = [...registeredHelp()]
      .filter(([, help]) => /\bor 0 when\b/.test(help))
      .map(([name]) => name);
    // Non-vacuity: the convention has to still be in the source for the scan
    // below to have anything to check.
    expect(zeroMeansAbsent).toContain('n409_cgroup_memory_max_bytes');

    const unguarded: string[] = [];
    for (const rule of parsedRules()) {
      for (const metric of zeroMeansAbsent) {
        if (!new RegExp(`/[\\s(]*${metric}\\b`).test(rule.expr)) continue;
        // Parenthesised, and that is not pedantry: the unguarded expression
        // `current / max_bytes > 0.9` *contains* the substring `max_bytes > 0`,
        // so a looser pattern here passes on exactly the rule this case exists
        // to fail. `(metric > 0)` is also the only spelling that is a filter
        // rather than a comparison against the whole division.
        if (!new RegExp(`\\(\\s*${metric}\\s*>\\s*0\\s*\\)`).test(rule.expr))
          unguarded.push(`${rule.name}/${metric}`);
      }
    }
    expect(unguarded, 'rules dividing by a gauge that reads 0 when the limit is unset').toEqual([]);
  });

  it('has a rule for a unit whose memory ceiling has gone', () => {
    // The other half of the fix above: filtering the divisor drops the
    // no-ceiling unit out of `MemoryNearCgroupLimit` entirely, and a reading
    // that is dropped by every rule is one nobody sees. R99 gave all five
    // units a MemoryMax because the box is 3.8 GB and one unit's leak must not
    // be able to take the other four with it; a unit that has lost its ceiling
    // is back to that, silently.
    expect(RULES).toContain('n409_cgroup_memory_max_bytes == 0');
  });

  it('groups and annotates by labels the metrics in that rule actually carry', () => {
    /*
     * R329. Two censuses already stand here: a rule may not name a metric
     * nothing exports, and may not select a label *value* nothing sets. The
     * third direction was open, and it is the one that fails hardest — a label
     * *name* that no metric in the expression carries.
     *
     * Five rules grouped and annotated by `service`, which lives on
     * `upstream_*` (where it names the dependency being called) and on
     * `n409_build_info`, and on none of the process or HTTP instruments. Both
     * halves of that are silent:
     *
     *   * `sum by (service) (rate(http_request_errors_total[5m]))` drops `job`
     *     and `instance` and groups by a label that is not there, which is one
     *     series containing all three units. `HighServerErrorRate` therefore
     *     fired on the estate-wide ratio, and the report unit — low volume by
     *     design — could fail every single request while the web service's
     *     healthy traffic held the quotient under five per cent.
     *   * `{{ $labels.service }}` on a series without one renders empty, so the
     *     page that did fire said "  is failing more than 5% of requests".
     *
     * Neither is visible from the rule: it parses, it evaluates, it produces a
     * number. Same family as a query that matches nothing, one level down.
     */
    const labels = registeredLabels();
    const rules = parsedRules();
    expect(rules.length).toBeGreaterThan(15);

    const offenders: string[] = [];
    for (const rule of rules) {
      const metrics = [...rule.expr.replace(/"[^"]*"/g, '""').matchAll(/[a-z_][a-z0-9_]*/g)]
        .map((m) => baseMetric(m[0]))
        .filter((name) => labels.has(name));
      // A rule with no instrument of ours in it (`up`) can only be talking
      // about the scraper's labels, which is the allow-list below.
      const available = new Set([...SCRAPER_LABELS, ...metrics.flatMap((m) => labels.get(m)!)]);

      const referenced = new Set<string>();
      // Grouped by…
      for (const by of rule.expr.matchAll(/\b(?:by|without)\s*\(([^)]*)\)/g)) {
        for (const name of by[1]!.split(',')) if (name.trim()) referenced.add(name.trim());
      }
      // …selected on…
      for (const sel of rule.expr.matchAll(/([a-z_][a-z0-9_]*)\s*(?:=~|!~|!=|=)\s*"/g)) {
        referenced.add(sel[1]!);
      }
      // …and named in the summary or the runbook, which is the half an operator
      // reads at three in the morning.
      for (const tpl of rule.block.matchAll(/\$labels\.([a-z_][a-z0-9_]*)/g)) referenced.add(tpl[1]!);

      for (const name of referenced) {
        if (!available.has(name)) offenders.push(`${rule.name}: ${name}`);
      }
    }
    expect(offenders, 'rules referring to labels their own metrics do not carry').toEqual([]);
  });

  it('reads the label arrays off the registrations rather than a list', () => {
    // Non-vacuity for the census above: if the extraction returned nothing, or
    // returned the bucket array instead of the label array, every rule would
    // pass by having no labels to contradict.
    const labels = registeredLabels();
    expect(labels.get('http_requests_total')).toEqual(['method', 'route', 'status']);
    expect(labels.get('upstream_requests_total')).toEqual(['service', 'outcome']);
    // A histogram, whose buckets follow its labels.
    expect(labels.get('http_request_duration_seconds')).toEqual(['method', 'route']);
    // And the shape the five broken rules were written against: no labels at
    // all, so `by (service)` on it was one series holding the whole estate.
    expect(labels.get('process_uptime_seconds')).toEqual([]);
  });

  it('pages only on the severities it declares', () => {
    const severities = new Set([...RULES.matchAll(/severity: (\w+)/g)].map((m) => m[1]!));
    // Deliberately two. A third level is where "info" alerts come from, and an
    // alert nobody acts on trains people to close alerts.
    expect([...severities].sort()).toEqual(['page', 'ticket']);
  });
});
