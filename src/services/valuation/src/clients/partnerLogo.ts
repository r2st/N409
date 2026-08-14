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
import { isPrivateAddress, isPrivateIpv4, isPrivateIpv6 } from '../domain/privateAddress.js';

/*
 * Re-exported rather than re-implemented. These used to live here, and a
 * second copy of them grew in domain/partnerWebhooks.ts for the other
 * outbound-request guard — see the note at the top of domain/privateAddress.ts
 * for what the copies disagreed about. Kept exported from here because this is
 * where the SSRF note lives and where callers look for them.
 */
export { isPrivateAddress, isPrivateIpv4, isPrivateIpv6 };

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
