// Reading a service's own memory ceiling out of the kernel.
//
// The reason this exists is a consequence of round 99 rather than a feature in
// its own right. Giving every unit a `MemoryMax` converts "the host runs out
// and the kernel kills whatever is largest" into "this unit is killed and
// restarted", and the second failure is quieter than the first: SIGKILL leaves
// no error and no log line in the process, and `Restart=always` has a healthy
// service back within seconds. `process_resident_memory_bytes` cannot tell you
// how close you were, because the number it would have to be compared against
// lives in a file the process had never read.
//
// Everything below uses an injected reader. None of it needs Linux, which is
// the point of the injection: the fixtures are real `/sys/fs/cgroup` contents
// taken from 204.168.241.124.
import { describe, expect, it } from 'vitest';
import {
  CGROUP_MEMORY_EVENTS,
  readCgroupMemory,
  registerCgroupMemoryMetrics,
  type GaugeSink,
} from '../src/cgroupMemory.js';

/** The report unit's cgroup as the host really presents it. */
const HOST: Record<string, string> = {
  '/proc/self/cgroup': '0::/system.slice/n409-report.service\n',
  '/sys/fs/cgroup/system.slice/n409-report.service/memory.current': '75759616\n',
  '/sys/fs/cgroup/system.slice/n409-report.service/memory.peak': '142233600\n',
  '/sys/fs/cgroup/system.slice/n409-report.service/memory.max': '536870912\n',
  '/sys/fs/cgroup/system.slice/n409-report.service/memory.high': '402653184\n',
  '/sys/fs/cgroup/system.slice/n409-report.service/memory.swap.current': '0\n',
  '/sys/fs/cgroup/system.slice/n409-report.service/memory.swap.max': '134217728\n',
  // One `name value` pair per line, which is the kernel's format. Two of the
  // names here are not zero on purpose: the fixture is a cgroup that has been
  // throttled three times and has come within an allocation of its ceiling once.
  '/sys/fs/cgroup/system.slice/n409-report.service/memory.events': [
    'low 0',
    'high 3',
    'max 1',
    'oom 0',
    'oom_kill 0',
    'oom_group_kill 0',
    'sock_throttled 0',
    '',
  ].join('\n'),
};

function reader(files: Record<string, string>) {
  return (file: string) => {
    const text = files[file];
    if (text === undefined) throw new Error(`ENOENT ${file}`);
    return text;
  };
}

/** Collects what was registered, so a test can read a gauge the way a scrape would. */
function sink(): GaugeSink & { read(name: string): unknown } {
  const gauges = new Map<string, () => unknown>();
  return {
    gauge(name, _help, read) {
      gauges.set(name, read);
    },
    read(name) {
      const fn = gauges.get(name);
      return fn === undefined ? undefined : fn();
    },
  };
}

describe('readCgroupMemory', () => {
  it('reads the unit cgroup the process is actually in', () => {
    const m = readCgroupMemory({ readFile: reader(HOST) })!;
    expect(m.path).toBe('/system.slice/n409-report.service');
    expect(m.current).toBe(75759616);
    expect(m.peak).toBe(142233600);
    expect(m.max).toBe(512 * 1024 ** 2);
    expect(m.high).toBe(384 * 1024 ** 2);
    expect(m.swapMax).toBe(128 * 1024 ** 2);
    expect(m.events).toMatchObject({ high: 3, max: 1, oom_kill: 0 });
  });

  // `max` is the kernel's spelling of "no limit", and it is not a number. Read
  // as one it becomes NaN, and a NaN in a gauge poisons the whole scrape.
  it('reads an absent limit as null rather than as a number', () => {
    const files = {
      ...HOST,
      '/sys/fs/cgroup/system.slice/n409-report.service/memory.max': 'max\n',
      '/sys/fs/cgroup/system.slice/n409-report.service/memory.swap.max': 'max\n',
    };
    const m = readCgroupMemory({ readFile: reader(files) })!;
    expect(m.max).toBeNull();
    expect(m.swapMax).toBeNull();
    // The usage beside it is still a real reading — an unlimited cgroup is a
    // cgroup, and refusing to report it would hide exactly the units this round
    // is about.
    expect(m.current).toBe(75759616);
  });

  // A developer machine. Returning null here is what keeps this module from
  // being an import that only works on the deploy target.
  it('returns null when there is no /proc/self/cgroup at all', () => {
    expect(readCgroupMemory({ readFile: reader({}) })).toBeNull();
  });

  // cgroup v1 and the hybrid layout both have numbered controller lines and no
  // `0::` line. There is no useful reading to take from them, and guessing at
  // one would produce numbers that look right and are not.
  it('returns null on a cgroup v1 host', () => {
    const v1 = { '/proc/self/cgroup': '9:memory:/system.slice/n409-report.service\n1:name=systemd:/\n' };
    expect(readCgroupMemory({ readFile: reader(v1) })).toBeNull();
  });

  it('returns null when the cgroup exists but has no memory controller', () => {
    const files = { '/proc/self/cgroup': '0::/system.slice/n409-report.service\n' };
    expect(readCgroupMemory({ readFile: reader(files) })).toBeNull();
  });

  // Only `memory.current` decides whether there is anything to report; the rest
  // read as null. A kernel that does not carry `memory.peak` (added in 5.19)
  // must not cost us the five files it does carry.
  it('tolerates individual files being absent', () => {
    const { '/sys/fs/cgroup/system.slice/n409-report.service/memory.peak': _gone, ...files } = HOST;
    const m = readCgroupMemory({ readFile: reader(files) })!;
    expect(m.peak).toBeNull();
    expect(m.max).toBe(512 * 1024 ** 2);
  });

  // An empty file is not a zero. cgroup pseudo-files are normally never empty,
  // but a read racing a cgroup being torn down can come back with nothing, and
  // reporting that as `0 bytes in use` would be a measurement invented from an
  // absence.
  it('reads an empty limit file as null, not as zero', () => {
    const files = { ...HOST, '/sys/fs/cgroup/system.slice/n409-report.service/memory.high': '\n' };
    expect(readCgroupMemory({ readFile: reader(files) })!.high).toBeNull();
  });

  // Not a number and not `max`. Nothing should ever write this, and reading it
  // through `Number()` unguarded would put a NaN in a gauge — which poisons the
  // whole scrape, not just this series.
  it('reads an unparseable value as null rather than as NaN', () => {
    const files = {
      ...HOST,
      '/sys/fs/cgroup/system.slice/n409-report.service/memory.current': 'unexpected\n',
    };
    expect(readCgroupMemory({ readFile: reader(files) })!.current).toBeNull();
  });

  it('honours an alternative cgroup mount point', () => {
    const files = {
      '/proc/self/cgroup': '0::/system.slice/n409-report.service\n',
      '/elsewhere/system.slice/n409-report.service/memory.current': '42\n',
    };
    const m = readCgroupMemory({ readFile: reader(files), root: '/elsewhere' })!;
    expect(m.current).toBe(42);
  });

  // With no injected reader it goes to the real filesystem. On a developer
  // machine that is a missing /proc and a null; on Linux it is this process's
  // own cgroup. Either is fine — what must not happen is a throw, because the
  // registration below calls this during app construction.
  it('does not throw when reading the real filesystem', () => {
    expect(() => readCgroupMemory()).not.toThrow();
  });
});

describe('registerCgroupMemoryMetrics', () => {
  it('exports the ceiling beside the usage', () => {
    const registry = sink();
    expect(registerCgroupMemoryMetrics(registry, { readFile: reader(HOST) })).toBe(true);
    expect(registry.read('n409_cgroup_memory_current_bytes')).toBe(75759616);
    expect(registry.read('n409_cgroup_memory_max_bytes')).toBe(512 * 1024 ** 2);
    expect(registry.read('n409_cgroup_memory_high_bytes')).toBe(384 * 1024 ** 2);
    expect(registry.read('n409_cgroup_memory_swap_max_bytes')).toBe(128 * 1024 ** 2);
  });

  // The pre-kill signal, and the whole reason the events file is read. `high`
  // ticks every time the cgroup was throttled at MemoryHigh and `max` every
  // time an allocation was about to breach MemoryMax — both long before
  // anything dies, and both invisible from inside the process.
  it('exports the throttling counters, one series per event', () => {
    const registry = sink();
    registerCgroupMemoryMetrics(registry, { readFile: reader(HOST) });
    const events = registry.read('n409_cgroup_memory_events') as {
      value: number;
      labels: { event: string };
    }[];
    expect(events.map((e) => e.labels.event)).toEqual([...CGROUP_MEMORY_EVENTS]);
    expect(events.find((e) => e.labels.event === 'high')?.value).toBe(3);
    expect(events.find((e) => e.labels.event === 'max')?.value).toBe(1);
  });

  // A kernel that does not carry every name — `oom_group_kill` and
  // `sock_throttled` are recent — must still produce the full series set, or a
  // dashboard's query breaks on a kernel upgrade rather than on a change here.
  it('reports zero for an event this kernel does not name', () => {
    const files = {
      ...HOST,
      '/sys/fs/cgroup/system.slice/n409-report.service/memory.events': 'low 0\nhigh 3\n',
    };
    const registry = sink();
    registerCgroupMemoryMetrics(registry, { readFile: reader(files) });
    const events = registry.read('n409_cgroup_memory_events') as {
      value: number;
      labels: { event: string };
    }[];
    expect(events.map((e) => e.labels.event)).toEqual([...CGROUP_MEMORY_EVENTS]);
    expect(events.find((e) => e.labels.event === 'oom_kill')?.value).toBe(0);
  });

  // Zero, not absent. A ceiling of zero is impossible, so the value is
  // unambiguous, and it makes "this unit has no limit" a thing an alert can
  // match rather than a missing series — which looks identical to a service
  // that is down.
  it('reports an unlimited cgroup as a zero ceiling rather than as no series', () => {
    const files = { ...HOST, '/sys/fs/cgroup/system.slice/n409-report.service/memory.max': 'max\n' };
    const registry = sink();
    registerCgroupMemoryMetrics(registry, { readFile: reader(files) });
    expect(registry.read('n409_cgroup_memory_max_bytes')).toBe(0);
  });

  // Off Linux there are no gauges at all. Five series that always read zero
  // would be worse than none: only one of those is obviously not an answer.
  it('registers nothing when the process is not in a cgroup v2', () => {
    const registry = sink();
    expect(registerCgroupMemoryMetrics(registry, { readFile: reader({}) })).toBe(false);
    expect(registry.read('n409_cgroup_memory_current_bytes')).toBeUndefined();
  });

  // A cgroup rearranged under a running process must not take down the metrics
  // endpoint — every other series on it would go with it, which is a bad trade
  // for a number nobody was going to page on.
  it('reads zero rather than throwing when the files vanish after registration', () => {
    let files: Record<string, string> = HOST;
    const registry = sink();
    registerCgroupMemoryMetrics(registry, { readFile: (f) => reader(files)(f) });
    files = {};
    expect(registry.read('n409_cgroup_memory_current_bytes')).toBe(0);
    expect(registry.read('n409_cgroup_memory_events')).toEqual([]);
  });

  // Per scrape, not once at registration. A ceiling read once would be right,
  // but a usage read once is a number frozen at boot — which is the reading
  // least likely to be interesting and most likely to be believed.
  it('reads fresh values on each scrape', () => {
    let current = '75759616\n';
    const registry = sink();
    registerCgroupMemoryMetrics(registry, {
      readFile: (f) => (f.endsWith('memory.current') ? current : reader(HOST)(f)),
    });
    expect(registry.read('n409_cgroup_memory_current_bytes')).toBe(75759616);
    current = '400000000\n';
    expect(registry.read('n409_cgroup_memory_current_bytes')).toBe(400000000);
  });
});
