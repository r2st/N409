/**
 * A short-lived cache in front of `fetchPartnerLogo`.
 *
 * Rendering a report for a white-labelled engagement made this process resolve
 * the partner's logo hostname and GET the image — every render, for an asset
 * that changes when a partner uploads a new one and not otherwise. A firm
 * re-rendering a batch of reports paid a DNS lookup and an HTTP round trip per
 * document, on the critical path of the render, with a 3s ceiling each.
 *
 * The TTL is deliberately short. A logo swap should show up on the next
 * render-ish, not next deploy, and a stale logo on a signed PDF is a real (if
 * small) defect — so this trades a minute of staleness for the round trip,
 * rather than caching indefinitely.
 *
 * Failures are cached too, and that is the point rather than an oversight: a
 * partner whose logo URL 404s or points at a host that times out would
 * otherwise cost every single render the full timeout. The negative entry is
 * shorter-lived, so a fixed URL recovers quickly.
 *
 * In-process, so each replica keeps its own; there is nothing to invalidate
 * across the fleet and no coherence to lose — the worst case is two replicas
 * disagreeing for under a minute about an image.
 */

import { fetchPartnerLogo } from './partnerLogo.js';

const HIT_TTL_MS = 60_000;
const MISS_TTL_MS = 10_000;

interface Entry {
  logo: Buffer | null;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

/** Number of URLs held. Unbounded growth is bounded by the partner count. */
export function partnerLogoCacheSize(): number {
  return cache.size;
}

/** Drops every entry. For tests, and for an explicit operational flush. */
export function clearPartnerLogoCache(): void {
  cache.clear();
}

export async function fetchPartnerLogoCached(
  logoUrl: string | null,
  now: () => number = Date.now,
  fetchLogo: typeof fetchPartnerLogo = fetchPartnerLogo,
): Promise<Buffer | null> {
  if (!logoUrl) return null;
  const at = now();
  const hit = cache.get(logoUrl);
  if (hit && hit.expiresAt > at) return hit.logo;

  const logo = await fetchLogo(logoUrl);
  cache.set(logoUrl, { logo, expiresAt: at + (logo ? HIT_TTL_MS : MISS_TTL_MS) });
  return logo;
}
