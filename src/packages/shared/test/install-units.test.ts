// Tests for infra/install-units.sh.
//
// THE FAILURE THIS SCRIPT CLOSES, and therefore what these tests are really
// about: deploy.sh shipped `infra/systemd/` onto the host with every other
// tracked file and then restarted the units under /etc/systemd/system, which
// are a different set of files that nothing kept in step. The production box
// ran units dated 21 Jul against a repo that had moved on 14 Aug, and the line
// that had not travelled was engine-wrapper's `Environment=APP_ENV=production`
// — the switch that makes its INTERNAL_SERVICE_TOKEN guard mandatory instead of
// advisory. With it absent, `internal_token_middleware` passes unauthenticated
// requests through the moment the secret is unset.
//
// Exercised as a black box the way deploy.test.ts does: a temp directory stands
// in for /etc/systemd/system and a stub `systemctl` records its argv into a
// transcript, so the assertions are about what systemd would have been asked to
// do.
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const SCRIPT = path.join(repoRoot, 'infra/install-units.sh');

let work: string;
let dest: string;
let src: string;
let bin: string;
let transcript: string;

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'n409-units-'));
  dest = path.join(work, 'systemd');
  src = path.join(work, 'src');
  bin = path.join(work, 'bin');
  transcript = path.join(work, 'transcript');
  for (const d of [dest, src, bin]) mkdirSync(d);
  writeFileSync(transcript, '');
  writeFileSync(
    path.join(bin, 'systemctl'),
    ['#!/usr/bin/env bash', `printf 'systemctl %s\\n' "$*" >> "$TRANSCRIPT"`, 'exit 0'].join('\n') + '\n',
    { mode: 0o755 },
  );
});

afterEach(() => rmSync(work, { recursive: true, force: true }));

interface Run {
  status: number;
  stderr: string;
  /** One line per stubbed systemctl invocation, argv flattened. */
  systemctl: string[];
}

function install(env: Record<string, string> = {}): Run {
  const res = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TRANSCRIPT: transcript,
      UNIT_DEST: dest,
      SOURCE_DIRS: src,
      ...env,
    },
  });
  return {
    status: res.status ?? 1,
    stderr: res.stderr ?? '',
    systemctl: readFileSync(transcript, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('systemctl '))
      .map((l) => l.slice('systemctl '.length).trim()),
  };
}

function source(name: string, body: string): void {
  writeFileSync(path.join(src, name), body);
}
function installed(name: string): string {
  return readFileSync(path.join(dest, name), 'utf8');
}

describe('bringing the host in step with the checkout', () => {
  it('installs a unit the host does not have', () => {
    source('n409-web.service', '[Service]\nExecStart=/usr/bin/node dist/index.js\n');
    const run = install();
    expect(run.status).toBe(0);
    expect(installed('n409-web.service')).toContain('ExecStart=/usr/bin/node');
    expect(run.stderr).toContain('n409-web.service: not installed');
  });

  it('replaces a unit whose bytes differ', () => {
    source('n409-web.service', 'new\n');
    writeFileSync(path.join(dest, 'n409-web.service'), 'old\n');
    const run = install();
    expect(installed('n409-web.service')).toBe('new\n');
    expect(run.stderr).toContain('differs from this checkout');
  });

  // The regression, stated as itself. This is the byte that was missing from
  // the production host for four weeks, and the only reason it was missing is
  // that nothing ever copied the file.
  it('carries engine-wrapper APP_ENV=production across from the real checkout', () => {
    const run = install({ SOURCE_DIRS: path.join(repoRoot, 'infra/systemd') });
    expect(run.status).toBe(0);
    expect(installed('n409-engine-wrapper.service')).toContain('Environment=APP_ENV=production');
  });

  it('installs every unit the real checkout carries, services and timers alike', () => {
    const run = install({
      SOURCE_DIRS: [path.join(repoRoot, 'infra/systemd'), path.join(repoRoot, 'infra/backup')].join(' '),
    });
    expect(run.status).toBe(0);
    expect(readdirSync(dest).sort()).toEqual([
      'n409-ai.service',
      'n409-backup-verify.service',
      'n409-backup-verify.timer',
      'n409-backup.service',
      'n409-backup.timer',
      'n409-engine-wrapper.service',
      'n409-report.service',
      'n409-valuation.service',
      'n409-web.service',
    ]);
  });

  it('leaves a unit that already matches untouched', () => {
    source('n409-web.service', 'same\n');
    writeFileSync(path.join(dest, 'n409-web.service'), 'same\n');
    const run = install();
    expect(run.stderr).toContain('already match this checkout');
    expect(run.stderr).not.toContain('replacing');
  });

  // `cp` truncates the destination before writing it, so a failure mid-write
  // leaves a unit systemd cannot parse. The write goes to a temp path and is
  // moved into place; nothing should be left behind either way.
  it('leaves no temp files behind', () => {
    source('n409-web.service', 'new\n');
    install();
    expect(readdirSync(dest)).toEqual(['n409-web.service']);
  });
});

describe('telling systemd about it', () => {
  it('reloads exactly once when anything changed', () => {
    source('a.service', 'a\n');
    source('b.service', 'b\n');
    const run = install();
    expect(run.systemctl.filter((c) => c === 'daemon-reload')).toHaveLength(1);
  });

  // Not merely wasteful: a reload is the only thing standing between a changed
  // unit file and a `systemctl restart` that silently runs the previous one, so
  // it has to be tied to "something changed" rather than to "the script ran".
  it('does not reload when nothing changed', () => {
    source('n409-web.service', 'same\n');
    writeFileSync(path.join(dest, 'n409-web.service'), 'same\n');
    const run = install();
    expect(run.systemctl).not.toContain('daemon-reload');
  });

  it('reloads before it enables or restarts anything', () => {
    source('n409-backup.timer', 'timer\n');
    const run = install();
    expect(run.systemctl[0]).toBe('daemon-reload');
  });

  // Enable is about the box surviving a reboot, not about the changed set: a
  // unit can be current on disk and wanted by no target at all.
  it('enables every unit, changed or not', () => {
    source('n409-web.service', 'same\n');
    source('n409-ai.service', 'new\n');
    writeFileSync(path.join(dest, 'n409-web.service'), 'same\n');
    const run = install();
    expect(run.systemctl).toContain('enable n409-web.service');
    expect(run.systemctl).toContain('enable n409-ai.service');
  });

  it('survives a unit that cannot be enabled', () => {
    source('n409-web.service', 'x\n');
    writeFileSync(
      path.join(bin, 'systemctl'),
      [
        '#!/usr/bin/env bash',
        `printf 'systemctl %s\\n' "$*" >> "$TRANSCRIPT"`,
        '[[ "$1" == enable ]] && exit 1',
        'exit 0',
      ].join('\n') + '\n',
      { mode: 0o755 },
    );
    const run = install();
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('enable failed');
  });
});

describe('what gets restarted, and what emphatically does not', () => {
  // A timer's schedule lives in its unit file, so a changed .timer that is
  // never restarted keeps firing on the old one — applied in appearance only.
  it('re-arms a timer whose schedule changed', () => {
    source('n409-backup.timer', 'OnCalendar=daily\n');
    writeFileSync(path.join(dest, 'n409-backup.timer'), 'OnCalendar=weekly\n');
    const run = install();
    expect(run.systemctl).toContain('restart n409-backup.timer');
  });

  it('leaves an unchanged timer alone', () => {
    source('n409-backup.timer', 'same\n');
    writeFileSync(path.join(dest, 'n409-backup.timer'), 'same\n');
    const run = install();
    expect(run.systemctl.join('\n')).not.toContain('restart');
  });

  // deploy.sh section 6 owns the application restarts, because it owns the
  // ordering that matters — valuation first, since it runs the migrations.
  // Restarting them here would restart them in alphabetical order instead.
  it('does not restart an application service it just replaced', () => {
    source('n409-valuation.service', 'new\n');
    writeFileSync(path.join(dest, 'n409-valuation.service'), 'old\n');
    const run = install();
    expect(run.systemctl.join('\n')).not.toContain('restart n409-valuation.service');
  });

  // The sharpest one. These two are Type=oneshot bodies that their timers
  // trigger; "restarting" n409-backup.service does not apply a change, it takes
  // a database backup, and n409-backup-verify.service starts a restore
  // rehearsal against a scratch database. Neither belongs in a deploy.
  it.each(['n409-backup.service', 'n409-backup-verify.service'])('never restarts %s', (unit) => {
    source(unit, 'new\n');
    writeFileSync(path.join(dest, unit), 'old\n');
    const run = install();
    expect(installed(unit)).toBe('new\n');
    expect(run.systemctl.join('\n')).not.toContain(`restart ${unit}`);
  });
});

describe('refusing to guess', () => {
  it('fails when the destination does not exist', () => {
    const run = install({ UNIT_DEST: path.join(work, 'nope') });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('does not look like a systemd box');
  });

  it('fails when a source directory does not exist', () => {
    const run = install({ SOURCE_DIRS: path.join(work, 'nope') });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('not a directory');
  });

  // A SOURCE_DIRS that resolves to nothing would otherwise be a silent success
  // that installs no units at all — the same "reported healthy, did nothing"
  // shape as the drift this script exists to close.
  it('fails when the source directories hold no units', () => {
    const run = install();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('no .service or .timer files found');
    expect(existsSync(path.join(dest, 'n409-web.service'))).toBe(false);
  });

  // Collected before anything is written, so a bad directory late in the list
  // does not leave the estate half-rewritten.
  it('writes nothing when a later source directory is bad', () => {
    source('n409-web.service', 'new\n');
    const run = install({ SOURCE_DIRS: `${src} ${path.join(work, 'nope')}` });
    expect(run.status).not.toBe(0);
    expect(readdirSync(dest)).toEqual([]);
  });
});
