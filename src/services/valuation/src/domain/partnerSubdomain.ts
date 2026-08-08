/**
 * Partner subdomains (migration 0106) — resolving a white-label firm from the
 * host a client typed.
 *
 * Pure string work, deliberately: the resolution runs on every unauthenticated
 * page load of every tenant, and the only thing standing between a Host header
 * and a database lookup is this file. A Host header is attacker-controlled, so
 * everything here is written to reject rather than repair.
 */

/**
 * Names that must never resolve to a partner, whatever a firm asks for.
 *
 * Two separate reasons, and both matter. The infrastructure names (`www`,
 * `api`, `app`, `admin`, `mail`, …) are ours and would be shadowed by a tenant
 * claiming them. The credibility names (`secure`, `login`, `billing`,
 * `support`) are what a phishing page wants to be called — `secure.<our
 * domain>` in an address bar is worth more to an attacker than any amount of
 * page content, and self-service subdomain registration is how they would get
 * it.
 */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  'www',
  'api',
  'app',
  'admin',
  'onboard',
  'docs',
  'help',
  'support',
  'status',
  'blog',
  'mail',
  'smtp',
  'imap',
  'ftp',
  'ns',
  'ns1',
  'ns2',
  'cdn',
  'static',
  'assets',
  'staging',
  'dev',
  'test',
  'demo',
  'internal',
  'secure',
  'login',
  'signin',
  'auth',
  'sso',
  'account',
  'accounts',
  'billing',
  'pay',
  'payments',
  'partner',
  'partners',
  'n409',
]);

/** RFC 1123 label: 3–63 chars, lowercase alphanumerics and hyphens, no edge hyphen. */
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$/;

export function isWellFormedSubdomain(value: string): boolean {
  return SUBDOMAIN_RE.test(value);
}

export type SubdomainProblem = 'malformed' | 'reserved';

/**
 * Normalizes a firm's requested subdomain, or says why it cannot have it.
 *
 * Case and surrounding whitespace are forgiven — a firm typing "Acme " means
 * `acme` and telling them otherwise is pedantry. Nothing else is: an
 * underscore or a trailing hyphen produces a name DNS will not serve, and
 * silently rewriting it hands the firm an address different from the one they
 * asked for.
 */
export function normalizeSubdomain(input: string): { subdomain: string } | { problem: SubdomainProblem } {
  const candidate = input.trim().toLowerCase();
  if (!isWellFormedSubdomain(candidate)) return { problem: 'malformed' };
  if (RESERVED_SUBDOMAINS.has(candidate)) return { problem: 'reserved' };
  return { subdomain: candidate };
}

/**
 * The tenant label in a Host header, or null when the host is not a tenant
 * address.
 *
 * `baseDomain` is the suffix tenants live under (`app.409.ai`), so
 * `acme.app.409.ai` yields `acme`. Everything else yields null: the bare base
 * domain (that is the platform itself), a deeper label like `a.b.app.409.ai`
 * (we issue exactly one level, so anything deeper is either a mistake or
 * someone probing), and any host outside the base domain entirely.
 *
 * The port is stripped, the case is folded, and a trailing dot — legal in a
 * Host header and absolutely something a scanner will send — is dropped, so
 * `ACME.App.409.ai.:443` resolves the same tenant as `acme.app.409.ai`. Without
 * that last step the same tenant has two spellings and only one of them works.
 */
export function subdomainFromHost(host: string | undefined | null, baseDomain: string): string | null {
  if (!host || !baseDomain) return null;

  // IPv6 literals arrive bracketed ([::1]:3000) and never carry a tenant.
  if (host.startsWith('[')) return null;

  const hostname = host.split(':')[0]!.trim().toLowerCase().replace(/\.$/, '');
  const base = baseDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!hostname || !base) return null;

  if (!hostname.endsWith(`.${base}`)) return null;
  const label = hostname.slice(0, -(base.length + 1));

  // Exactly one label deep, and well-formed. A reserved name is *not* rejected
  // here: this function reports what the host says, and refusing to look up
  // `admin.app.409.ai` is the lookup's business — a reserved name simply has no
  // partner row, because normalizeSubdomain never let one be stored.
  if (label.includes('.')) return null;
  return isWellFormedSubdomain(label) ? label : null;
}
