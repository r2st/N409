// Tests for infra/check-edge-exposure.mjs.
//
// WHAT THE SCRIPT ANSWERS, and why it is a script rather than a paragraph.
// infra/DEPLOYMENT.md carries the open item left by R88: trusting Cloudflare's
// ranges is only completely safe once the origin accepts 80/443 from those
// ranges alone, and the recipe for doing it is gated on "after confirming the
// other two sites are proxied".
//
// That confirmation was prose, and it was wrong. Two of the three sites on the
// box are proxied; `ustradingbot.aiknol.com` resolves straight to the origin,
// so following the recipe would have taken a live product off the internet —
// and then done it a second time at certificate renewal, because the validation
// traffic that renews a grey-clouded site arrives from Let's Encrypt rather
// than from Cloudflare and the same rule blocks it.
//
// So the property under test is not "does it detect Cloudflare addresses". It
// is that the safe verdict is hard to get by accident: a site that does not
// resolve, a site with one proxied record and one that is not, and a config
// with no sites in it must all fail to produce "safe", because every one of
// those is a question nobody answered rather than an answer.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS infra module, deliberately outside the TS project
import {
  assessEdge,
  cloudflareRangesFrom,
  inRange,
  ipv4,
  servedDirectly,
  sitesIn,
} from '../../../../infra/check-edge-exposure.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const SCRIPT = path.join(repoRoot, 'infra/check-edge-exposure.mjs');

/** A minimal stand-in for the host's shared Caddyfile. */
const CADDYFILE = `{
	servers {
		trusted_proxies static 104.16.0.0/13 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32
	}
}

:80 {
	file_server
}

n409.aiknol.com {
	handle {
		reverse_proxy localhost:3000
	}
}

ustradingbot.aiknol.com {
	reverse_proxy localhost:8501
}
`;

const RANGES = ['104.16.0.0/13', '172.64.0.0/13', '131.0.72.0/22'];

describe('reading the host’s config', () => {
  it('names every site it serves', () => {
    expect(sitesIn(CADDYFILE)).toEqual(['n409.aiknol.com', 'ustradingbot.aiknol.com']);
  });

  // `:80 { … }` is a port, not a hostname. Resolving it would produce a DNS
  // failure that the assessment then has to call "unknown", turning a healthy
  // host into a permanent unsafe verdict for no reason.
  it('leaves port-only blocks out', () => {
    expect(sitesIn(CADDYFILE)).not.toContain(':80');
  });

  it('reads a block that serves several names as several sites', () => {
    expect(sitesIn('a.example.com, b.example.com {\n\tfile_server\n}\n')).toEqual([
      'a.example.com',
      'b.example.com',
    ]);
  });

  // The list comes out of the config being assessed rather than a copy kept
  // here. A checker whose idea of "Cloudflare" has drifted from the edge's is
  // reporting on a network that does not exist.
  it('takes the ranges from the config, not from itself', () => {
    expect(cloudflareRangesFrom(CADDYFILE)).toEqual(RANGES);
  });

  // v6 blocks are dropped because the comparison is against A records. Carried
  // through, they would never match anything and cost nothing — but they would
  // make the "against N ranges" line a number that means something else.
  it('keeps only the IPv4 blocks', () => {
    expect(cloudflareRangesFrom(CADDYFILE)).not.toContain('2400:cb00::/32');
  });

  it('reports no ranges when the config declares none', () => {
    expect(cloudflareRangesFrom('site.example.com {\n\tfile_server\n}\n')).toEqual([]);
  });
});

describe('deciding whether an address is Cloudflare’s', () => {
  it('accepts an address inside a block', () => {
    expect(inRange('104.21.13.34', '104.16.0.0/13')).toBe(true);
    expect(inRange('172.67.197.163', '172.64.0.0/13')).toBe(true);
  });

  it('rejects the origin', () => {
    expect(RANGES.some((r) => inRange('204.168.241.124', r))).toBe(false);
  });

  // The boundaries, because an off-by-one in the mask is the way this returns
  // "proxied" for an address that is not.
  it('gets the edges of a block right', () => {
    expect(inRange('131.0.72.0', '131.0.72.0/22')).toBe(true);
    expect(inRange('131.0.75.255', '131.0.72.0/22')).toBe(true);
    expect(inRange('131.0.71.255', '131.0.72.0/22')).toBe(false);
    expect(inRange('131.0.76.0', '131.0.72.0/22')).toBe(false);
  });

  // /8 and above shift by more than 24, where a signed 32-bit shift in JS goes
  // wrong if the result is not coerced back to unsigned.
  it('handles a wide block without sign trouble', () => {
    expect(inRange('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(inRange('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(inRange('203.0.113.9', '0.0.0.0/0')).toBe(true);
  });

  it('refuses anything that is not an address', () => {
    expect(ipv4('2400:cb00::1')).toBeUndefined();
    expect(ipv4('1.2.3')).toBeUndefined();
    expect(ipv4('1.2.3.256')).toBeUndefined();
    expect(ipv4('1.2.3.x')).toBeUndefined();
    expect(inRange('2400:cb00::1', '104.16.0.0/13')).toBe(false);
    expect(inRange('104.21.13.34', 'nonsense')).toBe(false);
  });
});

describe('the verdict', () => {
  const site = (host: string, ...addresses: string[]) => ({ host, addresses });

  it('is safe when every site is behind Cloudflare', () => {
    const result = assessEdge({
      sites: [
        site('n409.aiknol.com', '104.21.13.34', '172.67.197.163'),
        site('talentping.aiknol.com', '104.21.13.34'),
      ],
      ranges: RANGES,
    });
    expect(result.safeToLock).toBe(true);
    expect(result.direct).toEqual([]);
    expect(result.proxied).toHaveLength(2);
  });

  // The real state of the box, and the finding this script exists for.
  it('is not safe while one site resolves to the origin', () => {
    const result = assessEdge({
      sites: [site('n409.aiknol.com', '104.21.13.34'), site('ustradingbot.aiknol.com', '204.168.241.124')],
      ranges: RANGES,
    });
    expect(result.safeToLock).toBe(false);
    expect(result.direct.map((s: { host: string }) => s.host)).toEqual(['ustradingbot.aiknol.com']);
    // Naming the address is what makes the report actionable rather than a
    // verdict somebody has to go and reproduce.
    expect(result.direct[0].outside).toEqual(['204.168.241.124']);
  });

  // A hostname with one proxied record and one pointing at the origin is not
  // protected — it is a coin flip per client. Calling that "proxied" is exactly
  // how the premise went wrong the first time.
  it('does not call a partly-proxied site proxied', () => {
    const result = assessEdge({
      sites: [site('half.example.com', '104.21.13.34', '204.168.241.124')],
      ranges: RANGES,
    });
    expect(result.safeToLock).toBe(false);
    expect(result.direct[0].outside).toEqual(['204.168.241.124']);
  });

  // An unresolvable site is not evidence of safety. Treating "no addresses" as
  // "nothing outside Cloudflare" would return the safe verdict for a DNS
  // outage, which is the most dangerous moment to get this answer wrong.
  it('refuses to call a site it could not resolve safe', () => {
    const result = assessEdge({
      sites: [
        site('n409.aiknol.com', '104.21.13.34'),
        { host: 'gone.example.com', addresses: [], error: 'ENOTFOUND' },
      ],
      ranges: RANGES,
    });
    expect(result.safeToLock).toBe(false);
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0].why).toBe('ENOTFOUND');
  });

  // Vacuity guard. Every branch above is "nothing was found in the bad list",
  // and an empty site list satisfies all of them at once.
  it('refuses to call a host with no sites safe', () => {
    expect(assessEdge({ sites: [], ranges: RANGES }).safeToLock).toBe(false);
  });

  // Likewise from the other side: no ranges means nothing can match, so every
  // site lands in `direct` rather than quietly passing.
  it('calls everything direct when there are no ranges to match', () => {
    const result = assessEdge({ sites: [site('n409.aiknol.com', '104.21.13.34')], ranges: [] });
    expect(result.safeToLock).toBe(false);
    expect(result.direct).toHaveLength(1);
  });
});

describe('probing the origin directly', () => {
  /** A stub standing in for node:https, recording how it was called. */
  function fakeHttps(behaviour: 'ok' | 'error' | 'timeout', calls: Record<string, unknown>[] = []) {
    return {
      calls,
      request(
        options: Record<string, unknown>,
        cb: (res: { statusCode: number; resume: () => void }) => void,
      ) {
        calls.push(options);
        const handlers: Record<string, () => void> = {};
        const req = {
          on(event: string, fn: () => void) {
            handlers[event] = fn;
            return req;
          },
          destroy() {
            handlers.error?.();
          },
          end() {
            if (behaviour === 'ok') cb({ statusCode: 200, resume: () => {} });
            else if (behaviour === 'error') handlers.error?.();
            else handlers.timeout?.();
          },
        };
        return req;
      },
    };
  }

  it('reports the status the origin answered with', async () => {
    const https = fakeHttps('ok');
    await expect(servedDirectly('n409.aiknol.com', '203.0.113.1', https)).resolves.toBe(200);
  });

  // The two things `fetch` could not do, and the reason this uses node:https.
  // Without both, the request arrives asking for the origin's IP and is
  // answered by whichever site Caddy defaults to — a different question.
  it('names the site in both SNI and Host', async () => {
    const https = fakeHttps('ok');
    await servedDirectly('n409.aiknol.com', '203.0.113.1', https);
    expect(https.calls[0].servername).toBe('n409.aiknol.com');
    expect((https.calls[0].headers as Record<string, string>).Host).toBe('n409.aiknol.com');
    // Dialled by address, so the certificate is for a name we did not ask for.
    expect(https.calls[0].host).toBe('203.0.113.1');
    expect(https.calls[0].rejectUnauthorized).toBe(false);
  });

  // A refused connection is the *good* outcome here — it is what a locked-down
  // origin looks like — so it has to be distinguishable from a 200 rather than
  // throwing.
  it('reports null when the origin refuses', async () => {
    await expect(servedDirectly('n409.aiknol.com', '203.0.113.1', fakeHttps('error'))).resolves.toBeNull();
  });

  it('reports null rather than hanging when the origin never answers', async () => {
    await expect(servedDirectly('n409.aiknol.com', '203.0.113.1', fakeHttps('timeout'))).resolves.toBeNull();
  });
});

describe('the command', () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'n409-edge-'));
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  const run = (args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  it('exits 2 when the config cannot be read', () => {
    const r = run(['--caddyfile', path.join(work, 'nope')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot read');
  });

  it('exits 2 when the config does not parse', () => {
    const f = path.join(work, 'Caddyfile');
    writeFileSync(f, 'site.example.com {\n\tfile_server\n');
    const r = run(['--caddyfile', f]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('does not parse');
  });

  // Without ranges there is nothing to compare against, and reporting every
  // site as exposed would be a false alarm rather than a finding.
  it('exits 2 when the config declares no ranges', () => {
    const f = path.join(work, 'Caddyfile');
    writeFileSync(f, 'site.example.com {\n\tfile_server\n}\n');
    const r = run(['--caddyfile', f]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no trusted_proxies');
  });

  // Uses a name that cannot resolve, so this asserts the unsafe path without
  // depending on the network agreeing.
  it('exits 1 and names what would break', () => {
    const f = path.join(work, 'Caddyfile');
    writeFileSync(f, CADDYFILE.replace(/n409\.aiknol\.com|ustradingbot\.aiknol\.com/g, 'nx.invalid'));
    const r = run(['--caddyfile', f]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('NOT safe');
    expect(r.stderr).toContain('nx.invalid');
    // The certificate consequence is the non-obvious half and the one that
    // arrives two months later, so the failure has to say it.
    expect(r.stderr).toContain('renews the certificate');
  });
});

describe('what the documentation says about it', () => {
  it('DEPLOYMENT.md points at the script rather than asking for a manual check', () => {
    const doc = readFileSync(path.join(repoRoot, 'infra/DEPLOYMENT.md'), 'utf8');
    expect(doc).toContain('check-edge-exposure.mjs');
  });

  // The claim that started this: the repo said every site on the host was
  // behind Cloudflare, and one is not. Pinned so it cannot quietly come back —
  // a false premise in an infrastructure doc is worse than a missing one,
  // because it is the thing somebody acts on.
  it('no longer claims every site on the host is proxied', () => {
    for (const f of ['infra/caddy/README.md', 'infra/caddy/n409.aiknol.com.caddy']) {
      const text = readFileSync(path.join(repoRoot, f), 'utf8');
      expect(text).not.toMatch(/Every site on this host is fronted by Cloudflare/i);
      expect(text).not.toMatch(/all three sites on this box are fronted by Cloudflare/i);
    }
  });
});
