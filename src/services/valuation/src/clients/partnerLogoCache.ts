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

import { fetchPartnerLogo, type LogoLogger } from './partnerLogo.js';

const HIT_TTL_MS = 60_000;
const MISS_TTL_MS = 10_000;

/**
 * Ceiling on held URLs.
 *
 * The original comment here said growth was "bounded by the partner count",
 * and that was not quite what the map does: the key is the *URL*, not the
 * partner, so every logo swap mints a new key and the superseded one stays for
 * as long as the process lives. Expiry alone never removed it either — an
 * expired entry was skipped on read and left in place, so the map only ever
 * grew. Neither is fast growth, but "slow and monotonic" is the shape that
 * shows up as a restart every few months rather than as a bug.
 *
 * Far above any real partner roster, so eviction is a backstop and not
 * something a normal deployment reaches. Least-recently-used, which `touch`
 * below maintains for free by re-inserting: the Map's own iteration order then
 * *is* LRU order, with no second index and no sort.
 */
const MAX_ENTRIES = 512;

interface Entry {
  logo: Buffer | null;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

/**
 * In-flight fetches, keyed the same way — the half the cache was missing.
 *
 * A cache with no in-flight map only helps the *second* render. The shape this
 * exists for is a firm re-rendering a batch of reports, and those go out
 * together: on a cold entry every one of them missed, and every one of them
 * ran its own DNS lookup and HTTP GET for the same image, concurrently, each
 * with the same 3s ceiling. So the exact workload the cache was written for
 * was the one it did the least for, and a partner whose logo host had gone
 * slow could still stall a whole batch at once.
 *
 * Collapsing them means the first render pays and the rest await its result.
 * A rejection is not cached: the entry is only written on success, and the
 * slot is cleared either way so a throw cannot wedge the URL permanently.
 * (`fetchPartnerLogo` reports failure as `null`, which *is* cached — see the
 * negative TTL above. This is the belt for the case where it throws instead.)
 */
const inflight = new Map<string, Promise<Buffer | null>>();

/** Number of URLs held. Bounded by MAX_ENTRIES. */
export function partnerLogoCacheSize(): number {
  return cache.size;
}

/** Drops every entry. For tests, and for an explicit operational flush. */
export function clearPartnerLogoCache(): void {
  cache.clear();
  inflight.clear();
}

/** Writes `key` at the back of the LRU order, dropping the dead and the oldest. */
function store(key: string, entry: Entry, at: number): void {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size <= MAX_ENTRIES) return;
  // Expired first: dropping those is free, and at this size the scan is too.
  for (const [k, e] of cache) if (e.expiresAt <= at) cache.delete(k);
  // Then oldest-touched, until the ceiling holds. Never the incoming key —
  // it is at the back, so the iteration reaches it last.
  for (const k of cache.keys()) {
    if (cache.size <= MAX_ENTRIES) break;
    cache.delete(k);
  }
}

/**
 * Where a failed logo fetch is reported, or null to report nowhere.
 *
 * A module-level sink rather than a parameter, for the reason
 * `configureReportRenderer` gives about the renderer it sits beside: the caller
 * is `brandingFor` in routes/reports.ts, which is reached through
 * `renderVersionPdf` and `deliverablePdf` from five more places, and widening
 * all of them to carry a logger would be a lot of plumbing to reach one call.
 *
 * Unset in tests, so a suite asserting on nulls stays quiet.
 */
let logoLog: LogoLogger | null = null;

export function configurePartnerLogoLogging(log: LogoLogger | null): void {
  logoLog = log;
}

export async function fetchPartnerLogoCached(
  logoUrl: string | null,
  now: () => number = Date.now,
  fetchLogo: typeof fetchPartnerLogo = fetchPartnerLogo,
  log: LogoLogger | null = logoLog,
): Promise<Buffer | null> {
  if (!logoUrl) return null;
  const at = now();
  const hit = cache.get(logoUrl);
  // A cached miss is deliberately silent. The negative TTL exists so a dead
  // logo host is dialled once rather than once per render, and re-reporting the
  // same failure off a cache entry would turn one broken partner into a line
  // per report — the shape that gets a log muted. The line is written by the
  // fetch that discovered it, once per MISS_TTL_MS.
  if (hit && hit.expiresAt > at) return hit.logo;

  const pending = inflight.get(logoUrl);
  if (pending) return pending;

  const load = fetchLogo(logoUrl, undefined, undefined, log ?? undefined).then(
    (logo) => {
      inflight.delete(logoUrl);
      // `now()` again rather than `at`: the fetch took time, and a TTL counted
      // from before it means a slow host gets a shorter cache than a fast one.
      const settledAt = now();
      store(logoUrl, { logo, expiresAt: settledAt + (logo ? HIT_TTL_MS : MISS_TTL_MS) }, settledAt);
      return logo;
    },
    (err: unknown) => {
      inflight.delete(logoUrl);
      throw err;
    },
  );
  inflight.set(logoUrl, load);
  return load;
}
