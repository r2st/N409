import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MetricsRegistry } from '@n409/shared';
import { readBackupSet, registerBackupMetrics } from '../../src/observability/backups.js';

/**
 * The failure nothing on this box reported (R428, methodology M11).
 *
 * R376 wrote the gap down and left it open: the two backup units are oneshots,
 * a oneshot is not a scrape target, so `up` says nothing about them and a
 * fortnight of failed dumps matched no rule in the estate. `pg-backup.sh` is
 * careful and every word of its care goes to a journal nobody reads.
 *
 * These gauges read the *artefacts*, which is what makes them cover more than
 * an `OnFailure=` handler would: a timer that was never enabled, a script that
 * died at 02:00 and a volume that filled so the dump could not land all present
 * identically here, as an age that stops moving.
 */

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'n409-backups-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** A dump of the shape `pg-backup.sh` writes, aged by `hoursAgo`. */
function dump(dir: string, name: string, hoursAgo: number): void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, 'PGDMP');
  const when = new Date(Date.now() - hoursAgo * 3_600_000);
  utimesSync(file, when, when);
}

describe('reading a backup set', () => {
  it('measures from the newest dump, not the first one listed', () => {
    // `readdirSync` is in whatever order the filesystem gives, and the newest
    // dump is the only one that answers "did last night's backup run".
    const dir = root();
    dump(dir, 'n409-2026-09-01T02-00-00Z.dump', 96);
    dump(dir, 'n409-2026-09-04T02-00-00Z.dump', 3);
    dump(dir, 'n409-2026-09-02T02-00-00Z.dump', 72);

    const reading = readBackupSet(dir)!;
    expect(reading.count).toBe(3);
    expect(reading.ageSeconds).toBeGreaterThan(2.5 * 3600);
    expect(reading.ageSeconds).toBeLessThan(3.5 * 3600);
  });

  it('counts dumps and not the checksum manifests beside them', () => {
    // `pg-backup.sh` writes a `.sha256` next to every dump, and counting those
    // would double every set and make BackupsMissing unreachable.
    const dir = root();
    dump(dir, 'n409-2026-09-04T02-00-00Z.dump', 1);
    writeFileSync(path.join(dir, 'n409-2026-09-04T02-00-00Z.dump.sha256'), 'abc  x');
    expect(readBackupSet(dir)!.count).toBe(1);
  });

  it('tells a directory it cannot read from one that holds no dumps', () => {
    /*
     * The distinction the whole module is built around. "The path is wrong or
     * the mount is gone" and "the backups have stopped" send whoever is woken
     * to different places, and reporting either as the other wastes the one
     * window in which a missing backup can still be taken.
     */
    expect(readBackupSet(path.join(root(), 'no-such-set'))).toBeNull();

    const empty = root();
    mkdirSync(path.join(empty, 'daily'));
    expect(readBackupSet(path.join(empty, 'daily'))).toEqual({ count: 0, ageSeconds: null });
  });

  it('does not report a dump from a host whose clock is ahead as a negative age', () => {
    const dir = root();
    dump(dir, 'n409-2026-09-05T02-00-00Z.dump', -2);
    expect(readBackupSet(dir)!.ageSeconds).toBe(0);
  });
});

describe('the backup gauges', () => {
  it('report an age and a count per set', () => {
    const base = root();
    dump(path.join(base, 'daily'), 'n409-2026-09-04T02-00-00Z.dump', 5);
    dump(path.join(base, 'weekly'), 'n409-2026-08-31T02-00-00Z.dump', 100);

    const registry = new MetricsRegistry();
    registerBackupMetrics(registry, base);
    const text = registry.render();

    expect(text).toContain('n409_backup_dumps{set="daily"} 1');
    expect(text).toContain('n409_backup_dumps{set="weekly"} 1');
    expect(text).toContain('n409_backup_watched{set="daily"} 1');
    expect(text).toMatch(/n409_backup_age_seconds\{set="daily"\} 1[78]\d\d\d/);
  });

  it('says zero dumps rather than going quiet, and publishes no age for a set with none', () => {
    // There is no number that means "never", and an age of zero would read as a
    // backup taken this second — so the count is the reading for an empty set
    // and `BackupsMissing` is the rule on it.
    const base = root();
    mkdirSync(path.join(base, 'daily'));
    mkdirSync(path.join(base, 'weekly'));

    const registry = new MetricsRegistry();
    registerBackupMetrics(registry, base);
    const text = registry.render();

    expect(text).toContain('n409_backup_dumps{set="daily"} 0');
    expect(text).not.toContain('n409_backup_age_seconds{set="daily"}');
    // Still watched: the directory was readable, it simply holds nothing.
    expect(text).toContain('n409_backup_watched{set="daily"} 1');
  });

  it('reports an unreadable root as watched=0 rather than as no series at all', () => {
    /*
     * Every rule here is gauge-backed, so an absent series is exactly what a
     * healthy backup regime looks like — the same lesson `diskSpace.ts` was
     * carrying one file over. The reading is minted whatever happens, including
     * for a deployment that left BACKUP_ROOT unset.
     */
    for (const configured of [path.join(root(), 'not-here'), '']) {
      const registry = new MetricsRegistry();
      registerBackupMetrics(registry, configured);
      const text = registry.render();
      expect(text).toContain('n409_backup_watched{set="daily"} 0');
      expect(text).toContain('n409_backup_watched{set="weekly"} 0');
      expect(text).not.toContain('n409_backup_dumps{');
      expect(text).not.toContain('n409_backup_age_seconds{');
    }
  });

  it('re-reads on every scrape, so a backup taken since boot moves the number', () => {
    // Registered once at boot; the readings are pull callbacks. A snapshot
    // taken at registration would report the state of the directory at 03:00
    // for as long as the process lives.
    const base = root();
    mkdirSync(path.join(base, 'daily'));
    const registry = new MetricsRegistry();
    registerBackupMetrics(registry, base);
    expect(registry.render()).toContain('n409_backup_dumps{set="daily"} 0');

    dump(path.join(base, 'daily'), 'n409-2026-09-05T02-00-00Z.dump', 1);
    expect(registry.render()).toContain('n409_backup_dumps{set="daily"} 1');
  });
});

describe('the configured root', () => {
  it('is the one the backup units write to', async () => {
    /*
     * The config-drift guard. These gauges read a directory another unit writes,
     * and the two values live in different files — `.env` for this service and
     * an `Environment=` line for the backup units. If they disagree, every rule
     * here watches an empty path and reports a healthy `watched 0` nobody
     * connects to the backups that are in fact running elsewhere.
     */
    const { readFileSync } = await import('node:fs');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const repo = path.resolve(here, '../../../../..');
    const unit = readFileSync(path.join(repo, 'infra/backup/n409-backup.service'), 'utf8');
    const config = readFileSync(path.join(repo, 'src/services/valuation/src/config.ts'), 'utf8');
    const example = readFileSync(path.join(repo, '.env.example'), 'utf8');

    const inUnit = /^Environment=BACKUP_ROOT=(.+)$/m.exec(unit)?.[1];
    expect(inUnit, 'the backup unit no longer sets BACKUP_ROOT').toBeTruthy();
    expect(config).toContain(`BACKUP_ROOT: z.string().default('${inUnit}')`);
    expect(example).toContain(`BACKUP_ROOT=${inUnit}`);
  });
});
