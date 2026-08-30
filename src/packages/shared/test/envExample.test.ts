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
    // The injected-environment form: `env.FOO`, where `env` is a parameter.
    //
    // Not a stylistic variant. The functions that have to be
    // testable without mutating the real environment take it as a parameter —
    // `resolvePoolTuning(url, env)`, `trustedProxies(env)`, `listenHost(env)`,
    // all defaulting to `process.env` — and `process.env` then appears once, in
    // a default argument, nowhere near the name being read. Eight variables
    // were invisible here for that reason: the six `DB_*` pool and TLS knobs,
    // `HOST`, and `TRUSTED_PROXIES` — the last of which decides whose address
    // every per-IP rate limit and audit row is keyed on, and which an operator
    // wiring up the Cloudflare edge had no way to discover.
    //
    // A `VITE_`-prefixed name is excluded here because in this position it is
    // always Vite's build-time substitution rather than the process
    // environment — the frontend destructures `import.meta.env` and reads
    // `env.VITE_GA4_ID` off it. The deployment variable behind that is `GA4_ID`,
    // which vite.config.ts's own idiom below reports. The one place a
    // `VITE_`-prefixed name *is* read from the process environment,
    // `process.env.VITE_SITE_URL` in vite.config.ts, is matched by the pattern
    // above and unaffected.
    for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})/g)) {
      if (!m[1]!.startsWith('VITE_')) note(m[1]!, rel);
    }
    // Python: os.environ.get("FOO") / os.environ["FOO"], either quote style
    for (const m of text.matchAll(/environ(?:\.get\(|\[)["']([A-Z][A-Z0-9_]{2,})["']/g)) {
      note(m[1]!, rel);
    }
    // The valuation service's env schema: a key of the `Env` object.
    //
    // Matched on the key rather than on what follows it, because what follows
    // it is not always `z`. Eight declarations use a helper — `atRestKey()` for
    // the six at-rest keys, `portParam()` for `PORT` and `SMTP_PORT` — and a
    // pattern anchored to `z\b` saw none of them. The six survived only because
    // `keyRing` below happens to name four of them a file away; `PORT` and
    // `SMTP_PORT` had nothing, so factoring the port rule into a helper made
    // two documented variables look like variables nothing reads.
    //
    // That is the failure this file exists to prevent, arriving through the
    // check itself: extracting a repeated schema is an ordinary refactor, and
    // it must not be able to silently delete a variable from the contract in
    // either direction. A key at this indentation in this file *is* a variable
    // the service reads, whatever spelling declares it — 79 of them today, and
    // the count over the narrow pattern was 71.
    //
    // The indentation is what bounds it: two spaces is a member of the single
    // top-level `Env` object, and nothing else in the file sits there.
    if (file.endsWith('config.ts')) {
      for (const m of text.matchAll(/^\s{2}([A-Z][A-Z0-9_]{2,}):\s*\S/gm)) note(m[1]!, rel);
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
    // The same idiom with the `_ENV` suffix this codebase actually prefers:
    // `export const METRICS_TOKEN_ENV = 'METRICS_TOKEN'`, read later as
    // `env[METRICS_TOKEN_ENV]`. Only `_VAR` was matched, so a variable named
    // this way was invisible in both directions — which is precisely the
    // silent-misconfiguration failure this file exists to prevent, and
    // `METRICS_TOKEN` shipped straight into it: unset everywhere, so the
    // scrape endpoint would simply not be registered in production and the
    // only evidence would be one warn line at boot.
    for (const m of text.matchAll(/^export const [A-Z][A-Z0-9_]*_ENV\s*=\s*["']([A-Z][A-Z0-9_]{2,})["']/gm)) {
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
    // The AI tier's spend ceilings: `TokenLedger("OPENROUTER_TOKEN_BUDGET")`.
    //
    // Both were visible here until the two providers' budget bookkeeping was
    // factored into one class, whose constructor takes the variable name as an
    // argument and reads it a file away. `os.environ.get` then appears once, in
    // `llm_http.py`, next to a parameter rather than a name — so this scan lost
    // sight of both ceilings and reported them as documented variables nothing
    // reads. That is the same failure as the `PORT`/`SMTP_PORT` helper and the
    // key ring above, and it is worth naming again: extracting a repeated read
    // into a helper is an ordinary refactor, and the advice this file would
    // then give — delete them from `.env.example` — would silently uncap the
    // spend on a billed provider.
    for (const m of text.matchAll(/\bTokenLedger\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g)) {
      note(m[1]!, rel);
    }
    // The at-rest key ring: `keyRing(env, KEY_NAMES)` / `keyRing(env, ['FOO'])`.
    //
    // Three subsystems seal something at rest — document blobs, TOTP seeds, and
    // the OAuth tokens and webhook secrets belonging to somebody else — and
    // since the envelope was factored out (round 95) not one of their key names
    // appears next to a read. The name is an element of a `KEY_NAMES` array, or
    // an inline array argument, and `env[name]` happens a file away in
    // `keyRing`. Every idiom above is blind to that, in *both* directions:
    // `MFA_ENCRYPTION_KEY` and `CONNECTION_ENCRYPTION_KEY` were undocumented
    // and invisible, and `DOCUMENTS_ENCRYPTION_KEY` — which had been read as
    // `process.env.DOCUMENTS_ENCRYPTION_KEY` until the refactor — turned into a
    // documented variable that nothing appeared to read, which is what the
    // second test below started failing on.
    //
    // The `_PREVIOUS` partner is noted with it because `keyRing` derives that
    // name rather than being given it: it is read from `env` and can therefore
    // never be seen by a scan for literals, and it is the half an operator most
    // needs the contract to mention — a key that cannot be rotated after it
    // leaks is a key that cannot be rotated when it matters.
    for (const m of text.matchAll(/\bkeyRing\(\s*[A-Za-z_$][\w$]*\s*,\s*(\[[^\]]*\]|[A-Za-z_$][\w$]*)/g)) {
      const arg = m[1]!;
      const list = arg.startsWith('[')
        ? arg
        : // A module constant: `const KEY_NAMES = ['A', 'B'] as const;`
          (text.match(new RegExp(`\\b${arg}\\s*=\\s*(\\[[^\\]]*\\])`))?.[1] ?? '');
      for (const n of list.matchAll(/["']([A-Z][A-Z0-9_]{2,})["']/g)) {
        note(n[1]!, rel);
        note(`${n[1]!}_PREVIOUS`, rel);
      }
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
    expect(names.has('METRICS_TOKEN')).toBe(true); // name held in an _ENV constant
    // The key ring, both halves: a name from a KEY_NAMES array and the
    // `_PREVIOUS` partner keyRing derives rather than is given.
    expect(names.has('CONNECTION_ENCRYPTION_KEY')).toBe(true);
    expect(names.has('MFA_ENCRYPTION_KEY_PREVIOUS')).toBe(true);
    // The inline-array form, `keyRing(env, ['DOCUMENTS_ENCRYPTION_KEY'])`.
    expect(names.has('DOCUMENTS_ENCRYPTION_KEY')).toBe(true);
    // Read off an injected `env` parameter rather than `process.env`, which is
    // how everything that has to be testable without mutating the real
    // environment reads its configuration.
    expect(names.has('TRUSTED_PROXIES')).toBe(true);
    expect(names.has('DB_POOL_MAX')).toBe(true);
    expect(names.has('HOST')).toBe(true);
    // …and the exclusion that idiom needs: `import.meta.env.VITE_GA4_ID` is a
    // build-time constant, not a deployment variable. `GA4_ID` is.
    expect(names.has('VITE_GA4_ID')).toBe(false);
    expect(names.has('GA4_ID')).toBe(true);
    // An `Env` key declared through a helper rather than starting with `z`.
    // Named because it is the case the config.ts pattern was widened for, and
    // because nothing else in this list would notice it going missing: SMTP_PORT
    // is read nowhere else in the codebase.
    expect(names.has('SMTP_PORT')).toBe(true);
    expect(names.size).toBeGreaterThan(50);
  });

  it('excludes the mutation-testing tree, whose source is corrupt by design', () => {
    expect([...used().keys()].filter((n) => n.startsWith('XX'))).toEqual([]);
  });
});
