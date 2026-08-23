// Tests for infra/install-journald.sh.
//
// THE FAILURE THIS SCRIPT CLOSES: every N409 service logs to stdout and systemd
// puts that in the journal — DEPLOYMENT.md says so, and then tells an operator
// to read the journal after an OOM kill. How large the journal may grow, how
// long it is kept, and whether it survives a reboot were all whatever the
// distro defaulted to, recorded nowhere. On a single-disk host an unbounded
// journal is an outage whose first symptom is Postgres refusing writes, and a
// journal that turns out to have been volatile is an incident with no evidence.
//
// The half worth testing hardest is the *verification*. R88's lesson was not
// "copy the file", it was "a checker pointed at a file nothing reads cannot
// fail" — so the assertions below are mostly about the script refusing to
// report success when the values it wrote are not the ones in force.
//
// Black box, the way install-units.test.ts does it: a temp directory stands in
// for /etc/systemd/journald.conf.d, and stub `systemctl` / `systemd-analyze`
// commands record their argv and replay a scripted answer.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const SCRIPT = path.join(repoRoot, 'infra/install-journald.sh');
const REPO_DROPIN = path.join(repoRoot, 'infra/journald/10-n409.conf');

let work: string;
let dest: string;
let bin: string;
let transcript: string;
let analyzeOut: string;

/** What a healthy `systemd-analyze cat-config` prints for our settings. */
function effectiveFromRepo(overrides: Record<string, string> = {}): string {
  const lines = readFileSync(REPO_DROPIN, 'utf8')
    .split('\n')
    .filter((l) => /^[A-Za-z]+=/.test(l));
  const merged = [
    '# /usr/lib/systemd/journald.conf',
    '[Journal]',
    ...lines,
    // A later-sorting drop-in appends, and the last assignment wins — which is
    // exactly the case the script has to be able to see.
    ...Object.entries(overrides).map(([k, v]) => `${k}=${v}`),
  ];
  return merged.join('\n') + '\n';
}

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'n409-journald-'));
  dest = path.join(work, 'journald.conf.d');
  bin = path.join(work, 'bin');
  transcript = path.join(work, 'transcript');
  analyzeOut = path.join(work, 'analyze-out');
  mkdirSync(bin);
  writeFileSync(transcript, '');
  writeFileSync(analyzeOut, effectiveFromRepo());
  writeFileSync(
    path.join(bin, 'systemctl'),
    [
      '#!/usr/bin/env bash',
      `printf 'systemctl %s\\n' "$*" >> "$TRANSCRIPT"`,
      'exit ${SYSTEMCTL_EXIT:-0}',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, 'systemd-analyze'),
    [
      '#!/usr/bin/env bash',
      `printf 'systemd-analyze %s\\n' "$*" >> "$TRANSCRIPT"`,
      'exit_code=${ANALYZE_EXIT:-0}',
      '[[ "$exit_code" == "0" ]] && cat "$ANALYZE_OUT"',
      'exit "$exit_code"',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );
});

afterEach(() => rmSync(work, { recursive: true, force: true }));

interface Run {
  status: number;
  stderr: string;
  commands: string[];
}

function install(env: Record<string, string> = {}): Run {
  const res = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TRANSCRIPT: transcript,
      ANALYZE_OUT: analyzeOut,
      JOURNALD_DEST: dest,
      ...env,
    },
  });
  return {
    status: res.status ?? 1,
    stderr: res.stderr ?? '',
    commands: readFileSync(transcript, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.trim()),
  };
}

const installed = () => path.join(dest, '10-n409.conf');

describe('bringing the journal in step with the checkout', () => {
  it('installs the drop-in on a host that has never had one', () => {
    // Not even the directory: journald.conf.d is absent on a stock install, and
    // demanding it would mean this only ever works where somebody had already
    // prepared the box by hand — which is the failure being closed.
    expect(existsSync(dest)).toBe(false);
    const run = install();
    expect(run.status).toBe(0);
    expect(readFileSync(installed(), 'utf8')).toBe(readFileSync(REPO_DROPIN, 'utf8'));
  });

  it('writes it world-readable, like the units', () => {
    install();
    expect(statSync(installed()).mode & 0o777).toBe(0o644);
  });

  it('replaces a drop-in whose bytes differ', () => {
    mkdirSync(dest, { recursive: true });
    writeFileSync(installed(), '[Journal]\nSystemMaxUse=8G\n');
    const run = install();
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('differs from this checkout');
    expect(readFileSync(installed(), 'utf8')).toBe(readFileSync(REPO_DROPIN, 'utf8'));
  });

  it('leaves a drop-in that already matches alone, and does not restart journald', () => {
    install();
    // The transcript accumulates across runs; the claim is about the second one.
    writeFileSync(transcript, '');
    const second = install();
    expect(second.stderr).toContain('already matches this checkout');
    // Restarting journald on every deploy would truncate nothing and cost
    // nothing, but it would also mean the transcript could never distinguish a
    // change from a no-op — and the same reasoning keeps install-units.sh from
    // reloading systemd when nothing moved.
    expect(second.commands.filter((c) => c.startsWith('systemctl'))).toEqual([]);
  });

  it('restarts journald when the drop-in changed, because limits are read at start', () => {
    const run = install();
    expect(run.commands).toContain('systemctl restart systemd-journald');
  });

  it('restarts before it asks what is in force', () => {
    // The other order would read the configuration the daemon was started with
    // and report the *old* limits as proof of the new file.
    const run = install();
    const restart = run.commands.findIndex((c) => c === 'systemctl restart systemd-journald');
    const verify = run.commands.findIndex((c) => c.startsWith('systemd-analyze'));
    expect(restart).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(restart);
  });

  it('fails when journald will not restart', () => {
    const run = install({ SYSTEMCTL_EXIT: '1' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('not in effect');
  });
});

describe('refusing to report a success it did not achieve', () => {
  it('verifies on every run, not only when it changed something', () => {
    // A drop-in that has been correct on disk for months and is being
    // overridden by a drop-in added last week is exactly the state a
    // change-gated check would never look at.
    install();
    writeFileSync(analyzeOut, effectiveFromRepo({ SystemMaxUse: '4G' }));
    const second = install();
    expect(second.stderr).toContain('already matches this checkout');
    expect(second.status).not.toBe(0);
  });

  it('fails when a later drop-in overrides one of the values', () => {
    writeFileSync(analyzeOut, effectiveFromRepo({ SystemMaxUse: '4G' }));
    const run = install();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('SystemMaxUse');
    expect(run.stderr).toContain("effective 'SystemMaxUse=4G'");
    expect(run.stderr).toContain('later-sorting drop-in');
  });

  it('fails when the journal is left volatile', () => {
    // The one that costs an incident review rather than a disk: Storage=volatile
    // puts the journal in a tmpfs, so it is empty after exactly the reboot that
    // makes anybody want to read it.
    writeFileSync(analyzeOut, effectiveFromRepo({ Storage: 'volatile' }));
    const run = install();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Storage');
  });

  it('fails when the effective configuration cannot be read at all', () => {
    const run = install({ ANALYZE_EXIT: '1' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('cannot confirm');
  });

  it('fails when a setting is missing from the merged configuration entirely', () => {
    // A drop-in directory this journald does not consult produces exactly this:
    // the file is on disk, and none of it is in the answer.
    writeFileSync(analyzeOut, '# /usr/lib/systemd/journald.conf\n[Journal]\n');
    const run = install({ JOURNALD_DEST: dest });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('<unset>');
  });

  it('names the missing settings rather than only the count', () => {
    writeFileSync(analyzeOut, effectiveFromRepo({ Storage: 'volatile', MaxRetentionSec: '10year' }));
    const run = install();
    expect(run.stderr).toContain('Storage');
    expect(run.stderr).toContain('MaxRetentionSec');
  });

  it('reports the limits it confirmed on a clean run', () => {
    const run = install();
    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/limits in force: SystemMaxUse=/);
  });

  it('refuses a checkout that has no drop-in to install', () => {
    const run = install({ JOURNALD_SRC: 'infra/journald/does-not-exist.conf' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('not a file in this checkout');
  });
});

describe('the drop-in itself', () => {
  const body = () => readFileSync(REPO_DROPIN, 'utf8');

  it('bounds the journal by size and by age, so neither alone has to hold', () => {
    expect(body()).toMatch(/^SystemMaxUse=\d+[KMG]$/m);
    expect(body()).toMatch(/^MaxRetentionSec=\d+(day|week|month)$/m);
  });

  it('does not set SystemKeepFree', () => {
    // Its default is 15% of the filesystem. Any absolute number worth writing
    // here would be smaller than that on this host, so naming one would lower
    // the free-space protection while reading like it raised it.
    expect(body()).not.toMatch(/^SystemKeepFree=/m);
  });

  it('keeps the journal across a reboot', () => {
    // `auto`, the default, is persistent only where /var/log/journal already
    // exists — otherwise the journal is a tmpfs and an OOM kill investigated
    // after the reboot has nothing to read.
    expect(body()).toMatch(/^Storage=persistent$/m);
  });

  it('raises the rate limit without removing it', () => {
    // 0 disables rate limiting entirely, which lets one log loop consume the
    // whole ceiling and vacuum away everything that came before it — the same
    // evidence loss the raise is meant to prevent, by the other route.
    const burst = /^RateLimitBurst=(\d+)$/m.exec(body());
    expect(burst).not.toBeNull();
    expect(Number(burst![1])).toBeGreaterThan(10_000);
  });
});
