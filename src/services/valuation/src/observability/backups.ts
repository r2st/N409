import { readFileSync, readdirSync, statSync } from 'node:fs';
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

/**
 * What `pg-verify.sh` last did, read from the two stamp files it writes.
 *
 * WHY THIS EXISTS (R437, methodology M5). The gauges above answer "did the
 * nightly dump run" from artefacts `pg-backup.sh` writes into `BACKUP_ROOT`.
 * They say nothing about whether that dump actually *restores* — that is
 * `pg-verify.sh`'s job, it is the one check in the estate that "produces
 * evidence rather than inference" (its own header), and until now its result
 * went nowhere but a journal on a box nobody logs into. `n409-backup-verify
 * .service` cannot write its stamp into `BACKUP_ROOT` — `ReadOnlyPaths=` there
 * is deliberate, "verification restores into a database, never into the
 * backup directory" — so it needs a directory of its own, provisioned as a
 * systemd `StateDirectory=` the way `ReadOnlyPaths` on the other unit is: a
 * path both the script and this process are given, rather than one either
 * side has to invent.
 *
 * Two files, not one, for the same reason `pg-backup.sh`'s dumps and
 * `pg-verify.sh`'s own SKIPPED line are already kept apart: `last_attempt`
 * moves on every run, success, failure or a deliberate
 * `FLAG_BACKUP_VERIFICATION=off`, and answers "is the job still running at
 * all". `last_success` moves only on a run that actually restored the dump
 * and asked it the sanity questions — a SKIPPED week or a FAILED one both
 * leave it exactly where it was, which is the property that makes its age
 * the number worth paging on: an operator who has switched verification off
 * for a month is still owed to know the last *proof* is a month stale.
 */
const VERIFY_ATTEMPT_FILE = 'last_attempt';
const VERIFY_SUCCESS_FILE = 'last_success';

export interface BackupVerifyReading {
  /** The word `pg-verify.sh` wrote on its last run: VERIFIED, FAILED or SKIPPED. */
  lastResult: string | null;
  /** Seconds since that run, or null when no attempt has ever been recorded. */
  lastAttemptAgeSeconds: number | null;
  /** Seconds since the last run that actually restored the dump, or null when none ever did. */
  lastSuccessAgeSeconds: number | null;
}

/**
 * The verify state under `dir`, or null when the directory itself cannot be
 * read — the same "path is wrong" vs "nothing has happened yet" distinction
 * `readBackupSet` draws, for the same reason: a `VERIFY_STATE_DIR` that is
 * unset or whose mount is gone must read as unwatched, not as a healthy job
 * that has simply never run.
 */
export function readBackupVerifyState(dir: string, now: number = Date.now()): BackupVerifyReading | null {
  try {
    // Existence of the directory is what "watched" means here; an empty one
    // (a freshly provisioned host, before the first Sunday) is not an error.
    statSync(dir);
  } catch {
    return null;
  }

  const ageOf = (file: string): number | null => {
    try {
      const { mtimeMs } = statSync(path.join(dir, file));
      // Clamped at zero for the reason readBackupSet's is: a clock skew must
      // read as "just happened", not as a negative that no rule can match.
      return Math.max(0, (now - mtimeMs) / 1000);
    } catch {
      return null;
    }
  };

  const lastResult = (() => {
    try {
      // Trimmed: the script writes the word with a trailing newline.
      return readFileSync(path.join(dir, VERIFY_ATTEMPT_FILE), 'utf8').trim() || null;
    } catch {
      return null;
    }
  })();

  return {
    lastResult,
    lastAttemptAgeSeconds: ageOf(VERIFY_ATTEMPT_FILE),
    lastSuccessAgeSeconds: ageOf(VERIFY_SUCCESS_FILE),
  };
}

/**
 * Publish the restore-verification state under `dir`.
 *
 * `n409_backup_verify_watched` is minted whatever happens, including for an
 * unset `BACKUP_VERIFY_STATE_DIR` — the same rule every gauge in this file
 * follows, so an absent series can never be misread as a healthy job.
 * `n409_backup_verify_failed` is the fast path pg-verify.sh's own header
 * argues for ("non-zero is a page: a backup that does not restore is
 * indistinguishable from no backup") — it flips the scrape after a bad run,
 * rather than waiting for `last_success_seconds` to cross a multi-day
 * threshold. That threshold gauge is what catches the slower failure: weeks
 * of `FLAG_BACKUP_VERIFICATION=off`, or a timer that stopped firing, where
 * every individual run (or non-run) looks unremarkable on its own.
 */
export function registerBackupVerifyMetrics(registry: MetricsRegistry, dir: string): void {
  const read = (): BackupVerifyReading | null => (dir ? readBackupVerifyState(dir) : null);

  registry.gauge(
    'n409_backup_verify_watched',
    '1 while this process can read the backup-verification state directory; 0 when it is unset or unreadable and BackupVerifyStale/BackupVerifyFailed are matching nothing',
    () => (read() ? 1 : 0),
  );

  registry.gauge(
    'n409_backup_verify_last_success_seconds',
    'Seconds since a restore verification last actually proved a dump restorable. Absent when none ever has — see n409_backup_verify_watched to tell that apart from an unreadable state directory.',
    () => {
      const r = read();
      const age = r?.lastSuccessAgeSeconds;
      return age === null || age === undefined ? [] : [{ value: age }];
    },
  );

  registry.gauge(
    'n409_backup_verify_failed',
    '1 when the most recent restore-verification attempt did not verify (a real failure, not a deliberate FLAG_BACKUP_VERIFICATION=off skip); 0 otherwise, including when none has ever run.',
    () => {
      const r = read();
      return r?.lastResult === 'FAILED' ? 1 : 0;
    },
  );
}
