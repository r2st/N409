import type { FastifyInstance } from 'fastify';

/**
 * Boot-time guard against an unauthenticated endpoint reaching production.
 *
 * Every route this service registers must either run through
 * `app.authenticate` or appear in PUBLIC_ROUTES below with a reason. The check
 * runs on `onReady`, so a route that forgets its `preHandler` fails the
 * process at start-up instead of quietly serving a client's valuation to
 * anyone who knows the id.
 *
 * That "forgets its preHandler" case is the whole point: authorization in this
 * service lives inside the handler (`requirePrincipal` + an rbac predicate),
 * and `requirePrincipal` only throws because `app.authenticate` never ran and
 * left `req.principal` null. A missing preHandler is therefore a 401, not a
 * leak — until a handler reads something before it calls `requirePrincipal`,
 * which is exactly the mistake nobody notices in review.
 */

/** A route that is deliberately reachable without a session, and why. */
interface PublicRoute {
  method: string;
  url: string;
  /** How the route authenticates instead, or why it needs no authentication. */
  reason: string;
}

export const PUBLIC_ROUTES: readonly PublicRoute[] = [
  // Liveness/readiness — scraped by systemd and the reverse proxy.
  { method: 'GET', url: '/', reason: 'service banner naming the health endpoints' },
  { method: 'GET', url: '/health', reason: 'liveness probe' },
  { method: 'GET', url: '/ready', reason: 'readiness probe' },
  {
    method: 'GET',
    url: '/metrics',
    reason:
      'Prometheus scrape; gated on METRICS_TOKEN/INTERNAL_SERVICE_TOKEN, and unregistered in production without one',
  },

  // Sign-in and account recovery: the routes that mint a session cannot
  // require one. Each is rate-limited and validates its own credential.
  { method: 'POST', url: '/api/v1/auth/register', reason: 'creates the account' },
  { method: 'POST', url: '/api/v1/auth/login', reason: 'mints the session' },
  {
    method: 'POST',
    url: '/api/v1/auth/mfa/verify',
    reason: 'second factor, authenticated by the MFA challenge token',
  },
  { method: 'POST', url: '/api/v1/auth/logout', reason: 'clears the cookie; safe without a valid session' },
  { method: 'GET', url: '/api/v1/auth/providers', reason: 'which sign-in buttons to render' },
  { method: 'GET', url: '/api/v1/auth/google', reason: 'OIDC redirect start' },
  {
    method: 'GET',
    url: '/api/v1/auth/google/callback',
    reason: 'OIDC redirect return, authenticated by the signed state',
  },
  { method: 'POST', url: '/api/v1/auth/forgot-password', reason: 'the caller has lost their credential' },
  { method: 'POST', url: '/api/v1/auth/reset-password', reason: 'authenticated by the emailed reset token' },
  {
    method: 'POST',
    url: '/api/v1/auth/verify-email',
    reason: 'authenticated by the emailed verification token',
  },
  { method: 'POST', url: '/api/v1/auth/invite-info', reason: 'authenticated by the invitation token' },
  { method: 'POST', url: '/api/v1/auth/accept-invite', reason: 'authenticated by the invitation token' },

  // Enterprise SSO: the SP endpoints are the pre-session half of the handshake;
  // SCIM carries its own bearer secret and its own per-IP limiter.
  { method: 'GET', url: '/api/v1/auth/saml/metadata', reason: 'SP metadata is public by specification' },
  { method: 'GET', url: '/api/v1/auth/saml/login', reason: 'SAML AuthnRequest redirect' },
  {
    method: 'POST',
    url: '/api/v1/auth/saml/acs',
    reason: 'assertion consumer, authenticated by the signed SAML assertion',
  },
  {
    method: 'GET',
    url: '/scim/v2/ServiceProviderConfig',
    reason: 'SCIM discovery; guarded by the SCIM bearer',
  },
  { method: 'GET', url: '/scim/v2/Users', reason: 'guarded by the SCIM bearer token' },
  { method: 'GET', url: '/scim/v2/Users/:id', reason: 'guarded by the SCIM bearer token' },
  { method: 'POST', url: '/scim/v2/Users', reason: 'guarded by the SCIM bearer token' },
  { method: 'PATCH', url: '/scim/v2/Users/:id', reason: 'guarded by the SCIM bearer token' },
  { method: 'DELETE', url: '/scim/v2/Users/:id', reason: 'guarded by the SCIM bearer token' },

  // OAuth redirect returns from third-party providers. The browser arrives
  // without our cookie; the signed `state` is the authentication, and each
  // callback rejects a state minted for a different flow.
  {
    method: 'GET',
    url: '/api/v1/accounting/callback',
    reason: 'authenticated by the signed accounting state',
  },
  {
    method: 'GET',
    url: '/api/v1/cap-table-sync/callback',
    reason: 'authenticated by the signed cap-table state',
  },
  { method: 'GET', url: '/api/v1/hris/callback', reason: 'authenticated by the signed HRIS state' },

  // Token-authenticated portals for people who have no account here: the
  // auditor with a share link, the board member with a signing link, the
  // client filling in a firm's intake form. Each redeems a single-purpose
  // token and is behind a per-IP limiter.
  { method: 'POST', url: '/api/v1/auditor/portal', reason: 'authenticated by the auditor access token' },
  {
    method: 'POST',
    url: '/api/v1/auditor/portal/notes',
    reason: 'authenticated by the auditor access token',
  },
  { method: 'POST', url: '/api/v1/board/resolution', reason: 'authenticated by the board signing token' },
  { method: 'POST', url: '/api/v1/board/sign', reason: 'authenticated by the board signing token' },
  { method: 'POST', url: '/api/v1/intake/portal', reason: 'authenticated by the intake link token' },
  { method: 'POST', url: '/api/v1/intake/portal/answers', reason: 'authenticated by the intake link token' },
  { method: 'POST', url: '/api/v1/intake/portal/submit', reason: 'authenticated by the intake link token' },

  // Payment-provider webhooks: authenticated by the Stripe signature header,
  // which is the only thing that can be trusted on a server-to-server POST.
  { method: 'POST', url: '/api/v1/stripe/webhook', reason: 'authenticated by the Stripe signature' },
  { method: 'POST', url: '/api/v1/billing/webhook', reason: 'authenticated by the Stripe signature' },

  // Email delivery signals (0163), same shape and same justification: a mail
  // provider has no session, so the whole of its authority is an HMAC over the
  // raw body against EMAIL_WEBHOOK_SECRET. The route is only registered when
  // that secret is set — unsigned delivery claims would let anyone suppress a
  // named client's address, which stops their reports arriving.
  {
    method: 'POST',
    url: '/api/v1/webhooks/email/:provider',
    reason: 'authenticated by the EMAIL_WEBHOOK_SECRET signature',
  },

  // Deliberately public reads. These serve the sign-in page before anyone has
  // a session — a firm's logo and colours, and whether registration is open.
  { method: 'GET', url: '/api/v1/public/branding/:key', reason: 'white-label chrome on the pre-login pages' },
  {
    method: 'GET',
    url: '/api/v1/public/branding',
    reason:
      'same chrome, resolved from the tenant subdomain the client arrived on (0106) — the ' +
      'signed-out SPA has no slug to pass until it has rendered',
  },
  {
    method: 'GET',
    url: '/api/v1/public/settings',
    reason: 'is registration open, is the platform in maintenance',
  },

  // Marketing surface.
  {
    method: 'POST',
    url: '/api/v1/contact',
    reason: 'public contact form; rate-limited and captcha-free by design',
  },
  {
    method: 'POST',
    url: '/api/v1/valuation-selector',
    reason: 'public "which valuation?" quiz; pure computation, no data touched',
  },
  {
    method: 'POST',
    url: '/api/v1/fmv-estimator',
    reason: 'free no-signup 409A estimator; pure computation, no data touched or stored',
  },
  {
    method: 'GET',
    url: '/api/v1/sample-report',
    reason: "the deliverable's own chapter outline; a sample behind a login shows a prospect nothing",
  },
  {
    method: 'GET',
    url: '/api/v1/sample-report/pdf',
    reason:
      'the same outline rendered as the document itself, on a fictitious company; every page is ' +
      'marked as not a valuation opinion, and no engagement data is reachable from it',
  },
  // The client API's own documentation. Public for the same reason the partner
  // pair is: the first thing somebody does with a status they do not understand
  // is look it up, and requiring a credential to read what a 401 means is a
  // loop. Neither document names an engagement, a person or a tenant — one is
  // the shape of the URL space, the other a fixed vocabulary in the binary.
  {
    method: 'GET',
    url: '/api/v1/openapi.json',
    reason: 'the client API described as an OpenAPI 3.1 document; the URL space, not any data in it',
  },
  {
    method: 'GET',
    url: '/api/v1/problems',
    reason: 'the problem-type catalogue every error body branches on; a fixed vocabulary',
  },
  { method: 'GET', url: '/api/partner/v1/docs', reason: 'self-describing partner API documentation' },
  {
    method: 'GET',
    url: '/api/partner/v1/openapi.json',
    reason: 'the same documentation as an OpenAPI 3.1 spec; a spec behind a key cannot bootstrap a client',
  },

  // One-click unsubscribe (RFC 8058). Both verbs are authenticated by the
  // signed, scoped, expiring token in the query string — they have to be, since
  // the POST is issued by the mailbox provider with no session and no user
  // present. See domain/unsubscribeToken and routes/unsubscribe.
  {
    method: 'POST',
    url: '/api/v1/unsubscribe',
    reason:
      "one-click unsubscribe POSTed by the recipient's mailbox provider; authenticated by a signed token",
  },
  {
    method: 'GET',
    url: '/api/v1/unsubscribe',
    reason: 'unsubscribe link in an email footer; authenticated by a signed token',
  },
  {
    method: 'GET',
    url: '/api/v1/blog/posts',
    reason: 'published marketing articles; a blog index a crawler cannot read is not a blog',
  },
  {
    method: 'GET',
    url: '/api/v1/blog/posts/:slug',
    reason: 'a published marketing article; drafts are served only from /admin/blog',
  },
];

const key = (method: string, url: string): string => `${method.toUpperCase()} ${url}`;

const PUBLIC_KEYS: ReadonlySet<string> = new Set(PUBLIC_ROUTES.map((r) => key(r.method, r.url)));

export interface RouteAudit {
  /** Registered routes that are neither authenticated nor allow-listed. */
  unguarded(): string[];
  /** Allow-list entries no route matched — a stale exemption to delete. */
  staleExemptions(): string[];
  /**
   * Allow-list entries whose route does in fact run `app.authenticate` — a
   * waiver granted to something that never needed one.
   *
   * `staleExemptions` cannot see these: the route exists, so the entry matches.
   * What makes them worth reporting is what the waiver does *next*. The boot
   * check below only asks "is this route authenticated **or** listed", so an
   * entry here pre-authorizes the route to lose its `preHandler` — the one
   * mistake the audit exists to catch would pass silently on exactly the route
   * somebody already thought was worth writing down. `POST /auth/change-password`
   * was listed as "authenticated by the current password in the body" while
   * actually requiring a session, so dropping its preHandler in a refactor would
   * have turned it into an unauthenticated password-reset endpoint and booted
   * cleanly.
   *
   * Reported rather than fatal: a redundant entry is not itself a leak, and
   * failing boot on one would take a service down for a comment. The test suite
   * asserts it is empty, which is where the mistake actually gets made.
   */
  redundantExemptions(): string[];
  /**
   * Every registered route as `METHOD /url`, params still in `:name` form.
   *
   * The audit already walks every route for the authentication check, so it is
   * the one place that knows the real URL set. Other invariants that are
   * written *about* routes — the request-cost table, whose patterns silently
   * stopped matching anything when routes were renamed — can then be asserted
   * against reality instead of against what somebody assumed the paths were.
   */
  all(): string[];
  /**
   * The subset of {@link all} that runs through `app.authenticate`.
   *
   * `unguarded()` answers the security question — "what escaped both the
   * preHandler and the allow-list" — and deliberately subtracts PUBLIC_ROUTES,
   * so it cannot answer the documentation one. The generated OpenAPI needs to
   * mark each operation `security: [session]` or `security: []`, and a route
   * that is authenticated is a different claim from a route that is merely not
   * a violation.
   */
  authenticated(): string[];
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Exposed so the security regression test can inspect the same data the boot check uses. */
    routeAudit: RouteAudit;
  }
}

/**
 * Records every route as it is registered. Must run before the first route, so
 * `buildApp` installs it immediately after the problem handler.
 */
export function registerRouteAudit(app: FastifyInstance): RouteAudit {
  const authenticated = new Set<string>();
  const seen = new Set<string>();

  app.addHook('onRoute', (route) => {
    // HEAD is synthesised by Fastify for every GET; auditing it twice adds noise.
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).filter(
      (m) => m !== 'HEAD' && m !== 'OPTIONS',
    );
    const handlers = route.preHandler
      ? Array.isArray(route.preHandler)
        ? route.preHandler
        : [route.preHandler]
      : [];
    const guarded = handlers.some((h) => h === app.authenticate);
    for (const method of methods) {
      const k = key(method, route.url);
      seen.add(k);
      if (guarded) authenticated.add(k);
    }
  });

  const audit: RouteAudit = {
    unguarded: () =>
      [...seen]
        .filter((k) => !authenticated.has(k) && !PUBLIC_KEYS.has(k))
        .sort((a, b) => a.localeCompare(b)),
    staleExemptions: () => [...PUBLIC_KEYS].filter((k) => !seen.has(k)).sort((a, b) => a.localeCompare(b)),
    redundantExemptions: () =>
      [...PUBLIC_KEYS].filter((k) => authenticated.has(k)).sort((a, b) => a.localeCompare(b)),
    all: () => [...seen].sort((a, b) => a.localeCompare(b)),
    authenticated: () => [...authenticated].sort((a, b) => a.localeCompare(b)),
  };
  app.decorate('routeAudit', audit);
  return audit;
}

/**
 * Fails `app.ready()` if any route escaped both `app.authenticate` and
 * PUBLIC_ROUTES, so an unguarded endpoint takes the service down at boot
 * rather than serving traffic.
 *
 * This runs on `onReady`, not at the end of `buildApp`, because the Stripe
 * webhooks and the SAML assertion consumer are registered inside encapsulated
 * `app.register()` scopes whose bodies do not execute until the boot sequence
 * runs. Asserting synchronously would silently skip exactly the routes that
 * most need the check.
 */
export function assertRoutesGuarded(app: FastifyInstance, audit: RouteAudit): void {
  app.addHook('onReady', async () => {
    const unguarded = audit.unguarded();
    if (unguarded.length > 0) {
      throw new Error(
        `Unauthenticated routes registered without an entry in PUBLIC_ROUTES:\n  ${unguarded.join('\n  ')}\n` +
          'Add `preHandler: app.authenticate`, or list the route in src/plugins/routeAudit.ts with a reason.',
      );
    }
  });
}
