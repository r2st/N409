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

/**
 * Cloudflare's published edge ranges, as the named hop `cloudflare`.
 *
 * WHY THIS IS HERE. 409.doaide.com resolves to Cloudflare, not to the origin:
 * the A record is proxied (orange cloud), which the infra/caddy README says it
 * must not be and which nothing has ever checked. So the chain in production is
 * `client → Cloudflare edge → Caddy → web`, and the edge is a hop this list did
 * not name. proxy-addr walks in from the socket, finds 127.0.0.1 (trusted),
 * steps left to the Cloudflare address (not trusted), and stops there — so
 * `req.ip` is a Cloudflare datacenter for every request on the internet.
 *
 * That is exactly the failure the header comment above describes, one hop
 * further out, and it was live. Measured rather than reasoned: a request from
 * 49.43.232.92 was logged by n409-web as `remoteAddress: 104.23.175.42`. Every
 * throttle keyed on `req.ip` was therefore keyed on a Cloudflare POP shared by
 * everyone routed through it — `login-ip:` and `register-ip:` and
 * `reset-ip:` included, so one person's failed logins consumed a stranger's
 * budget, and an attacker moving between POPs got a fresh one each time.
 *
 * THE TRADE THIS MAKES, stated plainly because it is a real one. Every other
 * entry in the default list is unroutable, so nothing on the internet can
 * occupy one and forge a header. These ranges are routable, and code running on
 * Cloudflare — a Worker, say — can reach this origin directly by IP and would
 * then be a trusted hop able to name any client it likes. The complete fix is
 * to accept 80/443 at the origin only from these same ranges. That is not done
 * here, and deliberately not shipped as an unapplied script either — this
 * host's Caddy serves two unrelated products from the same ports, and locking
 * those to Cloudflare is not this repo's call to make. It is written down as an
 * open item in infra/DEPLOYMENT.md instead, where it can be decided rather than
 * accidentally run.
 *
 * It is still strictly better than what it replaces. Today the per-IP limits
 * are one shared bucket and defeating them takes no effort at all; after this
 * they are per-client, and defeating them takes an attacker who both runs code
 * inside Cloudflare and knows the origin address.
 *
 * REFRESHING. Fetched 2026-08-21 from https://www.cloudflare.com/ips-v4 and
 * .../ips-v6, which are the authoritative lists. They change rarely; when they
 * do, a removed range means a Cloudflare POP stops being trusted and its
 * traffic is attributed to the edge again — the old bug, narrowed to one POP —
 * so this is worth re-checking at the same time as any other annual review.
 * `clientIp.test.ts` pins the shapes, not the values, so a refresh does not
 * fight the test suite.
 */
export const CLOUDFLARE_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

/** The token that expands to {@link CLOUDFLARE_RANGES}. */
const CLOUDFLARE_TOKEN = 'cloudflare';

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

/** The IPv4-mapped range `::ffff:0:0/96` — every IPv4 address, spelled as IPv6. */
const V4_MAPPED_START = 0xffff00000000n;
const V4_MAPPED_END = V4_MAPPED_START + 0xffffffffn;

/**
 * The IPv4 space an IPv6 block also grants, or undefined if it grants none.
 *
 * The breadth check above counts prefix bits, and for a v4-mapped block that
 * counts the wrong thing: `::ffff:0.0.0.0/96` is a `/96`, sails past the `/32`
 * IPv6 floor, and is every IPv4 address there is. Nor is that a spelling only a
 * pedant would reach for — it is how a dual-stack listener reports IPv4 peers
 * (`::ffff:203.0.113.9`), so it is the natural thing to write after reading a
 * log line, and proxy-addr converts across families in both directions, so it
 * really does trust all of IPv4. `TRUSTED_PROXIES=::ffff:0.0.0.0/96` was
 * therefore `trustProxy: true` under a name that looks narrow — the same
 * failure the numeric guard exists to catch, one family over.
 *
 * Intersecting rather than requiring containment is what makes it hold for the
 * blocks written *around* the mapped range too: `::ffff:0.0.0.0/95` and `::/0`
 * grant all of IPv4 just as completely while being IPv6 blocks in their own
 * right, and only the overlap says so.
 */
function v4Equivalent(block: Block): Block | undefined {
  if (block.bits !== 128) return undefined;
  const start = block.start > V4_MAPPED_START ? block.start : V4_MAPPED_START;
  const end = block.end < V4_MAPPED_END ? block.end : V4_MAPPED_END;
  if (start > end) return undefined;
  // CIDR blocks are power-of-two aligned, so the overlap is one too.
  let prefix = 32;
  for (let size = end - start + 1n; size > 1n; size >>= 1n) prefix--;
  return { bits: 32, prefix, start: start - V4_MAPPED_START, end: end - V4_MAPPED_START };
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
    // An IPv6 block is measured twice: once as itself, and once as the IPv4
    // space it reaches through the mapped range. Either one being too wide is
    // the same bug, so either one refuses the whole list.
    for (const span of [block, v4Equivalent(block)]) {
      if (span === undefined) continue;
      if (span.prefix >= MIN_PREFIX[span.bits]!) continue;
      if (safe.some((range) => contains(range, span))) continue;
      const mapped = span !== block ? ' of IPv4, via the ::ffff:0:0/96 mapped range,' : ' of routable';
      throw new Error(
        `Invalid configuration: TRUSTED_PROXIES contains "${hop}", which spans ` +
          `${span.end - span.start + 1n} addresses${mapped} space. A trusted-proxy list names ` +
          'the hops you run, and a block that wide lets anyone inside it forge X-Forwarded-For — ' +
          `the same result as TRUSTED_PROXIES=true. Name the proxy addresses instead (default: ` +
          `"${DEFAULT_TRUSTED_PROXIES}").`,
      );
    }
  }
  // Expanded last, and deliberately after the width check above rather than
  // before it.
  //
  // `2a06:98c0::/29` is wider than MIN_PREFIX allows, and refusing it would be
  // right if an operator had typed it: that guard exists to catch a human
  // writing a block wider than they meant. This is not that. It is a vetted
  // constant, fetched from the vendor that publishes it, and the reason it is a
  // named token rather than twenty-two CIDRs in an env file is precisely so it
  // does not have to be retyped — and so the one entry a width rule would
  // reject cannot be quietly dropped by whoever is retyping it. Anything the
  // operator writes literally is still measured.
  return hops.flatMap((hop) => (hop.toLowerCase() === CLOUDFLARE_TOKEN ? CLOUDFLARE_RANGES : [hop]));
}
