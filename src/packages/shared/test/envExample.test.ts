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
    if (file.endsWith('config.ts')) {
      for (const m of text.matchAll(/^\s{2}([A-Z][A-Z0-9_]{2,}):\s*z\./gm)) note(m[1]!, rel);
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

  it('finds the variables it is supposed to be checking', () => {
    // A regex that silently stopped matching would make the test above pass
    // for the wrong reason — an empty "missing" list because nothing was
    // scanned at all. These three cover the three idioms.
    const names = new Set(used().keys());
    expect(names.has('STRIPE_WEBHOOK_SECRET')).toBe(true); // Zod schema
    expect(names.has('OPENROUTER_MODEL')).toBe(true); // Python os.environ
    expect(names.has('OTEL_METRICS_ENABLED')).toBe(true); // TS process.env
    expect(names.size).toBeGreaterThan(50);
  });

  it('excludes the mutation-testing tree, whose source is corrupt by design', () => {
    expect([...used().keys()].filter((n) => n.startsWith('XX'))).toEqual([]);
  });
});
