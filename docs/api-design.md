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
- Webhooks are signed (HMAC) with retry + replay protection.

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
