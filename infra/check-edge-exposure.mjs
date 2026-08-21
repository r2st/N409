#!/usr/bin/env node
// Can the origin be locked to Cloudflare yet, and what breaks if it is?
//
// THE OPEN ITEM THIS ANSWERS. R88 taught Caddy and the app to trust Cloudflare's
// ranges, which is what makes `req.ip` a client rather than a datacenter. The
// note left behind (infra/DEPLOYMENT.md) says that trust is only completely
// safe once the origin accepts 80/443 *from those ranges alone*, and that the
// change was not made because this box's Caddy serves two unrelated products
// from the same ports — so it "would take those down unless they are proxied
// too", with the recipe gated on "after confirming the other two sites are
// proxied".
//
// Confirming that was left as prose, and prose is where this kind of premise
// goes wrong. It was: the repo asserted every site on the host is fronted by
// Cloudflare, and one of them is not. `ustradingbot.aiknol.com` resolves
// straight to the origin, so the documented `ufw` recipe would have taken it
// off the internet — and, because its certificate is renewed by validation
// traffic that arrives from Let's Encrypt rather than from Cloudflare, would
// have done it twice: once at the firewall and again sixty days later when the
// renewal it also blocked came due.
//
// So this measures instead. It reads the site names out of the Caddy config the
// host actually serves, resolves each one, and says which of them are behind
// Cloudflare and which would lose their door. The lock is safe exactly when
// nothing is in the second list.
//
// WHAT IT DOES NOT CLAIM. A site resolving to Cloudflare says the record is
// proxied today; it does not say the origin is unreachable, which is the thing
// the lock would change. `--probe` measures that separately by dialling the
// origin address directly with the site's Host header — a 200 there is the
// bypass in one line.
//
// Usage:
//   node infra/check-edge-exposure.mjs [--caddyfile PATH] [--origin IP] [--probe]
//
// Exits 0 when every site on the host is proxied (the lock is safe to apply),
// 1 when at least one would break, 2 when the config could not be read.
// Neither 0 nor 1 applies anything: this script only ever reads.
import { readFileSync } from 'node:fs';
import { resolve4 } from 'node:dns/promises';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBlocks } from './check-caddy.mjs';

/**
 * Cloudflare's published IPv4 ranges.
 *
 * Deliberately read from the Caddy config being assessed rather than kept here.
 * A third copy of this list — after `clientIp.ts` and the Caddyfile — is a third
 * thing to keep in step, and a checker whose idea of "Cloudflare" has drifted
 * from the edge's would report on a network that does not exist.
 */
export function cloudflareRangesFrom(caddyfile) {
  const global = parseBlocks(caddyfile).find((b) => b.header === '');
  const line = (global?.body ?? '')
    .split('\n')
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .find((l) => l.startsWith('trusted_proxies static '));
  if (!line) return [];
  return line
    .slice('trusted_proxies static '.length)
    .split(' ')
    .filter((r) => r.includes('.') && r.includes('/'));
}

/** The hostnames this Caddy serves, excluding port-only blocks like `:80`. */
export function sitesIn(caddyfile) {
  return parseBlocks(caddyfile)
    .filter((b) => b.header !== '')
    .flatMap((b) => b.header.split(',').map((s) => s.trim()))
    .filter((name) => name.includes('.') && !name.startsWith(':'));
}

/** An IPv4 dotted quad as a number, or undefined if it is not one. */
export function ipv4(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const v = Number(p);
    if (v > 255) return undefined;
    n = n * 256 + v;
  }
  return n;
}

/** Whether an IPv4 address falls inside a `a.b.c.d/len` block. */
export function inRange(address, cidr) {
  const [base, lenText] = cidr.split('/');
  const addr = ipv4(address);
  const net = ipv4(base);
  const len = Number(lenText);
  if (addr === undefined || net === undefined || !Number.isInteger(len) || len < 0 || len > 32) return false;
  // `len === 0` would shift by 32, which in JS wraps to a no-op mask. Spelled
  // out rather than relying on the shift.
  if (len === 0) return true;
  const mask = (0xffffffff << (32 - len)) >>> 0;
  return (addr & mask) >>> 0 === (net & mask) >>> 0;
}

/**
 * Which sites survive a Cloudflare-only origin and which lose their door.
 *
 * `sites` is `[{ host, addresses }]` — the resolution is injected rather than
 * done here so the judgement is testable without a network, and so a DNS
 * failure is a stated condition rather than a silent "not proxied".
 */
export function assessEdge({ sites, ranges }) {
  const proxied = [];
  const direct = [];
  const unknown = [];
  for (const site of sites) {
    if (!site.addresses || site.addresses.length === 0) {
      unknown.push({ ...site, why: site.error ?? 'did not resolve' });
      continue;
    }
    // Every address must be Cloudflare's. A hostname with one proxied record
    // and one pointing at the origin is not protected — it is a coin flip per
    // client, and calling that "proxied" is how the premise goes wrong again.
    const outside = site.addresses.filter((a) => !ranges.some((r) => inRange(a, r)));
    if (outside.length === 0) proxied.push(site);
    else direct.push({ ...site, outside });
  }
  return {
    proxied,
    direct,
    unknown,
    // Safe only when nothing is unaccounted for. An unresolvable site is not
    // evidence of safety; it is a question nobody answered.
    safeToLock: direct.length === 0 && unknown.length === 0 && sites.length > 0,
  };
}

/** Resolve a host, turning a DNS failure into a reported condition. */
async function addressesOf(host, resolver = resolve4) {
  try {
    return { host, addresses: await resolver(host) };
  } catch (err) {
    return { host, addresses: [], error: err.code ?? err.message };
  }
}

/**
 * Is the origin serving this site to anyone who dials its address directly?
 *
 * This is the bypass itself rather than a proxy for it: connect to the origin's
 * address, name the site in SNI and in Host, and see what comes back. A 200 is
 * the edge being optional for that site, in one line.
 *
 * `node:https` rather than `fetch`, and that is not a style choice. `fetch`
 * treats `host` as a forbidden header and silently drops it, so every request
 * would arrive asking for the origin's IP and be answered by whichever site
 * Caddy defaults to — and it rejects the origin's certificate, which is issued
 * for a name DNS points at Cloudflare. Both failures land as "did not answer",
 * which is the same output as a locked-down origin. A probe that cannot tell
 * the bypass from its absence is worse than no probe: it reports the reassuring
 * answer either way.
 */
export function servedDirectly(host, origin, https) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: origin,
        port: 443,
        path: '/health',
        method: 'GET',
        // The name being asked for, in both the places a server reads it.
        servername: host,
        headers: { Host: host },
        // The origin holds a certificate for `host`, but we dialled an address.
        // Verification would fail on the name mismatch and tell us nothing
        // about the question, which is whether the door opens at all.
        rejectUnauthorized: false,
        timeout: 10_000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
  };
  const caddyPath = arg('--caddyfile', '/etc/caddy/Caddyfile');
  const origin = arg('--origin', undefined);

  let caddyfile;
  try {
    caddyfile = readFileSync(caddyPath, 'utf8');
  } catch (err) {
    process.stderr.write(`n409-edge: ERROR: cannot read ${caddyPath}: ${err.message}\n`);
    return 2;
  }

  let sites;
  let ranges;
  try {
    sites = sitesIn(caddyfile);
    ranges = cloudflareRangesFrom(caddyfile);
  } catch (err) {
    process.stderr.write(`n409-edge: ERROR: ${caddyPath} does not parse: ${err.message}\n`);
    return 2;
  }
  if (ranges.length === 0) {
    process.stderr.write(
      `n409-edge: ERROR: ${caddyPath} declares no trusted_proxies ranges, so there is nothing to compare against\n`,
    );
    return 2;
  }

  const resolved = await Promise.all(sites.map((h) => addressesOf(h)));
  const { proxied, direct, unknown, safeToLock } = assessEdge({ sites: resolved, ranges });

  process.stderr.write(
    `n409-edge: ${sites.length} site(s) served by ${caddyPath}, against ${ranges.length} ranges\n`,
  );
  for (const s of proxied) process.stderr.write(`  proxied  ${s.host} (${s.addresses.join(' ')})\n`);
  for (const s of direct) process.stderr.write(`  DIRECT   ${s.host} → ${s.outside.join(' ')}\n`);
  for (const s of unknown) process.stderr.write(`  unknown  ${s.host} (${s.why})\n`);

  if (argv.includes('--probe') && origin) {
    for (const s of resolved) {
      const status = await servedDirectly(s.host, origin, https);
      process.stderr.write(
        status === null
          ? `  bypass   ${s.host}: origin did not answer\n`
          : `  bypass   ${s.host}: origin answers ${status} for its Host header — the edge is optional for this site today\n`,
      );
    }
  }

  if (safeToLock) {
    process.stderr.write(
      'n409-edge: every site on this host is proxied — restricting 80/443 to the ranges above would not orphan one.\n' +
        '           See infra/DEPLOYMENT.md for the recipe, and read the certificate note there before applying it.\n',
    );
    return 0;
  }
  process.stderr.write(
    'n409-edge: NOT safe to restrict 80/443 to Cloudflare.\n' +
      `           ${[...direct, ...unknown].map((s) => s.host).join(', ')} would lose ${direct.length + unknown.length === 1 ? 'its door' : 'their door'}, and with it the\n` +
      '           validation traffic that renews the certificate — an outage now and a second one at renewal.\n',
  );
  return 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
