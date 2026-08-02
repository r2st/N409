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
  return hops;
}
