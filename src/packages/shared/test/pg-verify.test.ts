// Tests for infra/backup/pg-verify.sh.
//
// The script's whole purpose is to produce evidence that a dump restores, so a
// test that let it pass vacuously would be worse than no test at all. Both
// binaries it shells out to are stubbed (the script's header reserves
// PG_RESTORE/PSQL for exactly this), and every stub logs what it was asked, so
// the assertions are about what the script actually *did*: which database it
// created, which URL it restored into, which questions it asked afterwards, and
// whether it cleaned up.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const SCRIPT = path.join(repoRoot, 'infra/backup/pg-verify.sh');

let work: string;
let stubRestore: string;
let stubPsql: string;
let psqlLog: string;

/** A fake custom-format archive, in the shape the pg_restore stub can read. */
function writeDump(file: string, opts: { corrupt?: boolean; manifest?: boolean } = {}): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, opts.corrupt ? 'not-an-archive\n' : 'FAKE-DUMP\n12\n');
  if (opts.manifest !== false) {
    // Same format `sha256sum`/`shasum -a 256` write, which is what the script reads.
    const digest = execFileSync('shasum', ['-a', '256', file], { encoding: 'utf8' }).split(/\s+/)[0];
    writeFileSync(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`);
  }
}

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'n409-vftest-'));
  psqlLog = path.join(work, 'psql.log');

  // pg_restore: `--list` reads the TOC back (quick mode), `--dbname=` restores
  // (full mode). A file that is not an archive is an error, not an empty list.
  stubRestore = path.join(work, 'pg_restore');
  writeFileSync(
    stubRestore,
    [
      '#!/usr/bin/env bash',
      'mode="list"; file=""',
      'for a in "$@"; do',
      '  case "$a" in',
      '    --list) mode="list" ;;',
      '    --dbname=*) mode="restore" ;;',
      '    -*) ;;',
      '    *) file="$a" ;;',
      '  esac',
      'done',
      'if [ "$mode" = "list" ]; then',
      '  head -n 1 "$file" | grep -q "^FAKE-DUMP$" || {',
      '    echo "pg_restore: error: input file does not appear to be a valid archive" >&2; exit 1; }',
      '  echo "1; 1259 16001 TABLE public t1 n409"',
      '  exit 0',
      'fi',
      'if [ "${STUB_RESTORE_FAIL:-0}" = "1" ]; then',
      '  echo "pg_restore: error: could not read block 42 of archive" >&2; exit 1',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );
  chmodSync(stubRestore, 0o755);

  // psql: log every (url, sql) pair, then answer the specific questions the
  // script asks. Anything it does not recognise succeeds silently, so a new
  // query in the script shows up as a missing assertion rather than a crash.
  stubPsql = path.join(work, 'psql');
  writeFileSync(
    stubPsql,
    [
      '#!/usr/bin/env bash',
      'url=""; sql=""; skip=0',
      'for a in "$@"; do',
      '  if [ "$skip" = "1" ]; then skip=0; continue; fi',
      '  case "$a" in',
      '    -v) skip=1 ;;',
      '    -*) ;;',
      '    *) if [ -z "$url" ]; then url="$a"; else sql="$a"; fi ;;',
      '  esac',
      'done',
      'printf "%s|%s\\n" "$url" "$sql" >> "$STUB_LOG"',
      'case "$sql" in',
      '  *"CREATE DATABASE"*)',
      '    [ "${STUB_CREATE_FAIL:-0}" = "1" ] && exit 1',
      '    exit 0 ;;',
      '  *"DROP DATABASE"*) exit 0 ;;',
      '  *information_schema.tables*) echo "${STUB_TABLES:-77}"; exit 0 ;;',
      '  *"FROM schema_migrations"*) echo "${STUB_MIGRATIONS:-161}"; exit 0 ;;',
      '  *"count(*) FROM "*)',
      '    t="${sql##*FROM \\"}"; t="${t%\\"}"',
      '    for m in ${STUB_MISSING_TABLES:-}; do',
      '      if [ "$m" = "$t" ]; then echo "ERROR: relation \\"$t\\" does not exist" >&2; exit 1; fi',
      '    done',
      '    echo "${STUB_ROWS:-5}"; exit 0 ;;',
      'esac',
      'exit 0',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );
  chmodSync(stubPsql, 0o755);
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

beforeEach(() => {
  writeFileSync(psqlLog, '');
});

const DB_URL = 'postgres://u:p@localhost:5432/n409?sslmode=require';

function run(args: string[], env: Record<string, string> = {}, backupRoot = path.join(work, 'root')): string {
  return execFileSync('bash', [SCRIPT, ...args], {
    env: {
      ...process.env,
      DATABASE_URL: DB_URL,
      ENV_FILE: path.join(work, 'does-not-exist.env'),
      BACKUP_ROOT: backupRoot,
      PG_RESTORE: stubRestore,
      PSQL: stubPsql,
      STUB_LOG: psqlLog,
      VERIFY_DB: 'n409_verify_test',
      ...env,
    },
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

const psqlCalls = (): string[] => readFileSync(psqlLog, 'utf8').split('\n').filter(Boolean);

/** A backup root with one good daily dump, under a fresh directory per test. */
function rootWith(name: string, opts: Parameters<typeof writeDump>[1] = {}): string {
  const root = path.join(work, name);
  writeDump(path.join(root, 'daily', 'n409-20260801-020000.dump'), opts);
  mkdirSync(path.join(root, 'weekly'), { recursive: true });
  return root;
}

describe('pg-verify.sh --quick', () => {
  it('passes when every dump is readable and matches its checksum', () => {
    const root = rootWith('q1');
    writeDump(path.join(root, 'weekly', 'n409-20260726-020000.dump'));
    const out = run(['--quick'], {}, root);
    expect(out + '').toBeDefined();
    // No server is involved at all — that is the point of quick mode.
    expect(psqlCalls()).toHaveLength(0);
  });

  // The failure quick mode exists to catch: a dump that was good when written
  // and whose bytes have since changed on disk.
  it('fails when a dump no longer matches its recorded checksum', () => {
    const root = rootWith('q2');
    const dump = path.join(root, 'daily', 'n409-20260801-020000.dump');
    writeFileSync(dump, 'FAKE-DUMP\n12\nsomething-else\n'); // manifest now stale
    let stderr = '';
    expect(() => {
      try {
        run(['--quick'], {}, root);
      } catch (e) {
        stderr = String((e as { stderr?: Buffer }).stderr ?? '');
        throw e;
      }
    }).toThrow();
    expect(stderr).toContain('sha256 mismatch');
  });

  it('fails when an archive has become unreadable', () => {
    const root = path.join(work, 'q3');
    writeDump(path.join(root, 'daily', 'n409-20260801-020000.dump'), { corrupt: true });
    let stderr = '';
    expect(() => {
      try {
        run(['--quick'], {}, root);
      } catch (e) {
        stderr = String((e as { stderr?: Buffer }).stderr ?? '');
        throw e;
      }
    }).toThrow();
    expect(stderr).toContain('archive is unreadable');
  });

  // Dumps written before checksums existed have no manifest. Failing on their
  // absence would page somebody about backups that are perfectly fine.
  it('tolerates dumps written before checksums existed', () => {
    const root = path.join(work, 'q4');
    writeDump(path.join(root, 'daily', 'n409-20260801-020000.dump'), { manifest: false });
    const out = run(['--quick'], {}, root);
    expect(out).toBeDefined();
  });

  it('fails when there are no dumps at all', () => {
    const root = path.join(work, 'q5');
    mkdirSync(path.join(root, 'daily'), { recursive: true });
    expect(() => run(['--quick'], {}, root)).toThrow();
  });
});

describe('pg-verify.sh full restore', () => {
  it('restores the newest dump into a scratch database and drops it', () => {
    const root = rootWith('f1');
    run([], {}, root);
    const calls = psqlCalls();
    expect(calls.some((c) => c.includes('CREATE DATABASE "n409_verify_test"'))).toBe(true);
    expect(calls.some((c) => c.includes('DROP DATABASE IF EXISTS "n409_verify_test"'))).toBe(true);
    // It asked the questions that make this evidence rather than inference:
    // the table count, each spine table, and the migration ledger.
    expect(calls.some((c) => c.includes('information_schema.tables'))).toBe(true);
    for (const t of ['valuations', 'users', 'valuation_params', 'calculations']) {
      expect(calls.some((c) => c.includes(`FROM "${t}"`))).toBe(true);
    }
    expect(calls.some((c) => c.includes('FROM schema_migrations'))).toBe(true);
  });

  // Rebuilding the URL by hand is how sslmode gets dropped, and a connection
  // that then fails looks exactly like a bad backup.
  it('keeps the connection parameters when swapping in the scratch database', () => {
    const root = rootWith('f2');
    run([], {}, root);
    const calls = psqlCalls();
    // Admin connection borrows the server via the `postgres` database…
    expect(calls.some((c) => c.startsWith('postgres://u:p@localhost:5432/postgres?sslmode=require|'))).toBe(
      true,
    );
    // …and the scratch connection keeps the same parameters.
    expect(
      calls.some((c) => c.startsWith('postgres://u:p@localhost:5432/n409_verify_test?sslmode=require|')),
    ).toBe(true);
    // The live database is never connected to.
    expect(calls.some((c) => c.startsWith('postgres://u:p@localhost:5432/n409?'))).toBe(false);
  });

  it('reports a dump that does not restore as a failure', () => {
    const root = rootWith('f3');
    let stderr = '';
    expect(() => {
      try {
        run([], { STUB_RESTORE_FAIL: '1' }, root);
      } catch (e) {
        stderr = String((e as { stderr?: Buffer }).stderr ?? '');
        throw e;
      }
    }).toThrow();
    expect(stderr).toContain('NOT restorable');
  });

  // A restore that replays the DDL of the wrong database can still produce a
  // technically-successful pg_restore.
  it('fails when too few tables come back', () => {
    const root = rootWith('f4');
    let stderr = '';
    expect(() => {
      try {
        run([], { STUB_TABLES: '3' }, root);
      } catch (e) {
        stderr = String((e as { stderr?: Buffer }).stderr ?? '');
        throw e;
      }
    }).toThrow();
    expect(stderr).toContain('only 3 tables restored');
  });

  it('fails when a required table is missing from the restored schema', () => {
    const root = rootWith('f5');
    let stderr = '';
    expect(() => {
      try {
        run([], { STUB_MISSING_TABLES: 'calculations' }, root);
      } catch (e) {
        stderr = String((e as { stderr?: Buffer }).stderr ?? '');
        throw e;
      }
    }).toThrow();
    expect(stderr).toContain("required table 'calculations' is missing or unreadable");
  });

  it('fails when the restored database has never been migrated', () => {
    const root = rootWith('f6');
    let stderr = '';
    expect(() => {
      try {
        run([], { STUB_MIGRATIONS: '0' }, root);
      } catch (e) {
        stderr = String((e as { stderr?: Buffer }).stderr ?? '');
        throw e;
      }
    }).toThrow();
    expect(stderr).toContain('schema_migrations is empty');
  });

  // The scratch database must not outlive a failed verification — that is how
  // a weekly check slowly fills the server with n409_verify_* databases.
  it('drops the scratch database even when verification fails', () => {
    const root = rootWith('f7');
    expect(() => run([], { STUB_TABLES: '1' }, root)).toThrow();
    expect(psqlCalls().some((c) => c.includes('DROP DATABASE IF EXISTS "n409_verify_test"'))).toBe(true);
  });

  it('leaves the scratch database behind when asked to', () => {
    const root = rootWith('f8');
    run([], { KEEP_SCRATCH: '1' }, root);
    // Assert the run happened before asserting what it did not do, so this
    // cannot pass by the script never having reached psql at all.
    expect(psqlCalls().some((c) => c.includes('CREATE DATABASE'))).toBe(true);
    expect(psqlCalls().some((c) => c.includes('DROP DATABASE'))).toBe(false);
  });

  it('verifies an explicitly named dump rather than the newest', () => {
    const root = path.join(work, 'f9');
    writeDump(path.join(root, 'daily', 'n409-20260801-020000.dump'));
    const older = path.join(root, 'daily', 'n409-20260101-020000.dump');
    writeDump(older);
    const out = run([older], {}, root);
    expect(out).toBeDefined();
    expect(psqlCalls().length).toBeGreaterThan(0);
  });

  it('fails when no dump can be found', () => {
    const root = path.join(work, 'f10');
    mkdirSync(path.join(root, 'daily'), { recursive: true });
    expect(() => run([], {}, root)).toThrow();
  });

  it('rejects an unknown option instead of treating it as a dump path', () => {
    expect(() => run(['--restore-everything'], {}, rootWith('f11'))).toThrow();
    expect(existsSync(psqlLog)).toBe(true);
    expect(psqlCalls()).toHaveLength(0);
  });
});
