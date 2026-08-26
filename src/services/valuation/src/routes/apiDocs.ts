import type { FastifyInstance } from 'fastify';
import { PROBLEM_CATALOG, buildInfo } from '@n409/shared';
import { buildClientOpenApiDocument } from '../domain/apiCatalog.js';
import { PUBLIC_ROUTES } from '../plugins/routeAudit.js';

/**
 * The two self-describing documents for the client API: the endpoint inventory
 * and the error catalog.
 *
 * Both are public, and that is the point rather than an oversight. Documentation
 * behind a credential is useless to the person whose credential is what is
 * failing — the first thing somebody does with a 403 they do not understand is
 * look up what it means, and being told to authenticate first is a loop. Neither
 * document contains anything about an engagement, a person or a tenant: one is
 * the shape of the URL space, which is already discoverable by trying URLs, and
 * the other is a fixed vocabulary that ships in the binary.
 *
 * Rebuilt per request rather than memoised. Both are pure functions of in-memory
 * structures, the endpoints are cold, and a cached document is one more thing
 * that can be stale — the partner spec made the same call for the same reasons.
 */
export function registerApiDocsRoutes(app: FastifyInstance): void {
  /**
   * `PUBLIC_ROUTES` keyed the way `routeAudit` keys a route, so the generator
   * can attach each reason to the operation it was written about.
   */
  const publicReasons = new Map(
    PUBLIC_ROUTES.map((route) => [`${route.method.toUpperCase()} ${route.url}`, route.reason]),
  );

  app.get('/api/v1/openapi.json', async (_req, reply) => {
    const document = buildClientOpenApiDocument({
      routes: app.routeAudit.all(),
      authenticated: new Set(app.routeAudit.authenticated()),
      publicReasons,
      // The build's commit, not a hand-kept number. A spec version that has to
      // be bumped by hand is a spec version that says 1.0.0 forever, and the
      // question a reader actually has — "is this the deployment I am calling"
      // — is answered by the sha the same `/health` reports.
      version: buildInfo().sha,
    });
    // The registered media type for an OpenAPI document; tools content-sniff on
    // it, and `application/json` makes some of them ask the user what the file is.
    return reply.header('content-type', 'application/openapi+json; charset=utf-8').send(document);
  });

  app.get('/api/v1/problems', async () => ({
    // An array rather than the keyed object, because a client walking this to
    // build a lookup table wants the entries and a JSON object keyed by URN is
    // awkward in several of the languages that will read it. `type` is repeated
    // inside each entry precisely so this projection loses nothing.
    problems: Object.values(PROBLEM_CATALOG),
  }));
}
