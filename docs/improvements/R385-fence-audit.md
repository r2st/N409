# R385 — Fence & Boundary Audit (M6), Clean Pass

## Summary

Full audit of auth fences, tenant isolation, input validation, rate limiting,
and IDOR surfaces across the valuation service, report service, and shared
infrastructure. No actionable issues found — the estate is clean.

## Methodology

Systematic review of every authentication and authorization boundary in the
codebase, structured as:

1. **Auth infrastructure** — `internalAuth.ts`, `requestContext.ts`,
   `auth.ts` plugin, `rbac.ts` policy functions
2. **Route-level auth coverage** — every route file checked for
   `preHandler: app.authenticate` or equivalent gate
3. **Structural enforcement** — `routeAudit.ts` boot-time check that refuses
   to start if any unauthenticated route is not in `PUBLIC_ROUTES`
4. **Tenant isolation** — SQL WHERE builders, scope functions, repo-level
   `partner_id` / `user_id` filtering
5. **Input validation** — Zod schemas on all route inputs, ULID validation on
   all path parameters
6. **Rate limiting** — per-IP and per-user limiters on all public and
   sensitive endpoints
7. **IDOR** — cross-resource ownership checks (document-to-valuation,
   notification-to-user, entity-to-organization)
8. **Webhook authentication** — Stripe signature, email delivery HMAC,
   OAuth callback state JWTs

## Areas examined

### Auth infrastructure

| Component | File | Finding |
|-----------|------|---------|
| Internal service auth | `shared/src/internalAuth.ts` | Constant-time comparison, production boot refusal on missing secret, per-request re-read for rotation |
| Request context | `shared/src/requestContext.ts` | AsyncLocalStorage with `bindActor`, request-id charset and length validation |
| Session auth plugin | `valuation/src/plugins/auth.ts` | Bearer resolution (JWT + API token), session epoch check, per-user + per-org rate limiting, maintenance mode, MFA gate |
| RBAC policy | `valuation/src/auth/rbac.ts` | Pure functions, suspension guard on every privileged check, scope-based access (all/partner/own/none) |

### Route auth coverage

Every route in the valuation service either:
- Has `{ preHandler: app.authenticate }` and calls `requirePrincipal()`, or
- Appears in `PUBLIC_ROUTES` (`plugins/routeAudit.ts`) with a documented
  reason and its own authentication mechanism

The `routeAudit` boot check enforces this structurally — an unauthenticated
route without a `PUBLIC_ROUTES` entry prevents the service from starting.
Additionally, `routeAudit` detects and warns about stale exemptions and
over-exemptions (authenticated routes that are listed as public).

### Public / unauthenticated routes

Every public route was verified to have its own gate:

| Route | Gate |
|-------|------|
| Auth (register, login, MFA, password reset) | Per-IP + per-email rate limiting, Zod validation, timing-safe responses |
| Google OAuth callback | Signed state JWT |
| SAML ACS | SAML library assertion validation |
| SCIM endpoints | Bearer token with constant-time comparison, per-IP rate limiting |
| Stripe webhook | `stripe-signature` header verification |
| Billing webhook | `stripe-signature` header verification |
| Email delivery webhook | HMAC signature over raw body, constant-time comparison |
| HRIS / Accounting / Cap-table-sync callbacks | Signed JWT state with retirement + actor re-authorization checks |
| Auditor portal | Access token, per-IP rate limiting |
| Client intake portal | Link token, per-IP rate limiting |
| Board signing | Signing token |
| Unsubscribe (RFC 8058) | Signed token, per-IP rate limiting |
| Contact form | Per-IP rate limiting, Zod validation |
| FMV estimator | Per-IP rate limiting, Zod validation, pure computation |
| Sample report | Per-IP rate limiting, Zod validation |
| Blog posts | Slug validation, read-only |
| Public branding / settings | Read-only configuration |
| Client errors | Per-IP rate limiting, field caps, 204-only |

### Tenant isolation

**SQL-level scoping:** The `buildWhere` function in `repos/valuations.ts`
applies scope at the WHERE builder level — `partner` scope adds
`partner_id = ?`, `own` scope adds `user_id = ?`, and `all` (ops only)
applies no restriction. This runs in every read path: list, export, search,
counts, and bucket queries.

**Route-level authorization:** Every valuation route loads the valuation with
an authorization check (typically `loadAuthorizedValuation` or equivalent)
that calls `canReadValuation(principal, ref)` which checks scope against
the valuation's `user_id` and `partner_id`.

**Organization ownership:** `loadOwnedOrg` checks `owner_user_id` against
`principal.id` (ops bypass). Entity assignment verifies both the
organization and the valuation are owned by the caller.

### Input validation

- **Zod schemas** on every route body and query string, with `.strict()`
  preventing unknown fields
- **ULID validation** on all path parameters via `isUlid()` check before
  database lookup
- **Body size limits** per route type: 25 MB documents, 10 MB cap tables,
  8 MB reports, 4 MB cap table imports, 2 MB report templates
- **Multipart field limits** (`uploadLimits.ts`): 8 fields, 1024 bytes per
  field, 12 total parts — prevents the gigabyte-of-text-fields attack
- **NUL byte / unstorable text scanning** via `preValidation` hook on all
  JSON bodies, plus explicit check in webhook routes that bypass the hook
- **File type verification** (`checkUploadType`): magic-byte sniffing
  against declared MIME type
- **Filename sanitization** (`safeFilename`, `scrubFilename`): bidi
  controls, C0 controls, path traversal characters stripped
- **Content-Disposition** header properly escaped (`contentDisposition`
  function handles quotes, backslashes, and UTF-8 encoding)

### Rate limiting

Three limiter implementations cover the estate:

- **FixedWindowRateLimiter** — simple per-key counter (contact form,
  unsubscribe, FMV estimator, sample report, client errors, auditor portal,
  client intake)
- **WeightedWindowRateLimiter** — cost-weighted limiter (per-user session
  limiter, per-org cost limiter)
- **SlidingWindowRateLimiter** — sliding window with `maxKeys` cap to
  prevent memory exhaustion (auth routes: registration, login, MFA, forgot
  password)

All public POST endpoints have per-IP rate limiting. Authenticated endpoints
have per-user and per-org rate limiting through the auth plugin.

### IDOR checks

| Pattern | Implementation |
|---------|----------------|
| Document → Valuation | `loadDocument` checks `doc.valuation_id !== valuationId` |
| Notification → User | `markRead` passes `principal.id` alongside notification id |
| Organization → User | `loadOwnedOrg` checks `org.owner_user_id !== principal.id` |
| Entity → Organization | Delete checks `valuation.organization_id !== org.id` |
| Document delete | Non-ops restricted to `doc.uploaded_by === principal.id` |
| Export columns | `OPS_ONLY_EXPORT_COLUMNS` withholds `reviewer_email` from non-ops |

### Webhook / callback security

| Endpoint | Auth mechanism |
|----------|---------------|
| Stripe payments webhook | Scoped plugin, raw-buffer parser, `verifyWebhookSignature` |
| Stripe billing webhook | Same pattern as payments |
| Email delivery webhook | HMAC-SHA256 over raw body, constant-time comparison, refuses when unconfigured |
| OAuth callbacks (×3) | Signed JWT state with 30-minute expiry, retired-engagement and actor-authorization re-checks |

### Internal service auth (report, AI, engine-wrapper)

- `registerInternalAuth` requires `X-Internal-Token` on every non-health
  route in production
- Missing token in production refuses to boot
  (`MissingInternalTokenError`)
- Token compared in constant time via `timingSafeEqual`
- `gatedElsewhere` option for paths with their own gate (e.g., `/metrics`)

## Prior rounds

This estate has been through extensive security work in prior rounds:

- **B-1**: Original security audit — internal auth, file type checking,
  Content-Disposition, X-Content-Type-Options
- **R25**: Internal auth gate refinement
- **R55/R57**: Rate limiting coverage
- **R74**: Multipart field limits
- **R89**: Account enumeration prevention
- **R272**: Timing-safe responses
- **R305/R329/R340/R341**: Integration callback hardening (retirement
  checks, actor re-authorization, observability)
- **R344/R345**: SSRF protection, private address checking
- **R352**: Error handling methodology
- **R354**: Route audit redundant-exemption detection
- **R378**: FMV estimator rate limiting
- **R382**: Integration callback error separation
- **R384**: Cross-cutting security headers

## Conclusion

The fence and boundary audit found no actionable security issues. The
codebase demonstrates defense in depth across every layer:

1. **Structural enforcement** — the route audit boot check prevents
   unguarded routes from reaching production
2. **Consistent patterns** — every route follows the same
   authenticate → requirePrincipal → authorize → validate → execute pattern
3. **Tenant isolation at SQL level** — scope is applied in the WHERE
   builder, not at the route level, so a new route cannot forget it
4. **Comprehensive rate limiting** — every public endpoint and every
   authenticated endpoint has appropriate limiters
5. **Input validation everywhere** — Zod schemas with `.strict()`, ULID
   checks, body size limits, file type verification
6. **Webhook authentication** — every inbound webhook verifies its own
   credential before acting
