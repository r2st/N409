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

/**
 * The files a manifest is answerable for — its own tree, minus any nested
 * workspace.
 *
 * Only `'.'` is affected, and it is affected in both directions. The repo root
 * is a package like the others: it declares dependencies, and `tools/`, `e2e/`,
 * `infra/` and `eslint.config.js` import them. But `filesUnder(repoRoot)`
 * descends into `src/`, so scanning the root with it asks the wrong question
 * twice over. Reading imports, every workspace's imports would be charged to
 * the root manifest. Reading references, any mention *anywhere in the repo*
 * counts, so "the root declares nothing it does not use" passed by construction
 * — the vacuous half of a check that reads as covered.
 *
 * Excluding the workspace directories rather than `src/` wholesale keeps a
 * future non-workspace tree under `src/` attributed to the root instead of to
 * nobody.
 */
function ownedFilesUnder(ws: string): string[] {
  const files = filesUnder(path.join(repoRoot, ws));
  if (ws !== '.') return files;
  const nested = WORKSPACES.map((w) => path.join(repoRoot, w) + path.sep);
  return files.filter((f) => !nested.some((n) => f.startsWith(n)));
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

  // The root is in this list because it was the one package exempt from it.
  // `tools/`, `e2e/` and `infra/` are root-owned source that imports packages
  // like any workspace does, and five of those files imported `pg` while the
  // root manifest declared nothing at all. It resolved because `@n409/valuation`
  // and `@n409/web` declare `pg` and npm hoists it — so `npm run e2e` and
  // `tools/seed-samples.mjs` ran whatever version *valuation's* range chose,
  // which is exactly the arrangement the rest of this file exists to refuse.
  for (const ws of ['.', ...WORKSPACES]) {
    it(`${ws === '.' ? 'repo root' : ws}`, () => {
      const declared = declaredIn(manifest(ws));
      const undeclared = new Map<string, string>();

      for (const file of ownedFilesUnder(ws)) {
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
        `${ws === '.' ? 'the repo root' : ws} imports these but declares none of them. They resolve today only because ` +
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
      const text = ownedFilesUnder(ws)
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

/**
 * `tools/`, which runs inside the services' venvs but lives in neither.
 *
 * `tools/check_installed_deps.py` is the preflight `infra/deploy.sh` blocks on,
 * and it is run as `.venv/bin/python tools/check_installed_deps.py` — with the
 * *service's* interpreter, because its whole job is to read the distributions
 * installed there. Its imports are therefore requirements of every service venv
 * it is pointed at, and the census above could not see that: it walks `app/`
 * and `tests/` under each service, and this file is under neither.
 *
 * What hid there was `packaging`. The tool needs it to compare a PEP 440
 * version against a PEP 508 specifier — the docstring says so, and says why
 * string comparison is not a substitute — and it reached the tool only because
 * pytest depends on it. pytest is a dev dependency; the deploy host gets
 * `pip install -r requirements.txt` and nothing else. Resolving either runtime
 * file on its own brings 17 and 34 distributions respectively, and `packaging`
 * is not one of them. The tool fails closed, so the cost was not a skipped
 * check: it was every deploy to a freshly built host dying at preflight under a
 * message about the venv not satisfying requirements.txt.
 *
 * Checked against *runtime* requirements, both services, deliberately. A
 * dev-only declaration would be satisfied on a developer's machine and on CI
 * and absent on exactly the host this gate exists to protect.
 */
describe('tools/ declares what it imports in every venv it runs in', () => {
  const toolsDir = path.join(repoRoot, 'tools');

  for (const svc of PY_SERVICES) {
    it(`${svc}/requirements.txt`, () => {
      const declared = requirementNames(path.join(repoRoot, svc, 'requirements.txt'));
      const local = new Set(
        readdirSync(toolsDir, { withFileTypes: true }).map((e) => e.name.replace(/\.py$/, '')),
      );

      const undeclared = new Map<string, string>();
      for (const file of filesUnder(toolsDir)) {
        if (!file.endsWith('.py')) continue;
        for (const mod of pyImports(readFileSync(file, 'utf8'))) {
          if (PY_STDLIB.has(mod) || local.has(mod)) continue;
          const dist = (PY_IMPORT_TO_DIST[mod] ?? mod).toLowerCase();
          if (declared.has(dist)) continue;
          if (!undeclared.has(mod)) undeclared.set(mod, path.relative(repoRoot, file));
        }
      }

      expect(
        [...undeclared].map(([mod, where]) => `${mod} (imported by ${where})`),
        `tools/ runs under ${svc}'s venv and imports these, and ${svc}/requirements.txt ` +
          `declares none of them. The deploy host installs that file and nothing else, ` +
          `so whatever is missing is missing exactly where the deploy gate runs.`,
      ).toEqual([]);
    });
  }
});

/**
 * Requirement lines as `name` -> the whole normalised spec (`pydantic>=2.9`).
 *
 * Same parse as {@link requirementNames}, kept separate because the comparison
 * below is about the *floors* as well as the names: two lists naming the same
 * distributions at different versions is the drift this catches.
 */
function requirementSpecs(file: string): Map<string, string> {
  const specs = new Map<string, string>();
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.split('#')[0]!.trim();
    // `-r requirements.txt` — an include, not a requirement. The caller decides
    // whether to follow it.
    if (!line || line.startsWith('-')) continue;
    const name = line
      .split(/[<>=!~;[ ]/)[0]!
      .trim()
      .toLowerCase();
    if (name) specs.set(name, line.replace(/\s+/g, '').toLowerCase());
  }
  return specs;
}

/**
 * A `name = [ "a>=1", "b>=2" ]` array of strings out of a pyproject.
 *
 * Deliberately not a TOML parser: the two files this reads are ours, the two
 * tables it wants are flat arrays of requirement strings, and a real parser
 * would be a dependency added by a test whose subject is dependencies. It
 * throws rather than returning empty when the shape is not what it expects, so
 * a rewrite that moves these tables fails loudly here instead of passing by
 * finding nothing.
 */
function tomlStringArray(text: string, key: string): string[] {
  const start = new RegExp(`^${key}\\s*=\\s*\\[`, 'm').exec(text);
  if (!start) throw new Error(`pyproject has no \`${key} = [\` array`);
  const from = start.index + start[0].length;
  const end = text.indexOf(']', from);
  if (end < 0) throw new Error(`\`${key}\` array is never closed`);
  const body = text.slice(from, end).replace(/#[^\n]*/g, '');
  return [...body.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!.replace(/\s+/g, '').toLowerCase());
}

/**
 * `pyproject.toml` against the requirements files, per service.
 *
 * Nothing installs from `pyproject.toml` — the Dockerfiles, CI's python job and
 * infra/deploy.sh all run `pip install -r requirements.txt`, and
 * `tools/check_installed_deps.py` checks the deployed venv against that same
 * file. But pytest reads `[tool.pytest.ini_options]` out of it, so the file is
 * live and looks maintained, and its `[project] dependencies` reads as a
 * statement of what the service accepts. `pip install .` and `uv sync` believe
 * it.
 *
 * Maintained by hand, one of the two lists is eventually the stale one, and
 * both were: engine-wrapper's still filed yfinance under an optional `[market]`
 * extra whose comment claimed the service runs fine without it, several rounds
 * after requirements.txt made it mandatory for the opposite reason; ai's
 * carried R195's pypdf floor but not the pydantic/starlette/anyio floors added
 * beside it.
 *
 * `[project.optional-dependencies]` is out of scope by design — an extra is
 * exactly the thing a plain install does *not* get, so it has no counterpart in
 * requirements.txt to agree with.
 */
describe('pyproject.toml agrees with the requirements files that actually install', () => {
  for (const svc of PY_SERVICES) {
    const dir = path.join(repoRoot, svc);
    const toml = readFileSync(path.join(dir, 'pyproject.toml'), 'utf8');

    it(`${svc} runtime dependencies`, () => {
      const declared = tomlStringArray(toml, 'dependencies');
      const installed = [...requirementSpecs(path.join(dir, 'requirements.txt')).values()];
      expect(
        [...declared].sort(),
        `${svc}/pyproject.toml and ${svc}/requirements.txt name different runtime ` +
          `dependencies, or the same ones at different floors. requirements.txt is ` +
          `what every real install uses; pyproject.toml is what \`pip install .\` and ` +
          `\`uv sync\` use. Whichever is wrong, a developer's environment and CI's ` +
          `stop being the same environment.`,
      ).toEqual([...installed].sort());
    });

    it(`${svc} dev dependencies`, () => {
      const declared = tomlStringArray(toml, 'dev');
      // requirements-dev.txt opens with `-r requirements.txt`; requirementSpecs
      // drops the include, so what is left is the dev-only half — which is
      // exactly what `[dependency-groups] dev` is.
      const installed = [...requirementSpecs(path.join(dir, 'requirements-dev.txt')).values()];
      expect(
        [...declared].sort(),
        `${svc}/pyproject.toml's dev group and ${svc}/requirements-dev.txt disagree. ` +
          `CI installs the latter; a contributor following the pyproject gets the ` +
          `former, and finds out which tools are missing one failure at a time.`,
      ).toEqual([...installed].sort());
    });
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
  deprecated?: string;
  dev?: boolean;
  devOptional?: boolean;
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
 * Declared packages that legitimately resolve to more than one version.
 *
 * A duplicate is normally harmless — npm nests a second copy and both callers
 * get what they asked for. It stops being harmless when the two copies are
 * meant to be one thing: a shared registry, a shared module-load hook, an
 * `instanceof` across the seam. So the list is kept, and each entry says why
 * its split does not matter.
 */
const DUPLICATE_VERSIONS_ALLOWED: Record<string, string> = {
  '@types/pg':
    '`@opentelemetry/instrumentation-pg` pins an exact `@types/pg` for its own ' +
    'compilation. Types are erased; nothing of it reaches the running tree.',
  'p-limit':
    'an old 2.x nested under a transitive chain. Two concurrency limiters are ' +
    'two independent limiters, which is what each caller wanted anyway.',
};

describe('the lockfile resolves one version per package where a split would matter', () => {
  /** name -> every version the lockfile resolves it to. */
  function versionsByName(): Map<string, Set<string>> {
    const byName = new Map<string, Set<string>>();
    for (const [p, e] of Object.entries(lockfile())) {
      const at = p.lastIndexOf('node_modules/');
      if (at < 0 || !e.version) continue;
      const name = p.slice(at + 'node_modules/'.length);
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name)!.add(e.version);
    }
    return byName;
  }

  /**
   * OpenTelemetry ships as one versioned set — the SDK, the instrumentation
   * core and every instrumentation are released together and expect to be
   * installed together. `otel.ts` builds a `PgInstrumentation` and hands it to
   * `registerInstrumentations`; if those two came from different copies of
   * `@opentelemetry/instrumentation`, the object is crossing a seam between two
   * versions of the class it extends, and both halves still typecheck.
   *
   * They did. `@opentelemetry/instrumentation-pg` was declared `^0.65.0` while
   * the rest of the stack was on 0.221.0, and because a caret cannot cross a
   * minor in 0.x, that range was frozen eight lines back and pulled its own
   * nested `@opentelemetry/instrumentation@0.213.0` in beside the 0.221.0 the
   * SDK drove. Nothing else in this file could see it: the advisory scanners
   * had nothing to report, every package was declared, and both versions were
   * pinned with integrity.
   */
  it('every @opentelemetry package resolves to exactly one version', () => {
    const split = [...versionsByName()]
      .filter(([name]) => name.startsWith('@opentelemetry/'))
      .filter(([, versions]) => versions.size > 1)
      .map(([name, versions]) => `${name} @ ${[...versions].sort().join(', ')}`);
    expect(
      split,
      'a second copy of an OpenTelemetry package means one instrumentation is ' +
        'registering through a different core than the SDK drives. Bring the ' +
        'declared range in @n409/shared up to the line the rest of the stack is on.',
    ).toEqual([]);
  });

  /**
   * Splits inside the shipped closure that have been read and kept.
   *
   * Separate from DUPLICATE_VERSIONS_ALLOWED because the question is different.
   * That list answers "we chose a range and something else is running a version
   * we did not choose"; this one answers "two copies of the same code are in the
   * deployed tree", which is true of packages no manifest of ours has ever
   * named. The reasons are not interchangeable, so the lists are not either.
   *
   * Reviewed as of R286.
   */
  const SHIPPED_DUPLICATES_REVIEWED: Record<string, string> = {
    '@types/pg': 'types are erased; no copy of this reaches the running tree.',
    'p-limit':
      'two concurrency limiters are two independent limiters, which is what ' +
      'each caller wanted. qrcode nests the 2.x under its CLI.',
    // qrcode ships a command-line front end and its whole argument-parsing
    // stack with it. We import the library API; none of this is reached.
    cliui: "qrcode's bundled CLI. We call the library, never the command.",
    'wrap-ansi': "qrcode's bundled CLI. We call the library, never the command.",
    y18n: "qrcode's bundled CLI. We call the library, never the command.",
    yargs: "qrcode's bundled CLI. We call the library, never the command.",
    'yargs-parser': "qrcode's bundled CLI. We call the library, never the command.",
    'base64-js':
      'pdfkit -> linebreak nests a 0.0.x. Both copies are pure encoders called ' +
      'on bytes; no value produced by one is read by the other.',
    cookie:
      "fastify's light-my-request and react-router both take 1.x; @fastify/cookie " +
      'takes 2.x. Three independent parse/serialize sites — a cookie is a string ' +
      'at every boundary between them, never an object one copy hands another.',
    'fastify-plugin':
      'a per-plugin metadata wrapper, carried by each plugin rather than shared. ' +
      '@fastify/multipart and @fastify/reply-from are still on 5.x; fastify 5 ' +
      'reads the metadata of both.',
    'process-warning':
      'each copy keeps its own registry of emitted codes, so the worst a split ' +
      'costs is one warning printed twice.',
    xmlbuilder:
      'xml2js serialises with its own 11.x; @node-saml/node-saml builds the ' +
      'AuthnRequest with 15.x. Two writers, one direction, no shared state.',
    // The one on this list that is a judgement rather than an observation.
    //
    // Three XPath engines are in the SAML path at once: xml-encryption pins
    // 0.0.32 *exactly*, xml-crypto ranges at ^0.0.33, and @node-saml/node-saml
    // brings 0.0.34 for its own selections. Each library evaluates its own
    // expressions with its own copy, so nothing crosses a boundary the way
    // `PgInstrumentation` crossed the OpenTelemetry seam — but node-saml
    // *verifies* through xml-crypto's copy and then *reads* the assertion
    // through its own, and those two engines are 410 changed lines apart.
    //
    // Left split deliberately. Unifying means overriding an exact pin inside
    // xml-encryption with an engine that differs across 40 hunks of node
    // selection, on the decryption path for encrypted assertions, which nothing
    // in this repo's suite exercises. That is a larger and riskier change than
    // the one it would prevent, and it is not a dependency-hygiene edit. If a
    // signature-wrapping question is ever asked of this service, start here.
    xpath:
      'three engines in the SAML path (xml-encryption 0.0.32 exact, xml-crypto ' +
      '^0.0.33, node-saml 0.0.34). Each library evaluates only its own ' +
      'expressions. See the note above before widening or unifying.',
  };

  /**
   * The lockfile's own answer to "would `npm ci --omit=dev` install this?".
   *
   * The case below is about the deployed tree, and the tree is mostly not that:
   * of 574 resolutions, 234 ship. Reading the split over all of them buries the
   * ones that matter under eslint's, babel's and vitest's, and a list nobody can
   * read is a list nobody reviews.
   */
  function shipped(e: LockEntry): boolean {
    return !e.dev && !e.devOptional;
  }

  /**
   * The general case the OpenTelemetry one above is a single instance of.
   *
   * That case was written for one family because that is where the bug was
   * found: an instrumentation registering through a different copy of the
   * instrumentation core than the SDK drove, with both halves typechecking. The
   * defect is not specific to OpenTelemetry — it is what two copies of one
   * package in one running process can always do — and every other instance of
   * it in the shipped tree had no case at all. Fourteen were sitting there.
   *
   * Scoped to the shipped closure rather than to packages we declare, because a
   * split that matters at run time does not care whether we were the ones who
   * named the package.
   */
  it('a package in the shipped closure resolves to one version', () => {
    const byName = new Map<string, Set<string>>();
    for (const [p, e] of Object.entries(lockfile())) {
      const at = p.lastIndexOf('node_modules/');
      if (at < 0 || !e.version || !shipped(e)) continue;
      const name = p.slice(at + 'node_modules/'.length);
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name)!.add(e.version);
    }

    const split = [...byName]
      .filter(([name]) => !(name in SHIPPED_DUPLICATES_REVIEWED))
      .filter(([, versions]) => versions.size > 1)
      .map(([name, versions]) => `${name} @ ${[...versions].sort().join(', ')}`)
      .sort();

    expect(
      split,
      'the deployed tree contains two copies of this package, so two versions of ' +
        'it are live in one process. That is benign when each copy only talks to ' +
        'itself and a defect when a value produced by one is read by the other — ' +
        'which is what `@opentelemetry/instrumentation-pg` did, and it typechecked. ' +
        'Read which one it is, then either bring the copies together or add it to ' +
        'SHIPPED_DUPLICATES_REVIEWED with the reason the split is safe.',
    ).toEqual([]);
  });

  it('a package one of our manifests declares resolves to one version', () => {
    const declared = new Set<string>();
    for (const ws of ['.', ...WORKSPACES]) for (const d of declaredIn(manifest(ws))) declared.add(d);

    const split = [...versionsByName()]
      .filter(([name]) => declared.has(name) && !(name in DUPLICATE_VERSIONS_ALLOWED))
      .filter(([, versions]) => versions.size > 1)
      .map(([name, versions]) => `${name} @ ${[...versions].sort().join(', ')}`);
    expect(
      split,
      'we declare a range for this package, and the tree contains a copy that is ' +
        'not it — so some code imports a version nothing of ours chose. Either ' +
        'move our range onto the other version, or add it to ' +
        'DUPLICATE_VERSIONS_ALLOWED with the reason the split is safe.',
    ).toEqual([]);
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

/**
 * Every package in the tree whose author has published a deprecation.
 *
 * Reviewed as of R263. A deprecation is the one supply-chain signal that
 * arrives without a version number attached: nothing in the lockfile changes,
 * `npm audit` stays green because there is no advisory, and the package simply
 * stops getting fixed. `pdfkit@0.17` reached the tree through `jpeg-exif`
 * ("Package no longer supported"), which is what parsed the bytes of a partner's
 * uploaded logo in the service that renders the client's deliverable. Nothing
 * here reported it; it was found by reading the lockfile by hand.
 *
 * Both survivors are transitive, dev-only, and have no fixed version to move to
 * — the direct dependency above each is already current.
 *
 * Note what this case cannot see, and where the other half lives. npm writes
 * `deprecated` into the lockfile when it *resolves* a version, so a notice
 * published after we locked leaves the field absent — nothing in the lockfile
 * changes when a maintainer deprecates, which is the whole difficulty. This
 * case therefore only reports deprecations that were already published when the
 * entry was written. `tools/check-deprecations.mjs`, run by CI beside
 * `npm audit`, asks the registry what it says today; that is what found
 * `@xmldom/xmldom@0.8.13` sitting on the SAML response-parsing path with this
 * case green. Keep the two allowlists in step.
 */
const DEPRECATED_ALLOWED: Record<string, string> = {
  'node_modules/test-exclude/node_modules/glob':
    'nested under @vitest/coverage-v8 -> test-exclude, which pins glob 10. Runs ' +
    'only while collecting coverage.',
  'node_modules/whatwg-encoding':
    "jsdom's HTML decoder. The deprecation points at a replacement jsdom has " +
    'not adopted; jsdom itself is a dev dependency of web-frontend only.',
};

describe('deprecated packages', () => {
  /**
   * Compared as a whole set rather than as "nothing outside the allowlist", on
   * purpose. `deprecated` is written into the lockfile by npm at install time,
   * so a regeneration under a client that stopped recording it would empty the
   * field entirely — and a test phrased as "no unexpected deprecations" would
   * go green at exactly the moment it stopped being able to see any.
   */
  it('only the reviewed packages carry a deprecation notice', () => {
    const deprecated = Object.entries(lockfile())
      .filter(([, e]) => e.deprecated)
      .map(([name]) => name)
      .sort();
    expect(
      deprecated,
      'a package in the tree is deprecated — its author has said it will not be ' +
        'fixed again, and no advisory scan will ever say so. If it is reachable ' +
        'from one of our manifests, move off it; if it is transitive with nothing ' +
        'to move to, add it here with that reasoning. If this list came back ' +
        'empty, the lockfile was regenerated by something that does not record ' +
        'deprecations and this check has stopped working.',
    ).toEqual([...Object.keys(DEPRECATED_ALLOWED)].sort());
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

/**
 * Third-party code CI runs, addressed by a pointer somebody else can move.
 *
 * The digest case above refuses a `curl` whose bytes nothing verifies, on the
 * grounds that "a release tag is a mutable pointer: whoever can change what
 * that URL serves runs code in a job holding the repository and the workflow
 * token". Every `uses:` line was exempt from that reasoning while being the
 * larger instance of it — `actions/checkout@v4` is not a version, it is a
 * branch-shaped label the publisher force-pushes on every v4.x release, and a
 * compromised or coerced publisher moves it to whatever they like. There is no
 * lockfile for actions and no `--frozen` mode; the SHA in the ref *is* the
 * lockfile.
 *
 * The risk is not uniform and the rule is still uniform, deliberately. Two of
 * these jobs hold `security-events: write` (CodeQL) and one runs Terraform
 * against real state, so the blast radius of the third-party action
 * (`hashicorp/setup-terraform`) is the worst of the set — but `actions/*` being
 * GitHub-owned buys availability, not immutability, and tj-actions/changed-files
 * was a GitHub-Marketplace action whose tags were rewritten across every
 * version at once. Allowing "trusted publisher" here would mean maintaining a
 * trust list, and the exemption would be the thing that rots.
 *
 * A pin is only as good as the comment beside it: the SHA says what runs and
 * the `# vX.Y.Z` says what it was when a human last looked. Renovate/Dependabot
 * both read that pair and keep it in step.
 */
describe('CI pins the actions it runs to an immutable ref', () => {
  const workflowDir = path.join(repoRoot, '.github/workflows');
  const FULL_SHA = /^[0-9a-f]{40}$/;

  for (const file of readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))) {
    it(file, () => {
      const lines = readFileSync(path.join(workflowDir, file), 'utf8').split('\n');
      const unpinned: string[] = [];
      const uncommented: string[] = [];

      for (const [i, line] of lines.entries()) {
        const m = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line);
        if (!m) continue;
        const ref = m[1]!;
        // A local action (`./.github/actions/x`) is this repository's own code
        // at this commit; there is no third party and nothing to pin to.
        if (ref.startsWith('./') || ref.startsWith('docker://')) continue;

        const at = ref.lastIndexOf('@');
        const rev = at === -1 ? '' : ref.slice(at + 1);
        if (!FULL_SHA.test(rev)) {
          unpinned.push(`${file}:${i + 1} ${ref}`);
          continue;
        }
        if (!/#\s*v?\d+\.\d+\.\d+/.test(line)) uncommented.push(`${file}:${i + 1} ${ref}`);
      }

      expect(
        unpinned,
        `${file} runs an action at a tag or branch. That ref is mutable: the publisher ` +
          `(or anyone who compromises them) can repoint it at new code, which then runs ` +
          `in a job holding this repository's checkout and workflow token — no diff here, ` +
          `no review, no lockfile entry. Pin the full 40-character commit SHA.`,
      ).toEqual([]);

      expect(
        uncommented,
        `${file} pins a SHA with no version comment. The pin is then unreadable and ` +
          `unmaintainable — nobody can tell how stale it is, and Dependabot/Renovate ` +
          `key their updates off the trailing \`# vX.Y.Z\`. Add it.`,
      ).toEqual([]);
    });
  }
});
