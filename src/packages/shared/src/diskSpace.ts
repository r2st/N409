/**
 * How much room is left on the filesystem this estate keeps everything on.
 *
 * WHY THIS EXISTS (R353, methodology M11). Round 99 gave every unit a
 * `MemoryMax` and R337 exported the cgroup's own view of it, so the question
 * "is this box about to run out of memory" has a gauge, a ratio and two rules.
 * The other finite resource on the same 3.8 GB single-disk host had none of
 * that, and it is the one that takes everything with it:
 *
 *   * PostgreSQL stops accepting writes. Every request that writes answers
 *     `503 database-unavailable`, which is `databaseUnavailableReason` working
 *     exactly as designed and says nothing whatever about the cause;
 *   * uploads fail at `open` with ENOSPC, which `storage/blobFile.ts` handles
 *     correctly — nothing is truncated — and reports as a failed upload;
 *   * the nightly dump has nowhere to land, so the backup that would let
 *     somebody undo this stops being taken on exactly the days it is needed;
 *   * the journal fills and the log lines describing all of the above are the
 *     first thing dropped.
 *
 * Every one of those is a symptom that arrives *after* the disk is full, and
 * none of them names the disk. What was missing is the part with lead time: a
 * filesystem at 90% is a ticket somebody works through on a Tuesday, and the
 * same filesystem at 99% is an outage nobody has a spare hour for. The reading
 * costs one `statfs` syscall, which is what makes it honest to take inside a
 * scrape.
 *
 * ## Why the collect is allowed to throw
 *
 * Deliberately unguarded, and it is the one decision in this module. A path
 * that cannot be stat'ed is not a filesystem with zero bytes free and must
 * never be reported as one — the two readings are opposite instructions to
 * whoever is woken. Nor may it quietly return no series: a gauge that is absent
 * is what a rule reading it cannot tell from a healthy one, which is the whole
 * of R341's argument. So the throw is left to reach `MetricsRegistry.render`,
 * which drops the gauge from the body, counts it on
 * `n409_metric_collect_failures_total{metric}`, and lets `MetricCollectFailing`
 * say in as many words that this gauge is missing and its rules are matching
 * nothing.
 */
import { statfsSync, type StatsFs } from 'node:fs';
import type { GaugeSink } from './cgroupMemory.js';

/** One filesystem's free space, in bytes. */
export interface DiskSpace {
  /** Bytes unprivileged processes may still use — `bavail`, not `bfree`. */
  available: number;
  /** Bytes the filesystem holds in total. */
  total: number;
}

export interface DiskReadOptions {
  /** Injectable so the tests need no filesystem of a particular size. */
  statfs?: (path: string) => Pick<StatsFs, 'bsize' | 'blocks' | 'bavail'>;
}

/**
 * Read one path's filesystem.
 *
 * `bavail` rather than `bfree`, and the difference is not pedantry: ext4
 * reserves 5% of a volume for root by default, so a service running as
 * `n409` hits ENOSPC with `bfree` still reporting tens of gigabytes. The
 * number that decides whether the next write succeeds is the one this process
 * is allowed to use.
 */
export function readDiskSpace(path: string, options: DiskReadOptions = {}): DiskSpace {
  const stat = (options.statfs ?? statfsSync)(path);
  return { available: stat.bsize * stat.bavail, total: stat.bsize * stat.blocks };
}

/**
 * Export free and total bytes for each named path.
 *
 * The key is a *role* — `data`, `backups` — rather than a device or a mount
 * point, for the reason the readiness checks are named for what a failure means
 * to a visitor: the operator reading the alert needs to know what stops
 * working, and `/dev/sda1` does not say. Two roles on one filesystem produce
 * two identical readings, which is the correct answer to two questions that
 * happen to share a disk today and may not tomorrow.
 *
 * Returns the roles it registered — empty when there is nothing to watch, so a
 * caller can say so at boot rather than assume.
 */
export function registerDiskMetrics(
  registry: GaugeSink,
  paths: Readonly<Record<string, string>>,
  options: DiskReadOptions = {},
): string[] {
  const roles = Object.keys(paths).sort();
  if (roles.length === 0) return [];

  // Read once here so a path that is wrong is a boot-time failure of the thing
  // that registered it rather than a scrape-time one — the same order
  // `registerCgroupMemoryMetrics` uses to decide there is nothing to report.
  const readable = roles.filter((role) => {
    try {
      readDiskSpace(paths[role]!, options);
      return true;
    } catch {
      return false;
    }
  });
  if (readable.length === 0) return [];

  const reading = (pick: (d: DiskSpace) => number) => () =>
    readable.map((role) => ({ value: pick(readDiskSpace(paths[role]!, options)), labels: { mount: role } }));

  registry.gauge(
    'n409_disk_available_bytes',
    'Bytes still writable by this process on the filesystem holding each named path',
    reading((d) => d.available),
    ['mount'],
  );
  registry.gauge(
    'n409_disk_total_bytes',
    'Size of the filesystem holding each named path',
    reading((d) => d.total),
    ['mount'],
  );
  return readable;
}
