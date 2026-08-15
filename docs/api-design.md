# 409.ai — API Design

REST/JSON APIs for the rebuild. Three surfaces: **Client**, **Partner** (public, token-authed),
and **Internal** (service-to-service, incl. the R engine). Conventions below; entities per
[`database-design.md`](./database-design.md).

## 1. Conventions
- Base: `/api/v1`. JSON only. ULIDs in paths. `Idempotency-Key` header on POSTs with side effects.
- Auth: client/admin = session or bearer JWT; partner = `Authorization: Bearer <api_token>`;
  internal = mTLS + service JWT.
- Pagination: `?page`, `?per_page` (cursor for large lists); filtering mirrors the admin UI.
- Errors: RFC 9457 problem+json `{type,title,status,detail,instance}`. Rate-limited (429 + Retry-After).
  The `type` vocabulary is [§1.1](#11-problem-types) — that is the field to branch on.
- Webhooks are signed (HMAC) with retry + replay protection.

### 1.1 Problem types

`type` is the stable identifier; `title` is a constant reason phrase and `detail` is prose that
may change between releases. **Branch on `type`, never on `title` or `detail`.** An unrecognized
`type` should be handled by its status class, so new members can be added without breaking a
client.

| `type` | Status | Raised when |
|--------|--------|-------------|
| `urn:n409:problem:bad-request` | 400 | The request is malformed in a way no other type names. |
| `urn:n409:problem:malformed-body` | 400 | The body is not parseable as its declared content-type. |
| `urn:n409:problem:empty-body` | 400 | A JSON content-type was declared with no body. |
| `urn:n409:problem:unauthorized` | 401 | No session or bearer credential, or it has expired. |
| `urn:n409:problem:forbidden` | 403 | Authenticated, but the principal may not do this. |
| `urn:n409:problem:not-found` | 404 | No such resource, or it is outside the caller's scope. |
| `urn:n409:problem:method-not-allowed` | 405 | The path exists; the verb does not. |
| `urn:n409:problem:not-acceptable` | 406 | No representation matches the `Accept` header. |
| `urn:n409:problem:conflict` | 409 | State conflict — including an `Idempotency-Key` replayed against a different body. |
| `urn:n409:problem:plan-limit` | 409 | The organisation's plan does not allow another of these. |
| `urn:n409:problem:payload-too-large` | 413 | The body is over the route's limit. |
| `urn:n409:problem:unsupported-media-type` | 415 | Nothing can parse the declared content-type. |
| `urn:n409:problem:validation` | 422 | The body or query parsed but failed its validator; `errors` carries the issues. |
| `urn:n409:problem:rate-limited` | 429 | Limiter exhausted; `retry_after_seconds` and `Retry-After` say when to return. |
| `urn:n409:problem:internal` | 5xx | Unhandled server-side failure. Carries no `detail` by design. |
| `urn:n409:problem:unavailable` | 503 | This service is up but cannot serve the request yet. |
| `urn:n409:problem:upstream` | 502/503/504 | A service this one depends on failed or timed out. |
| `urn:n409:problem:upstream-degraded` | 503 | A dependency failed repeatedly, so its circuit breaker is open and the request was not attempted. `retry_after_seconds` and `Retry-After` say when the breaker next admits a trial call. Distinct from `upstream`: nothing was dialled, the caller's data is unaffected, and retrying after the stated delay is the correct response. |
| `urn:n409:problem:accounting-unavailable` | 503 | The accounting integration is unreachable or unconfigured. |
| `urn:n409:problem:captable-sync-unavailable` | 503 | The cap-table integration is unreachable or unconfigured. |
| `urn:n409:problem:hris-unavailable` | 503 | The HRIS integration is unreachable or unconfigured. |
| `urn:n409:problem:billing-unavailable` | 503 | Billing is unreachable. |
| `urn:n409:problem:payments-unconfigured` | 503 | No payment provider key is set in this deployment. |
| `urn:n409:problem:stripe` | 4xx/5xx | Stripe refused the operation; `detail` carries its reason. |

This table is not prose: `problemTypes.test.ts` fails if the code raises a type the table omits,
or if the table names one no code raises.

## 2. Client / Admin API

### Valuations
```
GET    /valuations                     # list; filters: state,kind,partner,source,reviewer,q,dates
POST   /valuations                     # create (kind, company, contact)
GET    /valuations/{id}                # detail (aggregate)
PATCH  /valuations/{id}                # update fields
POST   /valuations/{id}/transition     # {to_state} — guarded by state machine
POST   /valuations/{id}/restart-workflow
POST   /valuations/{id}/clone          # roll-forward / reapplication
POST   /valuations/{id}/reassign       # {reviewer_id}
GET    /valuations/{id}/events         # audit timeline (append-only)
GET    /valuations.csv                 # export
```

### Params, overwrites, calculations
```
GET    /valuations/{id}/params
PUT    /valuations/{id}/params
GET    /valuations/{id}/overwrites
PUT    /valuations/{id}/overwrites/{field_key}   # {value} (original preserved)
POST   /valuations/{id}/calculate      # {kind: accounting|bot|report} → async job
GET    /valuations/{id}/calculations/latest
GET    /valuations/{id}/sensitivity    # OPM grids (term/vol/rfr)
```

### Attachments & AI
```
POST   /valuations/{id}/attachments            # multipart; {kind}
GET    /valuations/{id}/attachments
POST   /valuations/{id}/ai/{pipeline}/run      # data_extraction|missing_data|comparables|set_params|summarize|find_mappings
GET    /valuations/{id}/ai/jobs                # status, model, cost, confidence, provenance
GET    /valuations/{id}/comparables
PATCH  /valuations/{id}/comparables/{cid}      # accept/reject {accepted, rationale}
```

### Reports
```
GET    /valuations/{id}/report
PUT    /valuations/{id}/report                 # save editor content → new version
GET    /valuations/{id}/report/versions
POST   /valuations/{id}/report/render          # → PDF (async)
GET    /valuations/{id}/report.pdf
POST   /valuations/{id}/report/sign            # {kind: main|second}
POST   /valuations/{id}/report/publish
```

### Reviews / tasks
```
GET    /reviews?scope=assigned_to_me|new|started|completed|overdue
POST   /reviews                                # {valuation_id, section, assignee_id, due_by}
PATCH  /reviews/{id}                           # {state}
```

### Comments / inbox / chat
```
GET    /valuations/{id}/comments
POST   /valuations/{id}/comments               # chat/notes
GET    /inbox/unassigned                        # unrouted inbound emails
POST   /inbox/{email_id}/assign                # {valuation_id}
```

### Admin config
```
GET/POST/PATCH/DELETE /users        /roles       /partners
GET/POST/PATCH/DELETE /prompts                    # AI prompt registry (versioned)
GET/POST/DELETE       /api-tokens                 # partner tokens (secret shown once)
GET                   /dashboard/stats            # stage×product pivot + charts
```

## 3. Partner API (public)
Token-scoped to one partner; only that partner's data.
```
POST   /partner/v1/valuations          # create for their customer
GET    /partner/v1/valuations          # list (their scope)
GET    /partner/v1/valuations/{id}
POST   /partner/v1/valuations/{id}/attachments
GET    /partner/v1/valuations/{id}/report.pdf     # white-labelled
```
Webhooks (partner-registered): `valuation.created`, `valuation.updated`, `valuation.waiting_on_client`,
`valuation.drafted`, `valuation.published`. Signed; at-least-once with retry/backoff.

## 4. Internal — Valuation Engine (R/Plumber contract)
Stable, versioned; the app pins the engine image digest per valuation.
```
POST /engine/v1/valuations/compute
  req:  { valuation_id, kind, params, financials, cap_table, comparables, overwrites }
  resp: { engine_version, concluded_fmv_per_share, equity_value,
          share_class_values[], discounts:{dloc,dlom}, approach_outputs{opm,income,market,asset},
          warnings[] }
POST /engine/v1/valuations/sensitivity
  req:  { valuation_id, axes:[term,volatility,rfr], ranges }
  resp: { grids:{ term_vs_vol:{implied,price}, rfr_vs_vol:{...}, rfr_vs_term:{...} } }
POST /engine/v1/roll-forward           # FRODO/ROLL_FRODO
GET  /engine/v1/health                 # + version/digest
```
All engine calls are idempotent (keyed by `valuation_id + inputs hash`) and traced.

## 5. Internal — AI Gateway
```
POST /ai/v1/run
  req:  { prompt_ref:{name,version}, context, model_override? }
  resp: { output, model, tokens_in, tokens_out, cost_cents, latency_ms, confidence?, source_refs? }
```
Enforces: budget check → cache → **anonymize inputs** → provider adapter (Anthropic/Bedrock/
Perplexity) with retry → schema-validate → persist `ai_job` + provenance.

## 6. Versioning & compatibility
- Path-versioned (`/v1`); additive changes only within a major.
- Engine and prompt versions are data (pinned per valuation), decoupled from API version.
- Deprecations announced via `Sunset` header + partner webhook notice.
