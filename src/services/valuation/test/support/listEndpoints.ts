import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRoutes, type SourceRoute } from './routeSource.js';

/**
 * The collection endpoints, and the guard that keeps the list from falling
 * behind the service.
 *
 * `listQueryScaling.test.ts` calls each of these twice — once with a few rows
 * behind it, once with four times as many — and fails if the second call costs
 * more statements than the first. That is the population guard beside
 * `batchedReads.test.ts`'s three named regressions, and it is worth exactly as
 * much as its list is complete.
 *
 * The list was hand-maintained and stood inside the integration file, which
 * has two consequences that both showed up:
 *
 *   * it goes stale silently. Thirteen collection endpoints were added after
 *     the list was written — the admin billing dashboard, the plan catalogue,
 *     the firm's intake links, the grant templates, the tag catalogue, the
 *     token consoles, `/me/billing`, `/me/subscription`, the user picker and
 *     the user export among them — and none of them was ever measured. A
 *     missing endpoint does not fail; it is simply not asked, which is the
 *     failure mode of every hand-kept roster in this repo; and
 *   * it could only be checked where a database is up. The suite that would
 *     have noticed the drift skips itself entirely on a machine with no
 *     Postgres, so on those machines the roster had no guard at all.
 *
 * So the roster moves here, next to a source scan of the route table, and
 * `listScalingCoverage.test.ts` — a unit test, no database — requires every
 * collection route the service registers to be either measured or named as
 * deliberately unmeasured. Adding a list endpoint now fails a test until
 * somebody decides which it is.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROUTES_DIR = path.resolve(here, '../../src/routes');

/**
 * The measured endpoints, as `[label, url]`. `:partner` is substituted with
 * the seeded firm so the partner-scoped consoles — which answer 400 to an ops
 * caller without one — are measured rather than skipped.
 */
export const SCALING_ENDPOINTS: Array<[string, string]> = [
  ['valuations', '/api/v1/valuations?per_page=50'],
  ['valuations (sorted)', '/api/v1/valuations?per_page=50&sort=company_name:asc'],
  ['valuations counts', '/api/v1/valuations/counts'],
  ['valuations export', '/api/v1/valuations/export'],
  ['engagements', '/api/v1/engagements?per_page=50'],
  ['inbox', '/api/v1/inbox?per_page=50'],
  ['tasks', '/api/v1/tasks'],
  ['reviews', '/api/v1/reviews'],
  ['search', '/api/v1/search?q=Scaling'],
  ['stats dashboard', '/api/v1/stats/dashboard'],
  ['firm dashboard', '/api/v1/firm/dashboard?partner_id=:partner'],
  ['firm clients', '/api/v1/firm/clients?partner_id=:partner'],
  ['firm attention', '/api/v1/firm/attention?partner_id=:partner'],
  ['firm intake links', '/api/v1/firm/intake-links?partner_id=:partner'],
  ['partner valuations', '/api/v1/partners/:partner/valuations'],
  ['organizations', '/api/v1/organizations'],
  ['monitors', '/api/v1/monitors'],
  ['notifications', '/api/v1/notifications'],
  ['saved views', '/api/v1/saved-views'],
  ['funds', '/api/v1/funds'],
  ['debt instruments', '/api/v1/debt/instruments'],
  ['report templates', '/api/v1/report-templates'],
  ['grant templates', '/api/v1/grant-templates'],
  ['tag catalogue', '/api/v1/tag-catalogue'],
  ['blog posts', '/api/v1/blog/posts'],
  ['help articles', '/api/v1/help/articles'],
  ['support messages', '/api/v1/support/messages'],
  ['contact submissions', '/api/v1/contact/submissions'],
  ['billing plans', '/api/v1/billing/plans'],
  ['my subscription', '/api/v1/me/subscription'],
  ['my billing', '/api/v1/me/billing'],
  ['my tokens', '/api/v1/me/tokens'],
  ['users', '/api/v1/users'],
  ['users export', '/api/v1/users/export'],
  ['user options', '/api/v1/users/options'],
  ['user invitations', '/api/v1/users/invitations'],
  ['partners', '/api/v1/partners'],
  ['admin events', '/api/v1/admin/events'],
  ['admin jobs', '/api/v1/admin/jobs'],
  ['admin job alerts', '/api/v1/admin/jobs/alerts'],
  ['admin billing', '/api/v1/admin/billing'],
  ['admin blog posts', '/api/v1/admin/blog/posts'],
  ['admin email outbox', '/api/v1/admin/email-outbox'],
  ['admin email suppressions', '/api/v1/admin/email/suppressions'],
  ['admin email delivery stats', '/api/v1/admin/email/delivery-stats'],
  ['admin document triage', '/api/v1/admin/documents/triage'],
  ['admin data remediation', '/api/v1/admin/data-remediation'],
  ['admin retention policies', '/api/v1/admin/retention/policies'],
  ['admin retention actions', '/api/v1/admin/retention/actions'],
  ['admin retention holds', '/api/v1/admin/retention/holds'],
  ['admin retired valuations', '/api/v1/admin/retention/valuations/retired'],
  ['admin prompts', '/api/v1/admin/prompts'],
  ['admin narrative prompts', '/api/v1/admin/narrative-prompts'],
  ['admin auto-emails', '/api/v1/admin/auto-emails'],
  ['admin communication templates', '/api/v1/admin/communication-templates'],
  ['admin api tokens', '/api/v1/admin/api-tokens'],
  ['admin scim tokens', '/api/v1/admin/sso/scim-tokens'],
  ['admin webhook delivery stats', '/api/v1/admin/webhooks/deliveries/stats'],
  ['admin failed webhook deliveries', '/api/v1/admin/webhooks/deliveries/failed'],
  ['admin system metrics', '/api/v1/admin/system/metrics'],
];

/**
 * Collection endpoints deliberately outside the measurement, with what makes
 * measuring them the wrong thing rather than an omission.
 *
 * The bar is the same one `unboundedListCensus` sets for an uncapped read: a
 * mechanism, not a hope. "It is small" is not a reason to leave an endpoint
 * unmeasured — a per-row query on a small list is the same defect waiting for
 * the list to grow, which is what this whole file exists to catch.
 */
export const UNMEASURED: Record<string, string> = {};

/**
 * Every GET route that answers with a collection.
 *
 * Two conditions, and the second is what makes the population the right one:
 * the URL names no row (a `:id` route answers about one thing, and its cost
 * does not scale with the table), and the handler reaches a `list…`/`search…`
 * helper — this service's own naming convention for a read that returns many
 * rows. Keyed on the convention rather than on the response shape because the
 * response shape is not in the source: a handler returns `{ funds }` and what
 * makes `funds` many rows is the function that produced it.
 */
export function collectionRoutes(): SourceRoute[] {
  return scanRoutes(ROUTES_DIR)
    .filter((r) => r.method === 'GET' && !r.url.includes(':'))
    .filter((r) => /\b(?:list|search)[A-Z]\w*\s*\(/.test(r.body));
}

/** The path half of a measured URL — the query string is the test's, not the route's. */
export function pathOf(url: string): string {
  return url.split('?')[0]!;
}

/** A URL with its path parameters flattened, so `:partner` and `:id` compare equal. */
export function shapeOf(url: string): string {
  return pathOf(url)
    .split('/')
    .map((segment) => (segment.startsWith(':') ? ':*' : segment))
    .join('/');
}
