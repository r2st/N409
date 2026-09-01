import type { FastifyInstance } from 'fastify';
import { problems } from '@n409/shared';
import { ulidField } from '../domain/ulidField.js';

/**
 * Route-parameter validation.
 *
 * Handlers reach for `req.params as { id: string }` in ~190 places and then pass
 * that string to a repo. Fastify does not check it, so the cast is a promise the
 * request never made: `id` is whatever was in the URL. Individual handlers each
 * had to remember an `isUlid` guard, and most did not — leaving the id to reach
 * SQL and be rejected by the `ulid` domain, which surfaces as a 500 and, on the
 * public token-authenticated routes, as a free error-message oracle.
 *
 * A single hook is the fix rather than ~190 per-handler guards: it cannot be
 * forgotten by the next route added.
 *
 * NOTE ON FORMAT: these ids are ULIDs, not UUIDs — `newUlid()` mints them and
 * migration 0001 pins the column type to
 * `CREATE DOMAIN ulid AS text CHECK (VALUE ~ '^[0-9A-HJKMNP-TV-Z]{26}$')`.
 * Validating them as UUIDs would reject every id the platform has ever issued.
 */

/**
 * A single id-shaped route parameter.
 *
 * The same rule `domain/ulidField.ts` applies to an id carried in a body, and
 * deliberately the same definition: two spellings of "is this an id" that could
 * drift is how one door ends up stricter than the one beside it.
 */
export const UlidParam = ulidField();

/**
 * Parameter names carrying an id. Named explicitly rather than pattern-matched
 * on a `*id` suffix, because that would also catch parameters that are legally
 * not ULIDs and 404 every request to them.
 *
 * An id-shaped parameter missing from this set is the exact failure the hook
 * was written to end — it falls back to whatever guard its handler happens to
 * carry, which is the arrangement that left most handlers without one. So the
 * set is not merely a list to extend by hand: `NON_ID_PARAM_NAMES` below names
 * every parameter that is deliberately *not* an id, and the two together must
 * cover every parameter the app registers. `routeParamNames` and the security
 * regression test over it are what hold that.
 */
export const ID_PARAM_NAMES: ReadonlySet<string> = new Set([
  'id',
  'pid', // fund position id
  'accessId',
  'calculationId',
  'commentId',
  'compareId',
  // Partner API. Its path is written `{deliveryId}` in the OpenAPI table and
  // converted to `:deliveryId` at registration, so it is invisible to a grep
  // for route literals — which is how it stayed off this list.
  'deliveryId',
  'documentId',
  'estimateId', // volatility estimate
  'grantId',
  'itemId', // comparable item / network item
  'memberId',
  'partnerId',
  'paymentId',
  'projectionId',
  'roundId',
  'runId', // roll-forward run
  'scenarioId',
  'transactionId',
  'valuationId',
]);

/**
 * Parameters that are legitimately not ULIDs, with what each one is.
 *
 * Exists so the partition can be asserted: a new route parameter has to be
 * classified as one or the other, and cannot arrive as an unguarded id by
 * being neither.
 */
export const NON_ID_PARAM_NAMES: ReadonlySet<string> = new Set([
  'provider', // accounting / cap-table / HRIS provider key
  'role', // role key
  'slug', // blog post slug
  'key', // partner or branding lookup key
  'field_key', // override cell key
  'dataType', // retention data type
  'pipeline', // pipeline name
  'kind', // valuation kind
  'source', // lead/traffic source
  'version', // integer report-version number
  'n', // diagnostic routes
  'problem', // diagnostic routes
  // The suppressed email address itself, on the admin release route. An
  // address, not an id: guarding it as a ULID would 404 every real release.
  'address',
]);

/**
 * The distinct `:name` parameters in a set of route patterns
 * (`app.routeAudit.all()` supplies the real ones).
 */
export function routeParamNames(routes: readonly string[]): string[] {
  const names = new Set<string>();
  for (const route of routes) {
    for (const match of route.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1]!);
  }
  return [...names].sort();
}

/** Offending parameter names, empty when everything id-shaped is a valid ULID. */
export function invalidIdParams(
  params: unknown,
  idParamNames: ReadonlySet<string> = ID_PARAM_NAMES,
): string[] {
  if (params == null || typeof params !== 'object') return [];
  const bad: string[] = [];
  for (const [name, value] of Object.entries(params as Record<string, unknown>)) {
    if (!idParamNames.has(name)) continue;
    if (!UlidParam.safeParse(value).success) bad.push(name);
  }
  return bad;
}

/**
 * Rejects malformed ids before any handler runs.
 *
 * 404, not 422: a syntactically impossible id cannot name a row, and this is
 * the answer `loadValuation` and friends already give for one
 * (`if (!isUlid(id)) throw problems.notFound()`). It also keeps the public
 * token-authenticated routes from distinguishing "malformed" from "not yours",
 * which is the whole point of answering 404 there.
 *
 * `preValidation` rather than `preHandler`, so a bad id costs nothing: it is
 * turned away before body parsing, authentication and rate limiting.
 */
export function registerParamValidation(
  app: FastifyInstance,
  opts: { idParams?: ReadonlySet<string> } = {},
): void {
  const idParamNames = opts.idParams ?? ID_PARAM_NAMES;
  app.addHook('preValidation', async (req) => {
    const bad = invalidIdParams(req.params, idParamNames);
    if (bad.length === 0) return;
    // Logged, not returned: the client learns only that there is no such row.
    req.log.debug({ params: bad, url: req.url }, 'rejected malformed id route parameter');
    throw problems.notFound();
  });
}
