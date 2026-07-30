import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';

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

/** A single id-shaped route parameter. */
export const UlidParam = z
  .string()
  .refine(isUlid, { message: 'must be a 26-character Crockford-base32 ULID' });

/**
 * Parameter names carrying an id. Named explicitly rather than pattern-matched
 * on a `*id` suffix, because that would also catch parameters that are legally
 * not ULIDs and 404 every request to them.
 *
 * Deliberately excluded, all of which are real route parameters:
 *   :provider, :role, :slug, :key, :field_key, :dataType, :pipeline — lookup
 *   keys, not ids; :version — an integer report-version number; :n, :problem —
 *   test/diagnostic routes.
 */
export const ID_PARAM_NAMES: ReadonlySet<string> = new Set([
  'id',
  'pid', // fund position id
  'accessId',
  'commentId',
  'compareId',
  'documentId',
  'grantId',
  'memberId',
  'partnerId',
  'roundId',
  'scenarioId',
  'transactionId',
  'valuationId',
]);

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
