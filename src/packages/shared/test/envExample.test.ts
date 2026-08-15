// Every environment variable the services read must appear in .env.example.
//
// The failure this guards is quiet and expensive: a feature ships reading a new
// variable, .env.example is not touched, and the variable is simply absent from
// every deployment. Nothing errors — the code has a default, or treats unset as
// "feature off" — so the integration is just silently not configured, and the
// way it surfaces is somebody asking why Stripe webhooks never arrive.
//
// That is not hypothetical: this test was written after an audit found 43 such
// variables, among them both Stripe webhook secrets and all six accounting
// OAuth pairs.
//
// .env.example is therefore treated as the deployment contract rather than as
// documentation. A variable may of course be optional — most are — but its
// existence has to be discoverable by reading one file.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

/** Variable names with a `KEY=` line in .env.example, commented lines ignored. */
function documented(): Set<string> {
  const text = readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
  return new Set([...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));
}

/**
 * Source files that run in a deployed process.
 *
 * Deliberately excludes:
 *   - `dist` and `node_modules`, which are build output and other people's code;
 *   - `test` directories, whose variables (TEST_DATABASE_URL) configure a test
 *     run rather than a deployment;
 *   - `mutants`, the mutation-testing tree, whose whole point is deliberately
 *     corrupted source — it contains names like XXLOG_LEVELXX;
 *   - the root dev scripts, which are run by hand and take their arguments
 *     from the environment as a convenience (OUT, ALLOCATION).
 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'coverage', '.venv', 'test', 'tests', 'mutants'].includes(entry.name)) {
        continue;
      }
      sourceFiles(full, out);
    } else if (/\.(ts|tsx|py)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Every variable name read from the environment, by any of the three idioms. */
function used(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const note = (name: string, file: string) => {
    const at = found.get(name) ?? [];
    if (!at.includes(file)) at.push(file);
    found.set(name, at);
  };

  for (const file of [
    ...sourceFiles(path.join(repoRoot, 'src/services')),
    ...sourceFiles(path.join(repoRoot, 'src/packages')),
  ]) {
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(repoRoot, file);
    // TypeScript: process.env.FOO
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) note(m[1]!, rel);
    // Python: os.environ.get("FOO") / os.environ["FOO"], either quote style
    for (const m of text.matchAll(/environ(?:\.get\(|\[)["']([A-Z][A-Z0-9_]{2,})["']/g)) {
      note(m[1]!, rel);
    }
    // The valuation service's Zod env schema: `  FOO: z.…`
    //
    // Matches `z` as a word rather than `z.` because prettier breaks a long
    // declaration after the `z`, putting the first call on the next line:
    //
    //     VIRUS_SCAN_FAIL_CLOSED: z
    //       .enum(['true', 'false'])
    //
    // Requiring the dot therefore made this check blind to exactly the
    // variables with the most configuration behind them — the long ones. Two
    // had already slipped through when this was widened, one of them
    // undocumented. `\b` still refuses `zip`/`zod`, which is the reason it is
    // not just `z`.
    if (file.endsWith('config.ts')) {
      for (const m of text.matchAll(/^\s{2}([A-Z][A-Z0-9_]{2,}):\s*z\b/gm)) note(m[1]!, rel);
    }

    // ── Indirect reads ────────────────────────────────────────────────────
    //
    // The three idioms above all name the variable next to the call that reads
    // it. Plenty of this codebase does not, and every one of those was
    // invisible here — ten variables were undocumented behind these four
    // shapes, including both Bedrock ceilings and all seven marketing links on
    // the public site, whose failure mode is a silently missing button.

    // Python numeric helpers: env_int("FOO", 4) / env_float("FOO", 1.5)
    for (const m of text.matchAll(/\benv_(?:int|float|str|bool)\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g)) {
      note(m[1]!, rel);
    }
    // A module constant holding the name: SEARXNG_URL_VAR = "SEARXNG_URL"
    for (const m of text.matchAll(/^[A-Z][A-Z0-9_]*_VAR\s*=\s*["']([A-Z][A-Z0-9_]{2,})["']/gm)) {
      note(m[1]!, rel);
    }
    // A lookup table from provider name to key name (websearch.py PROVIDER_KEYS).
    if (file.endsWith('websearch.py')) {
      for (const m of text.matchAll(/^\s+["'][a-z]+["']:\s*["']([A-Z][A-Z0-9_]{2,})["'],/gm)) {
        note(m[1]!, rel);
      }
    }
    // The feature flag registry (flags.ts), which reads `env[spec.env]` — the
    // variable name lives in the spec, not next to the lookup, so none of the
    // idioms above can see it. Matched on the `env:` field of a FlagSpec.
    //
    // Without this the flags are invisible in *both* directions: a new flag
    // could ship undocumented, and the three that are documented would look
    // like variables nothing reads, which is what the second test below
    // exists to catch.
    if (file.endsWith('flags.ts')) {
      for (const m of text.matchAll(/^\s+env:\s*['"]([A-Z][A-Z0-9_]{2,})['"]/gm)) note(m[1]!, rel);
    }
    // The Vite build's client-visible list, which reads `env[name]` in a loop.
    if (file.endsWith('vite.config.ts')) {
      const start = text.indexOf('const names = [');
      if (start !== -1) {
        for (const m of text
          .slice(start, text.indexOf('];', start))
          .matchAll(/["']([A-Z][A-Z0-9_]{2,})["']/g)) {
          note(m[1]!, rel);
        }
      }
    }
  }
  return found;
}

describe('.env.example is the deployment contract', () => {
  it('documents every variable the services read', () => {
    const have = documented();
    const missing = [...used().entries()]
      .filter(([name]) => !have.has(name))
      // PATH and the like are the operating system's, not this application's.
      .filter(([name]) => !['PATH', 'HOME', 'TZ', 'PWD'].includes(name));

    expect(
      missing.map(([name, files]) => `${name} (read in ${files[0]})`),
      'variables read by the services but absent from .env.example',
    ).toEqual([]);
  });

  it('documents nothing the services no longer read', () => {
    // The other direction, and the one an operator pays for: a variable left in
    // this file after the code that read it went away is an instruction to
    // configure something that does nothing. The research-provider rework is
    // exactly the shape that leaves them behind — a removed provider's key is
    // still a plausible-looking line in a file nobody re-reads.
    //
    // Scoped to the deployed services, so a name that only `tools/` or `e2e/`
    // reads would fail this — which is correct: `.env.example` is the
    // deployment contract, and a dev-script variable does not belong in it.
    const read = new Set(used().keys());
    const stale = [...documented()].filter((name) => !read.has(name));

    expect(stale, 'variables in .env.example that no deployed code reads').toEqual([]);
  });

  it('finds the variables it is supposed to be checking', () => {
    // A regex that silently stopped matching would make the tests above pass
    // for the wrong reason — an empty "missing" list because nothing was
    // scanned at all. One name per idiom, so a broken pattern names itself.
    const names = new Set(used().keys());
    expect(names.has('STRIPE_WEBHOOK_SECRET')).toBe(true); // Zod schema
    expect(names.has('OPENROUTER_MODEL')).toBe(true); // Python os.environ
    expect(names.has('OTEL_METRICS_ENABLED')).toBe(true); // TS process.env
    // A Zod declaration prettier wrapped after the `z`. Named explicitly
    // because the one-line form of this regex missed the whole idiom, and the
    // count assertion below is far too coarse to notice two absentees.
    expect(names.has('VIRUS_SCAN_FAIL_CLOSED')).toBe(true);
    expect(names.has('BEDROCK_MAX_TOKENS')).toBe(true); // Python env_int helper
    expect(names.has('SEARXNG_URL')).toBe(true); // name held in a _VAR constant
    expect(names.has('TAVILY_API_KEY')).toBe(true); // provider lookup table
    expect(names.has('CALENDLY_URL')).toBe(true); // Vite clientEnv list
    expect(names.size).toBeGreaterThan(50);
  });

  it('excludes the mutation-testing tree, whose source is corrupt by design', () => {
    expect([...used().keys()].filter((n) => n.startsWith('XX'))).toEqual([]);
  });
});
