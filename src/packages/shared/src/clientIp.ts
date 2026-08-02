/**
 * Which upstream hops are allowed to name the client.
 *
 * Every service here sits behind at least one proxy: Caddy terminates TLS and
 * forwards to the web BFF, and the web BFF forwards /api to the valuation
 * service over loopback. Fastify, left alone, reports `req.ip` as the *socket
 * peer* — so at the valuation service that is `127.0.0.1` for every request on
 * the internet, and at the web service it is whichever address Caddy dials
 * from. Neither has anything to do with who is calling.
 *
 * That is not a cosmetic problem. Fourteen throttles key on `req.ip`: the
 * contact form, the client-intake / auditor / board portals, SCIM, and eight
 * separate limits in the auth routes. With the peer address constant they are
 * not fourteen per-client limits, they are fourteen *global* ones — five
 * contact submissions per ten minutes for the whole internet, thirty
 * password-reset redemptions an hour for everyone together. A limiter meant to
 * isolate one abuser instead hands that abuser a lever to lock out every real
 * user, and it does so silently, because from the inside a 429 looks the same
 * either way. The login audit log has the same hole: every row records the
 * proxy.
 *
 * The fix is to trust the hops we actually run, and only those. `trustProxy`
 * set to `true` would be worse than the bug: it takes the leftmost
 * `X-Forwarded-For` entry on faith, and that entry is written by the client, so
 * every limit above becomes bypassable by anyone who can set a header. Naming
 * the trusted hops instead makes proxy-addr walk the chain from the socket
 * inward and stop at the first address we do not run — which is the real
 * client, whatever it prepended to the header.
 *
 * The default covers the deployments this repo describes without naming a
 * literal address, because the two documents disagree about one: DEPLOYMENT.md
 * says Caddy reaches web over loopback, while infra/caddy/ dials
 * `host.docker.internal` from a container, which arrives from the Docker bridge
 * (172.17.0.0/16). `uniquelocal` spans RFC1918 and so covers the bridge on any
 * host; `loopback` covers the same-host case and the web→valuation hop. None of
 * these ranges is routable from the internet, so a direct connection to the
 * published port 3000 still resolves to its own real source address rather than
 * to anything it claims — the header is only consulted for hops we trust.
 *
 * `TRUSTED_PROXIES` overrides it for deployments shaped differently: a
 * comma-separated list of addresses, CIDR blocks, or proxy-addr's named presets.
 */
export const DEFAULT_TRUSTED_PROXIES = 'loopback, linklocal, uniquelocal';

/** Values that ask for "trust whatever the header says". Never valid here. */
const BLANKET_TRUST = new Set(['true', 'all', '*', 'yes', 'any']);

/** Values that ask for no proxy at all, so `req.ip` stays the socket peer. */
const NO_TRUST = new Set(['false', 'none', 'off', 'no']);

/**
 * Blanket trust has a numeric spelling too, and the keyword list above does not
 * catch it. `TRUSTED_PROXIES=0.0.0.0/1, 128.0.0.0/1` is exactly `trustProxy:
 * true` — proxy-addr accepts both halves, they tile the whole IPv4 space, and
 * every hop in the chain is therefore trusted, so `req.ip` becomes the leftmost
 * entry the client wrote. `2000::/3` does the same for global-unicast IPv6, and
 * a single wide block like `198.0.0.0/4` covers enough of the internet to hand
 * the forgery to anyone in it. Nothing about that reads as "trust everyone" at a
 * glance, which is what makes it worth refusing explicitly: it is the same
 * failure the keyword guard exists to prevent, and it fails just as silently.
 *
 * The rule is breadth, not routability. A trusted-proxy list names hops you
 * operate, and nobody operates sixteen million of them — but operators do
 * legitimately trust a public load-balancer fleet, so the check cannot simply
 * refuse public space. `/8` and `/32` are set where they are to leave real
 * fleets alone: a CDN's widest advertised IPv4 block is around a `/13` and an
 * ISP's IPv6 allocation around a `/32`, while the blanket spellings above all
 * sit far to the left of both.
 *
 * Blocks that lie wholly inside non-routable space are exempt at any width,
 * because that is what the default asks for under another name — `uniquelocal`
 * *is* `10.0.0.0/8` plus `fc00::/7`, and refusing the literal while shipping the
 * preset would only teach operators that the preset is the way around the check.
 */
const MIN_PREFIX: Record<number, number> = { 32: 8, 128: 32 };

/** Written wide on purpose, and safe at any width: none of it is routable. */
const NON_ROUTABLE = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

interface Block {
  /** 32 for IPv4, 128 for IPv6 — a v4 block never contains a v6 one. */
  bits: number;
  prefix: number;
  start: bigint;
  end: bigint;
}

function parseIpv4(text: string): bigint | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    // Leading zeros are tolerated rather than rejected: if proxy-addr reads
    // `010.0.0.0/1` as decimal we must reach the same number it does, and if it
    // refuses the address outright the process fails to boot either way. The
    // one outcome to avoid is parsing it differently and waving it through.
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6(text: string): bigint | undefined {
  if (!text.includes(':')) return undefined;

  // A trailing dotted quad (`::ffff:10.0.0.1`) becomes the two hex groups it
  // stands for, so the `::` expansion below has only one form to deal with.
  let body = text;
  const lastColon = body.lastIndexOf(':');
  const tail = body.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (v4 === undefined) return undefined;
    const hi = ((v4 >> 16n) & 0xffffn).toString(16);
    const lo = (v4 & 0xffffn).toString(16);
    body = `${body.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = body.split('::');
  if (halves.length > 2) return undefined;
  const groupsOf = (part: string): bigint[] | undefined => {
    if (part === '') return [];
    const out: bigint[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
      out.push(BigInt(parseInt(group, 16)));
    }
    return out;
  };
  const left = groupsOf(halves[0] ?? '');
  const right = halves.length === 2 ? groupsOf(halves[1] ?? '') : [];
  if (left === undefined || right === undefined) return undefined;

  const missing = 8 - left.length - right.length;
  // Only `::` may stand in for omitted groups; without it the eight must be written.
  if (halves.length === 2 ? missing < 0 : missing !== 0) return undefined;
  const filler = halves.length === 2 ? Array.from({ length: missing }, () => 0n) : [];

  let value = 0n;
  for (const group of [...left, ...filler, ...right]) value = (value << 16n) | group;
  return value;
}

/**
 * The address range `entry` covers, or undefined if it is not a literal address
 * — proxy-addr's named presets (`loopback`, `uniquelocal`) land here, and they
 * are fixed strings this file chose, not operator-supplied breadth.
 */
function parseBlock(entry: string): Block | undefined {
  const slash = entry.indexOf('/');
  const addr = slash === -1 ? entry : entry.slice(0, slash);
  const prefixText = slash === -1 ? undefined : entry.slice(slash + 1);

  const v4 = parseIpv4(addr);
  const value = v4 ?? parseIpv6(addr);
  if (value === undefined) return undefined;
  const bits = v4 !== undefined ? 32 : 128;

  let prefix = bits;
  if (prefixText !== undefined) {
    if (!/^\d{1,3}$/.test(prefixText)) return undefined;
    prefix = Number(prefixText);
    if (prefix > bits) return undefined;
  }

  const hostBits = BigInt(bits - prefix);
  const start = (value >> hostBits) << hostBits;
  return { bits, prefix, start, end: start + ((1n << hostBits) - 1n) };
}

function contains(outer: Block, inner: Block): boolean {
  return outer.bits === inner.bits && inner.start >= outer.start && inner.end <= outer.end;
}

/**
 * Resolve `TRUSTED_PROXIES` into a Fastify `trustProxy` option.
 *
 * Returns `false` when no hop is trusted — correct for a service exposed
 * directly, where the socket peer *is* the client.
 *
 * @throws if the value asks for blanket trust. Failing to boot is the right
 * answer: the alternative is a process that starts, looks healthy, and quietly
 * lets anyone forge the identity that every rate limit and audit row is keyed
 * on. There is no deployment of this system where that is what was meant.
 */
export function trustedProxies(env: NodeJS.ProcessEnv = process.env): string[] | false {
  const raw = env.TRUSTED_PROXIES?.trim();
  const configured = raw ? raw : DEFAULT_TRUSTED_PROXIES;
  const normalized = configured.toLowerCase();

  if (BLANKET_TRUST.has(normalized)) {
    throw new Error(
      `Invalid configuration: TRUSTED_PROXIES=${raw} would trust any X-Forwarded-For header, ` +
        'making every per-IP rate limit and audit entry client-controlled. ' +
        `Name the hops instead (default: "${DEFAULT_TRUSTED_PROXIES}"), or set TRUSTED_PROXIES=none ` +
        'if this service is exposed directly.',
    );
  }
  if (NO_TRUST.has(normalized)) return false;

  const hops = configured
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop !== '');
  if (hops.length === 0) {
    // Reachable only via a value that is all separators — ",", " , ". Treating
    // it as "unset" would silently restore full default trust for what is
    // plainly a typo, so it is refused like any other unusable value.
    throw new Error(
      `Invalid configuration: TRUSTED_PROXIES=${raw} names no hops. ` +
        'Set TRUSTED_PROXIES=none to trust none of them explicitly.',
    );
  }
  // A single blanket keyword mixed into a list is still blanket trust — the
  // list is a union, so one permissive entry decides the whole thing.
  const blanket = hops.find((hop) => BLANKET_TRUST.has(hop.toLowerCase()));
  if (blanket !== undefined) {
    throw new Error(
      `Invalid configuration: TRUSTED_PROXIES contains "${blanket}", which trusts any ` +
        'X-Forwarded-For header regardless of the other entries. Remove it.',
    );
  }

  // …and so is a block wide enough to say the same thing in numbers. Checked
  // per entry, for the same reason: the list is a union.
  const safe = NON_ROUTABLE.map(parseBlock).filter((block): block is Block => block !== undefined);
  for (const hop of hops) {
    const block = parseBlock(hop);
    if (block === undefined) continue; // a preset name; proxy-addr validates it
    if (block.prefix >= MIN_PREFIX[block.bits]!) continue;
    if (safe.some((range) => contains(range, block))) continue;
    throw new Error(
      `Invalid configuration: TRUSTED_PROXIES contains "${hop}", which spans ` +
        `${block.end - block.start + 1n} addresses of routable space. A trusted-proxy list names ` +
        'the hops you run, and a block that wide lets anyone inside it forge X-Forwarded-For — ' +
        `the same result as TRUSTED_PROXIES=true. Name the proxy addresses instead (default: ` +
        `"${DEFAULT_TRUSTED_PROXIES}").`,
    );
  }
  return hops;
}
