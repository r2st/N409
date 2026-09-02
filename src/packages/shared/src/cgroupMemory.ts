/**
 * The memory ceiling a service is running under, read from the kernel and
 * exported next to what it is holding.
 *
 * ## Why a service should know its own limit
 *
 * Round 99 gave every unit in this estate a `MemoryMax`, which converts a class
 * of failure from "the host runs out and the kernel kills whatever is largest,
 * probably PostgreSQL" into "this unit is killed and systemd restarts it". That
 * is the right trade, and it introduces a new way to be blind: a SIGKILL from
 * the cgroup limiter arrives with no error, no stack, no log line from the
 * process, and `Restart=always` puts a healthy service back within seconds. From
 * the outside it looks like a blip. From `/metrics` it looks like a counter
 * reset and an uptime that starts again.
 *
 * `process_resident_memory_bytes` was already exported and cannot answer this on
 * its own: 400MB is comfortable under one ceiling and fatal under another, and
 * the ceiling lives in a file the process has never read. So the limit is
 * exported beside the usage, and the ratio between them is a number a dashboard
 * or an alert can hold.
 *
 * ## What the kernel will and will not tell you
 *
 * cgroup v2 keeps `memory.events`, a set of counters for the moments that
 * matter: `high` counts times the cgroup was throttled at `MemoryHigh`, `max`
 * counts times an allocation was about to breach `MemoryMax` and reclaim was
 * forced, and `oom_kill` counts processes killed by the cgroup's own OOM
 * handler. The first two are the early warning; they tick long before anything
 * dies, and a non-zero `high` rate is the signal that a ceiling is too low or a
 * service has grown past what it was sized for.
 *
 * `oom_kill` is the one to be careful about, and the care is the point of this
 * comment. systemd removes a unit's cgroup when the unit stops and creates a
 * fresh one when it starts, so the counters reset on every restart — and the
 * restart is exactly what follows the kill. A service killed at its ceiling
 * therefore comes back reporting `oom_kill 0`. The durable record of a kill is
 * the journal (`systemd` logs the cgroup OOM) and the sudden `process_uptime_
 * seconds` reset; what these gauges give you is the *approach*, which is the
 * part you can act on while there is still something to act on.
 *
 * ## Portability
 *
 * Everything here is best-effort and silent when it cannot work. On a developer
 * machine there is no `/sys/fs/cgroup`, and on a cgroup v1 host the files have
 * different names in a different place. Both cases produce no gauges rather
 * than an error or a zero — a metric reading zero because a file is missing is
 * worse than a metric that is absent, because only one of them is obviously not
 * an answer.
 *
 * The three Fastify services register these. The Python pair reads the same
 * files through `cgroup_memory.py` — a hand-kept twin of this file in each of
 * `src/services/{ai,engine-wrapper}/app`, added in R369 once R361 had made
 * those units scrape targets — under identical metric and label names, because
 * the five rules in `alerts.yml`'s memory group select by name and a rule that
 * matches three units out of five looks like it is working. Nothing derives
 * one file from the other and `alertRulesCensus.test.ts` reads only this one,
 * so a rename here has to be made there too; `test_cgroup_memory.py` on each
 * side asserts the names it expects.
 */
import { readFileSync } from 'node:fs';

/** A reading of the calling process's own cgroup. All values in bytes. */
export interface CgroupMemory {
  /** The cgroup path as `/proc/self/cgroup` gives it, e.g. `/system.slice/n409-report.service`. */
  path: string;
  current: number | null;
  /** High-water mark since the cgroup was created — i.e. since this unit last started. */
  peak: number | null;
  /** `null` when the limit is `max`, which is the kernel's spelling of unlimited. */
  max: number | null;
  high: number | null;
  swapCurrent: number | null;
  swapMax: number | null;
  /** `memory.events` counters. Reset when the unit restarts — see the file comment. */
  events: Record<string, number>;
}

export interface CgroupReadOptions {
  /** Injectable so the tests need no `/sys` and no Linux. */
  readFile?: (file: string) => string;
  /** Mount point of the cgroup v2 hierarchy. */
  root?: string;
}

/** The events worth exporting. The kernel emits more; these are the ones that mean something here. */
export const CGROUP_MEMORY_EVENTS = ['low', 'high', 'max', 'oom', 'oom_kill'] as const;

/** `max` is unlimited; anything else is a decimal byte count. */
function parseLimit(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === 'max' || trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Read the calling process's cgroup memory state, or `null` when this is not a
 * cgroup v2 host.
 *
 * The v2 line in `/proc/self/cgroup` is the one with an empty controller field —
 * `0::/system.slice/n409-report.service`. A host running v1, or the hybrid
 * layout, has no such line, and returning `null` for it is the whole of this
 * module's portability story.
 */
export function readCgroupMemory(options: CgroupReadOptions = {}): CgroupMemory | null {
  const read = options.readFile ?? ((file: string) => readFileSync(file, 'utf8'));
  const root = options.root ?? '/sys/fs/cgroup';

  let self: string;
  try {
    self = read('/proc/self/cgroup');
  } catch {
    return null;
  }
  const v2 = self
    .split('\n')
    .map((line) => /^0::(.*)$/.exec(line.trim())?.[1])
    .find((p): p is string => p !== undefined);
  if (v2 === undefined) return null;

  // A file that is missing reads as `null` rather than as zero, and a cgroup
  // with no `memory.current` at all is not a cgroup this can say anything
  // about — so that one absence is what decides there is nothing to report.
  const file = (name: string): string | null => {
    try {
      return read(`${root}${v2}/${name}`);
    } catch {
      return null;
    }
  };
  const currentText = file('memory.current');
  if (currentText === null) return null;

  const events: Record<string, number> = {};
  const eventsText = file('memory.events');
  if (eventsText !== null) {
    for (const line of eventsText.split('\n')) {
      const [name, value] = line.trim().split(/\s+/);
      if (name === undefined || value === undefined) continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) events[name] = parsed;
    }
  }

  const size = (name: string): number | null => {
    const text = file(name);
    return text === null ? null : parseLimit(text);
  };

  return {
    path: v2,
    current: parseLimit(currentText),
    peak: size('memory.peak'),
    max: size('memory.max'),
    high: size('memory.high'),
    swapCurrent: size('memory.swap.current'),
    swapMax: size('memory.swap.max'),
    events,
  };
}

/** The subset of `MetricsRegistry` this needs, so `prometheus.ts` need not be imported here. */
export interface GaugeSink {
  gauge(
    name: string,
    help: string,
    read: () => number | { value: number; labels?: Record<string, string> }[],
    labelNames?: string[],
  ): void;
}

/**
 * Register the cgroup gauges, if this process is in a cgroup v2 at all.
 *
 * The probe runs once, at registration, and decides whether the gauges exist;
 * the reads themselves happen per scrape. That split is deliberate in both
 * directions. Deciding once means a developer machine gets no gauges rather
 * than five that always read zero. Reading per scrape means the numbers are the
 * current ones — these are kernel pseudo-files, a handful of bytes each, served
 * without touching a disk, so the cost of being current is negligible and the
 * usual rule about a gauge doing no real work is not strained.
 *
 * A file that disappears between registration and a scrape reads as zero rather
 * than throwing: a metrics endpoint that 500s because a cgroup was rearranged
 * would take out every other metric on it, which is a bad trade for a number
 * nobody was going to page on.
 */
export function registerCgroupMemoryMetrics(registry: GaugeSink, options: CgroupReadOptions = {}): boolean {
  const probe = readCgroupMemory(options);
  if (probe === null) return false;

  const reading = () => readCgroupMemory(options);
  const field = (pick: (m: CgroupMemory) => number | null) => () => {
    const m = reading();
    if (m === null) return 0;
    return pick(m) ?? 0;
  };

  registry.gauge(
    'n409_cgroup_memory_current_bytes',
    "Memory charged to this unit's cgroup, including page cache",
    field((m) => m.current),
  );
  registry.gauge(
    'n409_cgroup_memory_peak_bytes',
    'High-water mark since this unit last started',
    field((m) => m.peak),
  );
  // Reported as 0 when the limit is `max`. That is not a measurement dressed as
  // one: a ceiling of zero is impossible, so the value is unambiguous, and it
  // makes "this unit has no limit" something an alert can match on rather than
  // an absent series that looks the same as a service that is down.
  registry.gauge(
    'n409_cgroup_memory_max_bytes',
    'MemoryMax for this unit, or 0 when unlimited',
    field((m) => m.max),
  );
  registry.gauge(
    'n409_cgroup_memory_high_bytes',
    'MemoryHigh throttling threshold for this unit, or 0 when unset',
    field((m) => m.high),
  );
  registry.gauge(
    'n409_cgroup_memory_swap_current_bytes',
    "Swap charged to this unit's cgroup",
    field((m) => m.swapCurrent),
  );
  registry.gauge(
    'n409_cgroup_memory_swap_max_bytes',
    'MemorySwapMax for this unit, or 0 when unlimited',
    field((m) => m.swapMax),
  );
  registry.gauge(
    'n409_cgroup_memory_events',
    'cgroup memory.events counters; reset whenever the unit restarts',
    () => {
      const m = reading();
      if (m === null) return [];
      return CGROUP_MEMORY_EVENTS.map((event) => ({
        value: m.events[event] ?? 0,
        labels: { event },
      }));
    },
    ['event'],
  );
  return true;
}
