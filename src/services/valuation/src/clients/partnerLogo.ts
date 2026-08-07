/**
 * Fetches a partner logo for PDF embedding (improvement 8). Deliberately
 * strict: http(s) only, a public destination, 3s timeout, 1 MB cap, and
 * PNG/JPEG magic-byte sniffing (the only formats PDFKit can embed). Every
 * failure returns null — a missing logo must never block a report render.
 *
 * The destination check is the load-bearing one, and it was missing.
 * `partners.logo_url` is a stored, caller-supplied URL, and this is the one
 * place in the service where such a URL meets an outbound request: rendering
 * any report for that partner makes this process issue a GET to wherever the
 * URL points, from inside the private network, with the estate's own network
 * position. `http://169.254.169.254/latest/meta-data/`, `http://127.0.0.1:3001`
 * (the valuation service itself), `http://10.x` — all were reachable, all
 * triggered by an action as ordinary as downloading a PDF.
 *
 * The body is discarded unless it sniffs as PNG or JPEG, so this is a blind
 * SSRF rather than a read primitive; that is a mitigation, not a defence. A
 * blind GET still probes internal hosts and ports (a fetch that resolves
 * quickly versus one that times out is an answer) and still reaches every
 * internal endpoint that acts on a GET.
 */

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const MAX_LOGO_BYTES = 1024 * 1024;
const TIMEOUT_MS = 3_000;

/**
 * Redirect hops followed.
 *
 * `redirect: 'follow'` is what the guard cannot live with: undici resolves the
 * chain itself, so only the *first* URL would ever be checked and any host on
 * the internet could bounce this process to `169.254.169.254` with a one-line
 * 302. Following by hand is the only way each hop gets the same check as the
 * first. Three is generous for a CDN's canonicalisation and short enough that
 * a redirect loop is not a way to hold the render open.
 */
const MAX_REDIRECTS = 3;

export function sniffImageKind(buf: Buffer): 'png' | 'jpeg' | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))) {
    return 'png';
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  return null;
}

/** Resolves a hostname to the addresses a connection would actually use. */
export type HostResolver = (hostname: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/**
 * True for an IPv4 literal that is not routable on the public internet.
 *
 * Deliberately wider than "RFC 1918": the interesting targets from inside a
 * host are the loopback and link-local ranges, and 169.254.169.254 — the cloud
 * instance-metadata address every provider serves credentials from — is in
 * neither of the classic private blocks.
 */
export function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) return true; // not an address we can reason about
  const [a, b] = parts.map((p) => Number(p)) as [number, number, number, number];
  if (!Number.isInteger(a) || !Number.isInteger(b)) return true;
  if (a === 0) return true; // "this network" / unspecified
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. instance metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 carrier NAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/**
 * An IPv6 literal as its 16 bytes, or null if it is not one.
 *
 * Expanded rather than pattern-matched on the text, because the same address
 * has many spellings and the URL parser picks its own: `::ffff:127.0.0.1`
 * comes back out of `new URL()` as `::ffff:7f00:1`. A guard that matched the
 * dotted form and not the hex one would have refused the string an attacker
 * would never bother to type.
 */
function ipv6Bytes(address: string): Uint8Array | null {
  let addr = address;
  // A trailing dotted quad ("::ffff:127.0.0.1") is two groups; rewrite it to hex
  // before counting, so the `::` expansion below has the right group total.
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (dotted) {
    const quad = dotted[2]!.split('.').map(Number);
    if (quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((quad[0]! << 8) | quad[1]!).toString(16);
    const lo = ((quad[2]! << 8) | quad[3]!).toString(16);
    addr = `${dotted[1]}${hi}:${lo}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const split = (part: string) => (part === '' ? [] : part.split(':'));
  let groups: string[];
  if (halves.length === 2) {
    const head = split(halves[0]!);
    const tail = split(halves[1]!);
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // `::` stands for at least one group
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = split(addr);
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i]!)) return null;
    const value = Number.parseInt(groups[i]!, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

/** True for an IPv6 literal that is not routable on the public internet. */
export function isPrivateIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address.toLowerCase().split('%')[0]!); // drop any zone index
  if (!bytes) return true; // unparseable — refuse rather than guess

  const allZeroUntil = (n: number) => bytes.slice(0, n).every((b) => b === 0);
  if (allZeroUntil(15) && (bytes[15] === 0 || bytes[15] === 1)) return true; // :: and ::1

  // IPv4-mapped (::ffff:a.b.c.d) and 6to4 (2002:aabb:ccdd::) both carry a v4
  // address inside a v6 one; judge them by the address they really reach.
  if (allZeroUntil(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isPrivateIpv4(`${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`);
  }
  // 64:ff9b::/96 NAT64, likewise.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return true;

  const head = (bytes[0]! << 8) | bytes[1]!;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** True when this literal address must not be dialled from inside the estate. */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isPrivateIpv4(address);
  if (kind === 6) return isPrivateIpv6(address);
  return true; // not an address at all — refuse rather than guess
}

/**
 * Whether this URL may be dialled: http(s), and every address its host resolves
 * to is public.
 *
 * *Every* address, not the first: a hostname with an A record on the internet
 * and a AAAA record on `::1` would otherwise pass the check and connect to
 * loopback, since which family the runtime picks is not this function's call.
 *
 * There is a residual race — the name is resolved here and again by the socket,
 * and a DNS answer with a one-second TTL can differ between the two. Closing it
 * properly means pinning the connection to the address that was checked, which
 * `fetch` gives no way to do. The check still removes the whole class of
 * attacks that needs no timing at all, which is what a stored URL actually is.
 */
export async function isPublicHttpUrl(url: URL, resolve: HostResolver): Promise<boolean> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // A URL hostname keeps IPv6 in brackets; `isIP` wants it without.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) return false;
  if (isIP(hostname)) return !isPrivateAddress(hostname);
  // `localhost` frequently resolves through /etc/hosts to both 127.0.0.1 and
  // ::1, which the address check catches — but say so explicitly, because a
  // resolver that answers it differently must not be the deciding vote.
  const lower = hostname.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.internal')) return false;

  let addresses: string[];
  try {
    addresses = await resolve(lower);
  } catch {
    return false;
  }
  if (addresses.length === 0) return false;
  return addresses.every((a) => !isPrivateAddress(a));
}

export async function fetchPartnerLogo(
  logoUrl: string | null,
  fetchImpl: typeof fetch = fetch,
  resolve: HostResolver = defaultResolver,
): Promise<Buffer | null> {
  if (!logoUrl) return null;
  let url: URL;
  try {
    url = new URL(logoUrl);
  } catch {
    return null;
  }

  try {
    // One deadline for the whole chain, not one per hop: three redirects each
    // allowed their own 3s would hold a report render open for nine.
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!(await isPublicHttpUrl(url, resolve))) return null;
      res = await fetchImpl(url, { signal, redirect: 'manual' });
      if (res.status < 300 || res.status >= 400) break;
      const location = res.headers.get('location');
      if (!location) return null;
      // Relative Locations are legal and resolve against the hop that sent them.
      try {
        url = new URL(location, url);
      } catch {
        return null;
      }
      res = null;
    }
    if (!res) return null; // ran out of hops still being redirected
    if (!res.ok) return null;
    const length = Number(res.headers.get('content-length') ?? '0');
    if (length > MAX_LOGO_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_LOGO_BYTES) return null;
    return sniffImageKind(buf) ? buf : null;
  } catch {
    return null;
  }
}
