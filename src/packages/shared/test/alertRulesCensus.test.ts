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
import { CGROUP_MEMORY_EVENTS } from '../src/cgroupMemory.js';
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
 * And every `.py`, which this census used to be blind to.
 *
 * The blind spot was written down rather than fixed: this file's own header in
 * `alerts.yml` said "it reads the **TypeScript** registrations only … a rule
 * that only the Python units would fire is therefore not covered by the census
 * — keep the two names identical". That held while every Python instrument was
 * a second copy of a TypeScript one, so the TS registration stood in for both.
 * R369 broke that assumption twice: `cgroup_memory.py` is still a twin, but
 * `market_feed_provider` is registered by the engine unit and nowhere else, so
 * `MarketFeedProviderMisbuilt` names a metric no `.ts` file has ever heard of —
 * which is indistinguishable, to the old census, from a rule watching nothing.
 *
 * Excludes `.venv` (a few thousand vendored files, none of them ours) and the
 * per-service `tests` directories, matching what `sourceFiles` excludes.
 */
function pythonSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '.venv' || entry === '__pycache__' || entry === 'tests' || entry === 'node_modules') {
      continue;
    }
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) pythonSourceFiles(full, out);
    else if (full.endsWith('.py')) out.push(full);
  }
  return out;
}

/**
 * One registration found in source: which file, and the text of the whole call.
 *
 * Paren-balanced to the end of the call, for the same reason the webhook census
 * brace-matches its scopes: a `gauge(` whose `collect` runs for twenty lines
 * would otherwise be read to the wrong closing bracket.
 *
 * The two languages differ in exactly two ways that matter here — the quote a
 * string literal uses, and whether a label list is `['a']` or `('a',)` — so
 * they share this walk and differ in the patterns handed to it.
 */
interface Registration {
  name: string;
  call: string;
  python: boolean;
}

function registrations(): Registration[] {
  const found: Registration[] = [];
  const scan = (files: string[], pattern: RegExp, python: boolean) => {
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(pattern)) {
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
        found.push({ name: m[1]!, call: src.slice(open, end), python });
      }
    }
  };
  scan(sourceFiles(path.join(REPO, 'src')), /\.(?:counter|histogram|gauge)\(\s*'([a-z_][a-z0-9_]*)'/g, false);
  scan(
    pythonSourceFiles(path.join(REPO, 'src/services')),
    /\.(?:counter|histogram|gauge)\(\s*"([a-z_][a-z0-9_]*)"/g,
    true,
  );
  return found;
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
  return new Set(registrations().map((r) => r.name));
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
  for (const { name, call, python } of registrations()) {
    // A tuple in Python, an array in TypeScript, and each language's own
    // quote — otherwise the same rule, including "last one wins" so a
    // histogram's numeric bucket list does not shadow its labels.
    const lists = python
      ? [...call.matchAll(/\(\s*(?:"[^"]*"\s*,\s*)*"[^"]*"\s*,?\s*\)/g)]
      : [...call.matchAll(/\[\s*(?:'[^']*'\s*,\s*)*'[^']*'\s*,?\s*\]/g)];
    const last = lists.at(-1);
    const quoted = python ? /"([^"]*)"/g : /'([^']*)'/g;
    labels.set(name, last ? [...last[0].matchAll(quoted)].map((q) => q[1]!) : []);
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
  for (const { name, call } of registrations()) {
    const first = /^\(\s*(?:'[a-z_][a-z0-9_]*'|"[a-z_][a-z0-9_]*")\s*,\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/.exec(
      call,
    );
    if (first) help.set(name, first[1] ?? first[2] ?? '');
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

  it('reads the Python tiers registrations, not only the TypeScript ones', () => {
    // The vacuity guard on the scan above. `pythonSourceFiles` walking the
    // wrong directory, or the double-quote pattern failing to match, would make
    // every assertion in this file pass by having nothing left to ask — and the
    // symptom would be a Python-only rule silently readmitted as "watching
    // nothing", which is the exact failure this census exists against.
    //
    // Named metrics rather than a count, because a population that shrinks to
    // one still satisfies a count. `market_feed_provider` is registered by the
    // engine unit and by nothing in TypeScript; `n409_cgroup_memory_events` is
    // registered on both sides and must resolve on this one too, since the twin
    // is hand-kept and a rename in `cgroup_memory.py` alone is exactly the
    // drift the comment in `cgroupMemory.ts` warns about.
    const python = registrations().filter((r) => r.python);
    const names = new Set(python.map((r) => r.name));
    expect(names.has('market_feed_provider')).toBe(true);
    expect(names.has('n409_cgroup_memory_events')).toBe(true);
    expect(names.has('http_requests_total')).toBe(true);

    // And the labels, which the tuple pattern reads and the array pattern
    // cannot: `MarketFeedProviderMisbuilt` selects `{state="misbuilt"}`.
    expect(registeredLabels().get('market_feed_provider')).toEqual(['state']);
    expect(registeredLabels().get('n409_cgroup_memory_events')).toEqual(['event']);
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

  it('reads the tally field every declining sweep flattens for it', () => {
    /*
     * R341, and the fifth direction. The four above are about a rule that is
     * wrong — a metric nothing exports, a label value nothing sets, a label
     * name nothing carries, a divisor whose zero is not a measurement. This one
     * is about a rule that is *absent*, which fails the same way and is the
     * harder half to notice: nothing in `alerts.yml` is red, because nothing in
     * `alerts.yml` mentions it.
     *
     * Two sweeps take a cross-instance Postgres advisory lock inside the tick
     * and decline when another pass holds it. A declined pass returns the same
     * zeros a pass that ran and found nothing due returns, so each one flattens
     * the decline into its tally — `auto-email` as `declined`, `job-alerts` as
     * `skipped` — for the sole purpose of separating "did not happen" from
     * "nothing to do". Both fields were written for the permanent case, where a
     * leaked session lock declines every later pass for ever; both then reached
     * `background_sweep_items_total` and no rule at all, so the condition they
     * exist to make visible was visible to nobody.
     *
     * `x ? 1 : 0` in a sweep tally is the whole idiom — `sweepTally` is
     * deliberately shallow and counts numbers only, so a boolean this tier
     * wants counted has to be spelled exactly this way. Held here rather than
     * as a list of the two, so the third one is caught the day it is written.
     */
    const src = readFileSync(path.join(REPO, 'src/services/valuation/src/index.ts'), 'utf8');
    const flattened: Array<{ sweep: string; field: string }> = [];
    for (const m of src.matchAll(/scheduleSweep\(\s*'([a-z-]+)'/g)) {
      // Paren-balanced to the end of the call, for the reason `registeredLabels`
      // above balances its own: a tick body runs for dozens of lines.
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
      for (const f of src.slice(open, end).matchAll(/(\w+):\s*[\w.]+\s*\?\s*1\s*:\s*0/g)) {
        flattened.push({ sweep: m[1]!, field: f[1]! });
      }
    }
    // Non-vacuity: a scan that matched no sweep, or no tick body, would pass
    // this case by having nothing to require a rule for.
    expect(flattened.map((f) => `${f.sweep}.${f.field}`).sort()).toEqual([
      'auto-email.declined',
      'job-alerts.skipped',
    ]);

    // Every selector on the item tally, as the braces of the selector.
    const selectors = [...RULES.matchAll(/background_sweep_items_total\{([^}]*)\}/g)].map((m) => m[1]!);
    expect(selectors.length).toBeGreaterThan(2);

    const unwatched = flattened.filter(
      ({ sweep, field }) =>
        !selectors.some(
          (sel) =>
            new RegExp(`sweep="${sweep}"`).test(sel) &&
            new RegExp(`outcome=~?"[^"]*\\b${field}\\b[^"]*"`).test(sel),
        ),
    );
    expect(
      unwatched.map((f) => `${f.sweep}.${f.field}`),
      'sweeps that report having examined nothing, to no rule',
    ).toEqual([]);
  });

  it('reads every kernel memory event it went to the trouble of exporting', () => {
    /*
     * R345, and the sixth direction. R341's case above is a rule that is
     * absent for a field two sweeps flatten; this is the same absence one size
     * up — a whole labelled family exported, scraped, and selected by nothing.
     *
     * `cgroupMemory.ts` reads `memory.events` and exports its five counters
     * with an argument for why they are the ones worth having: "`high` counts
     * times the cgroup was throttled at `MemoryHigh`, `max` counts times an
     * allocation was about to breach `MemoryMax` and reclaim was forced ... the
     * first two are the early warning; they tick long before anything dies".
     * No rule in this file named the metric at all, so the early warning warned
     * nobody, and the only memory rule that existed — `MemoryNearCgroupLimit` —
     * samples an instantaneous ratio and requires ten consecutive minutes of
     * it. A unit that allocates hard inside one request is reclaimed, throttled
     * or killed between two scrapes without that ratio ever being observed.
     *
     * Held against the exported constant rather than a list here, so an event
     * added to `CGROUP_MEMORY_EVENTS` — the kernel publishes more than these
     * five — arrives with this case red until somebody decides whether it is
     * worth waking for.
     */
    const selectors = [...RULES.matchAll(/n409_cgroup_memory_events\{([^}]*)\}/g)].map((m) => m[1]!);
    // Non-vacuity: a scan finding no selector would pass every event below by
    // having nothing to check them against.
    expect(selectors.length).toBeGreaterThan(1);

    /*
     * The one event deliberately left unwatched, and why.
     *
     * `low` counts reclaim that happened *despite* `MemoryLow` protection,
     * which is a statement about the host's pressure rather than about this
     * unit: nothing under infra/systemd sets `MemoryLow`, so it says only that
     * the box as a whole reclaimed. An alert nobody can act on is the thing
     * this file's header refuses to have.
     */
    const unwatchable = new Set(['low']);
    // And `oom`, which counts invocations of the cgroup OOM handler — every one
    // of which either ends in an `oom_kill` (watched) or in the allocation
    // failing, which is `max` (watched). A third page for the same instant.
    unwatchable.add('oom');

    const unwatched = CGROUP_MEMORY_EVENTS.filter(
      (event) =>
        !unwatchable.has(event) &&
        !selectors.some((sel) => new RegExp(`event=~?"[^"]*\\b${event}\\b[^"]*"`).test(sel)),
    );
    expect(unwatched, 'kernel memory events exported to no rule').toEqual([]);
    // Non-vacuity the other way: an exclusion list that grew to cover the
    // family would make the assertion above pass by having nothing left to ask.
    expect(CGROUP_MEMORY_EVENTS.filter((e) => !unwatchable.has(e)).length).toBeGreaterThan(2);
  });

  it('combines two vectors only where their label sets can match', () => {
    /*
     * R412, and the sixth direction. Four of the five above are about a rule
     * that is wrong in a way that leaves it matching nothing — a metric nothing
     * exports, a label value nothing sets, a label name nothing carries. This
     * is the same outcome reached one level further in, and it is the level
     * none of them look at: a binary operator between two instant vectors
     * matches them **one-to-one on the whole label set**, so two metrics that
     * both exist, both carry labels this estate really emits, and are both
     * spelled correctly still produce the empty vector when those label sets
     * differ.
     *
     * `RealtimeStreamsNearCapacity` divided `realtime_streams_open` — registered
     * in `app.ts` with no labels at all — by `realtime_stream_capacity{scope=
     * "total"}`, which carries `scope` precisely so it can publish a ceiling per
     * scope. No pair matched, the expression returned nothing, and the rule was
     * incapable of firing for as long as it existed. It parses; it evaluates; it
     * produces no series; and no series is exactly what a hub with room to spare
     * looks like.
     *
     * `ignoring(scope)` (or `on(...)`) is the modifier that says which labels to
     * match on, so an expression that carries one is deliberate and is left
     * alone. Only *unaggregated* sides are compared: `sum by (job) (…) / sum by
     * (job) (…)` sets both label sets from its own `by` lists, and those lists
     * are already held by the R329 case above.
     */
    const labels = registeredLabels();
    // Vector-matching operators. `or`/`and`/`unless` match the same way
    // arithmetic does, and a comparison between two vectors does too.
    const BINARY = /(?:^|[\s)])(?:\/|\*|\+|-|and|unless|or|==|!=|>=|<=|>|<)(?:$|[\s(])/;
    const AGGREGATION = /\b(?:sum|avg|min|max|count|topk|bottomk|quantile)\s*(?:by|without)?\s*\(/;

    /** The label sets this expression asks Prometheus to match, when it asks. */
    const unmatchable = (expr: string): string | null => {
      const bare = expr.replace(/"[^"]*"/g, '""');
      if (AGGREGATION.test(bare) || /\b(?:on|ignoring)\s*\(/.test(bare)) return null;
      const metrics = [
        ...new Set([...bare.matchAll(/[a-z_][a-z0-9_]*/g)].map((m) => baseMetric(m[0]))),
      ].filter((name) => labels.has(name));
      // One metric compared against a scalar cannot mismatch; nor can an
      // expression with no operator joining two of them.
      if (metrics.length < 2 || !BINARY.test(bare)) return null;
      const sets = metrics.map((m) => [...labels.get(m)!].sort().join(','));
      if (new Set(sets).size === 1) return '';
      return metrics.map((m, i) => `${m}{${sets[i]}}`).join(' vs ');
    };

    const checked = parsedRules().filter((r) => unmatchable(r.expr) !== null);
    const mismatched = checked
      .filter((r) => unmatchable(r.expr) !== '')
      .map((r) => `${r.name}: ${unmatchable(r.expr)}`);

    // Non-vacuity, both ways. These four really do combine two of this estate's
    // instruments without aggregating either, so a matcher that stopped
    // matching would show up here rather than as a green with nothing left to
    // ask. `RealtimeStreamsNearCapacity` is deliberately not among them any
    // more — it now carries `ignoring(scope)`, which is what a rule that has
    // thought about the question looks like.
    expect(checked.map((r) => r.name)).toEqual(
      expect.arrayContaining(['MemoryNearCgroupLimit', 'MemoryCeilingMissing', 'SweepFailing', 'SweepStopped']),
    );
    // And the expression as it stood, which no other case in this file could
    // see: both metrics exist, both are spelled right, and the division could
    // never produce a series.
    expect(unmatchable('realtime_streams_open / (realtime_stream_capacity{scope="total"} > 0) > 0.8')).toBe(
      'realtime_streams_open{} vs realtime_stream_capacity{scope}',
    );

    expect(mismatched, 'rules combining vectors whose labels cannot match, with no on()/ignoring()').toEqual(
      [],
    );
  });

  it('watches every ladder ending that nothing revisits', () => {
    /*
     * R412. `SweepAbandoningWork` is the one rule about a *terminal* row —
     * "unlike `failed` there is no next attempt that might make this right" —
     * and its selector is a list of tally field names, written by hand, in a
     * different file from the ladders that produce them. Two of the three were
     * there; `reaped` was not, and it is the one that matters most, because the
     * rule that watches the same queue's retryable half (`SweepWorkFailing`,
     * on `outcome="failed"`) *clears itself* the moment those rows run out of
     * attempts. The queue's only alert went green exactly when the partner
     * stopped getting its events.
     *
     * Pinned in both directions: each ending is asserted to still be the field
     * its ladder returns, and the rule is asserted to name it. A rename on
     * either side is the drift this catches, and it is the same failure the
     * whole file is about — a selector that keeps parsing and stops matching.
     */
    const endings: Array<{ field: string; file: string }> = [
      { field: 'retired', file: 'src/services/valuation/src/hooks/emailRetry.ts' },
      { field: 'stranded', file: 'src/services/valuation/src/hooks/pipelineRetry.ts' },
      { field: 'reaped', file: 'src/services/valuation/src/hooks/partnerWebhooks.ts' },
    ];
    const selector = /background_sweep_items_total\{outcome=~"([^"]+)"\}[^}]*\[6h\]/.exec(RULES)?.[1];
    expect(selector, 'SweepAbandoningWork no longer selects an outcome list').toBeDefined();
    const named = selector!.split('|');
    for (const { field, file } of endings) {
      // The tally field, still declared on the tick's return type. `sweepTally`
      // takes the field name verbatim as the `outcome` label, so this string is
      // the whole contract between the ladder and the rule.
      const src = readFileSync(path.join(REPO, file), 'utf8');
      expect(src, `${file} no longer returns a \`${field}\` tally`).toMatch(
        new RegExp(`\\b${field}:\\s*number`),
      );
      expect(named, `SweepAbandoningWork does not watch \`${field}\``).toContain(field);
    }
  });

  it('classifies every Python-tier degrade as alerted or routine', () => {
    /*
     * R450, methodology M11, and the seventh direction — the same absence as
     * R341's and R345's, one more size up.
     *
     * `log_degraded_events_total{event,level}` counts every warning-or-worse
     * line carrying an `event` on both Python units, and R376 built it as the
     * channel for "a tier whose degrades are reported in the log and nowhere
     * else". Its own header then argues, correctly, that most of that
     * vocabulary must *not* have rules: "an unreadable scanned PDF or a corpus
     * cut to its budget is a Tuesday, and a rule per routine degrade is how a
     * channel gets muted".
     *
     * Which leaves nobody deciding which is which. Four events were counted and
     * selected by nothing, and each one's own source comment had already made
     * the argument for a rate: `monte_carlo_conservation` ("what an operator
     * wants is a rate"), `market_universe_degraded` and
     * `market_universe_refresh_timeout` ("alertable without a new instrument …
     * that is the channel R376 built for exactly this"), `engine_input_type_error`
     * ("kept for whoever can: a 4xx is not otherwise logged here"). Whoever can
     * was never told. Counting a degrade and alerting on it look identical from
     * the source and identical from a scrape of a healthy box.
     *
     * So the population is derived and the *verdict* is hand-kept: every slug
     * this tier logs at warning or worse is either selected by a rule or listed
     * below with the reason it is not. A new event fails this case until
     * somebody writes one of the two down, which is the decision that was
     * missing rather than a rule per event.
     *
     * Levels are read off the nearest enclosing log call, so an `info` line is
     * out of scope — it is below the counter's own floor and reaches no rule by
     * construction. `event=` passed to a constructor (`EngineDegradedError`)
     * counts as in scope: `install_error_handlers` logs it at warning.
     */
    const ROUTINE: Record<string, string> = {
      // Counted at the caller instead, on a series with a denominator.
      market_feed_fallback: 'MarketFeedFallingBack, on market_feed_answers_total at the caller',
      ratelimit_exceeded: 'upstream_requests_total{outcome="rejected"} at the caller',
      // Alerted as a *state* rather than a rate, which is the right shape for
      // it — MarketFeedProviderMisbuilt reads market_feed_provider{state="misbuilt"},
      // so the condition is watched and this event is the line beside it. The
      // first slug this case caught, and only once it stopped believing a
      // runbook's `--grep=` counted as a rule.
      market_feed_provider_unavailable: 'MarketFeedProviderMisbuilt reads the state gauge instead',
      research_fallback: 'ResearchPrimaryFailing, on research_requests_total{path="primary"}',
      research_unsynthesized: 'ResearchAnswersUnwritten, on research_requests_total',
      research_suppressed: 'ResearchAnswersUnwritten — the same unsynthesized outcome',
      research_truncated: 'ResearchAnswersUnwritten — the same unsynthesized outcome',
      search_chain_failed: 'ResearchRetrievalFailing, on research_requests_total{outcome="search_failed"}',
      // The RED trio already answers these, with a route label the event has not got.
      request_failed: 'HighServerErrorRate — a 5xx is counted as a 5xx',
      unhandled_error: 'HighServerErrorRate — a 5xx is counted as a 5xx',
      http_access: 'the access log itself; every request is already in http_requests_total',
      // Genuinely routine: a bad input, a bad page, a retry that then worked.
      // A rule on any of these is a channel nobody reads within a fortnight.
      corpus_truncated: 'a corpus cut to its budget is the budget working',
      document_extract_failed: 'one unreadable upload; the analyst is told and re-uploads',
      documents_dropped: 'one unreadable upload; the analyst is told and re-uploads',
      documents_unreadable: 'one unreadable upload; the analyst is told and re-uploads',
      xlsx_sheets_unreadable: 'one workbook a reader could not open',
      xlsx_sheet_index_unreadable: 'one workbook a reader could not open',
      llm_retry: 'a retry that then succeeded; the ending is what LlmQuotaExhausted reads',
      pplx_retry: 'a retry that then succeeded',
      search_retry: 'a retry that then succeeded',
      search_chain_fallback: 'the chain doing its job; search_chain_failed is the ending',
      search_cooldown: 'the chain doing its job; search_chain_failed is the ending',
      llm_truncated: 'one answer over the output cap; the pipeline degrades around it',
      llm_suppressed: 'one answer a content filter withheld; the pipeline degrades around it',
      output_schema: 'one answer that did not match its schema; llm_prose_fallback is the pattern',
      ready: 'the readiness verdict, which registerReadinessMetrics publishes as a gauge',
      http_client_config: 'a boot-time default, and PythonTierMisconfigured is the pattern for those',
    };

    const files = pythonSourceFiles(path.join(REPO, 'src/services'));
    /** slug → the levels its call sites log at. */
    const events = new Map<string, Set<string>>();
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const add = (slug: string, level: string) => {
        const seen = events.get(slug) ?? new Set<string>();
        seen.add(level);
        events.set(slug, seen);
      };
      for (const m of src.matchAll(/"event":\s*"([a-z_]+)"/g)) {
        // The nearest log call before the literal. `_log.log(level, …)` is a
        // dynamic level and is treated as in scope, because it can be warning.
        const head = src.slice(0, m.index!);
        const calls = [...head.matchAll(/\b(?:_log|logger|log)\.(\w+)\(/g)];
        add(m[1]!, calls.length > 0 ? calls[calls.length - 1]![1]! : 'dynamic');
      }
      // `EngineDegradedError(…, event="…")` — the one slug that reaches the
      // formatter through a raise rather than a log call.
      for (const m of src.matchAll(/\bevent="([a-z_]+)"/g)) add(m[1]!, 'warning');
    }

    // Non-vacuity in the direction that matters: a scan that found no files, or
    // a regex that stopped matching the idiom, would pass by having nothing to
    // classify. Both tiers must be represented.
    expect(events.size, 'the event scan found nothing to classify').toBeGreaterThan(30);
    expect([...events.keys()]).toContain('monte_carlo_conservation'); // engine tier
    expect([...events.keys()]).toContain('openrouter_key'); // ai tier

    const INFO_ONLY = new Set(['info', 'debug']);
    const degrades = [...events.entries()]
      .filter(([, levels]) => [...levels].some((l) => !INFO_ONLY.has(l)))
      .map(([slug]) => slug)
      .sort();

    // Read off the `event` selectors in the rule expressions, not off the file
    // as a whole. Every one of these events is also named in some rule's
    // *runbook* — a `journalctl --grep=` line — so a substring search over
    // `alerts.yml` reports a slug as alerted on the strength of the prose
    // telling an operator how to grep for it. That is the same mistake this
    // whole file exists against, one level up: a check that keeps passing while
    // nothing selects anything. Verified by removing the selector and watching
    // this case go red.
    const selected = new Set(
      [...RULES.matchAll(/\bevent=~?"([^"]*)"/g)].flatMap((m) => m[1]!.split('|')),
    );
    expect(selected.size, 'no rule selects an event label at all').toBeGreaterThan(5);

    const unclassified = degrades.filter(
      (slug) => !selected.has(slug) && !Object.hasOwn(ROUTINE, slug),
    );
    expect(
      unclassified,
      'Python-tier degrades that are counted by log_degraded_events_total and reach no rule and no routine verdict',
    ).toEqual([]);

    // And the other way: a routine verdict for a slug this tier no longer logs
    // is a note about deleted code, and a slug that is both alerted and listed
    // routine is two people disagreeing in two files.
    const stale = Object.keys(ROUTINE).filter((slug) => !degrades.includes(slug));
    expect(stale, 'routine verdicts for events nothing logs at warning or worse').toEqual([]);
    const both = Object.keys(ROUTINE).filter((slug) => selected.has(slug));
    expect(both, 'events a rule selects and the roster also calls routine').toEqual([]);
  });

  it('gives every page-severity alert a `for` clause', () => {
    // R377, M11. A page-severity alert without `for` fires on a single scrape.
    // Counter resets (deploy, restart) make `increase()` briefly read nonzero
    // even when nothing leaked, so a missing `for` turns a counter artifact
    // into a 3 a.m. page. The one intentional exception is documented inline.
    const INTENTIONALLY_INSTANT = new Set(['IntegrationConnectGrantedButUnstored']);
    const rules = parsedRules();
    const missing: string[] = [];
    for (const rule of rules) {
      if (!rule.block.includes('severity: page')) continue;
      if (INTENTIONALLY_INSTANT.has(rule.name)) continue;
      if (!/\bfor:\s/.test(rule.block)) missing.push(rule.name);
    }
    expect(missing, 'page-severity alerts missing a `for` clause').toEqual([]);
  });

  it('does not name a gauge with the _total suffix reserved for counters', () => {
    // R377, M11. Prometheus convention reserves `_total` for counters.  A gauge
    // named `_total` misleads `increase()` — which handles counter resets — and
    // confuses every tool that infers the metric type from the suffix.
    //
    // Pre-existing violations whose underlying values are pool-size snapshots
    // or sweep tallies, not monotonic counts an `increase()` rule watches.
    // Renaming them is a future pass; adding new ones is the thing held here.
    const KNOWN: Set<string> = new Set([
      'system_settings_read_failures_total',
      'upstream_circuit_rejected_total',
      'db_pool_connections_total',
      'background_sweep_skipped_total',
      'background_sweep_runs_total',
      'background_sweep_failures_total',
    ]);
    const gaugeNames: string[] = [];
    const tsSources = sourceFiles(path.join(REPO, 'src'));
    for (const file of tsSources) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\.gauge\(\s*'([a-z_][a-z0-9_]*)'/g)) {
        gaugeNames.push(m[1]!);
      }
    }
    const totalGauges = gaugeNames.filter((n) => n.endsWith('_total') && !KNOWN.has(n));
    expect(totalGauges, 'gauges using the _total suffix reserved for counters').toEqual([]);
  });

  it('pages only on the severities it declares', () => {
    const severities = new Set([...RULES.matchAll(/severity: (\w+)/g)].map((m) => m[1]!));
    // Deliberately two. A third level is where "info" alerts come from, and an
    // alert nobody acts on trains people to close alerts.
    expect([...severities].sort()).toEqual(['page', 'ticket']);
  });
});
