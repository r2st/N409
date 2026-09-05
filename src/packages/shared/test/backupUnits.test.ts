// Tests for the systemd units in infra/backup.
//
// These four files are the only part of the backup subsystem that nothing
// executed until now, and the gap that produced them is instructive: the verify
// pair sat in the repository, fully written and fully documented, for the five
// days between the round that added them and the round that noticed they had
// never been copied to the host. Backups were taken nightly the whole time and
// not one of them had ever been restored.
//
// A test cannot install a unit on a server. What it can do is hold the
// invariants that make the unit correct when someone does — and those are the
// ones that were actually wrong on the first install: the EnvironmentFile order
// that decides which DATABASE_URL wins, and an `[Install]` section that would
// let `systemctl enable` schedule a full restore at every boot.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKUP = path.resolve(here, '../../../..', 'infra/backup');

const read = (name: string): string => readFileSync(path.join(BACKUP, name), 'utf8');

/** Directives only — every one of these files is more comment than setting. */
function directives(unit: string): string[] {
  return unit
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

const VERIFY_SERVICE = 'n409-backup-verify.service';
const VERIFY_TIMER = 'n409-backup-verify.timer';
const BACKUP_SERVICE = 'n409-backup.service';
const BACKUP_TIMER = 'n409-backup.timer';

describe('n409-backup-verify.service', () => {
  const lines = directives(read(VERIFY_SERVICE));

  it('reads the verification credential after the application env file', () => {
    // The order is the whole mechanism: systemd applies these as it meets them,
    // so /etc/n409/backup-verify.env only overrides DATABASE_URL by being
    // second. Reversed, the unit connects as the application role, which has no
    // CREATEDB, and fails every Sunday with `permission denied to create
    // database` — a message that reads like a broken backup.
    const app = lines.indexOf('EnvironmentFile=/opt/N409/.env');
    const verify = lines.indexOf('EnvironmentFile=/etc/n409/backup-verify.env');
    expect(app).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(app);
  });

  it('requires the credential file rather than tolerating its absence', () => {
    // `-` would make a host without the file fall through to the application
    // URL and fail at the restore instead of at the start, naming the wrong
    // cause.
    expect(lines).not.toContain('EnvironmentFile=-/etc/n409/backup-verify.env');
  });

  it('has no [Install] section, so it cannot be enabled to run at boot', () => {
    // A full restore competing for disk and IO with the services coming up, for
    // a check whose justification is that weekly is often enough.
    // Asserted against the directives, not the raw text: the comment that
    // explains the absence names `[Install]` on purpose.
    expect(lines).not.toContain('[Install]');
    expect(lines).not.toContain('WantedBy=multi-user.target');
  });

  it('is a oneshot that runs the verification script', () => {
    expect(lines).toContain('Type=oneshot');
    expect(lines).toContain('ExecStart=/opt/N409/infra/backup/pg-verify.sh');
  });

  it('runs unprivileged, as the same user that owns the dumps', () => {
    expect(lines).toContain('User=n409');
    expect(lines).toContain('NoNewPrivileges=true');
  });

  it('cannot write to the backup directory it reads from', () => {
    expect(lines).toContain('ReadOnlyPaths=/opt/n409-backups');
  });

  it('allows longer than a default start timeout for a real restore', () => {
    // A verification killed by a timeout reports as a failed verification, which
    // is the one false alarm guaranteed to get the timer masked.
    const timeout = lines.find((l) => l.startsWith('TimeoutStartSec='));
    expect(timeout).toBeDefined();
    expect(Number(timeout!.split('=')[1])).toBeGreaterThanOrEqual(1800);
  });

  // R437: the result of the restore rehearsal has somewhere to be written that
  // is not the read-only backup directory above.
  it('gets a writable state directory of its own, distinct from the read-only backup root', () => {
    const stateDir = lines.find((l) => l.startsWith('StateDirectory='))?.split('=')[1];
    expect(stateDir).toBeDefined();
    const env = lines.find((l) => l.startsWith('Environment=VERIFY_STATE_DIR='))?.split('=').slice(2).join('=');
    expect(env).toBeDefined();
    expect(env).toBe(`/var/lib/${stateDir}`);
    expect(env).not.toContain('/opt/n409-backups');
  });
});

describe('n409-backup-verify.timer', () => {
  const lines = directives(read(VERIFY_TIMER));

  it('is the unit that gets enabled', () => {
    expect(lines).toContain('WantedBy=timers.target');
    expect(lines).toContain(`Unit=${VERIFY_SERVICE}`);
  });

  it('fires after the nightly backup, not alongside it', () => {
    // The backup runs at 06:00 UTC; verifying at 04:00 local on the same host
    // reads a dump taken that morning rather than racing the writer.
    const calendar = lines.find((l) => l.startsWith('OnCalendar='));
    expect(calendar).toBe('OnCalendar=Sun *-*-* 04:00:00');
  });

  it('catches up a run missed while the host was down', () => {
    expect(lines).toContain('Persistent=true');
  });
});

describe('the backup pair, for comparison', () => {
  it('the timer names its service and the service is a oneshot', () => {
    const timer = directives(read(BACKUP_TIMER));
    const service = directives(read(BACKUP_SERVICE));
    expect(timer).toContain('WantedBy=timers.target');
    expect(service).toContain('Type=oneshot');
    expect(service).toContain('ExecStart=/opt/N409/infra/backup/pg-backup.sh');
  });

  // The dump is the only unencrypted copy of the estate. The script sets its
  // own umask so a hand-run is covered; the unit states the same bound where an
  // operator reading it can see it, and covers anything else it comes to write.
  it('creates nothing another local account can read', () => {
    expect(directives(read(BACKUP_SERVICE))).toContain('UMask=0077');
  });

  it('every ExecStart points at a script that exists in the repo', () => {
    for (const name of [BACKUP_SERVICE, VERIFY_SERVICE]) {
      const exec = directives(read(name)).find((l) => l.startsWith('ExecStart='));
      expect(exec).toBeDefined();
      const script = exec!.split('=')[1]!.replace('/opt/N409/', '');
      expect(() => readFileSync(path.resolve(here, '../../../..', script), 'utf8')).not.toThrow();
    }
  });
});
