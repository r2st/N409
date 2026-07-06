# 409.ai — Database Design

Proposed PostgreSQL schema for the rebuild, reverse-engineered from the crawled entities
([`features.md`](./features.md)) and shaped by the reproducibility/audit requirements
([`requirements.md`](./requirements.md)). IDs are **ULIDs** (matching current `01K…` scheme).

## 1. ER overview
```
users ──< user_roles >── roles
users ──< valuations >── partners
valuation ─1:1─ valuation_params
valuation ─1:M─ attachments ─1:M─ ai_jobs
valuation ─1:M─ overwrites
valuation ─1:M─ comments (email/chat) 
valuation ─1:M─ review_tasks ── users (assignee)
valuation ─1:M─ valuation_events        (append-only audit)
valuation ─1:M─ calculations ─1:M─ share_class_values
valuation ─1:M─ reports ─1:M─ report_versions
valuation ─1:M─ transactions (financing/securities)
valuation ─1:M─ comparables
prompts (registry)   api_tokens ── partners   workflow_runs ── valuation
```

## 2. Core tables

### valuations
| column | type | notes |
|--------|------|-------|
| id | ulid PK | |
| number | bigint unique | human `#1766` |
| workflow_id | text | orchestrator run id |
| kind | enum | 409a, fmv, 718, 820, gifts, qsbs, csop, emi, ifrs2, ppa, goodwill, esop, ip |
| template_version | text | e.g. `409a.v11` (pinned at draft) |
| engine_version | text | container digest used to compute (reproducibility) |
| state | enum | pending…published (+ timeout/cancelled/ignored) |
| waiting_on_client | bool | |
| company_name | text | |
| service_name | text | |
| user_id | ulid FK → users | requester |
| partner_id | ulid FK → partners | nullable |
| source | enum | partner/referral/ads/repeat |
| gclid | text | ads attribution |
| qsbs_attestation | bool | |
| currency | char(3) | |
| service_countries | text[] | jurisdictions |
| paid_status | enum | unpaid/paid/paid_by_partner |
| amount_cents | int | |
| custom_amount_cents | int | |
| paid_at | timestamptz | |
| delivery_days | int | SLA |
| amount_raised_cents | bigint | |
| assigned_reviewer_id | ulid FK → users | |
| created_at, started_at, user_finished_at, due_date, completed_at, drafted_at, draft_accepted_at, published_at | timestamptz | lifecycle |
| admin_read_at, user_read_at, last_comment_at | timestamptz | unread tracking |
Indexes: `(state)`, `(partner_id)`, `(kind)`, `(due_date)`, `(assigned_reviewer_id)`, `(company_name text_pattern_ops)`.

### valuation_params (1:1)
Holds the methodology inputs. Weights & discounts as `numeric`.
`rolling_forward bool, inception_date date, fiscal_year_end date, exit_timeline date,
business_overview text, revenue_status enum, last_round_date date, last_year_revenue_cents bigint,
ytd_revenue_cents bigint, runway_months int,
weight_asset numeric, weight_opm numeric, weight_income numeric, weight_market numeric,
dloc numeric, dlom numeric, dlom_method enum(chaffee|finnerty|qualitative),
dlom_qualitative numeric, market_method enum(revenue|ebitda), market_horizon enum(ltm|ntm),
market_custom_ranges jsonb, asset_method enum(cost_to_replicate|nav)`.
Constraint: `weight_asset+weight_opm+weight_income+weight_market = 1`.

### overwrites
Analyst manual overrides (the documented 68-field set). Keep original for audit.
`id, valuation_id FK, category enum(company_info|financial_metrics|forecasts|valuation_params|market_comparables|reporting), field_key text, value jsonb, original_value jsonb, class enum(numeric|date|character), created_by FK→users, created_at`. Unique `(valuation_id, field_key)`.

### attachments
`id, valuation_id FK, kind enum(articles|decks|exports|captable|monthly_is|annual_is|balance_sheet|projections|uploads|draft_reports|previous_valuations|mail), name, s3_key, size_bytes, content_type, tags text[], anonymized_s3_key, virus_scanned bool, created_by, created_at`.

## 3. AI tables

### prompts (registry)
`id, name unique, bot text (model key), provider enum(anthropic|bedrock|perplexity), content text, variables jsonb, version int, is_active bool, created_at, updated_at`.
History in `prompt_versions(id, prompt_id, version, content, model, created_at)`.

### ai_jobs
`id, valuation_id FK, attachment_id FK null, pipeline enum(data_extraction|missing_data|comparables|set_params|summarize|find_mappings|anonymize_captable), prompt_id FK, prompt_version int, model text, status enum(queued|running|succeeded|failed), input_ref jsonb (anonymized), output jsonb, confidence numeric, source_refs jsonb, tokens_in int, tokens_out int, cost_cents int, latency_ms int, error text, created_at, finished_at`.
Indexes: `(valuation_id)`, `(status)`, `(pipeline)`, `(created_at)`. Partition by month.

### comparables (network items)
`id, valuation_id FK, company_name, ticker, industry_id, match_score numeric, revenue_multiple numeric, ebitda_multiple numeric, source enum(ai|manual), rationale text, accepted bool, created_at`.

## 4. Workflow, review & audit

### review_tasks
`id, valuation_id FK, section enum(entire_valuation|data_task|support_task|full|approve_draft|review_draft|send_draft|manual_publish|publish_report|assign|signature_main|signature_second), assignee_id FK→users, state enum(new|started|completed|cancelled), started_at, finished_at, due_by, created_at`.
Indexes: `(assignee_id, state)`, `(valuation_id)`, `(due_by) WHERE state<>'completed'`.

### valuation_events  (append-only audit / event source)
`id, valuation_id FK, seq bigserial, type text (e.g. state_changed, param_updated, overwrite_applied, ai_output, review_completed, published), actor_type enum(human|ai|engine|system), actor_id, source text, payload jsonb, occurred_at`.
Immutable (no update/delete grant); unique `(valuation_id, seq)`. Basis for reproducibility & compliance.

### workflow_runs
`id, valuation_id FK, engine_run_id, status, current_step, restart_count, started_at, updated_at`.

## 5. Calculations & reports

### calculations
`id, valuation_id FK, kind enum(accounting|bot|report), concluded_fmv_per_share numeric, equity_value_cents bigint, inputs_snapshot jsonb, engine_version, computed_at`.
`share_class_values(id, calculation_id FK, share_class, price_per_share numeric, allocation_pct numeric)`.
`sensitivity_results(id, calculation_id FK, axis_x enum(term|rfr|volatility), axis_y enum(term|rfr|volatility), grid jsonb)`.

### reports
`id, valuation_id FK, template_version, status enum(draft|accepted|changes|published), current_version int`.
`report_versions(id, report_id FK, version, content jsonb, pdf_s3_key, rendered_at, created_by)`.
`signatures(id, report_id FK, kind enum(main|second), signer_id FK→users, signed_at, evidence jsonb)`.

## 6. Identity & partners

### users
`id, first_name, last_name, email unique, phone, verified bool, sso_provider enum(google|null), password_digest, gclid, created_at`.
### roles / user_roles
`roles(id, key)` with keys: valuation_user, admin, god, supervisor, support, support_supervisor, reviewer, main_reviewer, contributing_reviewer, data, data_supervisor, partner, member, investor, auto, spa, ignored.
`user_roles(user_id, role_id)`.
### partners
`id, name, key, config jsonb (branding, webhooks), created_at`.
### api_tokens
`id, partner_id FK, user_id FK, client_id, secret_hash, scopes text[], last_used_at, created_at`. Secret stored hashed; shown once.

## 7. Financing

### transactions
`id, valuation_id FK, event_type enum(priced_round|safe|note|option_grant|secondary), date, security, amount_cents, price_per_share numeric, shares numeric, source, created_at`.
### amounts_raised
`id, valuation_id FK, round_name, date, amount_cents, post_money_cents, created_at`.

## 8. Conventions
- ULID PKs; `timestamptz` UTC; money as integer cents; enums as PG enums or lookup tables.
- Soft delete only where the domain needs it; **never** on `valuation_events` (immutable).
- Row-level partner scoping enforced in the app/policy layer (and optionally RLS).
- All large/append-only tables (`valuation_events`, `ai_jobs`) partitioned by month.
