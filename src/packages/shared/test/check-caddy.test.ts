// Tests for infra/check-caddy.mjs.
//
// WHAT THE SCRIPT IS FOR, and therefore what these are really about: the repo
// carries `infra/caddy/n409.aiknol.com.caddy` and Caddy reads
// `/etc/caddy/Caddyfile`. Every deploy ships the first onto the host and
// nothing has ever compared it to the second. That is the same shape R88 closed
// for systemd, where the file the box booted was four weeks behind the file the
// repo reviewed and the difference was a fail-open guard.
//
// The half that needs pinning hardest is not "does it notice a change" — it is
// the pair of opposite properties that decide whether anyone leaves it turned
// on:
//
//   - a difference in comments or indentation must NOT be reported, because the
//     host's copy is genuinely formatted differently (spaces, its own comments
//     addressed to whoever edits the shared file) and a checker that fails on
//     the first honest deploy gets switched off that afternoon; and
//   - a difference in what Caddy would *do* must always be reported, including
//     the two that fail silently in production: a dropped trusted-proxy range,
//     which quietly re-keys every per-IP throttle onto a Cloudflare POP while
//     the site stays up, and a `/scim/v2/*` handle that stops preceding the
//     catch-all, which 404s an IdP's provisioning job in somebody else's logs.
//
// LIVE_SHAPE below is the host's real file, formatting and neighbours included,
// so the first property is asserted against the thing it actually has to
// tolerate rather than against a tidied-up imitation.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS infra module, deliberately outside the TS project
import {
  compareCaddy,
  directives,
  globalTrustedProxies,
  parseBlocks,
  repoSite,
  resolveRepoFile,
  stripComments,
} from '../../../../infra/check-caddy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const SCRIPT = path.join(repoRoot, 'infra/check-caddy.mjs');
const CADDY_DIR = path.join(repoRoot, 'infra/caddy');

/** This checkout's site block — the authority side of every comparison. */
const REPO = readFileSync(resolveRepoFile(CADDY_DIR), 'utf8');

/**
 * The host's `/etc/caddy/Caddyfile` as it stood on 2026-08-21, reduced to the
 * parts that bear on n409 plus one neighbouring site.
 *
 * Kept verbatim in its own formatting — four-space indent, its own comment
 * wording, the n409 block sitting between two unrelated products — because the
 * point of the fixture is that none of that counts as drift.
 */
const LIVE_SHAPE = `# ── Global options. Must stay the first block in this file. ────────────────
#
# Added for N409 (round 88). Caddy 2.7+ REPLACES an inbound X-Forwarded-For
# with the immediate peer address unless that peer is listed here.
{
	servers {
		trusted_proxies static 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32
	}
}

:80 {
	root * /usr/share/caddy
	file_server
}

ustradingbot.aiknol.com {
    reverse_proxy localhost:8501
}

n409.aiknol.com {
    # SCIM 2.0 provisioning (/scim/v2/*) lives on the valuation service (3001)
    # and is OUTSIDE the web service's /api proxy, so forward it directly.
    handle /scim/v2/* {
        reverse_proxy localhost:3001
    }

    # Everything else -> web service (3000).
    handle {
        reverse_proxy localhost:3000
    }
}

talentping.aiknol.com {
    encode gzip

    handle /api/* {
        reverse_proxy localhost:8000
    }

    handle {
        root * /opt/TalentPing/frontend/dist
        try_files {path} /index.html
        file_server
    }
}
`;

describe('the host and the checkout, when they agree', () => {
  it('reports nothing for the real deployed config', () => {
    expect(compareCaddy({ live: LIVE_SHAPE, repo: REPO })).toEqual([]);
  });

  // The property that keeps this checker switched on. The host's copy is
  // indented with spaces and carries comments written for whoever edits the
  // shared file; the repo's uses tabs and explains itself to a reviewer.
  it('ignores indentation, comments and blank lines', () => {
    const reformatted = LIVE_SHAPE.replace(/^ +/gm, '\t\t\t')
      .replace(/# .*$/gm, '# something else entirely')
      .replace(/\n\n/g, '\n\n\n');
    expect(compareCaddy({ live: reformatted, repo: REPO })).toEqual([]);
  });

  // Order does not change which peers Caddy trusts, and reporting a shuffle as
  // drift trains a reader to skim the one report that matters.
  it('ignores the order of the trusted-proxy list', () => {
    const ranges = globalTrustedProxies(LIVE_SHAPE) as string[];
    const shuffled = [...ranges].reverse().join(' ');
    const live = LIVE_SHAPE.replace(/trusted_proxies static .*/, `trusted_proxies static ${shuffled}`);
    expect(globalTrustedProxies(live)).not.toEqual(ranges);
    expect(compareCaddy({ live, repo: REPO })).toEqual([]);
  });

  // Guards the two above against passing by comparing nothing: a normalisation
  // bug that reduced either side to an empty list would satisfy every
  // assertion in this block.
  it('is comparing a site block that actually says something', () => {
    const body = directives(repoSite(REPO).body) as string[];
    expect(body.length).toBeGreaterThanOrEqual(6);
    expect(body).toContain('reverse_proxy localhost:3001');
    expect(body).toContain('reverse_proxy localhost:3000');
    expect((globalTrustedProxies(REPO) as string[]).length).toBeGreaterThan(10);
  });
});

describe('drift in the trusted-proxy list', () => {
  it('reports a range the host has stopped trusting', () => {
    const live = LIVE_SHAPE.replace(' 131.0.72.0/22', '');
    const problems = compareCaddy({ live, repo: REPO });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('131.0.72.0/22');
    expect(problems[0]).toContain('fewer');
  });

  // The opposite direction is a security finding rather than a stale config:
  // a range the app does not walk but Caddy does accept a header from is a
  // hop that can name any client it likes.
  it('reports a range the host trusts that this checkout does not name', () => {
    const live = LIVE_SHAPE.replace('trusted_proxies static ', 'trusted_proxies static 203.0.113.0/24 ');
    const problems = compareCaddy({ live, repo: REPO });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('203.0.113.0/24');
    expect(problems[0]).toContain('forge');
  });

  it('reports a host whose global options block declares none at all', () => {
    const live = LIVE_SHAPE.replace(/\{\n\tservers \{\n\t\ttrusted_proxies static [^\n]*\n\t\}\n\}\n/, '');
    const problems = compareCaddy({ live, repo: REPO });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no "trusted_proxies static"');
    expect(problems[0]).toContain('per-IP');
  });

  // The directive only does anything in the global options block. Finding the
  // words in a site block and calling that a match would report health on a
  // config where Caddy is still overwriting the header.
  it('does not accept one declared inside a site block', () => {
    const live = LIVE_SHAPE.replace(
      /\{\n\tservers \{\n\t\ttrusted_proxies static [^\n]*\n\t\}\n\}\n/,
      '',
    ).replace(
      'ustradingbot.aiknol.com {',
      'ustradingbot.aiknol.com {\n    trusted_proxies static 173.245.48.0/20',
    );
    expect(globalTrustedProxies(live)).toBeNull();
    expect(compareCaddy({ live, repo: REPO })[0]).toContain('no "trusted_proxies static"');
  });

  // Same trap one layer down: the words appear in this repo's own prose, and a
  // checker that matched those would pass on a config that says the right thing
  // in a comment and does nothing.
  it('does not accept one that is only mentioned in a comment', () => {
    const live = LIVE_SHAPE.replace(
      'trusted_proxies static',
      '# trusted_proxies static 173.245.48.0/20 — we should add this\n\t\tencode gzip #',
    );
    expect(globalTrustedProxies(live)).toBeNull();
  });
});

describe('drift in the routing', () => {
  it('reports a host that serves no such site at all', () => {
    const live = LIVE_SHAPE.replace('n409.aiknol.com {', 'n409-staging.aiknol.com {');
    const problems = compareCaddy({ live, repo: REPO });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no "n409.aiknol.com" site block');
  });

  it('reports a dropped /scim/v2 handle', () => {
    const live = LIVE_SHAPE.replace(
      / {4}handle \/scim\/v2\/\* \{\n {8}reverse_proxy localhost:3001\n {4}\}\n/,
      '',
    );
    const problems = compareCaddy({ live, repo: REPO });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('does not match this checkout');
    // The report has to name both sides — the whole point is telling somebody
    // what to go and change.
    expect(problems[0]).toContain('this checkout:');
    expect(problems[0]).toContain('the host:');
    expect(problems[0]).toContain('handle /scim/v2/*');
  });

  // `handle` is first-match-wins, so this is a reordering that changes
  // behaviour: SCIM routed to a service that has no such routes. It is the one
  // case where the normalisation must NOT be order-insensitive, which is why it
  // is asserted separately from the deletion above.
  it('reports handles that have swapped order', () => {
    const live = LIVE_SHAPE.replace(
      /n409\.aiknol\.com \{[\s\S]*?\n\}/,
      [
        'n409.aiknol.com {',
        '    handle {',
        '        reverse_proxy localhost:3000',
        '    }',
        '    handle /scim/v2/* {',
        '        reverse_proxy localhost:3001',
        '    }',
        '}',
      ].join('\n'),
    );
    const problems = compareCaddy({ live, repo: REPO });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('does not match this checkout');
  });

  it('reports an upstream pointed at a different port', () => {
    const live = LIVE_SHAPE.replace('reverse_proxy localhost:3000', 'reverse_proxy localhost:9999');
    const problems = compareCaddy({ live, repo: REPO });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('9999');
  });

  it('reports a directive the host has added', () => {
    const live = LIVE_SHAPE.replace('n409.aiknol.com {', 'n409.aiknol.com {\n    encode gzip');
    expect(compareCaddy({ live, repo: REPO })[0]).toContain('encode gzip');
  });

  // Caddy lets one block answer for several names. Finding the site only when
  // it is alone on the line would report a false drift on a legitimate config.
  it('finds the site in a block that serves several names', () => {
    const live = LIVE_SHAPE.replace('n409.aiknol.com {', 'www.n409.aiknol.com, n409.aiknol.com {');
    expect(compareCaddy({ live, repo: REPO })).toEqual([]);
  });
});

describe('reading the files', () => {
  it('strips a comment that follows a directive on the same line', () => {
    expect(stripComments('reverse_proxy localhost:3000 # the web service')).toBe(
      'reverse_proxy localhost:3000',
    );
  });

  // A `#` inside a token is not a comment in a Caddyfile, and treating it as
  // one would silently truncate a value.
  it('leaves a # that is inside a word alone', () => {
    expect(stripComments('respond https://example.com/a#b')).toBe('respond https://example.com/a#b');
  });

  it('tracks nesting so an inner block does not end its parent', () => {
    const blocks = parseBlocks('{\n servers {\n trusted_proxies static a\n }\n}\nsite {\n x\n}\n');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].header).toBe('');
    expect(blocks[1].header).toBe('site');
    expect(blocks[0].body).toContain('servers {');
  });

  it('refuses a file whose braces do not balance', () => {
    expect(() => parseBlocks('site {\n x\n')).toThrow(/unclosed/);
    expect(() => parseBlocks('site {\n x\n}\n}\n')).toThrow(/unbalanced/);
  });

  // The repo file is documented as the n409 block only. A second site block
  // appearing means it has become a whole Caddyfile — which its own header
  // warns must never be installed, because the host serves two other products
  // from the same file.
  it('refuses a checkout file that has grown a second site block', () => {
    expect(() => repoSite(`${REPO}\nother.example.com {\n\treverse_proxy localhost:1\n}\n`)).toThrow(
      /2 site blocks/,
    );
  });

  it('refuses a checkout file with no site block at all', () => {
    expect(() => repoSite('# just a comment\n')).toThrow(/no site block/);
  });
});

describe('finding this checkout’s file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'n409-caddy-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the one .caddy file beside the README', () => {
    writeFileSync(path.join(dir, 'README.md'), '# notes');
    writeFileSync(path.join(dir, 'site.caddy'), 'x {\n}\n');
    expect(resolveRepoFile(dir)).toBe(path.join(dir, 'site.caddy'));
  });

  // Globbing rather than naming means a rename cannot leave the check quietly
  // pointed at nothing — but it does have to fail when the answer is ambiguous.
  it('refuses to guess between two', () => {
    writeFileSync(path.join(dir, 'a.caddy'), 'x {\n}\n');
    writeFileSync(path.join(dir, 'b.caddy'), 'y {\n}\n');
    expect(() => resolveRepoFile(dir)).toThrow(/exactly one/);
  });

  it('refuses when there are none', () => {
    expect(() => resolveRepoFile(dir)).toThrow(/exactly one/);
  });

  // The default path the CLI uses, asserted against the real directory: this is
  // what makes the no-argument invocation in deploy.sh check the file a
  // reviewer reads rather than one that happens to be lying around.
  it('resolves the real infra/caddy directory to the committed site block', () => {
    expect(resolveRepoFile(CADDY_DIR)).toBe(path.join(CADDY_DIR, 'n409.aiknol.com.caddy'));
  });
});

describe('the command deploy.sh runs', () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'n409-caddy-cli-'));
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  function run(args: string[]) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  }

  it('exits 0 and says so when the host matches', () => {
    const live = path.join(work, 'Caddyfile');
    writeFileSync(live, LIVE_SHAPE);
    const r = run(['--live', live]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('matches');
  });

  it('exits 1 and names the difference when it does not', () => {
    const live = path.join(work, 'Caddyfile');
    writeFileSync(live, LIVE_SHAPE.replace(' 131.0.72.0/22', ''));
    const r = run(['--live', live]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('131.0.72.0/22');
    // Tells the reader the one thing that is not guessable: the host's file is
    // shared with two other products, so the fix is an in-place edit and never
    // a copy.
    expect(r.stderr).toContain('do NOT copy the file over it');
    expect(r.stderr).toContain('systemctl reload caddy');
  });

  // A distinct exit code, because "the file is not there" and "the file says
  // something else" call for different actions — the first usually means this
  // is not the host anybody thought it was.
  it('exits 2 when the host config cannot be read', () => {
    const r = run(['--live', path.join(work, 'nope')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot read');
  });

  it('exits 2 when the checkout file cannot be parsed', () => {
    const live = path.join(work, 'Caddyfile');
    const repo = path.join(work, 'site.caddy');
    writeFileSync(live, LIVE_SHAPE);
    writeFileSync(repo, 'n409.aiknol.com {\n\treverse_proxy localhost:3000\n');
    const r = run(['--live', live, '--repo', repo]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unclosed');
  });

  // With no --repo it must reach the committed file. Asserted by running it
  // against a live config that matches: a default resolving anywhere else
  // could not produce this answer.
  it('defaults --repo to the committed site block', () => {
    const live = path.join(work, 'Caddyfile');
    writeFileSync(live, LIVE_SHAPE);
    expect(run(['--live', live]).stderr).toContain('n409.aiknol.com.caddy');
  });

  it('reports every difference at once rather than the first', () => {
    const live = path.join(work, 'Caddyfile');
    writeFileSync(
      live,
      LIVE_SHAPE.replace(' 131.0.72.0/22', '').replace(
        'reverse_proxy localhost:3000',
        'reverse_proxy localhost:9999',
      ),
    );
    const r = run(['--live', live]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('2 difference(s)');
    expect(r.stderr).toContain('131.0.72.0/22');
    expect(r.stderr).toContain('9999');
  });
});

describe('what the checked-in files themselves say', () => {
  // The whole check rests on the repo file parsing into exactly one site block
  // with a trusted-proxy list. If a future edit broke that, every comparison
  // above would start throwing rather than quietly passing — but this states it
  // directly so the failure names the cause.
  it('the committed site block parses and names the deployed host', () => {
    const site = repoSite(REPO);
    expect(site.name).toBe('n409.aiknol.com');
    expect(globalTrustedProxies(REPO)).not.toBeNull();
  });

  // infra/caddy/README.md documents the deploy-time check. A reader who is
  // about to edit the host's file needs to know the deploy will now object.
  it('the README tells a reader the deploy checks this', () => {
    const readme = readFileSync(path.join(CADDY_DIR, 'README.md'), 'utf8');
    expect(readme).toContain('check-caddy.mjs');
  });

  // deploy.sh must actually run it. This is the R88 lesson stated as a test:
  // a checker nothing invokes is exactly as useful as the unit files nothing
  // installed.
  it('deploy.sh runs it', () => {
    const deploy = readFileSync(path.join(repoRoot, 'infra/deploy.sh'), 'utf8');
    expect(deploy).toContain('check-caddy.mjs');
  });
});

describe('a host that is not this host', () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'n409-caddy-alt-'));
    mkdirSync(path.join(work, 'caddy'));
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  // The site name comes out of the checkout rather than being hardcoded, so
  // renaming the site moves the check with it instead of leaving it looking for
  // a block nobody serves any more.
  it('follows a renamed site rather than looking for the old name', () => {
    const repo = REPO.replace('n409.aiknol.com {', 'valuations.example.com {');
    const matching = LIVE_SHAPE.replace('n409.aiknol.com {', 'valuations.example.com {');
    expect(compareCaddy({ live: matching, repo })).toEqual([]);
    expect(compareCaddy({ live: LIVE_SHAPE, repo })[0]).toContain('no "valuations.example.com" site block');
  });
});
