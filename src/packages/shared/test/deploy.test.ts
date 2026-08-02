// Tests for infra/deploy.sh.
//
// The deploy is pure Bash against a remote host, so it is exercised as a black
// box the way pg-backup.test.ts does: a throwaway git repo stands in for the
// checkout, and stub `ssh` / `scp` / `curl` binaries record every remote command
// into a transcript file instead of touching a machine. The assertions are then
// about the *transcript* — what would have run on the host, in what order.
//
// What is being pinned is the set of failure modes infra/DEPLOYMENT.md spends
// most of its length on, because every one of them fails silently:
//
//   - a skipped build leaves the previous release running while reporting success
//     (dist/ is gitignored, so the archive carries no compiled output);
//   - a BUILD_SHA read from the server names whatever was last checked out there,
//     not what was deployed, because `git archive` does not move the server's HEAD;
//   - `tar` never deletes, so a file removed in a commit stays live indefinitely;
//   - migrations run on n409-valuation's boot, so it has to restart first.
import { execFileSync, spawnSync } from 'node:child_process';
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
const SCRIPT = path.join(repoRoot, 'infra/deploy.sh');

let work: string;
let repo: string;
let transcript: string;
let bin: string;

/**
 * A stub that appends its argv to the transcript and exits 0.
 *
 * It records twice. The flat `$*` line is what most assertions read. The
 * second, `$TRANSCRIPT.argv`, keeps the arguments *separated* — one invocation
 * per line, fields joined by US (\037) — because `$*` cannot distinguish
 * `-i "/key dir/id"` (one argument holding a space) from `-i /key dir/id`
 * (two), and that distinction is the whole point of passing the identity as an
 * array. \037 is an octal escape: bash 3.2's printf has no \x.
 */
const US = '';

function stub(name: string, body: string[] = []): void {
  writeFileSync(
    path.join(bin, name),
    [
      '#!/usr/bin/env bash',
      `printf '${name} %s\\n' "$*" >> "$TRANSCRIPT"`,
      `printf '%s\\037' '${name}' "$@" >> "$TRANSCRIPT.argv"`,
      `printf '\\n' >> "$TRANSCRIPT.argv"`,
      ...body,
      'exit 0',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'n409-deploy-'));
  repo = path.join(work, 'repo');
  bin = path.join(work, 'bin');
  transcript = path.join(work, 'transcript');
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(transcript, '');
  writeFileSync(`${transcript}.argv`, '');

  git('init', '-q');
  git('config', 'user.email', 'test@n409.example');
  git('config', 'user.name', 'Test');
  writeFileSync(path.join(repo, 'keep.txt'), 'keep\n');
  writeFileSync(path.join(repo, 'doomed.txt'), 'doomed\n');
  git('add', '-A');
  git('commit', '-qm', 'first');

  stub('scp');
  stub('curl');
  // Stubbed so the verification waits cost nothing, and so the transcript
  // records that the script actually backed off between probes rather than
  // spinning through its whole attempt budget instantly.
  stub('sleep');
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

interface Run {
  status: number;
  stderr: string;
  transcript: string;
  remote: string[];
  /** One entry per stub invocation: [toolName, ...argv], arguments unsplit. */
  argv: string[][];
}

/**
 * Run the deploy with stubbed remote tooling. `sshBody` lets a test make the
 * stub answer a specific command (e.g. `cat BUILD_SHA`) or fail one.
 */
const HOST = 'root@test.invalid';

function deploy(
  args: string[],
  // `undefined` *removes* the variable rather than setting it empty — the
  // script distinguishes "SSH_KEY unset" (use the default, tolerate its
  // absence) from "SSH_KEY=" (use ssh-agent, deliberately).
  env: Record<string, string | undefined> = {},
  sshBody: string[] = [],
): Run {
  stub('ssh', sshBody);
  const merged: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TRANSCRIPT: transcript,
    HOST,
    SSH_KEY: '', // no identity file in the sandbox
    REMOTE_DIR: '/opt/N409',
    SKIP_VERIFY: '1',
    // Three attempts, not the production forty — enough for a test to prove the
    // loop retries and enough for it to prove the loop gives up, without either
    // case depending on the default budget.
    VERIFY_TIMEOUT: '9',
    VERIFY_INTERVAL: '3',
    ...env,
  };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];

  // spawnSync, not execFileSync: stderr is where every diagnostic goes, and
  // execFileSync only surfaces it when the command *fails*.
  const res = spawnSync('bash', [SCRIPT, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: merged as Record<string, string>,
  });
  const text = readFileSync(transcript, 'utf8');
  return {
    status: res.status ?? 1,
    stderr: res.stderr ?? '',
    transcript: text,
    remote: text
      .split('\n')
      .filter((l) => l.startsWith('ssh '))
      // The stub records the whole argv; drop the `ssh <host>` prefix so the
      // assertions read as the command that ran on the box.
      .map((l) => l.slice(4).replace(`${HOST} `, '').trim()),
    argv: readFileSync(`${transcript}.argv`, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => l.replace(new RegExp(`${US}$`), '').split(US)),
  };
}

describe('dry run is the default', () => {
  it('touches nothing remote without --apply', () => {
    const run = deploy([]);
    expect(run.status).toBe(0);
    // The one script whose accidental invocation restarts production.
    expect(run.transcript).toBe('');
    expect(run.stderr).toContain('DRY RUN');
  });

  it('still prints the plan it would run', () => {
    const run = deploy([]);
    expect(run.stderr).toContain('[dry-run]');
    expect(run.stderr).toContain('npm run build');
    expect(run.stderr).toContain('systemctl restart n409-valuation');
  });

  it('does not require a HOST to plan', () => {
    const run = deploy([], { HOST: '' });
    expect(run.status).toBe(0);
  });

  it('refuses to --apply without a HOST', () => {
    const run = deploy(['--apply'], { HOST: '' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('HOST is required');
  });
});

describe('a dirty tree is refused', () => {
  it('stops before touching the host', () => {
    writeFileSync(path.join(repo, 'keep.txt'), 'uncommitted edit\n');
    const run = deploy(['--apply']);
    expect(run.status).not.toBe(0);
    // The archive is built from HEAD, so the edit would not ship while
    // BUILD_SHA claimed the commit — deployer and host would disagree.
    expect(run.stderr).toContain('working tree is dirty');
    expect(run.transcript).toBe('');
  });

  it('proceeds under --allow-dirty', () => {
    writeFileSync(path.join(repo, 'keep.txt'), 'uncommitted edit\n');
    const run = deploy(['--apply', '--allow-dirty']);
    expect(run.status).toBe(0);
  });
});

describe('the build is mandatory and fatal', () => {
  it('builds before restarting anything', () => {
    const run = deploy(['--apply']);
    const build = run.remote.findIndex((c) => c.includes('npm run build'));
    const restart = run.remote.findIndex((c) => c.includes('systemctl restart'));
    expect(build).toBeGreaterThanOrEqual(0);
    expect(restart).toBeGreaterThan(build);
  });

  it('restarts nothing when the build fails', () => {
    // dist/ is gitignored: a deploy that restarts without a successful build
    // is a no-op that keeps the old release live while reporting success.
    const run = deploy(['--apply'], {}, ['[[ "$*" == *"npm run build"* ]] && exit 17']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('build failed');
    expect(run.remote.some((c) => c.includes('systemctl restart'))).toBe(false);
  });

  it('writes no BUILD_SHA when the build fails', () => {
    // A BUILD_SHA naming code that did not compile is worse than none: /health
    // would confidently report a commit that is not what is serving.
    const run = deploy(['--apply'], {}, ['[[ "$*" == *"npm run build"* ]] && exit 17']);
    expect(run.remote.some((c) => c.includes('> /opt/N409/BUILD_SHA'))).toBe(false);
  });
});

describe('BUILD_SHA', () => {
  it('is the local HEAD, written after the build', () => {
    const sha = git('rev-parse', 'HEAD');
    const run = deploy(['--apply']);
    const write = run.remote.find((c) => c.includes('> /opt/N409/BUILD_SHA'));
    expect(write).toBeDefined();
    expect(write).toContain(sha);

    const build = run.remote.findIndex((c) => c.includes('npm run build'));
    const wrote = run.remote.findIndex((c) => c.includes('> /opt/N409/BUILD_SHA'));
    expect(wrote).toBeGreaterThan(build);
  });

  it('never asks the server what it is running', () => {
    // `git archive` updates the tree without moving the server's HEAD, so
    // `git -C /opt/N409 rev-parse HEAD` names whatever was last checked out
    // there — a confidently wrong SHA.
    const run = deploy(['--apply']);
    expect(run.remote.some((c) => /git .*rev-parse/.test(c))).toBe(false);
  });

  it('hands the file to the service user', () => {
    const run = deploy(['--apply']);
    expect(run.remote.some((c) => c.includes('chown n409:n409 /opt/N409/BUILD_SHA'))).toBe(true);
  });
});

describe('files deleted since the last deploy', () => {
  function deployWithPrevSha(prev: string) {
    return deploy(['--apply'], {}, [
      `[[ "$*" == *"cat /opt/N409/BUILD_SHA"* ]] && { printf '${prev}\\n'; exit 0; }`,
    ]);
  }

  it('are removed from the host', () => {
    const prev = git('rev-parse', 'HEAD');
    rmSync(path.join(repo, 'doomed.txt'));
    git('add', '-A');
    git('commit', '-qm', 'drop doomed.txt');

    const run = deployWithPrevSha(prev);
    // tar never deletes; without this the withdrawn file stays live forever.
    // Quoted even when it needs no quoting — always, so there is no second code
    // path whose correctness depends on classifying the path first.
    expect(run.remote.some((c) => c === "rm -f '/opt/N409/doomed.txt'")).toBe(true);
  });

  it('leaves files that still exist alone', () => {
    const prev = git('rev-parse', 'HEAD');
    rmSync(path.join(repo, 'doomed.txt'));
    git('add', '-A');
    git('commit', '-qm', 'drop doomed.txt');

    const run = deployWithPrevSha(prev);
    expect(run.remote.some((c) => c.includes('rm -f /opt/N409/keep.txt'))).toBe(false);
  });

  it('says so when the host has no usable BUILD_SHA', () => {
    // Silently skipping the sweep would leave withdrawn files live with no
    // trace of the decision.
    const run = deploy(['--apply'], {}, []);
    expect(run.stderr).toContain('skipping deletion sweep');
  });

  it('does not trust a BUILD_SHA this checkout has never heard of', () => {
    const run = deployWithPrevSha('0'.repeat(40));
    expect(run.stderr).toContain('skipping deletion sweep');
    expect(run.remote.some((c) => c.startsWith('rm -f'))).toBe(false);
  });

  // ── The remote shell re-parses whatever we send it ────────────────────────
  //
  // ssh does not take an argv; it concatenates its arguments and hands the
  // result to a login shell on the far side. An unquoted path is therefore
  // word-split and glob-expanded *there*, however carefully it was quoted here.
  // This is not hypothetical for this repo: `git ls-files` already lists four
  // paths under docs/1/ with spaces, and two of those also carry parentheses.

  it('removes a path containing spaces as one path', () => {
    const prev = git('rev-parse', 'HEAD');
    const spacey = 'docs/WhatsApp Audio 2026-07-20 at 14.53.16.opus';
    mkdirSync(path.join(repo, 'docs'));
    writeFileSync(path.join(repo, spacey), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'add it');
    const mid = git('rev-parse', 'HEAD');
    rmSync(path.join(repo, spacey));
    git('add', '-A');
    git('commit', '-qm', 'drop it');

    const run = deploy(['--apply'], {}, [
      `[[ "$*" == *"cat /opt/N409/BUILD_SHA"* ]] && { printf '${mid}\\n'; exit 0; }`,
    ]);
    expect(prev).not.toBe(mid);
    // Unquoted, the remote shell saw six arguments and removed none of them —
    // and `rm -f` exits 0 on paths that do not exist, so the sweep reported
    // success while the withdrawn file stayed live. Exactly the silent failure
    // the sweep exists to prevent.
    const rm = run.remote.find((c) => c.includes('WhatsApp'));
    expect(rm).toBeDefined();
    expect(rm).toContain(`'/opt/N409/${spacey}'`);
  });

  it('removes a path containing shell metacharacters without breaking the deploy', () => {
    const prev = git('rev-parse', 'HEAD');
    // Parentheses are a bash syntax error unquoted, so this one did not fail
    // quietly — it aborted the deploy under `set -e` after the tree was already
    // unpacked, leaving new files on disk against the old build.
    const meta = 'docs/WhatsApp Image (1).jpeg';
    mkdirSync(path.join(repo, 'docs'));
    writeFileSync(path.join(repo, meta), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'add it');
    const mid = git('rev-parse', 'HEAD');
    rmSync(path.join(repo, meta));
    git('add', '-A');
    git('commit', '-qm', 'drop it');

    const run = deploy(['--apply'], {}, [
      `[[ "$*" == *"cat /opt/N409/BUILD_SHA"* ]] && { printf '${mid}\\n'; exit 0; }`,
    ]);
    expect(prev).not.toBe(mid);
    expect(run.remote.some((c) => c.includes(`'/opt/N409/${meta}'`))).toBe(true);
    // The deploy carried on: the build and the restarts still happened.
    expect(run.remote.some((c) => c.includes('systemctl restart n409-valuation'))).toBe(true);
  });

  it('removes a path that is not plain ASCII', () => {
    // `git diff --name-only` C-quotes anything outside ASCII: café.txt arrives
    // as the literal characters "caf\303\251.txt", double quotes and all. The
    // sweep then asked the host to remove a filename that has never existed,
    // and `rm -f` agreed without complaint. -z is what stops that.
    const prev = git('rev-parse', 'HEAD');
    const accented = 'docs/café.txt';
    mkdirSync(path.join(repo, 'docs'));
    writeFileSync(path.join(repo, accented), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'add it');
    const mid = git('rev-parse', 'HEAD');
    rmSync(path.join(repo, accented));
    git('add', '-A');
    git('commit', '-qm', 'drop it');

    const run = deploy(['--apply'], {}, [
      `[[ "$*" == *"cat /opt/N409/BUILD_SHA"* ]] && { printf '${mid}\\n'; exit 0; }`,
    ]);
    expect(prev).not.toBe(mid);
    expect(run.remote.some((c) => c === `rm -f '/opt/N409/${accented}'`)).toBe(true);
    expect(run.remote.some((c) => c.includes('\\303'))).toBe(false);
  });

  it('quotes a path containing a single quote so it cannot close the quoting', () => {
    const prev = git('rev-parse', 'HEAD');
    const quoted = "docs/it's here.txt";
    mkdirSync(path.join(repo, 'docs'));
    writeFileSync(path.join(repo, quoted), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'add it');
    const mid = git('rev-parse', 'HEAD');
    rmSync(path.join(repo, quoted));
    git('add', '-A');
    git('commit', '-qm', 'drop it');

    const run = deploy(['--apply'], {}, [
      `[[ "$*" == *"cat /opt/N409/BUILD_SHA"* ]] && { printf '${mid}\\n'; exit 0; }`,
    ]);
    expect(prev).not.toBe(mid);
    // The '\'' idiom: close, escape a literal quote, reopen.
    expect(run.remote.some((c) => c === `rm -f '/opt/N409/docs/it'\\''s here.txt'`)).toBe(true);
  });
});

describe('restart order', () => {
  it('restarts n409-valuation before the rest', () => {
    // Migrations run on its boot; the others must not come up against a schema
    // that has not moved yet.
    const run = deploy(['--apply']);
    const valuation = run.remote.findIndex((c) => c === 'systemctl restart n409-valuation');
    const others = run.remote.findIndex((c) => c.includes('systemctl restart n409-web'));
    expect(valuation).toBeGreaterThanOrEqual(0);
    expect(others).toBeGreaterThan(valuation);
  });

  it('restarts all five units', () => {
    const run = deploy(['--apply']);
    const restarts = run.remote.filter((c) => c.startsWith('systemctl restart')).join(' ');
    for (const unit of ['n409-valuation', 'n409-web', 'n409-ai', 'n409-engine-wrapper', 'n409-report']) {
      expect(restarts, `${unit} is never restarted`).toContain(unit);
    }
  });
});

describe('python dependencies', () => {
  function commitRequirements(): string {
    const dir = path.join(repo, 'src/services/ai');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'requirements.txt'), 'fastapi\n');
    git('add', '-A');
    git('commit', '-qm', 'add ai requirements');
    return git('rev-parse', 'HEAD~1');
  }

  it('installs only when requirements.txt actually moved', () => {
    const prev = commitRequirements();
    const run = deploy(['--apply'], {}, [
      `[[ "$*" == *"cat /opt/N409/BUILD_SHA"* ]] && { printf '${prev}\\n'; exit 0; }`,
    ]);
    expect(run.remote.some((c) => c.includes('pip install -r requirements.txt'))).toBe(true);
  });

  it('skips the pip resolve on an ordinary deploy', () => {
    const prev = git('rev-parse', 'HEAD');
    writeFileSync(path.join(repo, 'keep.txt'), 'edited\n');
    git('add', '-A');
    git('commit', '-qm', 'unrelated change');
    const run = deploy(['--apply'], {}, [
      `[[ "$*" == *"cat /opt/N409/BUILD_SHA"* ]] && { printf '${prev}\\n'; exit 0; }`,
    ]);
    expect(run.remote.some((c) => c.includes('pip install'))).toBe(false);
  });
});

describe('the shipped archive', () => {
  it('is uploaded and unpacked, then cleaned up', () => {
    const run = deploy(['--apply']);
    expect(run.transcript).toMatch(/scp .*n409-deploy\.tar\.gz/);
    expect(run.remote.some((c) => c.includes('tar -xzf /tmp/n409-deploy.tar.gz'))).toBe(true);
    expect(run.remote.some((c) => c.includes('rm -f /tmp/n409-deploy.tar.gz'))).toBe(true);
  });

  it('leaves nothing behind in the temp directory', () => {
    // Checked against a TMPDIR of our own rather than a /tmp glob: `mktemp -t`
    // honours TMPDIR, and on macOS that is a per-user /var/folders path, so a
    // hardcoded /tmp/n409-deploy-* matched nothing and the assertion held no
    // matter what the script leaked.
    //
    // What it leaked was real: `mktemp -t X` creates the file X, and naming the
    // tarball "$(mktemp …).tar.gz" then writes to a *different* path, so every
    // deploy left the empty original behind. The deletion sweep's list file is
    // the other one that has to go.
    const tmp = path.join(work, 'tmp');
    mkdirSync(tmp);
    const prev = git('rev-parse', 'HEAD');
    rmSync(path.join(repo, 'doomed.txt'));
    git('add', '-A');
    git('commit', '-qm', 'drop doomed.txt');
    const run = deploy(['--apply'], { TMPDIR: tmp }, [
      `[[ "$*" == *"cat /opt/N409/BUILD_SHA"* ]] && { printf '${prev}\\n'; exit 0; }`,
    ]);
    // Guard against the test passing because the sweep never ran at all.
    expect(run.remote.some((c) => c === "rm -f '/opt/N409/doomed.txt'")).toBe(true);
    // The trap must fire on the success path too, not only on the error paths.
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('leaves nothing behind when the deploy aborts before the deletion sweep', () => {
    // The abort path is the one where the cleanup is easiest to get wrong: the
    // trap names DELETED_LIST, but section 3 has not created it yet, so the
    // trap has to tolerate a name with no file behind it — and it has to do so
    // without `rm` inheriting an empty argument or the whole cleanup being
    // skipped. Failing the upload is the earliest realistic way in: after the
    // archive exists, before the sweep. Both temp files must still go.
    const tmp = path.join(work, 'tmp');
    mkdirSync(tmp);
    stub('scp', ['exit 3']);
    const run = deploy(['--apply'], { TMPDIR: tmp });
    // The abort must be a real one — a passing cleanup assertion means nothing
    // if the script actually finished.
    expect(run.status).not.toBe(0);
    expect(run.remote.some((c) => c.includes('tar -xzf'))).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });
});

/** Ports the script probes: web is the public origin, valuation the API. */
const WEB_PORT = 3000;
const VALUATION_PORT = 3001;

/**
 * An ssh stub clause answering `<port>/health` with `sha`.
 *
 * `notBefore` makes the first N-1 probes exit non-zero the way `curl -sf` does
 * when nothing is listening — which is what a service that has been forked but
 * has not finished booting actually looks like from outside. The count lives in
 * a file beside the transcript because each probe is a *fresh* stub process.
 */
function healthStub(port: number, sha: string, notBefore = 1): string {
  const counter = `"$TRANSCRIPT.health${port}"`;
  return [
    `if [[ "$*" == *":${port}/health"* ]]; then`,
    `  n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n + 1)); printf '%s' "$n" > ${counter}`,
    `  (( n < ${notBefore} )) && exit 7`,
    `  printf '{"build_sha":"${sha}"}'; exit 0`,
    'fi',
  ].join('\n');
}

/** How many times the stub was asked for `<port>/health`. */
function healthProbes(port: number): number {
  const f = `${transcript}.health${port}`;
  return existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0;
}

describe('post-deploy verification', () => {
  it('fails the deploy when /health reports a different commit', () => {
    // The whole point of BUILD_SHA: catching the deploy where the build or the
    // restart silently did not take. Valuation answers correctly so that the
    // failure under test is web's, and not the earlier gate.
    const sha = git('rev-parse', 'HEAD');
    const run = deploy(['--apply'], { SKIP_VERIFY: '0' }, [
      healthStub(VALUATION_PORT, sha),
      healthStub(WEB_PORT, 'deadbeef'),
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('/health reports');
    expect(run.stderr).toContain('deadbeef'); // says what it saw, not just that it was wrong
  });

  it('passes when the live commit matches', () => {
    const sha = git('rev-parse', 'HEAD');
    const run = deploy(['--apply'], { SKIP_VERIFY: '0' }, [
      `[[ "$*" == *"/health"* ]] && { printf '{"build_sha":"${sha}"}'; exit 0; }`,
    ]);
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('verified live');
  });

  it('fails when /ready is not passing', () => {
    const sha = git('rev-parse', 'HEAD');
    const run = deploy(['--apply'], { SKIP_VERIFY: '0' }, [
      `[[ "$*" == *"/health"* ]] && { printf '{"build_sha":"${sha}"}'; exit 0; }`,
      '[[ "$*" == *"/ready"* ]] && exit 22',
    ]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('/ready is not passing');
  });
});

describe('verification waits for the restart instead of racing it', () => {
  // Every unit is Type=simple, so `systemctl restart` returns at fork — not
  // when the service is listening. A single-shot probe therefore races the boot
  // and usually loses, failing a deploy that in fact succeeded, with a message
  // ("the build or the restart did not take") that sends the deployer hunting
  // in the wrong place — or rolling back a good release.

  it('succeeds when the service only answers on a later probe', () => {
    const sha = git('rev-parse', 'HEAD');
    const run = deploy(['--apply'], { SKIP_VERIFY: '0' }, [
      healthStub(VALUATION_PORT, sha, 2), // one connection-refused, then up
      healthStub(WEB_PORT, sha, 3), // two, then up
    ]);
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('verified live');
    // Proof the pass came from retrying rather than from a lucky first probe.
    expect(healthProbes(WEB_PORT)).toBe(3);
  });

  it('backs off between probes rather than spinning', () => {
    const sha = git('rev-parse', 'HEAD');
    const run = deploy(['--apply'], { SKIP_VERIFY: '0' }, [
      healthStub(VALUATION_PORT, sha),
      healthStub(WEB_PORT, sha, 3),
    ]);
    expect(run.status).toBe(0);
    // A retry loop with no sleep would hammer a booting host and exhaust its
    // budget in milliseconds, which is the original bug wearing a loop.
    expect(run.transcript).toContain('sleep 3');
  });

  it('gives up after the attempt budget and reports what it last saw', () => {
    const sha = git('rev-parse', 'HEAD');
    const run = deploy(['--apply'], { SKIP_VERIFY: '0' }, [
      healthStub(VALUATION_PORT, sha),
      healthStub(WEB_PORT, 'deadbeef'),
    ]);
    expect(run.status).not.toBe(0);
    // VERIFY_TIMEOUT/VERIFY_INTERVAL = 9/3. Waiting forever would hang a deploy
    // on a service that is never coming back.
    expect(healthProbes(WEB_PORT)).toBe(3);
  });

  it('keeps waiting while /ready is still 503', () => {
    // Readiness legitimately lags liveness: /ready probes upstreams, so it can
    // answer 503 for a while after the service itself is serving.
    const sha = git('rev-parse', 'HEAD');
    const run = deploy(['--apply'], { SKIP_VERIFY: '0' }, [
      `[[ "$*" == *"/health"* ]] && { printf '{"build_sha":"${sha}"}'; exit 0; }`,
      'if [[ "$*" == *"/ready"* ]]; then',
      '  n=$(cat "$TRANSCRIPT.ready" 2>/dev/null || echo 0); n=$((n + 1)); printf \'%s\' "$n" > "$TRANSCRIPT.ready"',
      '  (( n < 2 )) && exit 22',
      '  exit 0',
      'fi',
    ]);
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('verified live');
  });

  it('does not probe at all when verification is skipped', () => {
    const run = deploy(['--apply'], { SKIP_VERIFY: '1' });
    expect(run.status).toBe(0);
    expect(healthProbes(VALUATION_PORT)).toBe(0);
    expect(run.stderr).toContain('not verifying');
  });
});

describe('the restart order it claims to enforce', () => {
  // Migrations run on n409-valuation's boot, and it awaits migrate() before
  // listen(). Issuing the restarts in order only sequenced the two ssh calls;
  // the dependent services still booted against a half-migrated database.

  it('waits for valuation to report the new build before restarting the rest', () => {
    const sha = git('rev-parse', 'HEAD');
    const run = deploy(['--apply'], { SKIP_VERIFY: '0' }, [
      healthStub(VALUATION_PORT, sha, 2),
      healthStub(WEB_PORT, sha),
    ]);
    expect(run.status).toBe(0);

    const lastValuationProbe = run.remote.reduce(
      (acc, c, i) => (c.includes(`:${VALUATION_PORT}/health`) ? i : acc),
      -1,
    );
    const dependents = run.remote.findIndex((c) => c.includes('systemctl restart n409-web'));
    expect(lastValuationProbe).toBeGreaterThan(-1);
    expect(dependents).toBeGreaterThan(lastValuationProbe);
  });

  it('leaves the dependent services on the old release when valuation never comes up', () => {
    // Restarting them anyway would take down the services that were still
    // serving, on top of the one that failed.
    const run = deploy(['--apply'], { SKIP_VERIFY: '0' }, [healthStub(VALUATION_PORT, 'deadbeef')]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('valuation did not come up');
    expect(run.remote.some((c) => c.includes('systemctl restart n409-web'))).toBe(false);
  });

  it('plans both restart steps and both waits in a dry run', () => {
    const run = deploy([], { SKIP_VERIFY: '0' });
    expect(run.transcript).toBe('');
    expect(run.stderr).toContain('wait for valuation');
    expect(run.stderr).toContain('systemctl restart n409-web');
  });
});

describe('argument handling', () => {
  it('rejects an unknown flag rather than guessing', () => {
    const run = deploy(['--aply']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('unknown argument');
  });

  it('lets --dry-run override an earlier --apply', () => {
    const run = deploy(['--apply', '--dry-run']);
    expect(run.transcript).toBe('');
  });
});

describe('the ssh identity', () => {
  /** A readable stand-in for a private key, at `name` under the work dir. */
  function key(name: string): string {
    const p = path.join(work, name);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, 'NOT A REAL KEY\n', { mode: 0o600 });
    return p;
  }

  function callsTo(run: Run, tool: string): string[][] {
    return run.argv.filter((a) => a[0] === tool);
  }

  it('passes the identity to both ssh and scp', () => {
    const k = key('id_deploy');
    const run = deploy(['--apply'], { SSH_KEY: k });
    expect(run.status).toBe(0);

    // Every hop to the host must carry it — the archive upload included, or the
    // scp prompts for a password in the middle of a deploy.
    for (const tool of ['ssh', 'scp']) {
      const calls = callsTo(run, tool);
      expect(calls.length, `${tool} was never invoked`).toBeGreaterThan(0);
      for (const call of calls) expect(call.slice(1, 3)).toEqual(['-i', k]);
    }
  });

  it('keeps an identity path containing a space as one argument', () => {
    // The reason KEY_ARGS is an array and not a string. As a string this
    // arrives as `-i /key` plus a stray `dir/id_deploy` operand, and ssh reads
    // the tail as the host.
    const k = key('key dir/id_deploy');
    const run = deploy(['--apply'], { SSH_KEY: k });
    expect(run.status).toBe(0);

    const first = callsTo(run, 'ssh')[0];
    expect(first[1]).toBe('-i');
    expect(first[2]).toBe(k); // one field, space intact — not split across two
  });

  it('passes no identity when SSH_KEY is empty', () => {
    // This is the empty-array path: KEY_ARGS=() expanded under `set -u`. On
    // bash 3.2 the unguarded form aborts here with "unbound variable" before a
    // single remote command runs, so reaching a clean exit is the assertion.
    const run = deploy(['--apply'], { SSH_KEY: '' });
    expect(run.status).toBe(0);
    expect(callsTo(run, 'ssh').length).toBeGreaterThan(0);
    for (const call of [...callsTo(run, 'ssh'), ...callsTo(run, 'scp')]) {
      expect(call).not.toContain('-i');
    }
  });

  it('tolerates the default identity being absent', () => {
    // Not every checkout holds keys/hetzner_ustradingbot, and ssh-agent is a
    // legitimate way in — the default going missing must not block a deploy.
    const run = deploy(['--apply'], { SSH_KEY: undefined });
    expect(run.status).toBe(0);
  });

  it('refuses an SSH_KEY that names an unreadable file', () => {
    // Silently falling back would authenticate as whatever the agent happens to
    // offer, and the resulting "Permission denied" reads as a broken host
    // rather than a typo in the variable the deployer just set.
    const run = deploy(['--apply'], { SSH_KEY: path.join(work, 'typo_id') });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('not readable');
    expect(run.transcript).toBe('');
  });
});

describe('bash 3.2 portability', () => {
  it('guards every optional-array expansion', () => {
    // macOS still ships bash 3.2, where expanding an EMPTY array under `set -u`
    // aborts with "unbound variable" — and the documented workflow runs this
    // script from the local, usually macOS, checkout. CI runs bash 5, where the
    // unguarded form is perfectly fine, so the behavioural tests above pass
    // there either way. This static check is what fails in CI on a regression.
    const source = readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l)) // the header discusses both forms by name
      .join('\n');
    const unguarded = source.replace(/\$\{(\w+)\[@\]\+"\$\{\1\[@\]\}"\}/g, '');
    expect(unguarded, 'use ${A[@]+"${A[@]}"} — plain "${A[@]}" dies on bash 3.2').not.toMatch(
      /\$\{\w+\[@\]\}/,
    );
  });
});

describe('the script itself', () => {
  it('prints its whole header for --help', () => {
    // A hardcoded line range silently truncates the moment anything above it is
    // edited, and the config block is the half most likely to grow.
    const out = execFileSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(out).toContain('N409 deploy');
    expect(out).toContain('SKIP_VERIFY'); // the last configuration entry
    expect(out).toContain('accidental invocation restarts production');
    expect(out).not.toContain('set -euo pipefail'); // stops before the code
  });

  it('is executable and parses', () => {
    expect(existsSync(SCRIPT)).toBe(true);
    execFileSync('bash', ['-n', SCRIPT]);
  });

  it('runs under set -euo pipefail', () => {
    // Without -e a failing remote step is invisible and the deploy marches on.
    expect(readFileSync(SCRIPT, 'utf8')).toContain('set -euo pipefail');
  });
});
