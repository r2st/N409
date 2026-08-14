/**
 * Is this address one this process must not dial?
 *
 * The single classifier behind both outbound-request guards in the service —
 * the partner logo fetch (`clients/partnerLogo.ts`) and partner webhook
 * delivery (`domain/partnerWebhooks.ts`). It used to be two, written
 * independently, and they disagreed: the webhook one matched IPv6 on the text
 * of the address, which is the mistake the note on `ipv6Bytes` below explains,
 * so `::ffff:7f00:1` — the form `new URL()` produces from
 * `http://[::ffff:127.0.0.1]/` — was classified public and a loopback target
 * registered cleanly. Two implementations of one security rule is one of them
 * being wrong, and the wrong one is always the one nobody looks at.
 *
 * Everything here is a pure function of the address text, so both callers can
 * use it: the deployment-specific parts (does this deployment allow private
 * targets at all, what does the name resolve to) stay with the caller.
 */

import { isIP } from 'node:net';

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
  // Plain decimal only, and in range. `Number()` on its own accepts `0x7f`,
  // ` 10 ` and `1e2`, which is three more spellings of an octet than an
  // address has — and a classifier that reads a spelling it should have
  // refused is one an attacker only has to confuse rather than defeat.
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  if (octets.some((n) => !Number.isInteger(n) || n > 255)) return true;
  const [a, b] = octets as [number, number, number, number];
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

/**
 * True when this literal address must not be dialled from inside the estate.
 *
 * Accepts a bare literal. A URL's `hostname` keeps IPv6 in brackets and a
 * resolver may hand back a zone index; strip those at the call site, since
 * what counts as a host string differs between the two callers.
 */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isPrivateIpv4(address);
  if (kind === 6) return isPrivateIpv6(address);
  return true; // not an address at all — refuse rather than guess
}
