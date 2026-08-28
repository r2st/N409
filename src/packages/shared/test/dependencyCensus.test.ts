import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * The dependency questions `npm audit` and `pip-audit` structurally cannot ask.
 *
 * Both scanners answer one question well — "does anything in the resolved tree
 * have a published advisory?" — and the repo already blocks on it in CI. What
 * neither can see is the shape of the tree itself:
 *
 *   * a package our source imports that no manifest of ours declares. It works,
 *     because something else's dependency hoisted it into reach, which is
 *     precisely the problem: the version we run was chosen by *another
 *     package's* ranges, and nothing we wrote constrains it. `@n409/shared`
 *     imported three OpenTelemetry packages this way, and both Python services
 *     imported `pydantic`, `starlette` and `anyio` the same way — `starlette`
 *     permits `anyio>=3.6.2`, so a fresh install was entitled to hand
 *     `app/limits.py` an anyio three major lines below the one it was written
 *     against. The scanners saw those packages and reported them clean; they
 *     had no way to report that we had never said which versions we accept.
 *
 *   * a lock entry whose bytes are not pinned, or that came from somewhere
 *     other than the public registry. An advisory scan reads names and
 *     versions; it does not ask whether the tarball behind a name is fixed.
 *
 *   * a dependency that runs code at install time. This is the vector real npm
 *     compromises use, and it arrives as a *version bump*: the package name in
 *     the diff is one you already trust, and the new `postinstall` is in the
 *     tarball, not the diff. Four packages in this tree do it; a fifth appearing
 *     should be a decision, not a surprise.
 *
 *   * a dependency nobody uses. Unreferenced packages are install-time and
 *     supply-chain surface bought for nothing.
 *
 *   * a range loose enough that two installs of the same commit differ.
 *
 * All of it is read off the manifests, the lockfile and the source, so this
 * runs with no network and no installed tree.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Every workspace, as a path relative to the repo root. */
const WORKSPACES = [
  'src/packages/shared',
  'src/services/report',
  'src/services/valuation',
  'src/services/web',
  'src/services/web-frontend',
] as const;

type Manifest = {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

function manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8')) as Manifest;
}

function declaredIn(m: Manifest): Set<string> {
  return new Set([
    ...Object.keys(m.dependencies ?? {}),
    ...Object.keys(m.devDependencies ?? {}),
    ...Object.keys(m.peerDependencies ?? {}),
  ]);
}

/** Every file under `dir`, skipping build output, virtualenvs and dotfiles. */
function filesUnder(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    if (['node_modules', 'dist', 'coverage', '__pycache__', 'mutants'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, out);
    else out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Node: what the source imports vs what the manifests declare
// ---------------------------------------------------------------------------

/**
 * Import specifiers in a TypeScript/JavaScript source.
 *
 * Comments come out first, then four forms are matched over the whole file
 * rather than line by line — a multi-line `import { … } from 'x'` puts the
 * specifier on its own line, so an anchored pattern would miss exactly the
 * imports a large file has.
 *
 * Matching `from '…'` across a whole file also matches the phrase inside string
 * and template literals, and this repo's prose is full of it ("the reads whose
 * cost was the table"). {@link packageOf} throws those out on the shape of the
 * text: a package name has no spaces, no capitals and no punctuation beyond
 * `-._~`, and none of the prose survives that.
 */
function importSpecifiers(source: string): string[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  const out: string[] = [];
  const forms = [
    /\bfrom\s*['"]([^'"\n]+)['"]/g,
    /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /^\s*import\s+['"]([^'"\n]+)['"]/gm,
  ];
  for (const re of forms) for (const m of stripped.matchAll(re)) out.push(m[1]!);
  return out;
}

/** npm's grammar for a package name, minus the legacy uppercase allowance. */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(?:\/[^\s'"]*)?$/;

/** Node builtins reachable without the `node:` prefix. */
const NODE_BUILTINS = new Set(
  (
    'assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel ' +
    'dns domain events fs http http2 https inspector module net os path perf_hooks process punycode ' +
    'querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm ' +
    'wasi worker_threads zlib'
  )
    .split(' ')
    .filter(Boolean),
);

/** The package a specifier resolves to, or null if it is not a bare package. */
function packageOf(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  if (!PACKAGE_NAME.test(spec)) return null;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  return NODE_BUILTINS.has(name) ? null : name;
}

/**
 * Root-declared packages a workspace may import without declaring itself.
 *
 * Repo-wide tooling belongs to the root and is deliberately not duplicated
 * per workspace — a second copy of `eslint` could resolve a different version
 * than the one `npm run lint` runs, which is the opposite of what the test
 * importing it is trying to prove.
 */
const ROOT_TOOLING_ALLOWED: Record<string, string> = {
  eslint:
    'hookRulesGate.test.ts resolves the *root* eslint config with cwd=REPO_ROOT; a ' +
    'workspace-local eslint could be a different version than `npm run lint` uses.',
};

describe('node workspaces declare every package they import', () => {
  const rootDeclared = declaredIn(manifest('.'));

  for (const ws of WORKSPACES) {
    it(`${ws}`, () => {
      const declared = declaredIn(manifest(ws));
      const undeclared = new Map<string, string>();

      for (const file of filesUnder(path.join(repoRoot, ws))) {
        if (!/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(file)) continue;
        for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
          const pkg = packageOf(spec);
          if (!pkg || declared.has(pkg)) continue;
          if (rootDeclared.has(pkg) && pkg in ROOT_TOOLING_ALLOWED) continue;
          if (!undeclared.has(pkg)) undeclared.set(pkg, path.relative(repoRoot, file));
        }
      }

      expect(
        [...undeclared].map(([pkg, where]) => `${pkg} (first seen in ${where})`),
        `${ws} imports these but declares none of them. They resolve today only because ` +
          `something else hoisted them into node_modules, so their version is decided by ` +
          `another package's ranges. Add them to ${ws}/package.json.`,
      ).toEqual([]);
    });
  }
});

/**
 * Packages that are used without their name appearing in any scanned file.
 *
 * Kept as an allowlist rather than widened away, because "unreferenced" is the
 * only signal that separates a live dependency from surface bought for nothing.
 */
const INDIRECTLY_USED: Record<string, string> = {
  '@vitest/coverage-v8':
    'vitest resolves the v8 coverage provider by convention when CI passes ' +
    '`--coverage`; the package name never appears in a config.',
};

describe('every declared dependency is actually referenced', () => {
  for (const ws of ['.', ...WORKSPACES]) {
    it(`${ws === '.' ? 'repo root' : ws}`, () => {
      const m = manifest(ws);
      // package-lock.json and package.json are excluded on purpose: both list
      // every dependency by name, so including them would make this pass by
      // construction for every package that exists.
      const text = filesUnder(path.join(repoRoot, ws))
        .filter(
          (f) =>
            /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|css|html|yml|yaml|sh|Dockerfile)$/.test(f) ||
            path.basename(f) === 'Dockerfile',
        )
        .map((f) => readFileSync(f, 'utf8'))
        .join('\n')
        .concat('\n', JSON.stringify(m.scripts ?? {}));

      const unreferenced = [...declaredIn(m)].filter((dep) => {
        if (dep in INDIRECTLY_USED) return false;
        if (text.includes(dep)) return false;
        // A `@types/x` package is used exactly when `x` is: nothing imports it
        // by name, the compiler picks it up from node_modules/@types.
        if (dep.startsWith('@types/')) return !text.includes(dep.slice('@types/'.length));
        return true;
      });

      expect(
        unreferenced,
        `declared by ${ws} and referenced by nothing in it — either use them or ` +
          `remove them; an unused dependency is install-time and supply-chain ` +
          `surface bought for nothing.`,
      ).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Python: what the services import vs what requirements.txt declares
// ---------------------------------------------------------------------------

/**
 * `sys.stdlib_module_names`, so an import can be classified without a Python
 * interpreter. Only used to *exclude*, so a name this list is missing surfaces
 * as a loud false failure (add it) rather than as a silent gap.
 */
const PY_STDLIB = new Set(
  (
    'abc annotationlib antigravity argparse array ast asyncio atexit base64 bdb binascii bisect ' +
    'builtins bz2 cProfile calendar cmath cmd code codecs codeop collections colorsys compileall ' +
    'compression concurrent configparser contextlib contextvars copy copyreg csv ctypes curses ' +
    'dataclasses datetime dbm decimal difflib dis doctest email encodings ensurepip enum errno ' +
    'faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc genericpath getopt ' +
    'getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib importlib ' +
    'inspect io ipaddress itertools json keyword linecache locale logging lzma mailbox marshal math ' +
    'mimetypes mmap modulefinder msvcrt multiprocessing netrc nt ntpath nturl2path numbers opcode ' +
    'operator optparse os pathlib pdb pickle pickletools pkgutil platform plistlib poplib posix ' +
    'posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue quopri ' +
    'random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex ' +
    'shutil signal site smtplib socket socketserver sqlite3 sre_compile sre_constants sre_parse ssl ' +
    'stat statistics string stringprep struct subprocess symtable sys sysconfig syslog tabnanny tarfile ' +
    'tempfile termios textwrap this threading time timeit tkinter token tokenize tomllib trace traceback ' +
    'tracemalloc tty types typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser ' +
    'winreg winsound wsgiref xml xmlrpc zipapp zipfile zipimport zlib zoneinfo ' +
    // A compiler directive rather than a distribution, but it is spelled as an import.
    '__future__'
  )
    .split(' ')
    .filter(Boolean),
);

const PY_SERVICES = ['src/services/ai', 'src/services/engine-wrapper'] as const;

/** The distribution that provides an importable module, where they differ. */
const PY_IMPORT_TO_DIST: Record<string, string> = {
  yaml: 'pyyaml',
  dotenv: 'python-dotenv',
};

/** Distribution names in a requirements file, floors and markers stripped. */
function requirementNames(file: string): Set<string> {
  const names = new Set<string>();
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.split('#')[0]!.trim();
    if (!line || line.startsWith('-')) continue;
    const name = line
      .split(/[<>=!~;[ ]/)[0]!
      .trim()
      .toLowerCase();
    if (name) names.add(name);
  }
  return names;
}

/**
 * Top-level module names imported by a Python source.
 *
 * Triple-quoted strings come out first. Without that, every docstring sentence
 * starting "from the …" reads as an import, and this repo writes a lot of them
 * — the first draft of this census reported `the`, `its`, `somewhere` and
 * `opposite` as undeclared dependencies. Requiring the `import` keyword on a
 * `from` line is the second half of the same guard.
 */
function pyImports(source: string): string[] {
  const stripped = source
    .replace(/'''[\s\S]*?'''/g, '')
    .replace(/"""[\s\S]*?"""/g, '')
    .replace(/#[^\n]*/g, '');
  const out: string[] = [];
  for (const line of stripped.split('\n')) {
    const m =
      /^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s/.exec(line) ??
      /^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)/.exec(line);
    if (m) out.push(m[1]!.split('.')[0]!);
  }
  return out;
}

describe('python services declare every package they import', () => {
  for (const svc of PY_SERVICES) {
    const dir = path.join(repoRoot, svc);
    // `app/` ships; `tests/` does not. A test-only import belongs in
    // requirements-dev.txt, and a shipped import must not.
    const cases = [
      { tree: 'app', reqs: ['requirements.txt'] },
      { tree: 'tests', reqs: ['requirements.txt', 'requirements-dev.txt'] },
    ] as const;

    for (const { tree, reqs } of cases) {
      it(`${svc}/${tree}`, () => {
        const declared = new Set<string>();
        for (const r of reqs) for (const n of requirementNames(path.join(dir, r))) declared.add(n);

        // Anything importable from inside the service is local, not a dependency.
        const local = new Set(
          readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory() || e.name.endsWith('.py'))
            .map((e) => e.name.replace(/\.py$/, '')),
        );
        for (const e of readdirSync(path.join(dir, tree), { withFileTypes: true })) {
          local.add(e.name.replace(/\.py$/, ''));
        }

        const undeclared = new Map<string, string>();
        for (const file of filesUnder(path.join(dir, tree))) {
          if (!file.endsWith('.py')) continue;
          for (const mod of pyImports(readFileSync(file, 'utf8'))) {
            if (PY_STDLIB.has(mod) || local.has(mod)) continue;
            const dist = (PY_IMPORT_TO_DIST[mod] ?? mod).toLowerCase();
            if (declared.has(dist)) continue;
            if (!undeclared.has(mod)) undeclared.set(mod, path.relative(repoRoot, file));
          }
        }

        expect(
          [...undeclared].map(([mod, where]) => `${mod} (first seen in ${where})`),
          `${svc}/${tree} imports these and ${reqs.join(' + ')} declare none of them. ` +
            `They arrive as somebody else's transitive dependency, so the version ` +
            `installed is bounded by that package's ranges rather than by ours.`,
        ).toEqual([]);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// The lockfile
// ---------------------------------------------------------------------------

type LockEntry = {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  extraneous?: boolean;
  hasInstallScript?: boolean;
};

function lockfile(): Record<string, LockEntry> {
  const lock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8')) as {
    lockfileVersion: number;
    packages: Record<string, LockEntry>;
  };
  expect(lock.lockfileVersion, 'lockfileVersion 3 is what carries `integrity` per entry').toBe(3);
  return lock.packages;
}

describe('package-lock.json pins what npm ci will fetch', () => {
  it('every registry entry carries an integrity hash', () => {
    const missing = Object.entries(lockfile())
      .filter(([name, e]) => name !== '' && !e.link && e.resolved && !e.integrity)
      .map(([name]) => name);
    expect(missing, 'without integrity, `npm ci` accepts whatever the URL serves').toEqual([]);
  });

  it('every entry resolves from the public npm registry', () => {
    const offRegistry = Object.entries(lockfile())
      // `link: true` entries are the `@n409/*` workspace symlinks: their
      // `resolved` is a path in this repo, not a URL to fetch.
      .filter(([, e]) => !e.link && e.resolved)
      .filter(([, e]) => !e.resolved!.startsWith('https://registry.npmjs.org/'))
      .map(([name, e]) => `${name} <- ${e.resolved}`);
    expect(
      offRegistry,
      'a git, http or alternate-registry source is fetched from a host nobody audits ' +
        'and, for git, is not content-addressed at all',
    ).toEqual([]);
  });

  it('every entry without a resolved URL is a workspace that exists', () => {
    const ghosts = Object.entries(lockfile())
      .filter(([name, e]) => name !== '' && !e.resolved && !e.link)
      .map(([name]) => name)
      .filter((name) => !existsSync(path.join(repoRoot, name, 'package.json')));
    expect(
      ghosts,
      'lock entries for directories that no longer exist. `src/services/engine-wrapper` ' +
        '(now a Python service) and `src/services/web/frontend` (moved to ' +
        '`src/services/web-frontend`) survived their own deletion here for rounds, ' +
        'still declaring dependencies, because `npm install` marks a vanished workspace ' +
        'extraneous rather than dropping it.',
    ).toEqual([]);
  });

  it('no entry is marked extraneous', () => {
    const extraneous = Object.entries(lockfile())
      .filter(([, e]) => e.extraneous)
      .map(([name]) => name);
    expect(extraneous).toEqual([]);
  });
});

/**
 * Every package in the tree that runs code during `npm ci`.
 *
 * Reviewed as of R195. This is the npm supply-chain vector that does not look
 * like one in review: the name in the diff is a package already trusted, the
 * version bump is routine, and the new `postinstall` is inside the tarball
 * where no diff shows it. Read off the lockfile rather than `node_modules`, so
 * it describes what a clean CI install will execute.
 */
const INSTALL_SCRIPTS_ALLOWED = [
  // Selects and verifies the prebuilt binary for the platform.
  'node_modules/esbuild',
  // Optional macOS file-watcher native addon; builds on install.
  'node_modules/fsevents',
  'node_modules/playwright/node_modules/fsevents',
  // Writes the generated CLI shims.
  'node_modules/protobufjs',
];

describe('install-time code execution', () => {
  it('only the reviewed packages run scripts during npm ci', () => {
    const withScripts = Object.entries(lockfile())
      .filter(([, e]) => e.hasInstallScript)
      .map(([name]) => name)
      .sort();
    expect(
      withScripts,
      'a package gained (or lost) an install/preinstall/postinstall script. Read what ' +
        'it runs before widening this list — install scripts execute with the ' +
        "developer's and CI's full privileges, before any test has run.",
    ).toEqual([...INSTALL_SCRIPTS_ALLOWED].sort());
  });
});

// ---------------------------------------------------------------------------
// Version ranges
// ---------------------------------------------------------------------------

describe('no manifest declares a range that lets two installs differ', () => {
  for (const ws of ['.', ...WORKSPACES]) {
    it(`${ws === '.' ? 'repo root' : ws}`, () => {
      const m = manifest(ws);
      const loose: string[] = [];
      for (const group of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
        for (const [name, range] of Object.entries(m[group] ?? {})) {
          // `@n409/*: "*"` is a workspace link — npm resolves it to the local
          // directory, never to the registry, and the lockfile records no
          // `resolved` for it. The range is not a version range at all.
          if (name.startsWith('@n409/')) {
            expect(range, `${name} is a workspace link and should stay "*"`).toBe('*');
            continue;
          }
          if (/^(\*|latest|x|\d+\.x)$/.test(range)) loose.push(`${group}.${name} = ${range}`);
          if (/^(git|https?|file|link):|^github:|#/.test(range)) loose.push(`${group}.${name} = ${range}`);
        }
      }
      expect(
        loose,
        'an unbounded or non-registry range: two installs of this commit can differ, ' +
          'and a review of the diff cannot tell which version shipped',
      ).toEqual([]);
    });
  }
});

describe('every workspace package stays private', () => {
  it('nothing here can be published to the public registry', () => {
    // Each of these declares `@n409/*` siblings by workspace link. A published
    // copy of any of them would also publish the internal names, which is the
    // half of a dependency-confusion setup we control.
    const publishable = ['.', ...WORKSPACES].filter((ws) => manifest(ws).private !== true);
    expect(publishable).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CI's own downloads
// ---------------------------------------------------------------------------

describe('CI verifies the binaries it downloads and runs', () => {
  const workflowDir = path.join(repoRoot, '.github/workflows');

  for (const file of readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))) {
    it(file, () => {
      const text = readFileSync(path.join(workflowDir, file), 'utf8');

      // Only raw fetches are in scope. `apt-get`, `pip` and `npm ci` each carry
      // their own integrity mechanism (repository signatures, PyPI over TLS
      // with a resolver, and the lockfile's per-entry hashes); a bare curl or
      // wget carries none, and this pipeline's only one fed `tar -xz` directly
      // and then executed the result.
      const fetches = text
        .split('\n')
        .map((l, i) => [l, i + 1] as const)
        .filter(([l]) => /^\s*(?:\|\s*)?(?:curl|wget)\s/.test(l));

      for (const [line, no] of fetches) {
        expect(
          /-o\s|--output/.test(line),
          `${file}:${no} streams a download into another command. Nothing can verify ` +
            `bytes its consumer has already read — write the artifact to a file first.\n` +
            `  ${line.trim()}`,
        ).toBe(true);
      }

      if (fetches.length > 0) {
        expect(
          /sha256sum\s+-c|shasum\s+-a\s+256\s+-c/.test(text),
          `${file} downloads an artifact with curl/wget but never checks a digest. ` +
            `A release tag is a mutable pointer: whoever can change what that URL ` +
            `serves runs code in a job holding the repository and the workflow token.`,
        ).toBe(true);
      }
    });
  }
});
