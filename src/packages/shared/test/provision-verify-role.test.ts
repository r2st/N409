// Tests for infra/backup/provision-verify-role.sh.
//
// The credential the weekly restore rehearsal connects with was created by hand
// on the production host in R87 and recorded nowhere but a shell history and a
// paragraph of README. A rebuilt host would have come up with the timer armed,
// `n409-backup-verify.service` refusing to start on a missing EnvironmentFile,
// and nothing anywhere saying what belonged in it.
//
// Driven as a black box with stubbed `psql`/`openssl`: the superuser path and
// the connect-as-the-role path are separate stubs, so a test can make the role
// exist, make the connection fail, or make it succeed without CREATEDB — which
// is the state that actually broke the first rehearsal.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const SCRIPT = path.join(repoRoot, 'infra/backup/provision-verify-role.sh');

/** The fixed password the stubbed openssl always returns. */
const PW = 'a'.repeat(64);

let work: string;
let bin: string;
let envFile: string;
let transcript: string;

/**
 * `roleExists` seeds the superuser stub's catalogue answer; `clientAnswer` is
 * what a connection *as the role* reports for `rolcreatedb` — 't', 'f', or the
 * empty string standing for a connection that fails outright.
 */
function stubs(options: { roleExists?: boolean; clientAnswer?: string } = {}): void {
  const exists = options.roleExists ?? false;
  const client = options.clientAnswer ?? 't';
  writeFileSync(
    path.join(bin, 'psql-super'),
    [
      '#!/usr/bin/env bash',
      `printf 'super %s\\n' "$*" >> "$TRANSCRIPT"`,
      // Only the catalogue probe returns a row; the DDL statements say nothing.
      `[[ "$*" == *"FROM pg_roles WHERE rolname"* ]] && { ${exists ? 'echo 1' : 'true'}; exit 0; }`,
      'exit 0',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, 'psql'),
    [
      '#!/usr/bin/env bash',
      `printf 'client %s\\n' "$*" >> "$TRANSCRIPT"`,
      client === '' ? 'exit 1' : `echo ${client}`,
      'exit 0',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, 'openssl'),
    ['#!/usr/bin/env bash', `printf 'openssl %s\\n' "$*" >> "$TRANSCRIPT"`, `echo ${PW}`].join('\n') + '\n',
    { mode: 0o755 },
  );
  // chown needs root in production and must not be attempted here; stubbing it
  // rather than disabling it keeps the default ENV_OWNER under test.
  writeFileSync(
    path.join(bin, 'chown'),
    ['#!/usr/bin/env bash', `printf 'chown %s\\n' "$*" >> "$TRANSCRIPT"`, 'exit 0'].join('\n') + '\n',
    { mode: 0o755 },
  );
}

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'n409-verify-role-'));
  bin = path.join(work, 'bin');
  mkdirSync(bin);
  envFile = path.join(work, 'etc', 'backup-verify.env');
  transcript = path.join(work, 'transcript');
  writeFileSync(transcript, '');
  stubs();
});

afterEach(() => rmSync(work, { recursive: true, force: true }));

interface Run {
  status: number;
  stderr: string;
  /** Stub invocations, one line each, prefixed `super`/`client`/`openssl`/`chown`. */
  calls: string[];
}

function provision(env: Record<string, string> = {}): Run {
  const res = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TRANSCRIPT: transcript,
      ENV_FILE: envFile,
      PSQL: 'psql-super',
      ...env,
    },
  });
  return {
    status: res.status ?? 1,
    stderr: res.stderr ?? '',
    calls: readFileSync(transcript, 'utf8').split('\n').filter(Boolean),
  };
}

/**
 * These tests spawn a real bash interpreter, which then spawns several stubbed
 * binaries per run. In isolation each takes well under a second; run alongside
 * the other 40-odd files in this package they contend for process slots and can
 * cross vitest's 5s default, which surfaces as a timeout rather than as a
 * failure of anything the test is about. The budget is generous on purpose —
 * it is a ceiling for a hang, not a performance assertion.
 */
const SPAWN_TIMEOUT = 30_000;

const written = () => readFileSync(envFile, 'utf8');
const url = () =>
  written()
    .split('\n')
    .find((l) => l.startsWith('DATABASE_URL='))!;

describe(
  'provisioning a host that has never had the credential',
  () => {
    it('creates the role and writes the env file', () => {
      const run = provision();
      expect(run.status).toBe(0);
      expect(run.calls.join('\n')).toContain('CREATE ROLE');
      expect(url()).toBe(`DATABASE_URL=postgres://n409_verify:${PW}@localhost:5432/postgres`);
    });

    // The maintenance database, not the application one: the rehearsal connects
    // here only to issue CREATE DATABASE for its scratch copy.
    it('points the URL at the maintenance database', () => {
      provision();
      expect(url()).toContain('@localhost:5432/postgres');
    });

    // Hex rather than base64, because this value is the password component of a
    // URL and `+` and `/` would need percent-encoding in every place the URL is
    // copied to.
    it('generates a password that needs no URL-encoding', () => {
      provision();
      expect(run_password()).toMatch(/^[0-9a-f]{64}$/);
      expect(run_password()).toBe(encodeURIComponent(run_password()));
    });

    function run_password(): string {
      return url()
        .replace(/^DATABASE_URL=postgres:\/\/n409_verify:/, '')
        .replace(/@.*$/, '');
    }

    it('creates the directory when it is missing', () => {
      expect(existsSync(path.dirname(envFile))).toBe(false);
      provision();
      expect(existsSync(envFile)).toBe(true);
    });

    // The file holds a password and is read by a unit running as `n409`.
    it('writes the file 0640 and chowns it root:n409', () => {
      const run = provision();
      expect(statSync(envFile).mode & 0o777).toBe(0o640);
      expect(run.calls.some((c) => c.startsWith('chown root:n409 '))).toBe(true);
    });

    // The role's whole justification is CREATEDB *and nothing else*, so the
    // absence of the rest is part of what is provisioned — a role that picked up
    // SUPERUSER from an earlier experiment would otherwise pass every check.
    it('strips every privilege but LOGIN and CREATEDB', () => {
      const run = provision();
      const stripped = run.calls.find((c) => c.includes('NOSUPERUSER'));
      expect(stripped).toBeDefined();
      for (const attr of ['NOCREATEROLE', 'NOREPLICATION', 'NOBYPASSRLS', 'NOINHERIT']) {
        expect(stripped).toContain(attr);
      }
    });

    it('never prints the password', () => {
      const run = provision();
      expect(run.stderr).not.toContain(PW);
    });
  },
  SPAWN_TIMEOUT,
);

describe(
  're-running it',
  () => {
    function seed(contents: string): void {
      mkdirSync(path.dirname(envFile), { recursive: true });
      writeFileSync(envFile, contents);
    }

    // Rotating a working password on every run would be churn with a window in
    // it — the unit reads this file, and for the moment between the ALTER and the
    // write the two disagree.
    it('changes nothing when the existing credential works', () => {
      seed('DATABASE_URL=postgres://n409_verify:old@localhost:5432/postgres\n');
      const run = provision();
      expect(run.status).toBe(0);
      expect(run.stderr).toContain('nothing to do');
      expect(written()).toContain(':old@');
      expect(run.calls.join('\n')).not.toContain('ALTER ROLE');
    });

    // The exact state R87 spent a Sunday morning on: LOGIN succeeds, and the
    // CREATE DATABASE that follows does not. A bare connection check would call
    // this host healthy.
    it('re-provisions a credential that connects but cannot CREATE DATABASE', () => {
      seed('DATABASE_URL=postgres://n409_verify:old@localhost:5432/postgres\n');
      stubs({ roleExists: true, clientAnswer: 'f' });
      const run = provision();
      expect(run.stderr).toContain('cannot CREATE DATABASE');
      expect(run.calls.join('\n')).toContain('ALTER ROLE');
      expect(written()).toContain(`:${PW}@`);
    });

    it('re-provisions a credential that cannot connect at all', () => {
      seed('DATABASE_URL=postgres://n409_verify:stale@localhost:5432/postgres\n');
      // Connect-as-the-role fails on the probe and succeeds on the proof, which
      // is what a password reset actually looks like from here.
      writeFileSync(
        path.join(bin, 'psql'),
        [
          '#!/usr/bin/env bash',
          `printf 'client %s\\n' "$*" >> "$TRANSCRIPT"`,
          `[[ "$*" == *":stale@"* ]] && exit 1`,
          'echo t',
        ].join('\n') + '\n',
        { mode: 0o755 },
      );
      const run = provision();
      expect(run.status).toBe(0);
      expect(run.stderr).toContain('could not connect');
      expect(written()).toContain(`:${PW}@`);
    });

    it('alters rather than re-creates a role that already exists', () => {
      stubs({ roleExists: true });
      const run = provision();
      expect(run.calls.join('\n')).toContain('ALTER ROLE');
      expect(run.calls.join('\n')).not.toContain('CREATE ROLE');
    });

    it('provisions when the file exists but names no DATABASE_URL', () => {
      seed('# nothing useful here\n');
      const run = provision();
      expect(run.status).toBe(0);
      expect(url()).toContain(PW);
    });
  },
  SPAWN_TIMEOUT,
);

describe(
  'refusing to report a success it did not achieve',
  () => {
    // Without this the script's success means "the statements did not error",
    // which is not "the unit will work on Sunday": a role created against a
    // postgres reachable only over a socket, with an env file naming
    // localhost:5432, satisfies the first and fails the second.
    it('fails when the credential it just wrote cannot connect', () => {
      stubs({ clientAnswer: '' });
      const run = provision();
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('the weekly verification would fail');
    });

    it('fails when the credential it just wrote lacks CREATEDB', () => {
      stubs({ clientAnswer: 'f' });
      const run = provision();
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('the weekly verification would fail');
    });

    // Interpolated into SQL that runs as the database superuser. Not defence
    // against an attacker — anyone who can set ROLE can already run this as root
    // — but against a typo turning a CREATE ROLE into something else entirely.
    it.each(['n409 verify', "n409'; DROP", '409verify', 'N409_VERIFY', 'n409-verify'])(
      'refuses ROLE=%j rather than interpolating it',
      (role) => {
        const run = provision({ ROLE: role });
        expect(run.status).not.toBe(0);
        expect(run.stderr).toContain('plain lowercase identifier');
        expect(existsSync(envFile)).toBe(false);
      },
    );

    // An *empty* ROLE is not a rejected identifier, it is an unset one: `${ROLE:-}`
    // falls back to the default. Pinned because the obvious reading of the
    // validation above is that it rejects the empty string, and a later edit to
    // `${ROLE-}` — one character — would make that reading true and leave the
    // script interpolating nothing into a CREATE ROLE.
    it('falls back to the default rather than rejecting an empty ROLE', () => {
      const run = provision({ ROLE: '' });
      expect(run.status).toBe(0);
      expect(url()).toContain('postgres://n409_verify:');
    });
  },
  SPAWN_TIMEOUT,
);
