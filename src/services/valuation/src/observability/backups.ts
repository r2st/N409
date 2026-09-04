import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { MetricsRegistry } from '@n409/shared';

/**
 * Whether the nightly dump actually ran, as a number something can alert on.
 *
 * WHY THIS EXISTS (R428, methodology M11). R376 wrote the gap down and left it:
 * "the two oneshot backup units — no `OnFailure=` anywhere in the estate, and a
 * oneshot is not a scrape target, so `up` says nothing and a fortnight of
 * failed dumps matches no rule". `pg-backup.sh` is careful — it verifies the
 * dump's table of contents before rotating it in, writes a checksum beside it,
 * and refuses to promote one that looks like the wrong database — and every
 * word of that goes to the journal on a box nobody logs into. The one failure
 * this platform cannot recover from is the one it was announcing to nobody.
 *
 * Read from the *artefacts* rather than from the unit's exit status, which is
 * the property that makes this worth having: a timer that was never enabled, a
 * unit that succeeded against an empty database, a volume that filled so the
 * dump could not land, and a script that died at 02:00 all present identically
 * here — as an age that stops moving. An `OnFailure=` handler catches only the
 * fourth, and only while systemd is the thing that noticed.
 *
 * `mtime` and not the timestamp in the filename. The name is minted before the
 * dump starts; `mv -f "$TMP" "$DEST"` is the moment a good dump exists, and
 * that is the moment worth measuring from.
 *
 * COST. One `readdirSync` and one `statSync` per set per scrape, over a
 * directory the script prunes to seven files and four. `MetricsRegistry.gauge`
 * is sampled inside the scrape request and must be cheap and synchronous, which
 * is why the DB-backed backlogs are deliberately absent from `/metrics` — this
 * is the same shape as `registerDiskMetrics`'s `statfs` and belongs for the same
 * reason.
 */

/** The two sets `pg-backup.sh` maintains, as subdirectories of `BACKUP_ROOT`. */
const SETS = ['daily', 'weekly'] as const;
type BackupSet = (typeof SETS)[number];

/** What `pg-backup.sh` names a dump. The checksum manifests sit beside them. */
const DUMP = /^n409-.*\.dump$/;

interface SetReading {
  /** Dumps present. Zero means the retention window holds nothing at all. */
  count: number;
  /** Seconds since the newest dump was written, or null when there is none. */
  ageSeconds: number | null;
}

/**
 * One set's dumps, or null when the directory could not be read.
 *
 * The distinction is the whole point and is kept all the way to the gauges: a
 * directory that is not there is not a directory with no backups in it. One
 * says the path or the mount is wrong; the other says the backups have stopped.
 * Reporting either as the other sends whoever is woken to the wrong place.
 */
export function readBackupSet(dir: string, now: number = Date.now()): SetReading | null {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => DUMP.test(name));
  } catch {
    return null;
  }
  let newest = 0;
  for (const name of entries) {
    try {
      const { mtimeMs } = statSync(path.join(dir, name));
      if (mtimeMs > newest) newest = mtimeMs;
    } catch {
      // Pruned between the listing and the stat, which is a race with the very
      // script this watches and not a fault. The remaining files still answer.
    }
  }
  return {
    count: entries.length,
    // Clamped at zero: a dump written by a host whose clock is ahead is still a
    // dump that just happened, and a negative age reads as a rule that cannot
    // fire rather than as the clock problem it is.
    ageSeconds: newest > 0 ? Math.max(0, (now - newest) / 1000) : null,
  };
}

/**
 * Publish the backup state under `root`.
 *
 * `n409_backup_watched` is minted whatever happens, including when `root` is
 * unset — R313's rule for `UPSTREAM_CIRCUITS` and R376's for
 * `log_alert_lines_total`, and the one R428 found broken one file over in
 * `diskSpace.ts`: a series that appears only once things are working cannot
 * report that they are not, and every rule below is gauge-backed.
 */
export function registerBackupMetrics(registry: MetricsRegistry, root: string): void {
  const readings = (): Record<BackupSet, SetReading | null> => {
    if (!root) return { daily: null, weekly: null };
    return {
      daily: readBackupSet(path.join(root, 'daily')),
      weekly: readBackupSet(path.join(root, 'weekly')),
    };
  };

  registry.gauge(
    'n409_backup_watched',
    '1 while this process can read the backup directory; 0 when BACKUP_ROOT is unset or unreadable and every backup rule is matching nothing',
    () => {
      const r = readings();
      return SETS.map((set) => ({ value: r[set] ? 1 : 0, labels: { set } }));
    },
    ['set'],
  );

  registry.gauge(
    'n409_backup_age_seconds',
    'Seconds since the newest dump in each set was written. Absent for a set that holds no dump at all — see n409_backup_dumps, which says zero rather than going quiet.',
    () => {
      const r = readings();
      // A set with no dump publishes no age on purpose: there is no number that
      // means "never", and an age of zero reads as a backup taken this second.
      // `n409_backup_dumps == 0` is the reading for that case.
      return SETS.flatMap((set) => {
        const age = r[set]?.ageSeconds;
        return age === null || age === undefined ? [] : [{ value: age, labels: { set } }];
      });
    },
    ['set'],
  );

  /*
   * `_dumps`, not `_count`. `_count` is the suffix Prometheus mints for a
   * histogram's observation tally, and `alertRulesCensus` reads a rule token
   * ending in it as a histogram series — so a gauge spelled that way is a name
   * collision that only shows up in whichever query is read second.
   */
  registry.gauge(
    'n409_backup_dumps',
    'Dumps held in each set. Zero is a retention window holding nothing, which is a different situation from a directory that cannot be read.',
    () => {
      const r = readings();
      return SETS.flatMap((set) => (r[set] ? [{ value: r[set]!.count, labels: { set } }] : []));
    },
    ['set'],
  );
}
