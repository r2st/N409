# N409 — Remaining Feature Gaps vs 409.ai

> Status as of 2026-07-06, after Milestones M0–M4 (32 features shipped across
> `feat: Milestone 0`, `feat: web frontend`, `feat: Milestones 1+2`,
> `feat: Milestone 4`). Compiled by cross-referencing
> [`features.md`](./features.md) (the as-built 409.ai crawl) against the actual
> code in `src/services/`. Successor to
> [`feature-gap-analysis.md`](./feature-gap-analysis.md), which predates M1–M4.
>
> **Headline:** the end-to-end production pipeline (intake → AI extraction →
> params → engine → workbook/overwrites → report → publish) is real and works.
> What never landed is most of **Milestone 3 — Operations**: the migration
> numbering reserved `0004–0029` for it, but no M3 commit exists. That is where
> the bulk of the remaining gaps live (partner channel, user admin, inbox,
> comments/chat, clone/roll-forward, advanced filtering).

---

## 1. Fully implemented ✅

### Core domain & lifecycle
- [x] **Valuation aggregate** with all 13 product kinds (`409a` … `ip`), ULID ids,
  sequential human numbers, template/engine version tags
  (`migrations/0001_core.sql`, `routes/valuations.ts`).
- [x] **Full 14-state lifecycle enum** (`pending` → … → `published`, plus
  `timeout`/`cancelled`/`ignored`) with `waiting_on_client` overlay flag and all
  lifecycle timestamps from the crawl (`created/started/user_finished/due_date/
  completed/drafted/draft_accepted/published/admin_read_at/user_read_at`).
- [x] **Append-only audit event spine** — every mutation recorded in
  `valuation_events`, immutability enforced by DB triggers (UPDATE/DELETE/TRUNCATE
  blocked). Event timeline exposed at `GET /valuations/:id/events`.
- [x] **Workflow engine (M4)** — advance / restart / reassign endpoints with
  transition legality checks (`domain/workflow.ts`, `routes/workflow.ts`).
- [x] **Bulk actions** — `POST /valuations/bulk` (set_state, advance, restart,
  assign_reviewer) with per-id success/failure results; wired to checkbox
  selection in the valuations list UI.
- [x] **State-change hooks** — auto email workflows + in-app notifications fire
  on every state transition (`hooks/stateChange.ts`, `domain/emailWorkflows.ts`).

### Auth & RBAC
- [x] Email/password auth (bcrypt-style digests) + JWT sessions.
- [x] **Real Google OIDC SSO** — full authorization-code flow with JWKS
  verification (`auth/google.ts`), not a stub.
- [x] **RBAC with all 17 observed roles seeded** (`0002_seed_roles.sql`:
  valuation_user, admin, god, supervisor, support, reviewer, main_reviewer,
  data, partner, investor, …). Scope-aware reads (client sees own, partner sees
  partner-scoped, ops sees all), field-level patch permissions, 404-not-403 for
  out-of-scope ids (`auth/rbac.ts`).

### Pipeline (M1)
- [x] **Review/task system** — typed tasks (10 kinds), open/in_progress/blocked/
  done/cancelled states, assignee, SLA hours, due dates; per-valuation and
  "my tasks" views (`routes/tasks.ts`, TasksPage, TasksPanel).
- [x] **Document management** — multipart upload with 11 document kinds
  (cap_table, income_statement, balance_sheet, projections, pitch_deck, …),
  sha256 dedup metadata, soft delete, download (`routes/documents.ts`).
- [x] **AI pipelines** — `missing_data`, `extract`, `comparables` running via
  OpenRouter with model fallback; deterministic checklist + LLM hybrid for
  missing data; field-whitelisted extraction so hallucinated keys can never
  reach the engine; job provenance in `ai_jobs` (`services/ai/app/pipelines.py`,
  `routes/ai.ts`).
- [x] **Calculation engine (Python)** — weighted 4-approach model (asset
  NAV/cost-to-replicate, OPM, income DCF with terminal value, market multiples
  with median selection), Black-Scholes allocation over the preferred
  liquidation preference, DLOC, DLOM via **Chaffee and Finnerty** closed forms
  or qualitative override, FMV per fully-diluted common share
  (`engine-wrapper/app/engine/`). Results persisted per run in `calculations`.
- [x] **Valuation Params editor** — full methodology inputs from the crawl:
  rolling-forward flag, revenue status, exit timeline, approach weights with a
  DB-enforced sum-to-1 constraint, DLOC/DLOM method config, market
  method/horizon (`valuation_params` table, ParamsPanel).

### Output & delivery (M2)
- [x] **Overwrites system — all 68 fields across the 6 documented categories**
  (company_info 7 · financial_metrics 17 · forecasts 12 · valuation_params 15 ·
  market_comparables 16 · reporting 1) with class/min/max/example metadata,
  per-field validation, original-value capture, and the **self-documenting
  schema explorer** UI (`domain/overwrites.ts`, OverwritesSchemaPage).
- [x] **Valuation workbook** — code-defined sheets with input vs derived rows;
  only inputs persisted, formulas recomputed on read so stored data can never
  disagree with the model (`domain/workbook.ts`, WorkbookTab).
- [x] **Report editor + PDF + versions** — per-valuation report with sectioned
  HTML content, WYSIWYG editing (contentEditable, sanitized client and server
  side), immutable version history with revert, lazy PDF rendering (pdfkit,
  no headless browser), draft/accepted/changes/published statuses
  (`routes/reports.ts`, ReportTab, `report/src/pdf.ts`). Report service also
  exposes a stateless `POST /render/v1/pdf` for other consumers.
- [x] **Report template management (M4)** — versioned templates
  (`name` + integer version ≈ `409a.v53`), draft/active/archived with a
  one-active-per-name DB constraint, activate/archive endpoints, admin UI
  (`routes/templates.ts`, TemplatesPage).

### Operations polish (M4)
- [x] **Funding rounds & transaction history** — CRUD for rounds (pre/post
  money, shares issued) and securities transactions (issuance, secondary sale,
  conversion, …) (`routes/transactions.ts`, FundingHistory component).
- [x] **In-app notifications** — unread badge in nav (60s poll), read/read-all,
  notifications page.
- [x] **Auto email workflows** — transactional outbox (`email_outbox`) enqueued
  atomically with state changes; templates for started / review / draft-ready /
  published / cancelled; delivery status + attempts tracked.
- [x] **Global search** (`GET /api/v1/search`, SearchPage).
- [x] **CSV + PDF export** of the valuations list (`routes/exports.ts`).
- [x] **Sensitivity analysis** — OPM volatility × term stress grid with
  delta-from-base per cell (`domain/sensitivity.ts`, SensitivityPage).
- [x] **Rich sort** — whitelisted multi-column sort (`sort=company_name:asc,…`)
  with clickable column headers.
- [x] **Marketing attribution capture** — `source` (partner/referral/ads/repeat)
  and `gclid` accepted at creation and stored.
- [x] **QSBS attestation flag**, multi-currency (`currency`,
  `service_countries[]`), paid status incl. `paid_by_partner`, delivery-days SLA
  — all present as editable valuation fields.

---

## 2. Partially implemented ⚠️

| Feature | What's done | What's missing |
|---|---|---|
| **OPM backsolve** | Market-calibrated equity value from the last round | Simplified to post-money ≡ equity value (documented shortcut in `approaches.py`; "refinement lands with #17"). No Newton-Raphson iteration to reprice the preferred tranche to the round PPS like the R engine's `back_solve`/`newton_raphson`. |
| **OPM allocation** | Single-breakpoint Black-Scholes split (preference vs upside), as-converted fallback | 409.ai's engine allocates across the **full cap-table waterfall** (multiple share classes / breakpoints). Only one aggregate liquidation preference is modeled. |
| **Sensitivity dashboard** | One stress table: Volatility × Term, price + delta | 409.ai shows **three** tables — Term×Vol, RFR×Vol, RFR×Term — each with *implied* and *price* variations. RFR axes are absent. |
| **Dashboard** | Stat cards (open/in review/drafted/published/waiting-on-client) + recent list | No **product-kind pivot table** (states × 409a/718/gifts/nav with All row), no **pie chart**, no date-range search. Stats are computed client-side from the first 100 valuations (`per_page=100`), so counts go wrong at scale — needs a server-side stats endpoint. |
| **Valuations worklist** | State + kind filters, rich sort, pagination, bulk select, CSV/PDF export, waiting-on-client + kind/state badges | 409.ai's **filter sidebar** (id/uuid/workflow id, reviewer, partner, source, company, email, first/last name, date ranges) and **tabbed scopes with live counts** (Unfinished, Unverified, In Progress, Waiting On Client, Unread, Ignored) plus sibling nav lists (Incomplete/Unverified/Drafted/Published). Backend only accepts `state`/`kind`/`sort`/paging. |
| **AI actions & pipelines** | 3 of the crawled pipelines (Missing Data, Data Extraction, Public Comparables) | Missing AI actions: **Find Mappings and Sources**, **Set Valuation Parameters** (auto-apply to params — extraction results currently require manual application), **Summarize Attachments**, **Create Missing Entries**; no **Network Items** (extracted comparable-network data) tab. |
| **AI model routing** | OpenRouter with ordered fallback across 3 free models, per-job model recorded | No **prompt registry** (prompts are hard-coded in `pipelines.py`, not DB records with CRUD like `/admin/prompts`' 27 prompts); no multi-provider routing (Perplexity for research, Bedrock, Anthropic direct); no **cap-table anonymization** privacy step before extraction. |
| **Email** | Outbox with pluggable transport, but only the `log` transport exists (`EMAIL_MODE=log`) | No real SMTP/provider integration — nothing is actually delivered. And inbound email is entirely absent (see §3 Inbox). |
| **Attribution** | `source`/`gclid` captured and stored | No reporting/analytics on it, no Google Ads round-trip. |
| **Document ingestion formats** | PDF (pypdf, first 40 pages) + text-like (csv/tsv/txt/md/json) | No XLSX/DOCX extraction — cap tables and financials very often arrive as Excel. Corpus capped at 60k chars. |
| **Partner channel (data model only)** | `partners` table, partner-scoped RBAC reads, `paid_by_partner`, partner attribution on create | Everything user-facing: partner CRUD/admin, partner-scoped valuations list UI with the simplified status model, and the whole **Partner API** (see §3). |
| **Report templates ↔ reports** | Templates versioned and managed; reports carry a `template_version` | Only a single built-in 409a section layout in code (`domain/report.ts`); template bodies aren't merged into new reports per kind, and non-409a kinds have no bespoke layouts. |

---

## 3. Completely missing ❌

Almost all of these were scoped as **Milestone 3 (Operations)** and never built.

1. **Partner API + API tokens** — no `api_tokens` table, no token-authed partner
   REST surface, no token management UI. The 409.ai partner channel (Vestd,
   Promissory, DonateEquity, Reins…) has no equivalent.
2. **User / role admin console** — no routes to list users, edit roles, verify,
   or export users CSV. Roles are seeded in SQL but can only be assigned by
   hand in the database; registration hard-codes `valuation_user`
   (`routes/auth.ts:58`). This blocks actually operating the RBAC system.
3. **Inbox / email-to-valuation threading** — no inbound email ingestion, no
   unassigned-email routing, no message/unread indicators on valuations
   (`admin_read_at`/`user_read_at`/`last_comment_at` columns exist but nothing
   writes them).
4. **Comments & client chat** — no comments table, no per-valuation thread, no
   client↔analyst chat. Grep for comment/chat across services returns nothing.
5. **Sticky notes** on valuations — absent.
6. **Clone valuation / roll-forward** — no clone endpoint or UI. The
   `rolling_forward` param flag exists, but the engine has no roll-forward
   (`FRODO`/`ROLL_FRODO`) logic and there's no way to duplicate a valuation for
   a re-application.
7. **Payments** — no Stripe (or any) integration. `paid_status`/`amount_cents`/
   `paid_at` are manually edited fields; there is no checkout, webhook, or
   receipt flow.
8. **Client onboarding funnel** — no guided public flow (request → pay → upload
   documents → track status) like `onboard.app.409.ai`. Clients use the same
   admin-style SPA: register, create a valuation, upload from the workspace.
9. **Per-valuation Bot Prompts view** — no UI/API for per-valuation AI
   prompt/run state beyond the raw ai_jobs list in AiPanel.
10. **Signature workflow** — 409.ai's review sections include *Signature (main)*
    and *Signature (second)* before publish; task kinds here include `signoff`
    but there is no signature capture/enforcement gating publish.
11. **Recalculate-per-subsystem controls** — 409.ai exposes separate recompute
    triggers (accounting / bot / report stage / report prod). N409 has one
    engine compute + one report render.
12. **Package explorer** — no dependency-graph browser for the engine. (Arguably
    obsolete: the Python engine is 4 small modules, not a large R package.)
13. **Intercom / support widget** — absent.
14. **Company profile editor** ("modal_ui_data") — company is just a name field;
    no structured company profile.
15. **Versioned template tags on valuations advancing automatically**
    (`409a.v0 → v53` regeneration bumping) — `template_version` is stored but
    nothing increments it on regeneration.

---

## 4. UI/UX gaps

- **No charting at all.** 409.ai uses Chart.js (stage pie) and vis.js (package
  graph). N409's dashboard is stat cards + a table; the sensitivity grid is a
  plain table. No pie/pivot visualizations anywhere.
- **Worklist ergonomics.** No filter sidebar, no scope tabs with live counts, no
  quick actions per row (Company Overview / Uploads / Summary), no unread
  indicators. For an ops team living in this list all day, this is the largest
  day-to-day UX gap.
- **Valuation workspace nav** covers Details, Documents, Params, AI, Tasks,
  Calculations, Workbook, Overwrites, Report — but is missing the crawled
  **Bot Prompts**, **Amount Raised / Transaction History as workspace tabs**
  (rounds/transactions render inside the detail page via FundingHistory),
  and **Overwrites & Edits count badges** on the nav.
- **Report editor** is a minimal contentEditable toolbar (B/I/U, H2/H3, lists) —
  serviceable, but far from a production WYSIWYG (no tables, images, links,
  numbering controls) that analysts would need for a deliverable report.
- **Design system**: N409 has its own coherent "ledger" Tailwind theme (dark
  ink sidebar, brass accents, responsive mobile drawer) — polished, but
  intentionally not a visual clone of 409.ai. No gap per se; noting the
  deliberate divergence.
- **Sensitivity page** is properly linked as an ops-only workspace tab — no gap
  there beyond the missing RFR axes noted in §2.

## 5. Integration gaps

| Integration | 409.ai | N409 today |
|---|---|---|
| Email out | Transactional emails delivered | Outbox + `log` transport only — nothing sent |
| Email in | Inbound mail → valuation comments | Absent |
| Payments | Paid/amount fields driven by a processor (likely Stripe) | Manual fields only |
| AI providers | Perplexity, AWS Bedrock (Llama 3.3, Sonnet 3.5), Anthropic (Opus 4.8) | OpenRouter free tier only |
| Google Ads | `gclid` attribution loop | Captured, unused |
| Support | Intercom widget | Absent |
| Object storage | (implied) | Documents on local disk (`DOCUMENTS_DIR`), PDFs as `bytea` in Postgres — fine for one host, blocks horizontal scaling |
| Partner APIs | Token-authed REST for 4+ partners | Absent |

---

## 6. Prioritized recommendations

**P0 — operate the product at all** (mostly the skipped M3)
1. **User & role admin** (routes + console + users CSV). Without it RBAC is
   unmanageable — everything else assumes you can create reviewers/partners.
2. **Comments + client chat** on valuations (the collaboration backbone; also
   populates `last_comment_at`/unread indicators already in the schema).
3. **Advanced worklist filtering + scope tabs with counts** (backend query
   params + filter sidebar). Biggest daily-driver gap for ops.
4. **Real email transport** (one SMTP/provider adapter — the outbox
   architecture makes this a small, isolated change).
5. **Clone / roll-forward valuation** (core to the 409A annual-refresh business
   model; the audit spine makes cloning straightforward).

**P1 — revenue & fidelity**
6. **Payments (Stripe checkout + webhook → paid_status)** and a minimal client
   onboarding funnel (request → pay → upload → track).
7. **Partner API + token management** (the schema is ready; this unlocks the
   entire partner channel).
8. **Engine fidelity**: true OPM backsolve (root-find the round PPS) and
   multi-breakpoint waterfall allocation; add RFR axes + implied/price views to
   sensitivity.
9. **AI completion**: Set-Valuation-Params auto-apply, Summarize Attachments,
   cap-table anonymization step, XLSX extraction, DB-backed prompt registry.
10. **Server-side dashboard stats endpoint** + product pivot + date-range search
    (fixes the 100-row client-side stats bug at the same time).

**P2 — polish**
11. Inbox (inbound email routing), sticky notes, signature gating before
    publish, per-kind report template bodies merged into new reports, charts
    (stage pie), Intercom-style support widget, richer report editor.
