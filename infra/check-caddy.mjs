#!/usr/bin/env node
// Compare the Caddy config this host actually serves against the one in this
// checkout.
//
// WHY THIS EXISTS: R88 closed the same class of bug for systemd — `git archive`
// shipped `infra/systemd/` to the host and systemd read `/etc/systemd/system`,
// two sets of files nothing kept in step, and the line that had not travelled
// for four weeks was the one that armed a fail-open guard. `infra/caddy/` is
// the last copy of that shape still open: it is carried onto the box by every
// deploy and read by nothing, because Caddy reads `/etc/caddy/Caddyfile`.
//
// WHY IT CHECKS INSTEAD OF INSTALLING. install-units.sh can simply overwrite
// its destination; this cannot. That one Caddyfile also serves two unrelated
// products (ustradingbot, talentping) from the same ports, so the repo holds
// the n409 *site block* rather than a whole config, and writing it over
// /etc/caddy/Caddyfile would take the other two sites down. Reporting is the
// only safe direction, so this reports — and does it fatally from deploy.sh,
// because a warning about an edge config is a warning nobody reads.
//
// WHY THE COMPARISON IS SEMANTIC AND NOT `cmp`. The two files legitimately
// differ: the host's copy is indented with spaces and carries its own comments
// addressed to whoever is reading the shared file, the repo's uses tabs and
// explains itself to a reviewer. A byte comparison would fail on the very first
// deploy and be switched off within the day. What has to match is what Caddy
// *does*: the trusted-proxy set, and the directives of the n409 site block in
// the order they are written — `handle` is first-match-wins, so order is
// meaning, not formatting.
//
// The two things checked are exactly the two that fail silently:
//
//   - the trusted-proxy list, whose absence sends every per-IP throttle back to
//     sharing one bucket per Cloudflare POP while the site stays up, and
//   - the site block's routing, whose `/scim/v2/*` handle must precede the
//     catch-all or every IdP provisioning request 404s in somebody else's logs.
//
// Usage:
//   node infra/check-caddy.mjs [--live PATH] [--repo PATH]
//
//   --live  the config Caddy reads          (default /etc/caddy/Caddyfile)
//   --repo  this checkout's site block      (default infra/caddy/*.caddy beside
//                                            this script — see resolveRepoFile)
//
// Exits 0 when the host matches the checkout, 1 on drift, 2 when a file could
// not be read or parsed. Every failure prints what differed.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Remove Caddyfile comments.
 *
 * A `#` opens a comment only at the start of a token, so one at line start or
 * after whitespace begins a comment and one inside a word (a URL fragment, a
 * password) does not. Quoted strings containing a standalone `#` would be
 * mangled by this; neither config has one, and the alternative is a real
 * tokenizer for a gain nothing here needs.
 */
export function stripComments(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');
}

/**
 * Split a Caddyfile into its top-level blocks.
 *
 * Returns `{ header, body }` per block, where `header` is the text before the
 * opening brace (the site addresses, or '' for the global options block) and
 * `body` is the raw text between the braces. Depth is tracked so a nested
 * `servers { … }` does not end its parent.
 */
export function parseBlocks(text) {
  const clean = stripComments(text);
  const blocks = [];
  let depth = 0;
  let headerStart = 0;
  let bodyStart = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch === '{') {
      if (depth === 0) {
        blocks.push({ header: clean.slice(headerStart, i).trim(), bodyStart: i + 1 });
        bodyStart = i + 1;
      }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        blocks[blocks.length - 1].body = clean.slice(bodyStart, i);
        headerStart = i + 1;
      } else if (depth < 0) {
        throw new Error('unbalanced "}" — this does not parse as a Caddyfile');
      }
    }
  }
  if (depth !== 0) throw new Error('unclosed "{" — this does not parse as a Caddyfile');
  return blocks.map(({ header, body }) => ({ header, body: body ?? '' }));
}

/**
 * The directives of a block, as Caddy would act on them.
 *
 * Comments and blank lines go; indentation and runs of whitespace collapse;
 * everything else — including the order of the lines and the braces that show
 * nesting — is kept, because in a `handle` chain order is behaviour.
 */
export function directives(body) {
  return body
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line.length > 0);
}

/**
 * The single site block this checkout describes, and the name it is served
 * under.
 *
 * The name is read out of the file rather than passed in: a hardcoded default
 * is one more thing that can disagree with the config it is meant to be
 * checking, and renaming the site in the repo should move the check with it.
 * Exactly one site block is expected — the file is documented as the n409 block
 * only, and a second one appearing means it has quietly become a whole
 * Caddyfile, which is the thing its own header warns must never be installed.
 */
export function repoSite(text) {
  const sites = parseBlocks(text).filter((b) => b.header !== '');
  if (sites.length === 0) throw new Error('names no site block');
  if (sites.length > 1) {
    throw new Error(
      `names ${sites.length} site blocks (${sites.map((s) => s.header).join(', ')}) — this file is the n409 block only`,
    );
  }
  return { name: sites[0].header, body: sites[0].body };
}

/**
 * The `trusted_proxies static …` arguments from a config's global options
 * block, or null when it declares none.
 *
 * Scoped to the global block on purpose. Caddy only honours the directive
 * inside `servers { … }` at the top of the file, so finding the words anywhere
 * else — a site block, a comment that survived stripping — would be a check
 * passing on a config that does not do the thing.
 */
export function globalTrustedProxies(text) {
  const global = parseBlocks(text).find((b) => b.header === '');
  if (!global) return null;
  const line = directives(global.body).find((l) => l.startsWith('trusted_proxies static '));
  if (line === undefined) return null;
  return line.slice('trusted_proxies static '.length).split(' ').filter(Boolean);
}

/**
 * Compare a live config against this checkout's site block.
 *
 * Returns the list of problems, empty when the host matches. Every entry is
 * phrased as what the host does differently, because that is the file somebody
 * is about to go and edit.
 */
export function compareCaddy({ live, repo }) {
  const problems = [];
  const site = repoSite(repo);

  // ── routing ──
  const liveSite = parseBlocks(live).find((b) =>
    b.header
      .split(',')
      .map((s) => s.trim())
      .includes(site.name),
  );
  if (!liveSite) {
    problems.push(
      `the host serves no "${site.name}" site block — the site in this checkout is not deployed at this edge`,
    );
  } else {
    const want = directives(site.body);
    const got = directives(liveSite.body);
    if (want.join('\n') !== got.join('\n')) {
      problems.push(
        [
          `the host's "${site.name}" block does not match this checkout.`,
          '  this checkout:',
          ...want.map((l) => `    ${l}`),
          '  the host:',
          ...got.map((l) => `    ${l}`),
        ].join('\n'),
      );
    }
  }

  // ── trusted proxies ──
  //
  // Compared as a set: the order Caddy is given these in does not change which
  // peers it trusts, and reporting a reordering as drift would train a reader
  // to skim the one report that matters.
  const wantProxies = globalTrustedProxies(repo);
  const gotProxies = globalTrustedProxies(live);
  if (wantProxies === null) {
    problems.push(
      'this checkout declares no "trusted_proxies static" — it is meant to carry the list the host needs',
    );
  } else if (gotProxies === null) {
    problems.push(
      'the host declares no "trusted_proxies static" in its global options block — Caddy is overwriting X-Forwarded-For with the Cloudflare edge address, so every per-IP limit is keyed on a datacenter rather than a client',
    );
  } else {
    const missing = wantProxies.filter((r) => !gotProxies.includes(r));
    const extra = gotProxies.filter((r) => !wantProxies.includes(r));
    if (missing.length > 0) {
      problems.push(
        `the host trusts ${missing.length} fewer range(s) than this checkout: ${missing.join(' ')} — requests via those POPs resolve to the edge address`,
      );
    }
    if (extra.length > 0) {
      problems.push(
        `the host trusts ${extra.length} range(s) this checkout does not name: ${extra.join(' ')} — anything in them can forge a client address`,
      );
    }
  }

  return problems;
}

/**
 * The checkout's caddy file, found rather than named.
 *
 * `infra/caddy/` holds one `.caddy` file and the README beside it; globbing for
 * it means renaming the site's file does not silently start checking nothing.
 */
export function resolveRepoFile(dir) {
  const found = readdirSync(dir).filter((f) => f.endsWith('.caddy'));
  if (found.length !== 1) {
    throw new Error(`expected exactly one .caddy file in ${dir}, found ${found.length}`);
  }
  return path.join(dir, found[0]);
}

function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
  };
  const livePath = arg('--live', '/etc/caddy/Caddyfile');
  const repoPath = arg('--repo', undefined) ?? resolveRepoFile(path.join(here, 'caddy'));

  const read = (p, what) => {
    try {
      return readFileSync(p, 'utf8');
    } catch (err) {
      // Distinguished from drift with its own exit code: "the file is not
      // there" and "the file says something else" call for different actions,
      // and a missing /etc/caddy/Caddyfile most often means this is not the
      // host anybody thought it was.
      process.stderr.write(`n409-caddy: ERROR: cannot read ${what} at ${p}: ${err.message}\n`);
      process.exit(2);
    }
  };

  const live = read(livePath, "the host's Caddy config");
  const repo = read(repoPath, "this checkout's site block");

  let problems;
  try {
    problems = compareCaddy({ live, repo });
  } catch (err) {
    process.stderr.write(`n409-caddy: ERROR: ${err.message}\n`);
    process.exit(2);
  }

  if (problems.length === 0) {
    process.stderr.write(`n409-caddy: ${livePath} matches ${path.basename(repoPath)}\n`);
    return 0;
  }
  process.stderr.write(
    `n409-caddy: ${problems.length} difference(s) between ${livePath} and this checkout:\n`,
  );
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.stderr.write(
    `n409-caddy: the host is the authority for what is served; this checkout is the authority for what should be.\n` +
      `n409-caddy: edit the "${repoSite(repo).name}" block in ${livePath} in place (it is shared with other sites — do NOT copy the file over it), then: caddy validate --config ${livePath} && systemctl reload caddy\n`,
  );
  return 1;
}

// Only when run, not when imported by the tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
