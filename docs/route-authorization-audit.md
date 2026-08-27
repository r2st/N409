# Route authorization audit (R157, extended R185)

**Snapshot taken 2026-08-26, findings appended 2026-08-28. The numbers below are not the authority — the
census tests are.** A table of routes in a document is out of date the first
time somebody adds a route and does not open this file, which is exactly the
failure mode the tests exist to remove. Read this for the shape of the surface
and for where each guard lives; run the tests to find out what is true now.

## The guards, and what each one can and cannot see

| Guard | Kind | Covers | Blind to |
| --- | --- | --- | --- |
| `src/plugins/routeAudit.ts` | boot check on the real route table | every registered route runs `app.authenticate` or is in `PUBLIC_ROUTES` with a written reason | whether the caller may see *this row* |
| `test/unit/privilegedRouteAuthorization.test.ts` | source scan | `/api/v1/admin/`, `/users`, `/partners`, `/report-templates`, `/scim/v2` reach something that can throw 403 | whether the 403 is the *right* predicate |
| `test/unit/valuationScopeAuthorization.test.ts` | source scan | the 171 routes under `/api/v1/valuations/…` consult a scope predicate, and nested children are read as children of `:id` | anything not keyed on a valuation |
| `test/unit/resourceScopeAuthorization.test.ts` | source scan (**new, R157**) | the 43 routes keyed on a non-valuation row — organizations, saved views, comments, API tokens, intake links, invoices, funds, debt instruments, tasks, support messages — consult the caller before answering | whether the check compares the right field |
| `test/integration/crossTenantResourceAccess.test.ts` | behavioural (**new, R157**) | 17 probes: firm B, signed in and valid, aimed at firm A's ids; each paired with firm A making the same request | resources with no second tenant |
| `test/integration/partnerApiScoping.test.ts` | behavioural, registry-driven (**rewritten, R157**) | every `{id}`-scoped partner-API operation 404s for another firm's row, and serves the key's own | — |
| `test/unit/authorizationCoverageCensus.test.ts` | source scan + real route table (**new, R185**) | the 75 routes that name *nothing* — `GET /tasks`, `/funds`, `/firm/clients`, `/support/messages` — consult the caller; **and** every authenticated route the app registers is claimed by exactly one of the five sweeps | the correctness of the filter, once one is present |
| `test/unit/webhookSignatureCensus.test.ts` | source scan (**new, R185**) | every route behind a raw-buffer body parser reads a signature header, verifies it cryptographically over the raw bytes, and refuses on mismatch | outbound delivery signing, which `partnerWebhooks.test.ts` owns |
| `test/integration/publicRouteThrottleCensus.test.ts` | behavioural | every route in `PUBLIC_ROUTES` is throttled, or `open` with an argument | — |
| `test/integration/retiredEngagementWrites.test.ts`, `partnerApiRetired.test.ts` | behavioural, route-table-driven | no write reaches a withdrawn engagement | reads, which stay open by design |

Each guard resolves helpers **by what a function consults, not by what it is
called**, because the loader is spelled differently in every route file
(`loadReadable`, `authorize`, `loadOwnedOrg`, `resolveFirm`, …). A list of
names would have to be edited by the same person who forgot the check.

## What the sweep found, R157

* **431 registered routes in the valuation service. Zero unauthenticated
  without an entry in `PUBLIC_ROUTES`.** 52 are deliberately public, each with
  a written reason and its own throttle classification.
* **No cross-tenant read or write was reachable.** Every id-keyed route on the
  session API and on the partner API refuses another tenant, and refuses with
  404 rather than 403 wherever the row's existence is itself scoped.
* One real gap, and it was in the *guard* rather than in the product: the
  partner API's scoping sweep carried the docstring "every route scoped by
  `{id}`" over four hand-written lines, while the API had grown to ten such
  operations. The two valuation writes and all five webhook routes had never
  been asked the question. They answer it correctly — they are now asked.
* The thirty-eight non-valuation id-keyed routes had no sweep of any kind. They
  are correct today; nothing kept them that way.
* One route class *was* open that should not have been, on the internal tier
  rather than the customer-facing one: `/docs`, `/redoc` and `/openapi.json` on
  both Python services answered without the estate's shared secret. See "the two
  surfaces that table cannot see", below.

## What the sweep found, R185

R157 audited the routes that *name something*. R185 audited the rest, plus the
question no individual sweep can ask — whether the sweeps between them cover the
table. 465 registered routes, 410 authenticated; the partition is 108
privileged, 169 valuation-scoped, 43 other-resource-keyed, 75 collection, 15
partner API.

Five gaps, none of them a missing `preHandler` — every one passed the existing
guards, which is why they were still there:

1. **`GET /admin/email-outbox` served the rendered body of every message.**
   `listOutbox` is `SELECT *` and the route spread the row onto the wire, so the
   response carried `email_outbox.body` — which for a transactional send *is* a
   live bearer credential: the password-reset link, the email-verification link,
   the invitation, the board member's signing link, the auditor portal link, the
   client intake link. Rows are kept for a year (0083). The route is `isOps`,
   twelve roles, of which nine can administer nobody through any other door —
   so a `contributing_reviewer` could request a reset for any administrator,
   open this page and take the account. The body is now dropped from the
   response and replaced with `body_length`; `GET /admin/api-tokens` is gated on
   `canManageUsers` for the same reason, in a comment naming the same roles.

2. **SCIM's authority ran past the accounts it provisions.** Only the unfiltered
   listing asked `provisioned_by`; `GET /Users/:id`, the `userName eq` filter,
   `PATCH` and `DELETE` went straight to the whole `users` table. A SCIM bearer
   — a credential facing the open internet — could look up any account by
   address and `setUserActive(false)` it, with no last-administrator guard on
   that path. Now bounded to `provisioned_by IN ('scim','saml')`: the directory
   manages what the directory created, and refuses to name a locally-registered
   account at all.

3. **Minting an API token was not re-authenticated.** `auth/reauth.ts` lists the
   credential-level actions behind a password prompt — password, login email,
   account closure, 2FA, backup codes — and this was the one missing, and the
   only one that *creates* a credential rather than changing one.
   `bumpSessionEpoch` deliberately does not revoke API tokens, so a borrowed
   cookie bought permanent access that surviving a password change. `POST
   /me/tokens` now takes `current_password`, and neither it nor `POST
   /partners/:id/tokens` will mint from a request authenticated by an API token
   — a key that can issue its successor makes revocation mean nothing.

4. **`DELETE /organizations/:id/entities/:valuationId` ignored `:id`.** Both ids
   were authorized against the caller and neither against the other, so the
   handler detached the engagement from whatever roll-up it was really in. Not
   an escalation, which is exactly why three sweeps walked past it: the fault is
   in the relationship between two ids that each pass their own check.

5. **Two privileged prefixes matched nothing.** `/api/v1/operations` and
   `/api/v1/prompts` had moved under `/api/v1/admin/` — coverage never lapsed,
   but the list claimed seven surfaces and described five, and
   `resourceScopeAuthorization` mirrored both entries in order to *subtract*
   them. A per-prefix non-empty case now stops the next one; the aggregate floor
   could not, because `/api/v1/admin/` alone carries three quarters of the
   routes.

One near-miss worth recording: `scimEdges.test.ts` asserted the SCIM listing
boundary as `expect(body.totalResults).toBe(body.Resources.length)`, which
`scimList` computes from the array it was handed — true of any listing, including
one containing every administrator. The claim was right, the assertion was
vacuous, and it was the only place a reviewer would have looked to find out that
the other four routes had no such filter. It now names a real local account.

Verified as already fixed: R157's internal-tier `/docs` exposure (both Python
services gate them behind `INTERNAL_SERVICE_TOKEN`), and the partner API's
registry guard (`define()` attaches `apiKeyGuard` for every `auth: 'api_key'`
entry; the two documentation endpoints are the only others).

## Roles

`src/domain/roles.ts` is the whole model. `OPS_ROLES` (twelve keys, including
the `auto` and `spa` service accounts) see every tenant. `PARTNER_ROLES`
(`partner`, `member`) are scoped to `partner_id`. `CLIENT_ROLES`
(`valuation_user`, `investor`) see rows they own. `USER_ADMIN_ROLES` (`admin`,
`god`, `supervisor`) is a strict subset of ops and gates the platform console.
`auditor` and `ignored` belong to no group, so `valuationScope` returns
`{ kind: 'none' }` — the model fails closed for a role nobody classified.

## Surfaces

"Auth" is how the request is authenticated. "Tenant / role guard" counts the
handlers that reach an ops predicate and those that put the caller's own id or
tenant into the decision; a route can do both — `GET /billing/invoices/:id/pdf`
is owner-**or**-ops and is counted in both columns.

| Surface | Routes | Auth | Tenant / role guard |
| --- | ---: | --- | --- |
| `/api/v1/account/mfa` | 5 | 5 session | 5 caller identity |
| `/api/v1/accounting/callback` | 1 | 1 public | 1 neither |
| `/api/v1/admin/api-tokens` | 1 | 1 session | 1 ops predicate |
| `/api/v1/admin/auto-emails` | 5 | 5 session | 5 ops predicate, 1 caller identity |
| `/api/v1/admin/billing` | 1 | 1 session | 1 ops predicate |
| `/api/v1/admin/blog` | 5 | 5 session | 5 ops predicate, 3 caller identity |
| `/api/v1/admin/capabilities` | 1 | 1 session | 1 ops predicate |
| `/api/v1/admin/communication-templates` | 6 | 6 session | 6 ops predicate, 3 caller identity |
| `/api/v1/admin/data-remediation` | 2 | 2 session | 2 ops predicate, 2 caller identity |
| `/api/v1/admin/db` | 2 | 2 session | 2 ops predicate |
| `/api/v1/admin/documents` | 2 | 2 session | 2 ops predicate |
| `/api/v1/admin/email` | 4 | 4 session | 4 ops predicate, 1 caller identity |
| `/api/v1/admin/email-outbox` | 2 | 2 session | 2 ops predicate |
| `/api/v1/admin/engagements` | 1 | 1 session | 1 ops predicate |
| `/api/v1/admin/events` | 1 | 1 session | 1 ops predicate |
| `/api/v1/admin/help` | 3 | 3 session | 3 ops predicate, 3 caller identity |
| `/api/v1/admin/jobs` | 5 | 5 session | 5 ops predicate, 5 caller identity |
| `/api/v1/admin/monitors` | 1 | 1 session | 1 ops predicate |
| `/api/v1/admin/narrative-prompts` | 5 | 5 session | 5 ops predicate, 2 caller identity |
| `/api/v1/admin/outbox` | 1 | 1 session | 1 ops predicate |
| `/api/v1/admin/prompts` | 7 | 7 session | 7 ops predicate, 2 caller identity |
| `/api/v1/admin/retention` | 10 | 10 session | 10 ops predicate, 10 caller identity |
| `/api/v1/admin/settings` | 2 | 2 session | 2 ops predicate, 1 caller identity |
| `/api/v1/admin/sso` | 5 | 5 session | 5 ops predicate, 5 caller identity |
| `/api/v1/admin/system` | 1 | 1 session | 1 ops predicate, 1 caller identity |
| `/api/v1/admin/webhooks` | 4 | 4 session | 4 ops predicate |
| `/api/v1/api-tokens` | 1 | 1 session | 1 ops predicate, 1 caller identity |
| `/api/v1/auditor/portal` | 1 | 1 public | 1 neither |
| `/api/v1/auth/accept-invite` | 1 | 1 public | 1 neither |
| `/api/v1/auth/change-password` | 1 | 1 session | 1 caller identity |
| `/api/v1/auth/forgot-password` | 1 | 1 public | 1 neither |
| `/api/v1/auth/google` | 2 | 2 public | 2 neither |
| `/api/v1/auth/invite-info` | 1 | 1 public | 1 neither |
| `/api/v1/auth/login` | 1 | 1 public | 1 neither |
| `/api/v1/auth/logout` | 1 | 1 public | 1 neither |
| `/api/v1/auth/me` | 1 | 1 session | 1 caller identity |
| `/api/v1/auth/mfa` | 1 | 1 public | 1 neither |
| `/api/v1/auth/providers` | 1 | 1 public | 1 neither |
| `/api/v1/auth/register` | 1 | 1 public | 1 neither |
| `/api/v1/auth/resend-verification` | 1 | 1 session | 1 caller identity |
| `/api/v1/auth/reset-password` | 1 | 1 public | 1 neither |
| `/api/v1/auth/saml` | 2 | 2 public | 2 neither |
| `/api/v1/auth/verify-email` | 1 | 1 public | 1 neither |
| `/api/v1/billing/invoices` | 1 | 1 session | 1 ops predicate, 1 caller identity |
| `/api/v1/billing/plans` | 1 | 1 session | 1 ops predicate |
| `/api/v1/billing/portal` | 1 | 1 session | 1 caller identity |
| `/api/v1/billing/subscribe` | 1 | 1 session | 1 ops predicate, 1 caller identity |
| `/api/v1/blog/posts` | 2 | 2 public | 2 neither |
| `/api/v1/board/resolution` | 1 | 1 public | 1 ops predicate, 1 caller identity |
| `/api/v1/board/sign` | 1 | 1 public | 1 ops predicate, 1 caller identity |
| `/api/v1/branding` | 2 | 2 session | 1 ops predicate, 2 caller identity |
| `/api/v1/branding/settings` | 1 | 1 session | 1 ops predicate, 1 caller identity |
| `/api/v1/branding/tenants` | 1 | 1 session | 1 ops predicate |
| `/api/v1/cap-table-sync/callback` | 1 | 1 public | 1 neither |
| `/api/v1/cap-table/formats` | 1 | 1 session | 1 neither |
| `/api/v1/comments` | 2 | 2 session | 2 caller identity |
| `/api/v1/contact` | 1 | 1 public | 1 neither |
| `/api/v1/contact/submissions` | 2 | 2 session | 2 ops predicate, 1 caller identity |
| `/api/v1/debt/instruments` | 8 | 8 session | 8 ops predicate, 7 caller identity |
| `/api/v1/debt/rating-spread` | 1 | 1 session | 1 ops predicate |
| `/api/v1/engagements` | 1 | 1 session | 1 ops predicate |
| `/api/v1/firm/attention` | 1 | 1 session | 1 ops predicate, 1 caller identity |
| `/api/v1/firm/clients` | 1 | 1 session | 1 ops predicate, 1 caller identity |
| `/api/v1/firm/dashboard` | 1 | 1 session | 1 ops predicate, 1 caller identity |
| `/api/v1/firm/intake-links` | 5 | 5 session | 5 ops predicate, 5 caller identity |
| `/api/v1/fmv-estimator` | 1 | 1 public | 1 neither |
| `/api/v1/funds` | 13 | 13 session | 13 ops predicate, 12 caller identity |
| `/api/v1/grant-templates` | 1 | 1 session | 1 neither |
| `/api/v1/help/articles` | 2 | 2 session | 2 ops predicate |
| `/api/v1/hris/callback` | 1 | 1 public | 1 neither |
| `/api/v1/inbox` | 1 | 1 session | 1 caller identity |
| `/api/v1/inbox/email` | 1 | 1 session | 1 ops predicate, 1 caller identity |
| `/api/v1/inbox/read` | 1 | 1 session | 1 caller identity |
| `/api/v1/inbox/read-all` | 1 | 1 session | 1 caller identity |
| `/api/v1/inbox/unread-count` | 1 | 1 session | 1 caller identity |
| `/api/v1/intake/portal` | 3 | 3 public | 3 neither |
| `/api/v1/intake/schema` | 1 | 1 session | 1 neither |
| `/api/v1/me` | 3 | 3 session | 3 caller identity |
| `/api/v1/me/billing` | 1 | 1 session | 1 caller identity |
| `/api/v1/me/capabilities` | 1 | 1 session | 1 neither |
| `/api/v1/me/data-export` | 1 | 1 session | 1 caller identity |
| `/api/v1/me/notification-preferences` | 2 | 2 session | 2 caller identity |
| `/api/v1/me/sessions` | 1 | 1 session | 1 caller identity |
| `/api/v1/me/subscription` | 1 | 1 session | 1 caller identity |
| `/api/v1/me/tokens` | 3 | 3 session | 3 caller identity |
| `/api/v1/monitors` | 1 | 1 session | 1 ops predicate |
| `/api/v1/notifications` | 2 | 2 session | 2 caller identity |
| `/api/v1/notifications/read-all` | 1 | 1 session | 1 caller identity |
| `/api/v1/notifications/unread-count` | 1 | 1 session | 1 caller identity |
| `/api/v1/onboarding/progress` | 1 | 1 session | 1 caller identity |
| `/api/v1/organizations` | 8 | 8 session | 8 ops predicate, 8 caller identity |
| `/api/v1/overwrites/schema` | 1 | 1 session | 1 ops predicate |
| `/api/v1/partners` | 8 | 8 session | 8 ops predicate, 6 caller identity |
| `/api/v1/partners/mine` | 1 | 1 session | 1 caller identity |
| `/api/v1/public/branding` | 2 | 2 public | 2 neither |
| `/api/v1/public/partners` | 1 | 1 public | 1 neither |
| `/api/v1/public/settings` | 1 | 1 public | 1 neither |
| `/api/v1/report-templates` | 6 | 6 session | 6 ops predicate, 4 caller identity |
| `/api/v1/research/topics` | 1 | 1 session | 1 ops predicate |
| `/api/v1/reviews` | 1 | 1 session | 1 ops predicate, 1 caller identity |
| `/api/v1/roles` | 1 | 1 session | 1 ops predicate |
| `/api/v1/sample-report` | 1 | 1 public | 1 neither |
| `/api/v1/sample-report/pdf` | 1 | 1 public | 1 neither |
| `/api/v1/saved-views` | 4 | 4 session | 3 ops predicate, 4 caller identity |
| `/api/v1/search` | 1 | 1 session | 1 ops predicate, 1 caller identity |
| `/api/v1/specialty/schema` | 1 | 1 session | 1 ops predicate |
| `/api/v1/stats/dashboard` | 1 | 1 session | 1 caller identity |
| `/api/v1/support/messages` | 3 | 3 session | 2 ops predicate, 3 caller identity |
| `/api/v1/tag-catalogue` | 1 | 1 session | 1 neither |
| `/api/v1/tasks` | 2 | 2 session | 2 ops predicate, 2 caller identity |
| `/api/v1/unsubscribe` | 1 | 1 public | 1 neither |
| `/api/v1/users` | 10 | 10 session | 10 ops predicate, 8 caller identity |
| `/api/v1/users/export` | 1 | 1 session | 1 ops predicate |
| `/api/v1/users/invitations` | 3 | 3 session | 3 ops predicate, 2 caller identity |
| `/api/v1/users/invite` | 1 | 1 session | 1 ops predicate, 1 caller identity |
| `/api/v1/users/options` | 1 | 1 session | 1 ops predicate, 1 caller identity |
| `/api/v1/valuation-selector` | 1 | 1 public | 1 neither |
| `/api/v1/valuations` | 171 | 171 session | 137 ops predicate, 141 caller identity |
| `/api/v1/valuations/bulk` | 1 | 1 session | 1 ops predicate |
| `/api/v1/valuations/bulk-action` | 1 | 1 session | 1 ops predicate |
| `/api/v1/valuations/compare` | 1 | 1 session | 1 caller identity |
| `/api/v1/valuations/counts` | 1 | 1 session | 1 ops predicate, 1 caller identity |
| `/api/v1/valuations/export` | 1 | 1 session | 1 caller identity |
| `/scim/v2` | 6 | 6 public | 6 neither |

## The two surfaces that table cannot see

**The partner API** registers its routes from `PARTNER_API_ENDPOINTS` rather
than from literal `app.get('/…')` calls, so no source scan finds it — which is
why its sweep is behavioural and driven off that same registry. Seventeen
operations: two public (`/docs`, `/openapi.json`) and fifteen behind
`apiKeyGuard`, which refuses session bearers and personal tokens outright
because every route below it scopes by `partner_id` and a NULL would match
every partner-less valuation on the platform. Ten of the fifteen name a row.

**The internal tier** — the report service (TypeScript, port 3004) and the two
Python services (`ai`, `engine-wrapper`) — is gated by
`registerInternalAuth` / `internal_auth.py`: an `X-Internal-Token` compared in
constant time on every non-health route, required in production, where an unset
`INTERNAL_SERVICE_TOKEN` refuses to boot rather than serving traffic open.

The two tiers disagreed on what "public" meant, and R157 closed it. The
TypeScript set was `/`, `/health`, `/ready`; the Python set added `/docs`,
`/redoc` and `/openapi.json`, which published the complete internal API surface
— every AI pipeline and every engine endpoint, with the full request and
response schema of each — to anyone who could reach the port. This estate had
already ruled on that question one level down: the *reasons* inside a `/ready`
body are gated on `isInternalCaller` because "an installation that has not
configured a secret is exactly the one least able to afford publishing its
topology", and an OpenAPI document is more topology than a readiness reason, not
less. Loopback binding and ufw were the only two things in front of them, which
is the argument `internalAuth.ts` gives for not relying on either. The doc routes
are now gated rather than removed: with no secret configured — every developer
machine, every test run — they answer exactly as before.

## Where the exemptions live

Every list of exceptions in this system carries a reason per entry, so a
reviewer can check the claim rather than trust the list:

* `PUBLIC_ROUTES` in `src/plugins/routeAudit.ts` — why a route needs no session.
* `GUARDED_OTHERWISE` in `privilegedRouteAuthorization.test.ts` — what guards a
  privileged route instead of a 403.
* `OWN_SIDE_404_BY_DESIGN` in `partnerApiScoping.test.ts` — why an owner's own
  request legitimately 404s.
* `disclosureReason` in `crossTenantResourceAccess.test.ts` — why a refusal is
  403 rather than 404, i.e. why naming the row is safe.
* `INTERNAL_PUBLIC_PATHS` and `gatedElsewhere` in
  `packages/shared/src/internalAuth.ts` — what bypasses the service token, and
  what gates it instead.
* `SAME_FOR_EVERYONE` in `authorizationCoverageCensus.test.ts` (**R185**) — why
  a collection route answers every caller the same thing. The bar is that the
  response is a constant of the codebase, so there is one entry:
  `GET /intake/schema`.
