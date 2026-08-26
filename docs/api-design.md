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

| `type` | Status | Raised when | What to do |
|---|---|---|---|
| `urn:n409:problem:bad-request` | 400 | The request is malformed in a way no other type names. | Read `detail` — it describes the request, not the server. A malformed query parameter is the usual cause; the body half of the same failure is `validation`. |
| `urn:n409:problem:malformed-body` | 400 | The body is not parseable as its declared content-type. | Fix the serialization before looking at any field. The body never reached a validator, so no `errors` array is present and no field has been examined. |
| `urn:n409:problem:empty-body` | 400 | A JSON content-type was declared with no body. | Send the body, or drop the `content-type` header. The usual cause is an HTTP client that sets the header on every request, including the ones with nothing to send. |
| `urn:n409:problem:unauthorized` | 401 | No session or bearer credential, or it has expired. | Re-authenticate and send the request again. An integration should also check the key has not been revoked — a revoked key and a missing one are the same answer here. |
| `urn:n409:problem:plan-limit` | 402 | The organisation's plan does not allow another of these. | A commercial limit, not a technical one: retrying never clears it. Upgrade the plan or buy additional valuations. Note the status is 402, not the 409 the rest of the conflict family uses. |
| `urn:n409:problem:forbidden` | 403 | Authenticated, but the principal may not do this. | Do not retry with the same credential — this is a role or scope decision, not a transient one. Ask an administrator for the role, or use a key scoped to the right organisation. |
| `urn:n409:problem:not-found` | 404 | No such resource, or it is outside the caller's scope. | Check the identifier. This is also the answer for a resource that exists but belongs to another organisation — the API will not confirm that it exists — so a 404 is not proof that the id is wrong. |
| `urn:n409:problem:method-not-allowed` | 405 | The path exists; the verb does not. | Use the verb the endpoint documents. Most collections take GET and POST only. |
| `urn:n409:problem:not-acceptable` | 406 | No representation matches the `Accept` header. | Send `Accept: application/json`, or omit the header. The endpoints that answer a file — `report.pdf`, `workbook.xlsx`, the `.csv` exports — are the exception and name their own type. |
| `urn:n409:problem:conflict` | 409 | State conflict — including an `Idempotency-Key` replayed against a different body. | Re-read the resource and decide from its current state; the request was not applied. A replayed idempotency key is the one case where retrying unchanged cannot help — send the original body, or mint a new key. |
| `urn:n409:problem:payload-too-large` | 413 | The body is over the route's limit. | Send less. Upload routes have their own, larger ceiling than the JSON routes, and `GET /api/v1/upload-limits` reports both so a client can check before spending the bandwidth. |
| `urn:n409:problem:unsupported-media-type` | 415 | Nothing can parse the declared content-type. | Use `application/json` for JSON bodies and `multipart/form-data` for uploads. A charset parameter is fine; an unrecognised base type is not. |
| `urn:n409:problem:validation` | 422 | The body or query parsed but failed its validator; `errors` carries the issues. | Read `errors` rather than `detail`: each entry names the failing path and why. The body parsed, so this is a field-level problem and the framing was fine. |
| `urn:n409:problem:rate-limited` | 429 | Limiter exhausted; `retry_after_seconds` and `Retry-After` say when to return. | Wait the stated number of seconds — not a fixed timer of your own — then retry. Nothing was executed. On the partner API the `x-ratelimit-*` headers come back on *successful* responses too, so a client can slow down before it is refused; the `-partner` suffixed trio is a second budget shared across every key in the organisation. |
| `urn:n409:problem:upstream` | 502 | A service this one depends on failed or timed out. | Retry with backoff. A timeout is indistinguishable from a failure here, so the dependency may still be working on the request — send an `Idempotency-Key` where the endpoint accepts one. A 4xx from the dependency is not this: it is reported as `validation`, because it describes the request rather than the outage. |
| `urn:n409:problem:stripe` | 502 | Stripe refused the operation; `detail` carries its reason. | `detail` is Stripe’s own message and is safe to show a person. Retry with backoff if it reads like an outage; a declined card or a rejected parameter will be refused again unchanged. |
| `urn:n409:problem:unavailable` | 503 | This service is up but cannot serve the request yet. | Retry with backoff. Raised while a service is still warming up or is draining for shutdown, so it clears on its own — no configuration change makes it go away faster. |
| `urn:n409:problem:upstream-degraded` | 503 | A dependency failed repeatedly, so its circuit breaker is open and the request was not attempted. Distinct from `upstream`: nothing was dialled, so the caller’s data is unaffected. | Wait for `retry_after_seconds` — the moment the breaker next admits a trial call — and retry once. Retrying sooner is refused without being attempted, so it neither helps you nor helps the dependency recover. No idempotency key is needed: nothing ran. |
| `urn:n409:problem:accounting-unavailable` | 503 | The accounting integration is unreachable or unconfigured. | Check the accounting connection in settings — an unconfigured deployment and an unreachable provider answer the same way. Financials can be entered by hand meanwhile: the integration is an import path, not a dependency of the valuation. |
| `urn:n409:problem:captable-sync-unavailable` | 503 | The cap-table integration is unreachable or unconfigured. | Check the cap-table connection in settings. The cap table can be imported from a spreadsheet or entered by hand meanwhile. |
| `urn:n409:problem:hris-unavailable` | 503 | The HRIS integration is unreachable or unconfigured. | Check the HRIS connection in settings. Headcount and grant data can be entered by hand. |
| `urn:n409:problem:billing-unavailable` | 503 | Billing is unreachable. | Retry with backoff. Nothing was charged, and valuation work is unaffected — only the billing surfaces refuse. |
| `urn:n409:problem:payments-unconfigured` | 503 | No payment provider key is set in this deployment. | Neither transient nor the caller’s fault: this deployment has no Stripe key, so retrying cannot help. An operator sets `STRIPE_SECRET_KEY`; until then the payment surfaces are off. |
| `urn:n409:problem:internal` | 5xx | Unhandled server-side failure. Carries no `detail` by design. | Retry with exponential backoff, and send an `Idempotency-Key` on anything with side effects — the request may have committed before it failed. If it persists, quote the `instance` path and the time: the server-side log line carries the detail this body omits. |

This table is generated from `PROBLEM_CATALOG` in `@n409/shared`
(`src/packages/shared/src/problemCatalog.ts`) — edit the catalog, not this table.
`problemTypes.test.ts` fails if the two disagree, if the code raises a type the catalog omits,
if the catalog names one no code raises, or if a raise site uses a status or title the catalog
does not record. The same catalog is served at `GET /api/v1/problems`, so a client can resolve an
unrecognised `type` at runtime.

## 2. Client / Admin API

The authoritative inventory is **`GET /api/v1/openapi.json`** — an OpenAPI 3.1 document generated
from the route table the service registers, so it names every one of the ~460 endpoints, says
which need a session, and carries the problem-document schema. Import it into a client generator
or an HTTP client rather than reading paths off this section.

What follows is the original design sketch, kept because it shows the intended *shape* of the
surface — which resources exist and how they nest. It is not a reference: paths are written
without the `/api/v1` prefix they ship under, and it names a fraction of what is registered.
Prose about each group of endpoints lives in `API_TAGS`
(`src/services/valuation/src/domain/apiCatalog.ts`) and is rendered into the generated document.

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
