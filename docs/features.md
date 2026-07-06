# 409.ai — Features (as-built)

> Reverse-engineered from a read-only crawl of the admin back-office at
> `https://onboard.app.409.ai` (version **0.10.1**), logged in as an admin user.
> This documents the **existing** product. Gaps and improvements live in
> [`feature-gap-analysis.md`](./feature-gap-analysis.md) and [`improvements.md`](./improvements.md).
>
> No customer PII is reproduced here; entities are described by their schema, not their data.

---

## 1. What the product is

**409.ai** is an **AI-assisted valuation platform** for a valuation firm. It produces
independent, defensible business valuations — primarily **IRC §409A** common-stock
valuations for venture-backed private companies, plus a family of adjacent valuation
products. It combines:

1. A **client onboarding funnel** (`onboard.app.409.ai`) where founders/companies request a
   valuation, pay, and upload financial documents.
2. An **AI ingestion & extraction layer** that reads uploaded documents (cap tables, income
   statements, balance sheets, decks, projections) and auto-populates the valuation inputs,
   selects public comparables, and drafts narrative sections.
3. A **quantitative valuation engine** (an R package exposed as a REST microservice) that runs
   the actual finance math — Option Pricing Model (Black-Scholes), income/market/asset
   approaches, DLOM/DLOC discounts, roll-forwards, sensitivity analysis.
4. An **analyst/reviewer back-office** (the crawled admin app) where a large ops team reviews,
   overrides, drafts, reviews, signs, and publishes the final valuation report.
5. A **partner channel** — accounting firms, cap-table platforms and equity-management
   providers (Vestd, Promissory, DonateEquity, Reins, Gust, JPM, etc.) submit valuations on
   behalf of their customers via API and a partner-scoped view.

### Valuation product lines (`kind`)
| Kind | Meaning |
|------|---------|
| `409a` | IRC §409A common-stock fair market value (core product) |
| `fmv` | Fair market value (general) |
| `718` | ASC 718 stock-based compensation expense |
| `820` | ASC 820 fair-value measurement |
| `gifts` | Gift / estate-tax valuations |
| `qsbs` | Qualified Small Business Stock attestation |
| `csop` | UK Company Share Option Plan valuation |
| `emi` | UK Enterprise Management Incentive valuation |
| `ifrs2` | IFRS 2 share-based payment |
| `ppa` | Purchase Price Allocation |
| `goodwill` | Goodwill impairment |
| `esop` | Employee Stock Ownership Plan |
| `ip` | Intellectual-property valuation |

Each valuation instance carries a **versioned template** tag, e.g. `409a.v0 … 409a.v53`,
`gifts.v37` — the version increments as the report/template is regenerated or revised.

---

## 2. Core domain object: the Valuation

The **Valuation** is the central aggregate. Everything hangs off it. Identified by a
sequential number (`#1766`) for humans and a **ULID** (`01KWVHK7A0EMYXFSTQHSV2YTDR`) for URLs,
plus a separate **workflow id** for the orchestration engine.

### Lifecycle state machine
```
pending → started → onboarding_completed → user_finished → completed
        → (paid) → review → reviewed → drafted → draft_accepted
                                              ↘ draft_changes ↗
        → published
   side states: timeout, cancelled, ignored
   flag: waiting_on_client (overlay on any state)
```
Dashboard-facing groupings: **Pending / Incomplete / Reviewed / Drafted / Published**, plus
operational scopes **Unfinished, Unverified, In Progress, Waiting On Client, Unread, Ignored**.

### Attributes (from the meta-editor)
- **Identity:** id, uuid (ULID), workflow_id, kind, template version, service_name.
- **Company:** company name (+ editable company profile / "modal_ui_data").
- **Requester (User):** name, email, phone, `verified` flag.
- **Commercial:** `paid?` (Unpaid / Paid / Paid-by-partner), amount (e.g. $899, $809, $1,200),
  custom payment amount, `paid_at`, delivery days (SLA), `amount_raised`.
- **Attribution:** source (Partner / Referral / Ads / Repeat), partner, `gclid` (Google Ads).
- **Compliance flags:** QSBS attestation.
- **Lifecycle timestamps:** created, started, user_finished, due_date, completed, drafted,
  draft_accepted, published, admin_read_at, user_read_at, last_comment_at.
- **Ops:** assigned reviewer(s), sticky notes, comments, unread indicators.

### Per-valuation workspaces (analyst nav)
**REPORT**
- **Calculations** — the computed valuation outputs (progress shown as e.g. `0/5`), with a
  refresh/recalculate control.
- **Report Editor** — WYSIWYG editor for the deliverable report (bound to template version).
- **Report PDF** — renders/downloads the final PDF report.
- **Overwrites & Edits** — analyst manual overrides of computed/AI values (count badge).
- **Versions** — report version history.

**DATA**
- **Details** — the meta-editor (all valuation fields above).
- **Valuation Workbook** — the working spreadsheet/model.
- **Valuation Params** — the finance inputs (see §4).
- **AI / Attachments** — document uploads + AI extraction pipelines (see §5).
- **Bot Prompts** — per-valuation AI prompt/run state.
- **Amount Raised** — funding-round history.
- **Transaction History** — the company's securities transactions / financing events.

### Valuation actions
- **Restart Workflow** — re-kick the orchestration engine.
- **Recalculate**: accounting · bot (AI) · report (stage) · report (prod) — separate recompute
  triggers per subsystem/environment.
- **Reassign To** — reassign the analyst/reviewer.
- **Clone Valuation** — duplicate (used for roll-forwards / re-applications).
- **Save**, sticky **notes**, **comments**, **Chat** with the client.

---

## 3. Feature areas (admin back-office)

### 3.1 Dashboard (`/admin/dashboard`)
Ops overview: a **valuation-stage pivot** (Pending / Incomplete / Reviewed / Drafted /
Published) broken down by product (`409a`, `718`, `Gifts`, `Nav`) with an **All** total row,
plus a stage **pie chart**. Date-range search (Started at / Published at). At crawl time: 862
`409a`, 8 `718`, 12 `gifts`, 1 `nav` in flight.

### 3.2 Valuations list (`/admin/valuations`)
The operational worklist. Tabbed scopes with live counts; rich **filter sidebar** (kind, state,
id/uuid/workflow id, reviewer, partner, source, company, email, first/last name, date ranges);
multi-column **sort**; **row badges** (payment status, partner, reapplication, waiting-on-client,
dashboard_upload); quick actions (Company Overview, Uploads, Summary); **New Valuation**;
**Download CSV**; bulk-select checkboxes + actions sidebar. Sibling filtered lists exist as
first-class nav items: **Incomplete, Unverified, In Progress, Drafted, Published**.

### 3.3 Reviews / task management (`/admin/reviews`)
A granular **task-assignment system** layered over valuations — **5,703** review records at
crawl time. Each valuation spawns multiple typed **review tasks** assigned to specific team
members. Task **sections** include: *Entire valuation, Data task, Support task, Full, Approve
draft report, Review draft report, Send draft report, Manual publish, Publish report, Assign,
Signature (main), Signature (second)*. States: **New / Started / Completed / Cancelled /
Overdue / Assigned To Me**, with due dates and finished timestamps. This is the workflow that
routes a valuation from data-entry → analyst → reviewer → signer → publish.

### 3.4 Inbox (`/admin/inbox`)
**Email ↔ valuation** integration. Inbound client emails become **valuation comments**;
messages that can't be matched appear as **unassigned emails** to be routed to a valuation.
Powers the "No. of messages / last message at / unread" indicators on each valuation.

### 3.5 Sensitivity Dashboard (`/admin/investor`)
OPM **sensitivity analysis** tables for a valuation: **Term vs Volatility**, **Risk-Free-Rate
vs Volatility**, **Risk-Free-Rate vs Term**, each showing **implied** and **price** variations —
i.e. how the resulting share price moves as Black-Scholes inputs are stressed.

### 3.6 Documentation / Overwrites Explorer (`/admin/overwrites_doc`)
Self-documenting schema browser (table + card views) for the **Overwrites** configuration — the
set of fields an analyst can manually override on a valuation. **68 fields across 6 categories**:
Company Information (7), Financial Metrics (17), Forecasts & Projections (12), Valuation
Parameters (15), Market & Comparables (16), Reporting & Filing (1). Shows class (numeric/date/
character), min/max, and example values (e.g. `industry_id`, `valuation_date`, `exit_timeline`,
`currency`, `service_countries[]`, `yearend`, `bootstrap_assets`).

### 3.7 Package Explorer (`/admin/package_explorer_doc`)
A **visNetwork dependency graph** of the **R calculation-engine package** — a live map of the
quant codebase by dependency level (entry → calls → uses → depends → …). Confirms the engine's
building blocks (see §6): `BLACK_SCHOLES`, `back_solve`/`run_bsm`/`sa_bsm`, `CHAFFEE`,
`FINNERTY`, `BETAS`, `EBITDAM`, `REVM`, `newton_raphson` (C++), `ANNUALIZE_*`, `COMPARABLES`,
`FUNDAMENTALS`, `WEIGHTS`, `FRODO`/`ROLL_FRODO`, topic-modeling/NLP matchers, `plumber.R`.

### 3.8 Partner Valuations (`/admin/partner_valuations`)
Partner-scoped list (**323** at crawl) of valuations submitted through the partner channel, with
a simplified status model (**Work in progress / Waiting on client / Published**) and partner
filters. Backed by the Partner API.

### 3.9 Settings
- **Users** (`/admin/users`) — **1,308** users with role-based access. Roles/scopes observed:
  *Valuation User, Admin, God, Supervisor, Support / Support Supervisor, Reviewer / Main
  Reviewer / Contributing Reviewer, Data / Data Supervisor, Partner, Member, Investor, Auto,
  Spa, Ignored*. Per-user: name, email, roles, partner, phone, `verified`, `sso` (google),
  `gclid`, valuation count. Download CSV.
- **API Tokens** (`/admin/api_tokens`) — partner API credentials (client id + masked secret),
  scoped to a partner + user. Present: Promissory, Vestd, DonateEquity, Reins.
- **Prompts** (`/admin/prompts`) — the **AI prompt registry** (see §5): 27 named prompts, each
  bound to a **bot/model**, with content and timestamps; create/edit/delete.

---

## 4. The valuation methodology (Valuation Params)

The `Valuation Params` editor is the human-readable face of the finance model. It captures the
inputs a valuation analyst needs to run a multi-approach 409A valuation:

**Company / context**
- Rolling forward? (is this a roll-forward of a prior valuation), inception date, fiscal
  year-end, exit timeline, business overview, revenue status (Pre-Revenue / Post-Revenue
  Unprofitable / …), last financing round, last-year revenue, YTD revenue, runway (months).

**Approach weights** (how the concluded equity value is allocated across methods)
- **Asset** approach — cost-to-replicate, Net Asset Value.
- **OPM** — Option Pricing Model / Black-Scholes backsolve to the last round.
- **Income** approach — DCF.
- **Market** approach — guideline public companies: **Revenue** and **EBITDA** multiples,
  **LTM/NTM**, with optional custom multiple ranges.

**Discounts**
- **DLOC** — Discount for Lack of Control.
- **DLOM** — Discount for Lack of Marketability, via **Chaffee** (protective-put) and
  **Finnerty** (average-strike put) models, plus a **qualitative** override.

The engine converts these into a concluded common-share fair market value, with the OPM
allocating value across the cap-table's share classes.

---

## 5. AI layer

AI is central (it's in the name). Two surfaces:

### 5.1 Per-valuation AI (`/admin/ais/:uuid`)
- **Attachments** by kind: Articles, Decks, Exports, **Cap-table documents**, **Monthly/Annual
  income statements**, **Balance sheets**, **Projections files**, Uploads, Draft reports,
  **Previous valuations**, Mail attachments. Upload / drag-drop.
- **AI actions:** *Find Mappings and Sources* · *Set Valuation Parameters* · *Summarize
  Attachments* · *Create Missing Entries*.
- **Pipelines (Run):** *Missing Data*, *Data Extraction*, *Public Comparables*.
- **AI Jobs** tab (job history/status) and **Network Items** tab (extracted comparable-company
  / network data).

Flow: analyst uploads the company's financials & cap table → AI extracts and normalizes the
figures, fills in the valuation params, proposes comparable public companies, and flags missing
data → analyst reviews/overrides → engine calculates → report drafts.

### 5.2 Prompt registry & model routing (`/admin/prompts`)
Prompts are first-class, versioned records bound to a **bot** (model). Observed routing:
| Bot / model | Used for |
|-------------|----------|
| `perplexity`, `perplexity-PRO` | Market, industry & competitor research; country-specific market analysis (`market_us/ca/au/si/uk/un`); company overview/description; risks; industry outlook |
| `bedrock-LLAMA33` (AWS Bedrock, Llama 3.3) | Competitor extraction |
| `bedrock-SONNET35` (Bedrock, Claude Sonnet 3.5) | **Cap-table anonymization** (data-privacy step before extraction) |
| `Anthropic-OPUS_4_8` (Claude Opus 4.8) | Core structured extraction: `FIND_MAPPING_AND_SOURCES`, `MISSING_DATA_SUMMARY`, `FIND_COMPARABLES`, `SET_VALUATION_PARAMS` |

Notable: cap tables are **anonymized** by an LLM before downstream processing — a deliberate
privacy control given the sensitivity of the data.

---

## 6. Architecture (as observed)

- **Admin / web app** — server-rendered **Ruby on Rails** style app (`/admin/*` routes, ULID
  ids, `New/Edit/Listing` CRUD conventions, `Powered by 409.ai`, v0.10.1). Client-side viz via
  **Chart.js** and **vis.js/visNetwork**. **Intercom** support widget embedded.
- **Valuation engine** — an **R package** exposed as a **REST microservice via Plumber**
  (`plumber.R`, `LAUNCH_API`, `monitor.R`, HTTP error guards), with a **C++** `newton_raphson`
  root-finder for backsolve/IRR. **Dockerized** (`docker-base-image.yml`, `docker-image.yml`)
  with **Travis CI**. Config via YAML (`constants.yml`, `overwrites.yml`, `projections.yml`,
  `functions.yaml`).
- **AI services** — Perplexity API, **AWS Bedrock** (Llama 3.3, Claude Sonnet 3.5), and the
  **Anthropic API** (Claude Opus 4.8).
- **Auth** — email/password **and Google OAuth SSO**; fine-grained **RBAC**.
- **Integrations** — Partner **REST API** (token-authed), **email ingestion** → comments,
  **Google Ads** attribution (`gclid`), and payments (implied by paid/amount fields; likely
  Stripe).

A fuller target architecture is designed in [`architecture.md`](./architecture.md),
[`system-design.md`](./system-design.md), [`database-design.md`](./database-design.md) and
[`api-design.md`](./api-design.md).

---

## 7. Feature inventory (quick checklist)

- [x] Client onboarding funnel + payment + document upload (inferred from client side; not deeply crawled)
- [x] Google OAuth SSO + email/password auth
- [x] Multi-product valuations (13 kinds) with versioned templates
- [x] Valuation lifecycle state machine + workflow engine (restartable)
- [x] Ops dashboard (stage pivot + charts)
- [x] Valuation worklist with rich filter/sort/scopes + CSV export
- [x] Analyst meta-editor (all valuation fields)
- [x] Valuation Params (multi-approach 409A methodology inputs)
- [x] Valuation Workbook (working model)
- [x] R-based calculation engine (OPM/income/market/asset, DLOM Chaffee/Finnerty, roll-forward)
- [x] Sensitivity analysis dashboard (OPM stress tables)
- [x] AI document ingestion + data extraction + comparable selection + param setting
- [x] AI prompt registry with multi-provider model routing
- [x] Cap-table anonymization (privacy)
- [x] Manual Overwrites system (68 fields) + self-documenting schema explorer
- [x] Report editor + PDF rendering + version history
- [x] Review/task management (typed tasks, assignment, SLA, signatures, publish)
- [x] Email inbox integrated to valuation comment threads
- [x] Client chat per valuation
- [x] Partner channel: API tokens + partner-scoped valuations
- [x] RBAC with ~15 roles; user management + CSV export
- [x] Marketing attribution (source, gclid)
- [x] Package/dependency explorer for the engine codebase
```
