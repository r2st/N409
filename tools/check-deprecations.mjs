/**
 * Does the registry, *today*, say anything in our tree is deprecated?
 *
 * `dependencyCensus.test.ts` already asks a version of this question, and it
 * asks it offline by reading the `deprecated` field out of package-lock.json.
 * That field is written by npm when it **resolves** a version, which makes the
 * offline case structurally unable to see the thing it exists to catch: a
 * deprecation published *after* we locked. Nothing in the lockfile changes when
 * a maintainer deprecates — no version, no integrity hash, no diff — so the
 * field simply stays absent and the whole-set comparison stays equal to its
 * allowlist.
 *
 * That is not hypothetical. `@xmldom/xmldom@0.8.13` was locked before its
 * maintainer published "this version has critical issues, please update to the
 * latest version", so the lockfile recorded nothing, the census went green, and
 * `npm audit` had nothing to say either — a deprecation is not an advisory. The
 * package is what `@node-saml/node-saml`, `xml-crypto` and `xml-encryption`
 * parse the IdP's SAML response with, which is untrusted XML arriving at an
 * unauthenticated callback. It was found by asking the registry by hand.
 *
 * So this is the online half, and it belongs beside `npm audit` in CI rather
 * than in the suite: it needs the network, and a unit test that needs the
 * network is a unit test that fails for reasons that are not about the code.
 * The offline case stays — it catches what was already recorded, with no
 * network — and the two together cover both sides of when the notice arrived.
 *
 * Usage:  node tools/check-deprecations.mjs
 * Exits 0 if every deprecated resolution is on the reviewed list, 1 otherwise.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Deprecated packages we have read and decided to keep, by name.
 *
 * Keyed by name rather than by `name@version` on purpose: these are all cases
 * where the whole published line is deprecated, so pinning a version here would
 * make the entry expire on the next patch and turn a reviewed decision into a
 * recurring chore. The cost is that a *fixed* release of one of these will not
 * announce itself — re-read this list when you touch the dependency above it.
 *
 * Reviewed as of R286.
 */
const ALLOWED = {
  eslint:
    'ESLint deprecates the previous major line when a new one ships, so every ' +
    'eslint 9 release now carries "no longer supported" and 9.39.5 is the last ' +
    'of it. Moving to 10 is a migration with typescript-eslint in tow, not a ' +
    'bump — and this is a linter, run by CI and by developers, never shipped.',
  glob:
    'nested under @vitest/coverage-v8 -> test-exclude, which pins glob 10. ' +
    'test-exclude 8 moved to glob 13 but coverage-v8 3.2.7 ranges at ^7. Runs ' +
    'only while collecting coverage.',
  'whatwg-encoding':
    "jsdom's HTML decoder. The deprecation points at a replacement jsdom has " +
    'not adopted; jsdom is a dev dependency of web-frontend only.',
};

/** Every `name@version` the lockfile resolves from the public registry. */
export function resolutionsIn(lock) {
  const out = new Map();
  for (const [p, e] of Object.entries(lock.packages ?? {})) {
    const at = p.lastIndexOf('node_modules/');
    // No `resolved` means a workspace link — there is no registry entry to ask
    // about, and asking would query a name that does not exist publicly.
    if (at < 0 || !e.version || !e.resolved) continue;
    const name = p.slice(at + 'node_modules/'.length);
    if (!out.has(name)) out.set(name, new Set());
    out.get(name).add(e.version);
  }
  return out;
}

/** The deprecated resolutions of one package, given its packument. */
export function deprecatedOf(name, versions, packument) {
  const out = [];
  for (const v of versions) {
    const notice = packument?.versions?.[v]?.deprecated;
    if (notice) out.push({ name, version: v, notice: String(notice).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

async function packument(name) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
  let last;
  // Fails closed after the retries: a check that reports "clean" when it could
  // not reach the registry is worse than one that is loud about not knowing.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
      });
      if (res.ok) return await res.json();
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
  }
  throw new Error(`${name}: could not be read from the registry (${last?.message})`);
}

async function main() {
  const lock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const resolutions = [...resolutionsIn(lock)];

  const found = [];
  const unreachable = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (next < resolutions.length) {
        const [name, versions] = resolutions[next++];
        try {
          found.push(...deprecatedOf(name, versions, await packument(name)));
        } catch (err) {
          unreachable.push(err.message);
        }
      }
    }),
  );

  const unreviewed = found.filter((d) => !(d.name in ALLOWED)).sort((a, b) => a.name.localeCompare(b.name));

  for (const d of found.filter((f) => f.name in ALLOWED)) {
    console.log(`reviewed: ${d.name}@${d.version} — ${d.notice}`);
  }

  if (unreachable.length > 0) {
    console.error(`\n${unreachable.length} package(s) could not be checked:`);
    for (const m of unreachable) console.error(`  ${m}`);
    process.exit(1);
  }

  if (unreviewed.length > 0) {
    console.error(`\n${unreviewed.length} deprecated package(s) in the tree that nobody has reviewed:\n`);
    for (const d of unreviewed) console.error(`  ${d.name}@${d.version}\n    ${d.notice}\n`);
    console.error(
      'A deprecation arrives with no version number attached: the lockfile does not\n' +
        'change, `npm audit` stays green because there is no advisory, and the package\n' +
        'simply stops being fixed. Move off it, or add it to ALLOWED in this file with\n' +
        'the reason keeping it is safe.',
    );
    process.exit(1);
  }

  console.log(`\nchecked ${resolutions.length} packages — no unreviewed deprecations`);
}

// Importable for the unit test without running the network half.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
