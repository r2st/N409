// No unregistered TODO, FIXME, HACK or XXX anywhere in the tree.
//
// R191 swept the whole repository for them under methodology M9 — every
// TypeScript, TSX, Python, JavaScript, SQL, shell and CSS file across the five
// services, the shared package, the tooling and the infra scripts — and found
// exactly one hit, which is the string `'-- 0164: add the thing\n-- TODO\n'`
// passed to `isEmptyMigration` in a test. In other words: none. There is
// nothing to triage, which is the good outcome and also a fragile one.
//
// Fragile because a marker is the cheapest thing in the world to add and the
// easiest to stop seeing. The failure mode is not the first one — that one is
// deliberate and its author remembers it — it is the thirtieth, by which point
// the set has become scenery and nobody greps it because grepping it returns
// too much. A codebase reaches that state one unremarked comment at a time.
//
// So the rule is not "no TODOs". It is that a deferral is a decision, and a
// decision is written down where the next person will find it:
//
//   * Fix it now, or
//   * register it below with what is deferred, why, and what would settle it.
//
// A marker that is neither fails this test. The register is the artefact — a
// list of five real deferrals with owners and conditions is a healthy thing;
// three hundred anonymous `// TODO` comments are not, and no amount of good
// intent turns the second into the first.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

/**
 * Registered deferrals, keyed `<repo-relative path>\t<marker>`.
 *
 * Each value has to say three things: what is deferred, why it is not being
 * done now, and what would settle it. An entry that cannot answer the third is
 * not a deferral, it is an opinion — and it should either be fixed or the
 * comment should be rewritten as an ordinary note about the code.
 *
 * Empty today. That is not the point of it; the point is that the next marker
 * either gets fixed or gets a line here, rather than joining a pile.
 */
const REGISTERED: Record<string, string> = {};

/**
 * Directories a source sweep must not walk.
 *
 * `mutants` is the mutation-testing tree — deliberately corrupted copies of the
 * engine, so anything found there says nothing about the code we ship. The
 * rest are build output, other people's code, and virtualenvs.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.venv',
  '.git',
  'mutants',
  '.pytest_cache',
  '__pycache__',
  'test-results',
  '.artifacts',
]);

const EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py|sql|css|sh)$/;

/** Every source file under `dir` that a deployed process or its tests read. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(full);
    return EXTENSIONS.test(entry.name) ? [full] : [];
  });
}

const ROOTS = ['src', 'tools', 'infra', 'e2e'].filter((d) => {
  try {
    return statSync(path.join(repoRoot, d)).isDirectory();
  } catch {
    return false;
  }
});

const FILES = ROOTS.flatMap((root) => walk(path.join(repoRoot, root)));

/**
 * A marker is only a marker when it is *addressed to a maintainer*, which in
 * practice means it sits in a comment.
 *
 * The distinction is not pedantry. `isEmptyMigration('-- TODO\n')` in a test is
 * an input to an assertion, and `/\bTODO\b/` on the file is what turns that
 * into a false positive — one that has to be either allowlisted (weakening the
 * guard on a whole file) or lived with (training everyone to ignore the
 * result). Reading the comment prefix keeps the census about comments.
 */
const COMMENT = /^\s*(\/\/|\/\*|\*|#|--)/;
const MARKER = /\b(TODO|FIXME|HACK|XXX)\b/;

interface Hit {
  key: string;
  file: string;
  line: number;
  marker: string;
  text: string;
}

/**
 * This file, which has to be able to name the markers it forbids.
 *
 * The only exclusion, and it is the narrow kind: a rule stated in prose has to
 * spell the words it is about. Everything else in the tree is swept, this file
 * included for every other purpose — it simply cannot be its own subject.
 */
const SELF = path
  .relative(repoRoot, fileURLToPath(import.meta.url))
  .split(path.sep)
  .join('/');

const HITS: Hit[] = FILES.flatMap((full) => {
  const file = path.relative(repoRoot, full).split(path.sep).join('/');
  if (file === SELF) return [];
  return readFileSync(full, 'utf8')
    .split('\n')
    .flatMap((text, i) => {
      if (!COMMENT.test(text)) return [];
      const m = MARKER.exec(text);
      if (!m) return [];
      return [{ key: `${file}\t${m[1]}`, file, line: i + 1, marker: m[1]!, text: text.trim() }];
    });
});

describe('every deferral marker is a registered decision', () => {
  it('sweeps a tree big enough to be the tree', () => {
    // Guards the guard. A walker that stopped descending — a renamed root, a
    // skip list that grew a wildcard — would report a clean repository by
    // having looked at nothing, which is the one way this test can lie.
    expect(FILES.length).toBeGreaterThan(500);
    expect(ROOTS).toContain('src');
  });

  it('finds no marker that nobody decided about', () => {
    const unregistered = HITS.filter((h) => !(h.key in REGISTERED)).map(
      (h) => `${h.file}:${h.line} — ${h.text}`,
    );
    expect(
      unregistered,
      'fix it, or register it with what is deferred, why, and what would settle it',
    ).toEqual([]);
  });

  it('carries no register entry for a marker that has been dealt with', () => {
    const live = new Set(HITS.map((h) => h.key));
    const stale = Object.keys(REGISTERED).filter((key) => !live.has(key));
    expect(stale, 'these markers are gone; drop their entries').toEqual([]);
  });

  it('makes every registered deferral answer what would settle it', () => {
    const thin = Object.entries(REGISTERED)
      .filter(([, reason]) => reason.trim().length < 40)
      .map(([key]) => key);
    expect(thin, 'a deferral that cannot say what would settle it is not a deferral').toEqual([]);
  });
});
