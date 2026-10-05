import type { FixedWindowRateLimiter, WeightedWindowRateLimiter } from '../plugins/rateLimit.js';
import { costOfRequest } from './requestCost.js';

/**
 * Every throttle this service enforces, written down once so the published
 * OpenAPI can say what they are.
 *
 * The client spec declared a `429` on all 448 of its operations and said
 * nothing else about rate limiting: not what the limit is, not what it is keyed
 * on, not that a refusal carries `retry-after`, and not that a *successful*
 * response carries the `x-ratelimit-*` trio a client is supposed to slow down
 * on before it is refused. The partner spec has said all of that since it was
 * built. The client spec's readers — the web app, the firm workspace, and
 * anyone who imports the document into a tool — got a status code and no way to
 * act on it.
 *
 * A blanket `429` is also the *inaccurate* half. Around forty of those
 * operations are on the unauthenticated surface with no limiter anywhere near
 * them: a liveness probe, a branding read, an OAuth redirect leg, the Stripe
 * webhooks. `apiCatalog.test.ts` already refuses to promise a 401 on a route
 * that never requires a session, on the grounds that noise makes a generated
 * client's error handling meaningless. The same reasoning had never been
 * applied to the throttle, so `GET /health` was documented as answering 429.
 *
 * ## Where the numbers come from
 *
 * The authenticated half is not a table at all — it is read off the limiter
 * objects `buildApp` actually installed, so the document describes the process
 * serving it. A deployment with `SESSION_RATE_LIMIT_PER_MIN=0`, or one outside
 * production where the limiters are deliberately not constructed, publishes no
 * session limit rather than a number nothing enforces.
 *
 * The public half *is* a table, because those limiters are per-route and their
 * thresholds are constants in the route modules. `rateLimitPolicyCensus.test.ts`
 * requires it to name every entry in `PUBLIC_ROUTES` and no others, and
 * `publicRouteThrottleCensus.test.ts` fires a real burst at every route the
 * table calls throttled and at every route it calls open — so a number here is
 * held to what the service does, in both directions.
 */

/** What a counter is keyed on — the thing a caller shares a budget with. */
export type RateLimitKey =
  | 'ip'
  | 'email'
  | 'account'
  | 'organisation'
  /** The user the presented challenge or session token resolves to. */
  | 'token-subject';

/** One counter: how many of what, over how long, per what. */
export interface RateLimitWindow {
  /** Requests allowed in the window — or cost units, when `unit` says so. */
  limit: number;
  windowSeconds: number;
  key: RateLimitKey;
  /**
   * Only the heavy budget counts in anything but requests. Stated rather than
   * implied because "200 per minute" reads as two hundred calls, and against
   * the cost budget it is eight AI pipelines.
   */
  unit?: 'cost-units';
}

/** A named throttle, and every counter it checks. */
export interface RateLimitPolicy {
  /** Stable identifier; appears in the spec's `x-rate-limit` extension. */
  name: string;
  description: string;
  windows: readonly RateLimitWindow[];
}

const perHour = (limit: number, key: RateLimitKey): RateLimitWindow => ({
  limit,
  windowSeconds: 60 * 60,
  key,
});
const perMinutes = (limit: number, minutes: number, key: RateLimitKey): RateLimitWindow => ({
  limit,
  windowSeconds: minutes * 60,
  key,
});

/**
 * The public throttles, named. Thresholds mirror the constants in the route
 * modules they are enforced from, which the census below cites file by file.
 */
export const PUBLIC_POLICIES = {
  /** routes/auth.ts — `login`, checked before any DB or scrypt work. */
  signIn: {
    name: 'auth-sign-in',
    description:
      'Sign-in attempts. Only a *failed* attempt advances the counter, so a legitimate user is ' +
      'never locked out by their own successful sign-ins.',
    windows: [perMinutes(10, 15, 'email'), perMinutes(100, 15, 'ip')],
  },
  /** routes/auth.ts — `REGISTER_PER_IP` / `REGISTER_PER_EMAIL`. */
  register: {
    name: 'auth-register',
    description:
      'Account creation, bounded per address as well as per caller so one mailbox cannot be re-registered in a loop.',
    windows: [perHour(10, 'ip'), perHour(3, 'email')],
  },
  /** routes/auth.ts — `TOKEN_REDEEM_PER_IP`. */
  tokenRedeem: {
    name: 'auth-token-redeem',
    description:
      'Redeeming an emailed token — password reset, email verification, invitation lookup and ' +
      'acceptance. Bounds guessing of the secret and the scrypt work a guess costs.',
    windows: [perHour(20, 'ip')],
  },
  /** routes/auth.ts — `forgot-password`, which sends mail to a named address. */
  mailTrigger: {
    name: 'auth-mail-trigger',
    description:
      'Requests that send mail to an address the caller names. Tight per address, looser per caller.',
    windows: [perHour(3, 'email'), perHour(30, 'ip')],
  },
  /** routes/auth.ts — `mfa/verify`, keyed on the user the challenge resolves to. */
  secondFactor: {
    name: 'auth-second-factor',
    description:
      'Second-factor verification, keyed on the account the challenge token resolves to. A burst ' +
      'carrying a forged challenge is refused as unauthorized before it reaches this counter.',
    windows: [perMinutes(10, 15, 'token-subject')],
  },
  /** routes/auditorPortal.ts — `PORTAL_RATE_LIMIT`. */
  auditorPortal: {
    name: 'portal-auditor',
    description:
      'The auditor share link. The write shares the read’s budget: a write is at least as good an ' +
      'oracle for guessing a token, and worth less to the honest caller.',
    windows: [perMinutes(30, 10, 'ip')],
  },
  /** routes/boardApproval.ts — `BOARD_PUBLIC_RATE_LIMIT`. */
  boardPortal: {
    name: 'portal-board',
    description: 'The board signing link — redeeming it, and recording the signature.',
    windows: [perMinutes(30, 10, 'ip')],
  },
  /** routes/clientIntake.ts — `PORTAL_RATE_LIMIT`. */
  intakePortal: {
    name: 'portal-intake',
    description:
      'The client questionnaire. Looser than the other two portals because answering one is a long ' +
      'session of small saves rather than a single redemption.',
    windows: [perMinutes(120, 10, 'ip')],
  },
  /** routes/scim.ts — `SCIM_RATE_LIMIT`. */
  scim: {
    name: 'scim',
    description:
      'SCIM 2.0 provisioning. Sized for a directory’s sync rather than a person’s: an enterprise ' +
      'IdP reconciles in bursts.',
    windows: [perMinutes(600, 5, 'ip')],
  },
  /** routes/contact.ts. */
  contactForm: {
    name: 'contact-form',
    description: 'The public contact form. Rate-limited and captcha-free by design.',
    windows: [perMinutes(5, 10, 'ip')],
  },
  /** routes/clientErrors.ts — `CLIENT_ERROR_LIMIT`. */
  clientErrors: {
    name: 'client-error-reports',
    description:
      'Crash reports filed by the browser SPA. Sized for a page that breaks rather than one breaking ' +
      'in a loop; the client caps itself as well. What is refused here is counted, so the signal ' +
      'never flattens at the limit without saying so.',
    windows: [perMinutes(20, 5, 'ip')],
  },
  /** routes/sampleReport.ts — `PDF_RENDERS_PER_IP`. */
  sampleReportPdf: {
    name: 'sample-report-pdf',
    description:
      'Rendering the sample 409A report. The JSON outline beside it is static and unlimited; this ' +
      'is the one that costs a render.',
    windows: [perMinutes(10, 10, 'ip')],
  },
  /** routes/unsubscribe.ts — `UNSUBSCRIBE_LIMIT`. R378. */
  unsubscribe: {
    name: 'unsubscribe',
    description:
      'RFC 8058 one-click and the footer link. A rate limit the POST path silently absorbs ' +
      '(still 200, but the preference is not touched) and the GET path rejects. Protects the ' +
      'signature-verification CPU and the upsert it guards.',
    windows: [perMinutes(30, 10, 'ip')],
  },
  /** routes/fmvEstimator.ts — `ESTIMATOR_LIMIT`. R378. */
  fmvEstimator: {
    name: 'fmv-estimator',
    description:
      'The free 409A calculator. Pure computation — no database — but unbounded requests from one ' +
      'address can pin the event loop.',
    windows: [perMinutes(60, 10, 'ip')],
  },
  /** routes/valuationSelector.ts — `SELECTOR_LIMIT`. R378. */
  valuationSelector: {
    name: 'valuation-selector',
    description:
      'The "which valuation?" quiz. Likewise pure computation, and likewise unbounded before R378.',
    windows: [perMinutes(60, 10, 'ip')],
  },
} as const satisfies Record<string, RateLimitPolicy>;

/** A public route is either governed by a named policy or deliberately open. */
export type PublicRateLimit = { kind: 'throttled'; policy: RateLimitPolicy } | { kind: 'open'; why: string };

const throttled = (policy: RateLimitPolicy): PublicRateLimit => ({ kind: 'throttled', policy });
const open = (why: string): PublicRateLimit => ({ kind: 'open', why });

/**
 * Every route on the unauthenticated surface, and what governs it.
 *
 * Keyed exactly as `routeAudit` keys a route. The `open` entries carry the
 * argument, because "no limit" is the column that needs one — and every one of
 * them is fired at in `publicRouteThrottleCensus.test.ts`, which fails if a
 * route filed here ever answers a 429.
 */
export const PUBLIC_RATE_LIMITS: Readonly<Record<string, PublicRateLimit>> = {
  // ── Probes and self-description. No state read, nothing to guess ─────────
  'GET /': open('a static banner naming the health endpoints'),
  'GET /health': open('liveness probe; the proxy and systemd poll it continuously'),
  'GET /ready': open('readiness probe, polled on the same schedule'),
  'GET /metrics': open(
    'a Prometheus scrape is a fixed-rate poll, and the route is unregistered in production without a token',
  ),
  'GET /api/v1/auth/providers': open('which sign-in buttons to render; configuration, not data'),
  'GET /api/v1/auth/saml/metadata': open('SP metadata is a published document by specification'),
  'GET /api/v1/openapi.json': open(
    'this document, built from the in-memory route table; no query and no data behind it',
  ),
  'GET /api/v1/problems': open(
    'a constant catalogue served from the binary; the same bytes for every caller',
  ),
  'GET /api/partner/v1/docs': open('the partner API documentation page'),
  'GET /api/partner/v1/openapi.json': open('the same documentation as a spec; built from a static registry'),

  // ── Pre-login chrome and marketing reads ─────────────────────────────────
  'GET /api/v1/public/branding/:key': open('the logo and colours on the sign-in page'),
  'GET /api/v1/public/branding': open('the same chrome resolved from the tenant subdomain'),
  'GET /api/v1/public/settings': open('is registration open, is the platform in maintenance'),
  'GET /api/v1/blog/posts': open('a published article index; a blog a crawler cannot read is not a blog'),
  'GET /api/v1/blog/posts/:slug': open('a published marketing article'),
  'GET /api/v1/sample-report': open(
    "the deliverable's chapter outline as JSON; static content, and the render behind it is limited separately",
  ),
  'POST /api/v1/valuation-selector': throttled(PUBLIC_POLICIES.valuationSelector),
  'POST /api/v1/fmv-estimator': throttled(PUBLIC_POLICIES.fmvEstimator),

  // ── Redirect halves of a handshake, authenticated by a signed state ──────
  'GET /api/v1/auth/google': open('starts the OIDC redirect; issues a state and redirects'),
  'GET /api/v1/auth/google/callback': open('the return leg; a forged state is rejected before any lookup'),
  'GET /api/v1/auth/saml/login': open('emits the AuthnRequest redirect'),
  'POST /api/v1/auth/saml/acs': open('assertion consumer; an unsigned assertion is rejected on signature'),
  'GET /api/v1/accounting/callback': open('OAuth return leg, authenticated by the signed accounting state'),
  'GET /api/v1/cap-table-sync/callback': open(
    'OAuth return leg, authenticated by the signed cap-table state',
  ),
  'GET /api/v1/hris/callback': open('OAuth return leg, authenticated by the signed HRIS state'),

  // ── Server-to-server callbacks, authenticated by a signature over the body ─
  'POST /api/v1/stripe/webhook': open(
    'Stripe retries on its own schedule; a throttle would drop a real event',
  ),
  'POST /api/v1/billing/webhook': open('the same, on the billing half'),
  'POST /api/v1/webhooks/email/:provider': open(
    'a mail provider bursts delivery signals by design, and the route is unregistered without EMAIL_WEBHOOK_SECRET',
  ),

  // ── Signed-token endpoints — now throttled per IP (R378) ─────────────────
  'POST /api/v1/unsubscribe': throttled(PUBLIC_POLICIES.unsubscribe),
  'GET /api/v1/unsubscribe': throttled(PUBLIC_POLICIES.unsubscribe),
  'POST /api/v1/auth/logout': open(
    'clears a cookie; refusing it would leave a session the user asked to end',
  ),

  // ── Throttled: token oracles, account minting, and mail triggers ─────────
  'POST /api/v1/auth/register': throttled(PUBLIC_POLICIES.register),
  'POST /api/v1/auth/login': throttled(PUBLIC_POLICIES.signIn),
  'POST /api/v1/auth/forgot-password': throttled(PUBLIC_POLICIES.mailTrigger),
  'POST /api/v1/auth/reset-password': throttled(PUBLIC_POLICIES.tokenRedeem),
  'POST /api/v1/auth/verify-email': throttled(PUBLIC_POLICIES.tokenRedeem),
  'POST /api/v1/auth/invite-info': throttled(PUBLIC_POLICIES.tokenRedeem),
  'POST /api/v1/auth/accept-invite': throttled(PUBLIC_POLICIES.tokenRedeem),
  'POST /api/v1/auth/mfa/verify': throttled(PUBLIC_POLICIES.secondFactor),

  'POST /api/v1/client-errors': throttled(PUBLIC_POLICIES.clientErrors),

  'POST /api/v1/auditor/portal': throttled(PUBLIC_POLICIES.auditorPortal),
  'POST /api/v1/auditor/portal/notes': throttled(PUBLIC_POLICIES.auditorPortal),
  'POST /api/v1/board/resolution': throttled(PUBLIC_POLICIES.boardPortal),
  'POST /api/v1/board/sign': throttled(PUBLIC_POLICIES.boardPortal),
  'POST /api/v1/intake/portal': throttled(PUBLIC_POLICIES.intakePortal),
  'POST /api/v1/intake/portal/answers': throttled(PUBLIC_POLICIES.intakePortal),
  'POST /api/v1/intake/portal/submit': throttled(PUBLIC_POLICIES.intakePortal),

  'GET /scim/v2/ServiceProviderConfig': throttled(PUBLIC_POLICIES.scim),
  'GET /scim/v2/Users': throttled(PUBLIC_POLICIES.scim),
  'GET /scim/v2/Users/:id': throttled(PUBLIC_POLICIES.scim),
  'POST /scim/v2/Users': throttled(PUBLIC_POLICIES.scim),
  'PATCH /scim/v2/Users/:id': throttled(PUBLIC_POLICIES.scim),
  'DELETE /scim/v2/Users/:id': throttled(PUBLIC_POLICIES.scim),

  'POST /api/v1/contact': throttled(PUBLIC_POLICIES.contactForm),
  'GET /api/v1/sample-report/pdf': throttled(PUBLIC_POLICIES.sampleReportPdf),
};

/**
 * The three limiters the running process installed over the authenticated
 * surface, as policies. Absent when the deployment did not install one.
 */
export interface DeploymentRateLimits {
  session?: RateLimitPolicy;
  organisation?: RateLimitPolicy;
  cost?: RateLimitPolicy;
}

/**
 * Read the deployment's limits off the limiter objects themselves.
 *
 * Deliberately not read from config: `buildApp` only constructs these outside
 * of an injected test double when `NODE_ENV` is production *and* the setting is
 * above zero, so config alone would have the document promising a ceiling that
 * this process does not enforce. Passing the objects makes the two agree by
 * construction — there is no third place where a limit is written down.
 */
export function deploymentRateLimits(installed: {
  session?: FixedWindowRateLimiter;
  organisation?: FixedWindowRateLimiter;
  cost?: WeightedWindowRateLimiter;
}): DeploymentRateLimits {
  const seconds = (windowMs: number) => Math.round(windowMs / 1000);
  return {
    ...(installed.session
      ? {
          session: {
            name: 'session-account',
            description:
              'Every authenticated request, per account. Counts requests regardless of what they ' +
              'cost; the expensive ones are additionally charged against the budget below.',
            windows: [
              {
                limit: installed.session.limit,
                windowSeconds: seconds(installed.session.windowMs),
                key: 'account',
              },
            ],
          },
        }
      : {}),
    ...(installed.organisation
      ? {
          organisation: {
            name: 'session-organisation',
            description:
              'The same requests, pooled across the whole organisation. A client reading only its own ' +
              'headroom can still be refused, because the request that exhausted this one came from a colleague.',
            windows: [
              {
                limit: installed.organisation.limit,
                windowSeconds: seconds(installed.organisation.windowMs),
                key: 'organisation',
              },
            ],
          },
        }
      : {}),
    ...(installed.cost
      ? {
          cost: {
            name: 'heavy-operations',
            description:
              'A second budget, measured in cost units rather than requests, drawn on only by the ' +
              'expensive operations — renders, exports, engine runs, AI pipelines and large uploads. ' +
              'Each such operation declares its own cost in `x-rate-limit`.',
            windows: [
              {
                limit: installed.cost.budget,
                windowSeconds: seconds(installed.cost.windowMs),
                key: 'account',
                unit: 'cost-units',
              },
            ],
          },
        }
      : {}),
  };
}

/** The `x-ratelimit-*` trio a limiter reports itself through, in header order. */
const headerTrio = (suffix: string): readonly string[] => [
  `x-ratelimit-limit-${suffix}`,
  `x-ratelimit-remaining-${suffix}`,
  `x-ratelimit-reset-${suffix}`,
];

/** What governs one operation, resolved. */
export interface OperationRateLimit {
  /** Every policy that can refuse this operation; empty when none can. */
  policies: readonly RateLimitPolicy[];
  /** Cost units this operation draws from the heavy budget; 0 for ordinary ones. */
  cost: number;
  /**
   * The `x-ratelimit-*` headers this operation actually returns, on success as
   * well as on refusal. Empty for the public surface: those limiters answer
   * with a `retry-after` on the 429 and report nothing on the way there.
   */
  headers: readonly string[];
  /** Why nothing limits it, when `policies` is empty and the route is public. */
  open?: string;
}

/**
 * Resolve a registered route to the throttles that govern it.
 *
 * `authenticated` is the route audit's answer, not a guess: an authenticated
 * route runs `app.authenticate`, which is where the session, organisation and
 * cost limiters are applied, so every one the deployment installed governs it.
 * A public route is governed by whatever `PUBLIC_RATE_LIMITS` says and nothing
 * else — the session limiters never see it.
 */
export function rateLimitForOperation(input: {
  method: string;
  /** The registered path, `:id` placeholders and all. */
  path: string;
  authenticated: boolean;
  limits: DeploymentRateLimits;
}): OperationRateLimit {
  if (!input.authenticated) {
    const verdict = PUBLIC_RATE_LIMITS[`${input.method.toUpperCase()} ${input.path}`];
    if (!verdict) return { policies: [], cost: 0, headers: [] };
    return verdict.kind === 'throttled'
      ? { policies: [verdict.policy], cost: 0, headers: [] }
      : { policies: [], cost: 0, headers: [], open: verdict.why };
  }

  // The cost rules match on the request path, and `[^/]+` matches a `:id`
  // placeholder as readily as it matches a real identifier — so the registered
  // path is charged exactly what a request to it would be.
  const cost = costOfRequest(input.method, input.path);
  const policies: RateLimitPolicy[] = [];
  const headers: string[] = [];
  if (input.limits.session) {
    policies.push(input.limits.session);
    headers.push(...headerTrio('user'));
  }
  if (input.limits.organisation) {
    policies.push(input.limits.organisation);
    headers.push(...headerTrio('org'));
  }
  // The cost limiter returns early on an ordinary request without setting a
  // header, so a document that declared the `-cost` trio everywhere would be
  // describing a response nobody receives.
  if (input.limits.cost && cost > 0) {
    policies.push(input.limits.cost);
    headers.push(...headerTrio('cost'));
  }
  return { policies, cost, headers };
}
