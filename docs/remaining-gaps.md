# N409 — Remaining Feature Gaps vs 409.ai

> Status as of 2026-07-06, with **all milestones M0–M4 on main** (M0 foundations,
> React SPA, M1 core pipeline, M2 output & delivery, M3 operations, M4 polish —
> 32 features total). Compiled by cross-referencing
> [`features.md`](./features.md) (the as-built 409.ai crawl) against the actual
> code in `src/services/`. Successor to
> [`feature-gap-analysis.md`](./feature-gap-analysis.md), which predates M1–M4.
>
> **Headline:** the platform is functionally complete end-to-end — intake → AI
> extraction → params → engine → workbook/overwrites → report → review →
> publish, plus the operations layer (admin console, partner channel, comments,
> inbox, analytics). The remaining gaps cluster in four places: **(1) external
> integrations that stop at the boundary** (email delivery, payments, premium AI
> providers), **(2) engine fidelity** vs the R package (true backsolve,
> waterfall allocation), **(3) AI depth** (prompt registry, auto-apply actions,
> anonymization), and **(4) the client-facing onboarding funnel**, which was
> never a milestone.

---

## 1. Fully implemented ✅

### Core domain & lifecycle
- [x] **Valuation aggregate** with all 13 product kinds (`409a` … `ip`), ULID ids,
  sequential human numbers, template/engine version tags
  (`migrations/0001_core.sql`, `routes/valuations.ts`).
- [x] **Full 14-state lifecycle enum** (`pending` → … → `published`, plus
  `timeout`/`cancelled`/`ignored`) with `waiting_on_client` overlay flag and all
  lifecycle timestamps from the crawl.
- [x] **Append-only audit event spine** — every mutation recorded in
  `valuation_events`, immutability enforced by DB triggers; timeline at
  `GET /valuations/:id/events`.
- [x] **Workflow engine** — advance / restart / reassign with transition
  legality checks (`domain/workflow.ts`, `routes/workflow.ts`).
- [x] **Bulk actions** — set_state / advance / restart / assign_reviewer over
  checkbox selection, per-id results.
- [x] **Clone** — `POST /valuations/:id/clone` copies the engagement +
  methodology params, `roll_forward` flags the copy for re-dating
  (`routes/operations.ts`, `repos/valuations.ts:cloneValuation`). The flag names
  a *clone*, not the engine's calibration roll-forward, which is unwired — see
  §2.
- [x] **State-change hooks** — auto email workflows + in-app notifications fire
  on every transition (`hooks/stateChange.ts`, `domain/emailWorkflows.ts`).

### Auth & RBAC
- [x] Email/password auth + JWT sessions; **real Google OIDC SSO** (full
  auth-code flow with JWKS verification, `auth/google.ts`).
- [x] **RBAC with all 17 observed roles seeded** (`0002_seed_roles.sql`);
  scope-aware reads (client/partner/ops), field-level patch permissions,
  404-not-403 for out-of-scope ids (`auth/rbac.ts`).
- [x] **Partner API tokens** — `n409_pat_…` bearer secrets shown once, sha256
  stored, revocable, live RBAC re-read on every call; the same REST API serves
  JWT and token callers (`0020_m3_operations.sql`, `plugins/auth.ts`,
  `routes/apiTokens.ts`). Token management UI in the partner portal.
- [x] **User & role admin console** — list/create/edit/soft-delete users, role
  checkboxes, partner assignment, partner create/list, **users CSV export**
  (`routes/adminUsers.ts`, AdminUsersPage).

### Pipeline (M1)
- [x] **Review/task system** — typed tasks (10 kinds), lifecycle states,
  assignee, SLA hours, due dates; per-valuation and "my tasks" views.
- [x] **Document management** — multipart upload with 11 document kinds, sha256,
  soft delete, download.
- [x] **AI pipelines** — `missing_data`, `extract`, `comparables` via OpenRouter
  with ordered model fallback; deterministic checklist + LLM hybrid;
  field-whitelisted extraction (hallucinated keys can't reach the engine); job
  provenance in `ai_jobs` (`services/ai/app/pipelines.py`).
- [x] **Calculation engine (Python)** — weighted 4-approach model (asset
  NAV/cost-to-replicate, OPM, income DCF with terminal value, market multiples
  with median selection), Black-Scholes allocation over the preferred
  liquidation preference, DLOC, DLOM via **Chaffee and Finnerty** closed forms
  or qualitative override, FMV per fully-diluted share
  (`engine-wrapper/app/engine/`); every run persisted in `calculations`.
- [x] **Valuation Params editor** — the full methodology surface from the
  crawl: rolling-forward, revenue status, exit timeline, approach weights with
  a DB-enforced sum-to-1 constraint, DLOC/DLOM config, market method/horizon.

### Output & delivery (M2)
- [x] **Overwrites system — all 68 fields across the 6 documented categories**
  with class/min/max/example metadata, per-field validation, original-value
  capture, and the **self-documenting schema explorer** UI.
- [x] **Valuation workbook** — code-defined sheets, input vs derived rows; only
  inputs persisted, formulas recomputed on read.
- [x] **Report editor + PDF + versions** — sectioned HTML content, WYSIWYG
  editing (sanitized client and server side), immutable version history with
  revert, lazy pdfkit rendering, draft/accepted/changes/published statuses.
  Stateless `POST /render/v1/pdf` on the report service for other consumers.
- [x] **Report template management** — versioned templates (≈ `409a.v53`),
  draft/active/archived with one-active-per-name constraint, admin UI.

### Operations (M3)
- [x] **Comments, client chat & sticky notes** — one `valuation_comments` table,
  three surfaces: `chat` (client-visible thread), `note` (ops-only, pinnable),
  `email` (threaded inbound mail); kind-scoped visibility and edit permissions
  (`routes/comments.ts`, CommentThread component).
- [x] **Email inbox → valuation threading** — `POST /inbox/email` resolves the
  valuation from an explicit id, a ULID or `#123` in the subject, or the
  sender's latest engagement; idempotent on `message_id` (unique index).
- [x] **Advanced filtering + tabbed scopes with live counts** — state, kind,
  state-group, text search, reviewer, partner, user, source, paid status,
  waiting-on-client, created/due date ranges (`ValuationFilterQuery`), shared
  by the list, the counts endpoint, and the exporter; filter panel + scope tabs
  in the UI.
- [x] **Dashboard analytics** — server-side `GET /stats/dashboard`: per-kind
  **pivot over state groups**, by-state and by-source breakdowns, date-range
  search, rendered with **donut charts** (dependency-free SVG) — the 409.ai
  stage pivot + pie equivalent.
- [x] **Partner portal** — partner-scoped valuations view + API token
  management (PartnerPortalPage).

### Polish (M4)
- [x] **Funding rounds & transaction history** — CRUD for rounds and securities
  transactions (issuance, secondary sale, conversion, …).
- [x] **In-app notifications** — unread nav badge (60s poll), read/read-all.
- [x] **Auto email workflows** — transactional outbox enqueued atomically with
  state changes; templates for started/review/draft-ready/published/cancelled;
  delivery status + attempts tracked.
- [x] **Global search**, **CSV + PDF export** of the worklist, **rich
  multi-column sort**.
- [x] **Sensitivity analysis** — OPM volatility × term stress grid with
  delta-from-base, ops-only workspace tab.
- [x] **Attribution capture** (`source`, `gclid`), **QSBS flag**,
  multi-currency, `paid_by_partner`, delivery-days SLA.

---

## 2. Partially implemented ⚠️

| Feature | What's done | What's missing |
|---|---|---|
| **OPM backsolve** | Market-calibrated equity value from the last round | Simplified to post-money ≡ equity value (documented shortcut in `approaches.py`; "refinement lands with #17"). No root-finding iteration to reprice the preferred tranche to the round PPS like the R engine's `back_solve`/`newton_raphson`. |
| **OPM allocation** | Single-breakpoint Black-Scholes split (aggregate preference vs upside), as-converted fallback | 409.ai allocates across the **full cap-table waterfall** (multiple share classes / breakpoints / participation). Only one aggregate liquidation preference is modeled. |
| **Sensitivity dashboard** | One stress table: Volatility × Term, price + delta per cell | 409.ai shows **three** tables — Term×Vol, RFR×Vol, RFR×Term — each with *implied* and *price* variations. The risk-free-rate axes are absent. |
| **Email (outbound)** | Outbox architecture with pluggable transport | Only `log` and `off` transports exist (`config.ts: EMAIL_MODE`) — no SMTP/provider adapter, so nothing is actually delivered. |
| **Email (inbound)** | Ingestion endpoint with subject/sender resolution, idempotency | No **unassigned-email queue**: an unmatched email returns 422 to the relay rather than landing in a triage list for manual routing (409.ai §3.4). And no actual mail relay is deployed — the endpoint awaits one. |
| **Text search (`q`)** | Company name ILIKE + exact workflow-id match | 409.ai's sidebar also searches id/uuid, requester email, first/last name. No filter by requester identity beyond exact `user_id`. |
| **AI actions & pipelines** | 3 of the crawled pipelines (Missing Data, Data Extraction, Public Comparables) | Missing: **Find Mappings and Sources**, **Set Valuation Parameters** (extraction results are not auto-applied to params), **Summarize Attachments**, **Create Missing Entries**, and the **Network Items** view. |
| **AI model routing** | OpenRouter with ordered fallback across 3 free models; model recorded per job | No **prompt registry** (prompts hard-coded in `pipelines.py` vs 409.ai's 27 DB-backed prompts with CRUD); no multi-provider routing (Perplexity research, Bedrock, Anthropic direct); no **cap-table anonymization** privacy step. |
| **Document ingestion formats** | PDF (pypdf, first 40 pages) + text-like (csv/tsv/txt/md/json) | No **XLSX/DOCX** extraction — cap tables and financials usually arrive as Excel. Corpus capped at 60k chars. |
| **Report templates ↔ reports** | Templates versioned and managed; reports carry a `template_version` | Only a single built-in 409a section layout in code (`domain/report.ts`); template bodies aren't merged into new reports per kind, non-409a kinds have no bespoke layouts, and `template_version` isn't bumped on regeneration (the `409a.v0 → v53` behavior). |
| **Clone / roll-forward** | Engagement + params copied, roll-forward flagged. **The engine's calibration roll-forward now exists** — `engine/rollforward.py` behind `POST /engine/v1/rollforward`: carries the prior calibrated equity value forward at the prior required return over the elapsed period, applies a new round or explicit value adjustments, detects material changes (new round, revenue move past a threshold, cap-table change, a gap over a year) and emits `pre_populated_inputs` ready for `compute`. | Documents, funding rounds, and the workbook are not carried over. **And nothing calls the roll-forward endpoint** — it and `/engine/v1/market-data` are the only two engine routes with no caller in `src/services/valuation`. The platform's own "roll-forward" is `cloneValuation(rollForward: true)`, which copies last year's data and flags the copy for re-dating; it performs none of the calibration above. So no calculation stores a roll-forward result, which is also why there is no roll-forward exhibit in the report: the bridge from the prior 409A's concluded equity value to this one — the schedule an auditor asks for first on a re-valuation without a new priced round — has nothing to render from. Wiring it needs somewhere to persist the calibration trail and the material-change list, not just a route. |
| **Attribution** | `source`/`gclid` captured; by-source donut on the dashboard | No Google Ads round-trip / conversion reporting. |
| **Read/unread on valuations** | Columns exist (`admin_read_at`, `user_read_at`, `last_comment_at`); notifications cover the alerting need | Nothing writes the read markers, and the worklist has no per-row unread indicator or "Unread" scope (409.ai §3.2). |

---

## 3. Completely missing ❌

1. **Payments** — no Stripe (or any) integration. `paid_status`/`amount_cents`/
   `paid_at` are manually edited fields; no checkout, webhook, or receipt flow.
2. **Client onboarding funnel** — no guided public flow (request → pay → upload
   → track) like `onboard.app.409.ai`. Clients use the same admin-style SPA:
   register, create a valuation, upload from the workspace. Functional, but not
   the conversion-optimized funnel the business runs on.
3. **Signature workflow** — 409.ai gates publish behind *Signature (main)* and
   *Signature (second)* review sections. Task kinds include `signoff`, but
   nothing captures signatures or enforces them before `published`.
4. **Per-valuation Bot Prompts view** — no UI/API for per-valuation AI
   prompt/run state beyond the raw job list in AiPanel.
5. **Recalculate-per-subsystem controls** — 409.ai exposes separate recompute
   triggers (accounting / bot / report stage / report prod); N409 has one
   engine compute + one report render.
6. **Company profile editor** ("modal_ui_data") — company is a name string; no
   structured, editable company profile.
7. **Package explorer** — no dependency-graph browser for the engine. (Arguably
   obsolete: the Python engine is four small modules, not a large R package.)
8. **Intercom / support widget** — absent.
9. **Sensitivity "implied" variations** — only price variations are computed
   (also listed in §2; noted here because the implied-value view is wholly
   absent rather than partial).

---

## 4. UI/UX gaps

- **Worklist row enrichment.** Scope tabs, live counts, filters, sort, and bulk
  select all exist, but rows lack 409.ai's **badges** (payment status, partner,
  reapplication, dashboard-upload) beyond waiting-on-client + kind/state, the
  **quick actions** (Company Overview / Uploads / Summary), and **unread
  indicators**.
- **Workspace nav parity.** Tabs cover Details, Documents, Params, AI, Tasks,
  Calculations, Workbook, Overwrites, Report, Sensitivity (ops) — missing a
  **Bot Prompts** tab, dedicated **Amount Raised / Transaction History** tabs
  (rounds render inside the detail page), and **count badges** on tabs (e.g.
  overwrites count, calculation progress `0/5`).
- **Report editor depth.** The contentEditable toolbar (B/I/U, H2/H3, lists) is
  serviceable but far from a production WYSIWYG — no tables, images, links, or
  numbering controls, which a deliverable valuation report will eventually need.
- **Design system**: N409 ships its own coherent "ledger" Tailwind theme (dark
  ink sidebar, brass accents, responsive mobile drawer, dependency-free SVG
  donuts) — deliberately not a visual clone of 409.ai. Not a gap, but worth
  stating that pixel parity was never the goal.

## 5. Integration gaps

| Integration | 409.ai | N409 today |
|---|---|---|
| Email out | Transactional emails delivered | Outbox complete; only `log`/`off` transports — no SMTP/provider |
| Email in | Live mail ingestion → comments; unassigned-mail triage | Endpoint ready; no relay deployed, no triage queue |
| Payments | Processor-driven paid/amount (likely Stripe) | Manual fields only |
| AI providers | Perplexity, AWS Bedrock (Llama 3.3, Sonnet 3.5), Anthropic (Opus 4.8) | OpenRouter free tier only |
| Google Ads | `gclid` attribution loop | Captured + charted, no round-trip |
| Support | Intercom widget | Absent |
| Object storage | (implied) | Documents on local disk (`DOCUMENTS_DIR`), PDFs as `bytea` in Postgres — fine for the single-host Hetzner deploy, blocks horizontal scaling |

---

## 6. Prioritized recommendations

**P0 — close the loop with the outside world**
1. **Real email transport** — one SMTP/provider adapter behind the existing
   outbox interface. Small, isolated, and it activates the already-built auto
   email workflows.
2. **Stripe checkout + webhook → `paid_status`** — turns the manual payment
   fields into a revenue flow, prerequisite for the funnel.
3. **Client onboarding funnel** — a guided request → pay → upload → track flow
   on top of existing APIs (valuation create, documents, chat, notifications
   all exist; this is mostly frontend).
4. **Mail relay + unassigned-email triage queue** — deploy an ingest worker for
   `POST /inbox/email` and persist unmatched mail for manual routing instead of
   422.

**P1 — fidelity of the core product**
5. **Engine: true OPM backsolve** (root-find the last-round PPS) and
   **multi-breakpoint waterfall allocation** — the two biggest defensibility
   gaps vs the R engine.
6. **Sensitivity: RFR axes + implied views** (Term×Vol / RFR×Vol / RFR×Term).
7. **AI: Set-Valuation-Params auto-apply, Summarize Attachments, XLSX
   extraction, cap-table anonymization step** — closes the loop from extraction
   to params without manual transcription and restores the privacy control.
8. **DB-backed prompt registry** with per-pipeline model binding (the
   `/admin/prompts` equivalent), enabling premium-provider routing later.
9. **Signature gating before publish** (task-kind enforcement + signature
   capture on the report).

**P2 — ops polish**
10. Deeper clone (documents/rounds/workbook) + engine roll-forward math.
11. Worklist row badges, quick actions, unread indicators (write
    `admin_read_at`/`user_read_at`, add an Unread scope).
12. Per-kind report template bodies merged into new reports +
    `template_version` bumping on regeneration.
13. Requester email/name search in the worklist filter.
14. Richer report editor (tables, images, links); Bot Prompts tab; company
    profile editor; Intercom-style widget.
