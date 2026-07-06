# 409.ai — Requirements

Derived from the crawl ([`features.md`](./features.md)) plus valuation-industry best practice.
Requirements are the contract the rebuild in [`implementation-plan.md`](./implementation-plan.md)
must satisfy. IDs: `FR-*` functional, `NFR-*` non-functional.

## 1. Actors & roles
| Actor | Description |
|-------|-------------|
| **Valuation User (client)** | Founder/finance lead requesting a valuation; onboards, pays, uploads docs, reviews/accepts draft, downloads final report. |
| **Partner** | Accounting/cap-table/equity platform submitting valuations for their customers via API or partner portal. |
| **Analyst / Data** | Ops staff who ingest data, run AI, set params, build the model. |
| **Reviewer / Main / Contributing Reviewer** | Reviews the drafted valuation for quality/compliance. |
| **Signatory** | Applies main/second signature to the deliverable. |
| **Support / Support Supervisor** | Handles client comms and support tasks. |
| **Supervisor / Admin / God** | Configuration, user & role management, prompts, overrides, full access. |
| **Investor** | Read-only sensitivity/analytics view. |
| **Auto / System** | Automated workflow & AI jobs. |

## 2. Functional requirements

### Onboarding & intake
- **FR-1** A client can request a valuation, selecting a **kind** (409a, 718, 820, gifts, qsbs, csop, emi, ifrs2, ppa, goodwill, esop, ip).
- **FR-2** Collect company + requester details; verify email; capture marketing attribution (source, gclid).
- **FR-3** Take payment (fixed or custom amount; partner-paid = $0 to client); record `paid_at`; enforce a delivery-days SLA → `due_date`.
- **FR-4** Client uploads documents by kind (cap table, monthly/annual income statements, balance sheets, projections, decks, prior valuations).
- **FR-5** Partners can create valuations via authenticated REST API and see only their own.

### Valuation lifecycle
- **FR-6** Each valuation follows the state machine: `pending → started → onboarding_completed → user_finished → completed → (paid) → review → reviewed → drafted → draft_accepted | draft_changes → published`, plus `timeout`, `cancelled`, `ignored`, and a `waiting_on_client` flag.
- **FR-7** A workflow engine orchestrates transitions and background jobs; it must be **restartable** per valuation.
- **FR-8** Support **roll-forward** valuations (clone a prior valuation forward to a new date) and **re-applications**.
- **FR-9** Analysts can reassign, clone, add sticky notes/comments, and set `waiting_on_client`.

### AI ingestion & extraction
- **FR-10** Run AI pipelines per valuation: **Data Extraction**, **Missing Data**, **Public Comparables**; plus actions **Find Mappings and Sources**, **Set Valuation Parameters**, **Summarize Attachments**, **Create Missing Entries**.
- **FR-11** **Anonymize cap-table data** via LLM before downstream processing (privacy control).
- **FR-12** Persist AI **jobs** (status, model, cost, latency) and extracted **network items** (comparables) for audit.
- **FR-13** Prompts are managed records bound to a **model/bot**; support multiple providers (Anthropic, AWS Bedrock, Perplexity) and are editable without a deploy.

### Valuation model & engine
- **FR-14** Capture Valuation Params: approach weights (Asset, OPM, Income, Market), DLOC, DLOM (Chaffee, Finnerty, qualitative), market multiples (Revenue/EBITDA, LTM/NTM, custom ranges), asset methods (cost-to-replicate, NAV), revenue status, runway, exit timeline, roll-forward.
- **FR-15** The engine computes concluded common-share FMV via OPM backsolve + income/market/asset approaches and applies discounts; expose recompute triggers (accounting, bot, report stage/prod).
- **FR-16** Provide **sensitivity analysis** across OPM inputs (term, volatility, risk-free rate) with implied and price variations.
- **FR-17** Allow analyst **Overwrites** of computed/AI values across the 68 documented fields, with the original value preserved for audit.

### Reporting
- **FR-18** Generate the deliverable **report** from a versioned template; provide a **rich editor** and **PDF** rendering; keep **version history**.
- **FR-19** Draft → client accept/changes → sign (main + second) → publish; deliver the final PDF to the client.

### Review & task management
- **FR-20** Generate typed **review tasks** per valuation (Data, Support, Review/Approve/Send draft, Signatures, Publish, Entire valuation, Assign); assign to users; track New/Started/Completed/Cancelled/Overdue and due dates.
- **FR-21** "Assigned to me" and overdue views for reviewers.

### Communication
- **FR-22** Per-valuation **chat** with the client and **comment** threads.
- **FR-23** **Email ingestion**: inbound emails attach to the right valuation as comments; unmatched emails queue as **unassigned** for routing; track read/unread for admin and user.

### Admin & config
- **FR-24** Manage users, roles (RBAC ~15 roles), partners, and API tokens.
- **FR-25** Ops **dashboard** (stage × product pivot + charts) and **CSV export** on lists.

## 3. Non-functional requirements
- **NFR-1 Security/Privacy** — Financial PII & cap tables are highly sensitive: encryption at rest & in transit, least-privilege RBAC, cap-table anonymization before LLM calls, audit logging of every override/state change, PII redaction in logs.
- **NFR-2 Compliance** — Valuations must be defensible/auditable (AICPA practice-aid alignment); immutable audit trail of inputs, model, and who changed what; retention of published reports.
- **NFR-3 Accuracy & reproducibility** — A published valuation must be exactly reproducible from stored inputs + engine version (pin engine + template versions per valuation).
- **NFR-4 Availability** — 99.9% for the client & partner surfaces; engine and AI jobs degrade gracefully (queue + retry, never lose an upload or a payment).
- **NFR-5 Performance** — List/dashboard p95 < 500 ms; a full AI extraction pass minutes not hours; PDF render < 30 s.
- **NFR-6 Scalability** — 1.3k+ users, 1.8k+ valuations/yr and growing; horizontal scale of web, workers, engine, and AI workers independently.
- **NFR-7 Observability** — Structured logs, traces across web→engine→AI, per-job cost/latency metrics, alerting on stuck workflows and overdue SLAs.
- **NFR-8 Auditability of AI** — Store prompt version, model, inputs (anonymized), outputs, and human acceptance for every AI-produced value.
- **NFR-9 Data residency** — Support country-specific handling (US/UK/CA/AU/SG) given `service_countries` and multi-jurisdiction products.
- **NFR-10 Testability** — Golden-file tests for the engine (known company → known FMV), contract tests for the engine API, and regression tests on template versions.

## 4. Assumptions & open questions
- Payment processor is assumed **Stripe** (paid/amount/paid_at fields) — confirm.
- The client-facing onboarding funnel was not deeply crawled (admin session); its exact steps need confirmation.
- Signature flow (e-signature provider) not directly observed — confirm provider.
- Exact DB engine not observable from the UI; assumed PostgreSQL (see [`database-design.md`](./database-design.md)).
