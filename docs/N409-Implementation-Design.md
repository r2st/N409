# N409 Implementation Design

**Feature-by-feature specification derived from the 409.ai admin console**

| | |
|---|---|
| Document | N409 Implementation Design |
| Version | 1.1 |
| Date | 2026-08-08; revised 2026-08-14 |
| Source of requirements | `docs/screenshot-catalog.md` — 409.ai admin console at `onboard.app.409.ai`, version 0.10.1, captured 2026-08-07 |
| Codebase audited | `main` at `f883d6a`, deployed revision `79f5ba5` |
| Status | **Every gap in §17.1 is closed.** Status lines and specs are preserved as written at audit time; each section carries a trailing **Closed** note recording what actually shipped and where it diverged from the spec. Counts re-verified 2026-08-14 — see Appendix A. |
| Companion document | `N409-System-Design.docx` — describes N409 as built. This document was written as what was *left to build*, and is now the record of how it was built. |

---

## Contents

1. Purpose, method and how to read this document
2. Platform summary — 409.ai observed vs N409 as built
3. Dashboard & Analytics
4. Valuation Management
5. Workbook Editor
6. Report Generation
7. Calculation Engines
8. Overwrites System
9. Document Management
10. User & Role Management
11. Partner System
12. AI Integration
13. Email System
14. API Tokens & Partner API
15. Inbox & Comments
16. Intake Wizard
17. Consolidated gap analysis
18. The top ten P0 gaps
19. Appendix A — evidence map
20. Appendix B — gaps closed since the last design document

---

# 1. Purpose, method and how to read this document

## 1.1 Purpose

`N409-System-Design.docx` documents the system as built. It is a description. This document was a work order: it takes every feature visible in the 409.ai admin console, states whether N409 has it, and where N409 does not, specifies the schema, endpoints, components, logic and integration points required to close it.

Every item it specified has since shipped, which changes what the document is for rather than making it disposable. The specs stay because a reader asking *why* a table has the columns it has needs the argument that chose them, and the trailing **Closed** notes record where the implementation departed from the spec and on what grounds. A design document rewritten to match the code is a document that can never be checked against it.

The screenshot catalog is the requirements source. Where the catalog records a count — 68 overwrite fields, 20 prompts, 27 auto emails, 24 partners, 16 roles, 13 document categories — that count is treated as the target, and the audit below states the N409 figure against it.

## 1.2 Method

Every status claim in this document was verified against the tree, not carried forward from `docs/409AI_FEATURE_GAPS.md` (2026-07-10) or from section 13 of the existing design document (verified at `8861b0c`). Both predate the specialty engine work, the platform-surfaces commit `cb869ba`, and the Perplexity adapter. Appendix B lists the gaps those documents record that are now closed, so a reader working from either one does not re-do finished work.

Verification was: enumerate the migrations (115 files, 86 tables), enumerate the route registrations in `src/services/valuation/src/routes/` (80 files), enumerate the React router table in `src/services/web-frontend/src/App.tsx`, enumerate the FastAPI endpoints in both Python services, and grep for the specific identifier each feature would have to use.

## 1.3 Status labels

| Label | Meaning |
|---|---|
| **Built** | Present end to end — storage, server, client — and reachable by the role that needs it. |
| **Partial** | One or more layers exist and one is missing. The spec section says which. A feature whose server is complete but which nothing calls is Partial, not Built: an unreachable capability is not a capability. |
| **Missing** | No storage, no endpoint, no component. |
| **Deliberately different** | N409 does the job by another mechanism, and the difference is a decision rather than an omission. No work is specified. |

## 1.4 Priority ratings

| Rating | Definition |
|---|---|
| **P0** | Blocks a workflow an operator or client must complete, or a capability that is paid for and cannot be delivered. Includes work that is finished but unreachable — the cost is already sunk and the value is not being collected. |
| **P1** | The workflow completes but costs materially more operator time, or the surface is visibly thinner than the competitor's for a buyer comparing them. |
| **P2** | Parity or polish. Deferrable without an operational consequence. |

Effort is stated as **S** (under a day), **M** (one to three days), **L** (over three days), for one engineer already familiar with the area.

---

# 2. Platform summary — 409.ai observed vs N409 as built

| Dimension | 409.ai (observed) | N409 (audited, 2026-08-08) | Verdict at audit → now |
|---|---|---|---|
| Product kinds | 409A, ASC 718, ASC 820, FMV, gifts, IFRS2, IP, NAV — 8 marketed | 15 in `valuation_kind`: `409a fmv 718 820 gifts qsbs csop emi ifrs2 ppa goodwill esop ip fund debt` | N409 ahead |
| Lifecycle states | 14 documented; sidebar exposes 7 buckets | 15 in `valuation_state`, `paid` implemented as a real gate | N409 ahead |
| Listing filter tabs | 9 named tabs with live counts and unread badges | 5 state groups + All; 12 URL filter keys; saved views | Behind on presentation → **parity** (`NAMED_BUCKETS`, §4.2) |
| Report skeletons | 14 marketed report types | 16 skeletons — 15 kind-specific + generic fallback | N409 ahead |
| Overwrite fields | 68 across 6 categories | 68 across 6 categories, exact match, self-documenting registry | Parity |
| Document categories | 13+ | 13 in `document_category` | Parity |
| User roles | 16 tabs observed | 18 role keys, capability matrix asserted against `auth/rbac.ts` | N409 ahead |
| Partners | 24 rows; subdomain, prepaid, cc_emails | Same three fields, plus HMAC webhooks with a retry ladder and white-label branding | N409 ahead |
| AI prompts | 20 DB-backed prompts across 6 providers | 12 pipeline prompts + 34 narrative-section rows; Perplexity adapter built but unwired | Behind on breadth and reach → **N409 ahead** (20 pipelines, research wired, §12.1/§12.3) |
| Email templates | 12 | 32 seeded across 6 categories, 15 declared variables | N409 ahead |
| Auto sequences | 27 (21 email + 6 SMS) | 27 across both channels | Parity |
| API tokens | Admin listing of all tokens, 4 rows | Per-partner CRUD on the partner detail page; no cross-partner listing | Behind on presentation → **N409 ahead** (dormant-key summary, §14.1) |
| Inbox | Cross-engagement comment listing | Built, with per-reader unread state; no compose box | Partial → **N409 ahead** (§15.2) |
| Quant engine | R/Plumber — Black-Scholes, Newton-Raphson, waterfall, Chaffee/Finnerty | Python/FastAPI, 37 engine modules, 31 endpoints; adds PWERM, CVM, hybrid, WACC build-up, volatility estimation, Ghaidarov, Longstaff, restricted-stock | N409 well ahead |
| Payments | Live Stripe | Stripe code complete and tested; **unconfigured in production** | Behind in production → **configured** (test-mode key; webhook secrets pending a dashboard step) |
| Marketing | Landing, pricing, compare hub, 14 product pages, 25-article blog | All but the blog | Behind on the blog → **parity** (§16.2) |

The headline at audit: N409's depth exceeded 409.ai almost everywhere the engine or the data model was involved, and fell behind in three specific places — **operator-facing presentation of state it already stores**, **the reach of the AI layer**, and **payments in production**. The P0 list in section 18 was dominated by the third category of gap defined in §1.4: capability that is built and not reachable.

All three are now closed, and the pattern is worth keeping. Two of the three were never capability gaps at all — the state was stored and the adapter was written; what was missing was the last layer that made either reachable. Only payments needed something outside the tree. An audit that had counted features rather than asking who could actually reach them would have reported this platform as at parity and found nothing to do.

---

# 3. Dashboard & Analytics

## 3.1 Admin dashboard overview

**409.ai** — a landing dashboard with valuation statistics and a recent-activity list, plus a second screen of content below the fold.

**N409 status at audit: Partial.**

`GET /api/v1/stats/dashboard` and `GET /api/v1/valuations/counts` (`routes/operations.ts`) serve the figures. `DashboardPage.tsx` renders a welcome block, four state-group counts (`open`, `drafted`, `published`, `closed`) and a link to the listing. `FirmDashboardPage.tsx` and `GET /api/v1/firm/dashboard` / `/firm/attention` are the richer surface, but they are firm-scoped and live at `/firm`, so an ops user landing at `/dashboard` sees the thin version.

### Implementation spec

**Database.** None. Every figure is derivable from `valuations`, `valuation_comments`, `email_outbox` and `pipeline_runs`.

**API.** Extend `GET /api/v1/stats/dashboard` to return, in one response:
- `buckets`: the seven sidebar buckets of §4.2 with `total` and `unread` per bucket.
- `activity`: the 20 most recent `admin_events` rows visible to the caller's scope, joined to the engagement and actor.
- `throughput`: valuations published per week for the trailing 12 weeks.
- `sla`: count of engagements past `due_at`, and count in `waiting_on_client` for more than 7 days.

Scope every branch through `valuationScope` — the same helper the listing and inbox use. A dashboard that counts rows a partner may not read is a cross-firm leak in aggregate form, which the existing sweep test (`f883d6a`) exists to prevent.

**Frontend.** Rework `DashboardPage.tsx` into three bands: a bucket strip (clickable, each navigating to the listing pre-filtered), an attention band (reuse `AttentionBand.tsx`), and an activity feed. `charts.tsx` already has the primitives for the throughput sparkline.

**Business logic.** `unread` per bucket is per-reader, and `valuation_comment_reads` already models it that way (migration `0113`). Do not compute it from `last_comment_at` alone — that gives every reader one badge that goes stale at once, which is the bug `0113` was written to fix.

**Integration points.** `AppLayout.tsx` sidebar badges consume the same `buckets` payload, so the count on the nav and the count on the dashboard cannot disagree.

**Priority: P1 · Effort: M. Closed.** `routes/operations.ts` serves `buckets`, `activity`, `throughput` and `sla` from one handler in a single `Promise.all`, and `DashboardPage.tsx` renders the three new bands. Two judgments: the SLA band is the only one that changes colour, because a dashboard where everything can turn red is one where nothing means red — `overdue` and `waiting_stale` are the two conditions an ops user can actually act on today, and the rest is reporting. And throughput is counted by `date_trunc('week', published_at)` over ISO weeks rather than a rolling 7-day window, because a rolling window moves the boundary every time the page loads and makes a flat week look like a trend.

## 3.2 Sidebar bucket counts with unread badges

**409.ai** — the sidebar carries live counts: Valuations 979 (6 unread), Incomplete 359, Unverified 2, In Progress 21 (4 unread), Waiting On… 22 (6 unread), Drafted 41, Published 0.

**N409 status at audit: Missing.** `AppLayout.tsx` renders static nav labels. Counts exist server-side; nothing displays them per bucket.

### Implementation spec

**API.** Served by the `buckets` field added in §3.1. Cache for 30 seconds per (user, scope) — the nav re-renders on every route change and an uncached seven-way count on each is a self-inflicted load problem.

**Frontend.** A `useBucketCounts()` hook polling on a 60-second interval plus invalidation on the SSE workflow event already broadcast by `routes/stream.ts`. Badge component: total in muted type, unread in the accent colour, matching `InboxPage`'s existing unread treatment.

**Priority: P1 · Effort: S. Closed.** `AppLayout.tsx` reads the same `buckets` payload §3.1 added, so the nav count and the dashboard count cannot disagree — which was the whole reason to serve them from one place rather than let the sidebar total its own. `NAMED_BUCKETS` in `domain/workflow.ts` is the single definition the badges, the listing tab strip (§4.2) and the partner detail tiles (§4.4) all read; three surfaces counting "unverified" three ways is how two of them end up wrong and nobody can tell which.

## 3.3 Per-valuation analytics

**409.ai** — not observed as a distinct surface.

**N409 status: Built, ahead.** `GET /api/v1/valuations/:id/analytics` + `AnalyticsTab.tsx`, plus `ValuationComparePage`, `SensitivityPage`, `BridgeTab` (value-bridge decomposition) and `PortfolioPage`. No work.

---

# 4. Valuation Management

## 4.1 CRUD and detail view

**409.ai** — cards showing action badge, ID, kind, UUID, payment status, company, user, email, phone, six dates (created, started, completed, due, drafted, published) and a message count. Detail view with User & Business Info, Application Details (UUID, status, state, kind), Dates, and Comments.

**N409 status: Built.** `POST/GET/PATCH /api/v1/valuations`, `GET /api/v1/valuations/:id`, `GET /api/v1/valuations/:id/events`. `ValuationsPage.tsx` (table with multi-sort, 12 filter keys, saved views, CSV/PDF/XLSX export, bulk actions) and `ValuationWorkspace.tsx` with 26 tabs. Every field the catalog lists is present. No work.

## 4.2 The nine named filter tabs

**409.ai** — admin listing tabs: All (979), Incomplete (317), Unverified (17), In Progress (29), Drafted (41), Published (575), Unread (6), Waiting On Client (22), Ignored (326).

**N409 status at audit: Partial.** `STATE_GROUPS` in `lib/types.ts` is five buckets — `open`, `in_review`, `drafted`, `published`, `closed` — plus All. The 15 underlying states, the `waiting_on_client` boolean and an `unread` filter key all exist and are queryable; the listing simply does not name them as tabs, so an operator asking "what is stuck unverified" writes a filter instead of clicking.

This is a presentation gap over complete data, which is why it is P1 and not P2: it is the single most-used screen in the product and it is where a buyer comparing the two consoles looks first.

### Implementation spec

**Database.** None.

**API.** `GET /api/v1/valuations/counts` returns the five groups. Add a `?buckets=named` mode returning the nine:

| Tab | Predicate |
|---|---|
| All | scope only |
| Incomplete | `state IN ('pending','started','onboarding_completed')` |
| Unverified | `state = 'user_finished'` |
| In Progress | `state IN ('completed','paid','review','reviewed')` |
| Waiting On Client | `waiting_on_client = true` |
| Drafted | `state IN ('drafted','draft_changes','draft_accepted')` |
| Published | `state = 'published'` |
| Unread | unread for this reader per `valuation_comment_reads` |
| Ignored | `state IN ('ignored','cancelled','timeout')` |

Define these predicates **once**, in `domain/workflow.ts`, exported as `NAMED_BUCKETS`, and have both the count query and the list filter consume them. Two copies of this mapping is two different answers to "how many are in progress".

**Frontend.** Replace the group tab strip in `ValuationsPage.tsx` with the nine, count on each, unread in accent. Keep the group filter as a URL alias so existing saved views and shared links do not break.

**Priority: P1 · Effort: S. Closed** exactly as specified — `NAMED_BUCKETS` and `namedBucketsFor` in `domain/workflow.ts` are the single definition, `GET /valuations/counts?buckets=named` returns the counts alongside the bucket definitions themselves so the tab strip does not hard-code a second copy of the labels, and the five-group filter survives as a URL alias. That alias is the load-bearing part: `STATE_GROUPS` is what every saved view (`0088`) and every link anyone has ever pasted into a thread was written against, and a tab rename that quietly voids a saved filter is worse than the missing tabs were.

## 4.3 Status workflow — the fifteen states

**409.ai** — 14 documented states; the observed flow is Pending → Incomplete → Unverified → In Progress → Waiting On Client → Drafted → Published, with Ignored off to one side and loops back from Drafted.

**N409 status: Built, ahead.**

`valuation_state`: `pending, started, onboarding_completed, user_finished, completed, paid, review, reviewed, drafted, draft_accepted, draft_changes, published, timeout, cancelled, ignored`. `paid` (migration `0107`) is the fifteenth and is a real gate between `completed` and `review` rather than a status flag. `POST /valuations/:id/workflow/advance|restart|reassign`, `POST /valuations/bulk`, `POST /valuations/bulk-action`, auto-advance, the publish gate (`domain/publishGate.ts`) and transition side effects are all present and tested.

**One caveat, not a code gap:** nothing enters `paid` on its own except a Stripe settlement, and Stripe is unconfigured in production (§13.5 / P0-1). The path is real and tested; the provider is missing.

## 4.4 Partner Valuation listing

**409.ai** — a separate partner-scoped listing, 349 rows, its own tab set and its own sort/search sidebar (sort by created-at asc/desc; search by UUID, company name, user email, user first/last name, partner).

**N409 status at audit: Partial.** `PartnerPortalPage.tsx` at `/partner` is the partner's own view; the ops-side partner-scoped listing is the main listing with `partner_id` set. Every search field the catalog names is a supported filter key. What is absent is the saved entry point — a partner-scoped listing an ops user reaches in one click with counts of its own.

### Implementation spec

Ship it as a **saved view**, not a new page. `SavedViews.tsx` and the `saved_views` table (migration `0088`) already do this: seed one system view per partner-scoped listing, or add a `/valuations?partner_id=…` link on `PartnerDetailPage`. Building a second listing page duplicates the filter, sort, export and scope logic that the sweep test in `f883d6a` covers on the first one.

**Priority: P2 · Effort: S. Closed.** `POST /partners/:id/saved-view` pins the firm's listing as a *shared* saved view, idempotently — matched on the query rather than the name, so a firm renamed after pinning does not get a second one. `getPartnerDetail` gained `valuations_by_bucket`, the nine named buckets scoped to the firm, read from the same `namedBucketsFor` the listing tab strip and the sidebar badges use; each tile links into `/valuations?partner_id=…&bucket=…`. And the listing says when it is scoped: a partner-scoped page that looks identical to the unscoped one is how an operator concludes a firm has four engagements in total.

## 4.5 Network Items

**409.ai** — a per-valuation sidebar entry under DATA, catalogued as a "network/comparable items list".

**N409 status at audit: Missing.** No `network_item` identifier anywhere in the tree, and no persisted per-company comparable set. Comparables today are: computed inside the engine (`engine/comparables.py` — SIC similarity, size/growth proximity scoring, screening reasons, quartile statistics), selected by the `comp_selection` agent, and summarised into the 16 `market_comparables` overwrite fields. The aggregate is stored; the individual peer rows the analyst screened to get there are not.

That is a defensibility gap as much as a feature gap. An auditor asking "which companies were in your peer set and why was Acme excluded" is asking for rows N409 does not keep.

### Implementation spec

**Database.** New migration:

```sql
CREATE TABLE comparable_items (
  id            ulid PRIMARY KEY,
  valuation_id  ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  ticker        text,
  name          text NOT NULL,
  sic           text,
  source        text NOT NULL CHECK (source IN ('ai','analyst','market_feed')),
  included      boolean NOT NULL DEFAULT true,
  exclude_reason text,
  revenue_ltm    numeric(20,2),
  revenue_ntm    numeric(20,2),
  ebitda_ltm     numeric(20,2),
  ebitda_ntm     numeric(20,2),
  ev             numeric(20,2),
  score          numeric(6,4),
  score_breakdown jsonb NOT NULL DEFAULT '{}',
  created_by     ulid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comparable_items_valuation_idx ON comparable_items (valuation_id, included);
CREATE UNIQUE INDEX comparable_items_ticker_uq
  ON comparable_items (valuation_id, ticker) WHERE ticker IS NOT NULL;
```

`exclude_reason` is `NOT NULL`-in-spirit: enforce at the route that `included = false` requires a reason. An exclusion without a reason is the one row an auditor will ask about.

**API.** New `routes/comparables.ts`:
- `GET /api/v1/valuations/:id/comparables` — rows plus derived multiple statistics.
- `POST /api/v1/valuations/:id/comparables` — analyst adds a peer.
- `PATCH /api/v1/valuations/:id/comparables/:itemId` — edit, include/exclude with reason.
- `DELETE /api/v1/valuations/:id/comparables/:itemId` — analyst-sourced rows only; AI-sourced rows are excluded, never deleted, so the agent's output stays auditable.
- `POST /api/v1/valuations/:id/comparables/screen` — run `engine/v1/comparables` over the current set and persist scores and screening reasons.

**Frontend.** `pages/valuation/ComparablesTab.tsx` at `/valuations/:id/comparables`: table with source badge, include toggle, score column, inline exclude-reason prompt, an "Add peer" row and a "Re-screen" action. Register in `App.tsx` and in the workspace tab list.

**Business logic.** `engine/comparables.py` already computes `score_company`, `screen_comparables`, `_screen_out_reason`, `multiple_statistics` and `primary_multiple`. The engine stays the calculator; this table is the record of what it was given and what the analyst overrode. Feed the *included* set into the market approach rather than the overwrite aggregates when rows exist, and keep the overwrite fields as the fallback for engagements with no peer rows.

**Integration points.** `comp_selection` agent writes with `source='ai'`. `engine/v1/market-feed` writes with `source='market_feed'`. Exhibit generation (`domain/reportExhibits.ts`) gains a peer-set exhibit — this is currently the weakest exhibit in a market-approach report. Evidence bundle (`routes/evidence.ts`) includes the rows.

**Priority: P1 · Effort: M. Closed.** `0119_comparable_items.sql`, `routes/comparables.ts`, `ComparablesTab.tsx` and Exhibit D-1. Three rules the migration states and the route enforces, each of them about keeping the table a *screen* rather than a conclusion with a table under it:

**An AI-sourced row is never deleted, only excluded.** `DELETABLE_SOURCES` admits the analyst's own additions and nothing else. The agent's output is evidence of what the model proposed, and a peer set an analyst can silently prune to the flattering half answers the auditor's question dishonestly while looking complete.

**`exclude_reason` is required by the route whenever `included = false`, and nullable in the schema.** A CHECK constraint would be stricter and would also make the AI writer's bulk insert fail as a unit the first time the engine screened a candidate out with a reason string it could not produce — losing the whole set to enforce a field on one row.

**The included rows outrank the overwrite aggregate, and the aggregate stays as the fallback.** An engagement nobody has screened computes exactly as it did before, so shipping the table changed no stored number on its own — which is the property that let it ship without a re-run of every open engagement.

## 4.6 Per-valuation counters

**409.ai** — the detail header shows Pending files (2), My tasks (0), All tasks (2), Chat (2).

**N409 status at audit: Partial.** `GET /api/v1/tasks` and `/valuations/:id/tasks` serve tasks; `/valuations/:id/comments` serves chat; `/valuations/:id/documents` serves files. The workspace does not surface the four counters in the header.

**Spec.** Add a `counters` object to `GET /api/v1/valuations/:id` — `{ pending_files, my_tasks, all_tasks, unread_comments }` — and render it as a chip row in `ValuationWorkspace.tsx`. `pending_files` is documents in a category requiring review; define it as `documents WHERE reviewed_at IS NULL`.

**Priority: P2 · Effort: S. Closed.** `repos/valuationCounters.ts` serves all five (the fifth is §7.3's badge) in one round trip on the detail read, since the header cannot render without them and a second request is a second chance to disagree with the page under it. `reviewed_at` did not exist — a document row recorded that a file arrived and nothing recorded that anyone had looked at it — so `0121` adds it plus the ops-only toggle that sets it. Nothing is backfilled: an open engagement's existing files show as pending because they are. Ops-only on the frontend; every count is outstanding work rather than a total, because a counter that never reaches zero is a badge people learn to stop seeing.

---

# 5. Workbook Editor

## 5.1 The four tabs

**409.ai** — a workbook editor with exactly four tabs: Company Overview, Captable, Financials, Valuation Params.

**N409 status: Built, and better factored.**

`domain/workbookTabs.ts` defines `WORKBOOK_TAB_KEYS = ['company_overview','captable','financials','valuation_params']` — the same four. It assembles them as a read-only *view* over five tables (`company_profiles`, `cap_tables`, `valuations`, `valuation_params`, `workbook_cells`) with the override layer applied on top, and every field carries three things a form needs: its `source`, whether an analyst override is superseding it, and the endpoint that edits it (`TAB_SOURCE_ENDPOINTS`).

`GET /valuations/:id/workbook`, `GET /valuations/:id/workbook/tabs`, `PATCH /valuations/:id/workbook`. Frontend: `WorkbookTab.tsx` with per-cell PATCH, derived-cell handling, "Export auditor workbook" and "Save workbook".

The design decision worth preserving: writes go to the route that owns the table, not to the workbook. The view never becomes a second way to mutate a valuation. No work.

## 5.2 Cap-table structure graph

**409.ai** — not observed.

**N409 status: Built, ahead.** `CapTableGraph.tsx` + `domain/capTableGraph.ts` render conversion and seniority ranks as columns, and catch the class of error per-row validation cannot: a stack where half the classes declare a seniority. No work.

---

# 6. Report Generation

## 6.1 Report types

**409.ai** — 14 marketed report products (409A, ASC 718, ASC 820, FMV, gifts, IFRS2, IP, NAV among them).

**N409 status: Built, ahead.** 16 skeletons in `domain/report.ts` — one per `valuation_kind` (15) plus a generic fallback — each closed with the shared certification block. Per-kind exhibits in `domain/reportExhibits.ts`, `specialtyExhibits.ts` and `navExhibits.ts`. No work.

## 6.2 Report editor and versions

**409.ai** — a HAML template editor with a version badge (`#1861.v0`), a Report PDF link, and a Versions sidebar entry.

**N409 status: Built.** `reports` + `report_versions` (migration `0010`). `GET/PUT /valuations/:id/report`, `GET /valuations/:id/report/versions`, `POST /valuations/:id/report/revert`, `POST /valuations/:id/report/render`, `GET /valuations/:id/report.pdf`. `ReportTab.tsx` with draft/accepted/changes-requested/published status, render, download, restore. `RichTextEditor.tsx` rather than a HAML textarea — a deliberate difference, and the better one: an analyst editing raw template syntax is one typo from an unrenderable opinion.

The PDF pipeline (`src/services/report`) has nine dedicated test files covering branding, accessibility, charts, navigation, typography, tables and pathological input. No work.

## 6.3 Narrative prompt library UI

**N409 status at audit: Partial — server complete, no client.**

Migration `0114` created `narrative_prompts` with 34 seeded rows: per-section guidance keyed `(kind, section_key)`, `kind IS NULL` being the base library, with `default_guidance` preserved so a reset needs no redeploy. Five endpoints exist: `GET /admin/narrative-prompts`, `GET /admin/narrative-prompts/preview/:kind`, `GET|PATCH /admin/narrative-prompts/:id`, `POST /admin/narrative-prompts/:id/reset`.

The server chain is complete and verified end to end: `routes/ai.ts:188` passes the resolved library as `narrative_sections` in the pipeline payload, and `ai/app/agents/report_narrative.py:sections_for()` consumes it, falling back to its module-level `SECTIONS` tuple only when the payload carries none. Table → route → agent all work.

`grep -rn "narrative-prompts" src/services/web-frontend/src` returns nothing. So the missing layer is exactly one page. The whole point of moving this out of a Python tuple was to let a reviewer change DLOM framing and conclusion wording without a deploy; without a UI they still cannot — they need an engineer with a bearer token. The migration's own rationale is unfulfilled by a single missing component.

### Implementation spec

**Database.** None.

**API.** None.

**Frontend.** `pages/AdminNarrativePromptsPage.tsx` at `/admin/narrative-prompts`, ops+ only:
- Kind selector (base library plus the 15 kinds), showing for each section whether the row is base, an override, or absent.
- Per-section editor: `label`, `guidance` (textarea), `sort_order`, `enabled` toggle, and a Reset button wired to the reset endpoint with a confirm.
- A dirty-state guard, and a diff against `default_guidance` so an editor can see what they changed.
- A Preview panel calling `GET /admin/narrative-prompts/preview/:kind`, showing the assembled section list in order — the base-plus-override resolution is exactly what an editor gets wrong unaided.

Add to the admin nav in `AppLayout.tsx` next to `/admin/prompts`.

**Integration points.** None to build — the agent already consumes the library. An edit made through this page changes the next drafted narrative with no further wiring.

**Priority: P0 · Effort: S. Closed.** `AdminNarrativePromptsPage.tsx` at `/admin/narrative-prompts`, over the five endpoints that already existed — no schema, no new route, exactly the one missing page the audit said it was. `default_guidance` is what makes the reset button honest: a reviewer who has edited the DLOM framing into something worse can get back to the shipped wording without a deploy and without a colleague digging the original out of the migration. The per-kind override is the mechanism the section names — `0141` and `0145` seeded specialty rows on top of the `kind IS NULL` base library, which is how an EMI valuation stops reading as a 409A with the title swapped.

---

# 7. Calculation Engines

## 7.1 Coverage

**409.ai** — an R package behind Plumber: Black-Scholes, Newton-Raphson, waterfall, Chaffee/Finnerty.

**N409 status: Built, well ahead.** 37 modules under `src/services/engine-wrapper/app/engine/`, 31 endpoints on the FastAPI surface:

| Area | Modules | Status |
|---|---|---|
| Allocation | `approaches.py`, `current_value.py`, `pwerm.py`, `hybrid.py`, `waterfall.py` | Built — OPM, backsolve, CVM, PWERM, hybrid, full equity waterfall |
| Option maths | `bs.py`, `newton.py`, `compounding.py` | Built |
| DLOM | `dlom.py` | Built — Chaffee, Finnerty, **Ghaidarov, Longstaff, restricted-stock studies**, qualitative |
| Income | `projection.py`, `wacc.py` | Built — DCF with WACC build-up |
| Market | `comparables.py`, `market_data.py`, `market_feed.py` | Built — SIC similarity, proximity scoring, quartiles, LTM **and NTM** |
| Asset | `intangibles.py` | Built — cost-to-replicate and NAV |
| Specialty | `qsbs.py`, `emi_csop.py`, `esop.py`, `smb.py`, `impairment.py`, `fair_value_820.py`, `gift_estate.py`, `ifrs2.py` | Built — all eight |
| Measurement | `fund_valuation.py`, `debt_valuation.py`, `rollforward.py` | Built — NAV, LP waterfall, calibration, debt + rating spread |
| Quality | `validate.py`, `anomalies.py`, `sensitivity.py`, `volatility.py`, `errors.py` | Built |

Backsolve, OPM, DCF, market, asset, DLOM — every engine the section brief names is present, and the DLOM and 820/gifts/IFRS2 gaps recorded in the previous design document are closed (Appendix B).

## 7.2 Specialty engine workspace UI

**N409 status at audit: Partial — server complete, no client.**

`POST|GET /api/v1/valuations/:id/specialty` and `GET /valuations/:id/hmrc-form` are live and tested. `App.tsx` has no `specialty` route, and `CalculationsTab.tsx` shows only the 409A engines. Ops run the specialty engines over the API with curl.

Eight engines and eleven product kinds are therefore operable only by someone comfortable with a bearer token. This is the single largest built-but-unreachable surface in the tree.

### Implementation spec

**Database.** None — `POST /specialty` already persists a calculation row.

**API.** None.

**Frontend.** `pages/valuation/SpecialtyTab.tsx` at `/valuations/:id/specialty`:
- Dispatch on `valuation.kind` to the right engine and its input form. The kind→engine map exists in `domain/specialty.ts`; read it from the server via a schema endpoint rather than duplicating it in TypeScript.
- A "Run <kind> engine" button, a result panel, and a history list from `GET /specialty`.
- For `emi` and `csop`, a Download HMRC form action against `GET /valuations/:id/hmrc-form`.
- Render results through the same numeric formatting the 409A `CalculationsTab` uses, so two engines' outputs do not disagree on how a currency is printed.

Show the tab only for kinds that have a specialty engine; a Run button on a 409A that 422s is worse than no button.

**Integration points.** Specialty exhibits already exist (`domain/specialtyExhibits.ts`), so once a calculation is stored the report picks it up with no further work.

**Priority: P0 · Effort: M. Closed.** `SpecialtyTab.tsx` and a `specialty` entry in the workspace tab list, frontend-only as specified, converting eight finished engines from ops-only to product. The tab is ops-only and gated on the engagement's kind (`SPECIALTY_TAB_KINDS`, mirroring `domain/specialty.ts`), because a Run button on a 409A that 422s is worse than no button — it teaches an operator that the tab is unreliable rather than that the report type is wrong. The mirror is deliberately show-or-hide only: the tab reads the engine definition from the server, so the client-side list cannot disagree with the engine that actually runs.

## 7.3 Calculation badge and refresh

**409.ai** — the sidebar Calculations entry carries a progress badge (`0/5`) and a refresh button.

**N409 status at audit: Partial.** `POST /valuations/:id/calculations/preflight` returns the pre-flight validation state and `GET /calculations` the history; `CalculationsTab.tsx` runs and displays. The workspace nav shows no `n/m` badge.

**Spec.** Derive `m` from the approaches enabled in `valuation_params` and `n` from those with a successful result in the latest calculation; expose as `counters.calculations` on `GET /valuations/:id` (same object as §4.6) and badge the nav item. The refresh button is a re-run of the existing POST.

**Priority: P2 · Effort: S. Closed.** `domain/valuationCounters.ts` computes it, and `domain/approaches.ts` now owns the UI-name → engine-key → weight-column mapping that `routes/calculations.ts` used to, because a badge that read the UI name straight off the results would report 0/1 on a completed run. Three judgments worth naming: a zero weight is an approach the analyst considered and excluded, so it is out of the denominator rather than permanently missing from the numerator; unweighted params fall back to all four rather than reporting 0/0 on the engagement with the most to do; and an approach block present with a null equity value counts as missing, because the engine writes a key for what it attempted and 4/4 on a partly-failed run is worse than no badge.

## 7.4 Stale stored calculations

**N409 status at audit: Known data gap, carried from REVISION.**

Commit `99383b2` changed the single-breakpoint backsolve. Every calculation already stored that took that path with a non-zero option pool holds an equity value low by roughly the pool's share, and any report rendered from one still says so. Nothing re-runs them and nothing flags which are affected.

**Spec.** This needs a list before it needs a migration — published opinions cannot be silently rewritten.

1. A read-only ops report: calculations where `results.approaches.opm_backsolve.method = 'backsolve_single'` and `inputs.options_outstanding > 0`, joined to engagement, state and whether a report was rendered from it.
2. Surface it on `AdminJobsPage` or a new `/admin/data-remediation` page.
3. For unpublished engagements, a bulk re-run action. For published ones, a flag on the workspace and a decision recorded in `methodology_decisions` — never an automatic rewrite.

The same shape applies to the stale QA reviews gap (`qa_reviews` rows whose calculation's `results.discounts.dlom_method` is chaffee or finnerty and whose `checks` carry no `dlom_range`). Build one remediation-list surface that hosts both queries.

**Priority: P1 · Effort: M. Closed.** `repos/dataRemediation.ts` and `AdminDataRemediationPage.tsx` host both queries, as one surface. The list-first discipline the spec insisted on survived into the implementation: the bulk re-run is confined to engagements that have not published, and a published one gets a flag and a decision recorded by a human. A published opinion is a signed document a client has acted on, and silently rewriting the figure inside it is not a bug fix — it is a different opinion issued under the same cover.

One thing the spec did not anticipate. Both queries are latest-per-valuation scans across every engagement ever run, so they need a page cap; and a cap must not change the *answer* to "how many are affected". The totals are therefore `count(*) OVER ()`, evaluated before `LIMIT` and read off the first row, rather than counted in JavaScript over the returned page. A remediation queue that under-reports its own size as it is worked through is one that reports zero remaining while rows are still there.

---

# 8. Overwrites System

## 8.1 The 68 fields

**409.ai** — 68 configurable fields across 6 categories, documented in an Overwrites Explorer at `/admin/overwrites_doc`, reached from the Documentation sidebar link.

**N409 status: Built — exact parity.**

`domain/overwrites.ts` declares exactly 68 fields across the six categories, sized to match production: company_info 7, financial_metrics 17, forecasts 12, valuation_params 15, market_comparables 16, reporting 1. Each field carries `key`, `category`, `class` (numeric/date/character), `label`, `description`, `example` and optional `min`/`max`.

`GET /api/v1/overwrites/schema` serves the registry — the same declaration that validates writes, so the documentation cannot drift from the validator. `GET /valuations/:id/overwrites`, `PUT /valuations/:id/overwrites/:field_key`. Frontend: `OverwritesSchemaPage.tsx` at `/schema/overwrites` (the explorer) and `OverwritesTab.tsx` (per-valuation editing). The workbook view marks which fields an override is currently superseding.

No work.

---

# 9. Document Management

## 9.1 Categories

**409.ai** — an upload interface with 13+ categories: cap table, financial, corporate documents, pitch deck, IP, misc, articles of incorporation, shareholder agreement, stock option plan, board resolution, certificate of good standing, bylaws, operating agreement.

**N409 status: Built — parity at 13.**

`document_category` carries 13 values after migration `0112` expanded `0105`'s six. `domain/documentCategories.ts` is the registry. `POST|GET /valuations/:id/documents`, `GET /valuations/:id/documents/categories`. Upload security is documented in the existing design §12.7. AI summarisation per category exists as `ai_pipeline` values (`corporate_documents`, `pitch_deck`, `stock_option_plan`, `shareholder_agreements`, `board_resolutions`, `intellectual_property`, `prior_valuations`).

## 9.2 Legacy files still in `uploads`

**N409 status at audit: Known data gap.**

The seven categories `0112` added are reachable and nothing was moved into them. Every corporate file already on the platform is still in `uploads`, because re-filing from a filename is the silent reclassification `0105` exists to prevent.

**Spec.** An ops triage queue rather than a migration: a filtered document list (`category = 'uploads' AND kind = 'other'`) with a category dropdown per row and a bulk-assign for a selected set, on `AdminRetentionPage` or a new `/admin/documents` page. Optionally seed the dropdown with the `SUMMARIZE_ATTACHMENT` pipeline's classification as a *suggestion* — never an auto-apply.

**Priority: P2 · Effort: S. Closed.** `/admin/documents` over exactly that query — both conditions, because a file in `uploads` with a stated kind was filed there on purpose by somebody who saw the choices. The suggestion is a filename heuristic rather than the summariser, and it ships the *term it matched* rather than a confidence score: a score invites trusting it, a matched term invites reading the filename. It suggests only the seven corporate buckets and never a finance one, since "Financials 2023.xlsx" is a monthly, an annual or a balance sheet with equal likelihood — which is the ambiguity the category axis exists for. Nothing is pre-selected, and a re-file writes `document_refiled` on the engagement with the bucket it came from.

---

# 10. User & Role Management

## 10.1 Roles

**409.ai** — 16 role tabs: All, Valuation Users, Admin, Auto, Contributing Reviewer, Data, Data Supervisor, God, Investor, Main Reviewer, Member, Partner, Reviewer, Spa, Supervisor, Support, Support Supervisor, Ignored.

**N409 status: Built, ahead.**

`0002_seed_roles.sql` seeds 17 keys — `valuation_user, admin, god, supervisor, support, support_supervisor, reviewer, main_reviewer, contributing_reviewer, data, data_supervisor, partner, member, investor, auto, spa, ignored` — plus `auditor` added later, for 18. `domain/permissions.ts` describes the capability matrix and is asserted against `auth/rbac.ts` role by role, so the catalog and the enforcement cannot drift. The frontend reads the served catalog rather than keeping its own copy.

## 10.2 User listing

**409.ai** — 1,402 users; columns ID, first name, last name, email, roles, partner, phone, verified, SSO. Search by ID, partner, email, first/last name, phone, verified, SSO provider. Download CSV, actions sidebar, new-user button.

**N409 status: Built.** `routes/adminUsers.ts`, `AdminUsersPage.tsx`. SSO (`routes/adminSso.ts`, `saml.ts`, `scim.ts`), MFA (`mfa.ts`), invitations and email verification all present — beyond what the catalog shows. No work.

---

# 11. Partner System

## 11.1 Partner records

**409.ai** — 24 partners; columns ID, name, subdomain, prepaid, CC emails.

**N409 status: Built — parity plus.** `partners` carries `subdomain` (migration `0106`), `prepaid` and `cc_emails` (`0113`). `AdminPartnersPage.tsx`, `PartnerDetailPage.tsx` with firm-scoped engagement list and token management. No work.

## 11.2 White-label subdomains

**409.ai** — a white-label subdomain per partner.

**N409 status: Built, ahead.** `0050_partner_white_label.sql`, `0091_white_label_branding.sql`, `0106_partner_subdomains.sql`, `domain/partnerSubdomain.ts`, `routes/branding.ts`, `BrandingPage.tsx`, `PartnerLoginPage.tsx` at `/partner/:slug/login`. PDF branding is asserted in `report/test/pdfBranding.test.ts`. No work.

## 11.3 Partner webhooks

**409.ai** — not observed.

**N409 status: Built, ahead.** HMAC-signed delivery with a retry ladder (`0102`, `0103`), `domain/partnerWebhooks.ts`, `GET /admin/webhooks/deliveries/stats`, `POST /admin/webhooks/retry`. Webhook targets inside the network are refused (`bdecfb8`). No work.

---

# 12. AI Integration

This section held the largest genuine capability gap in the product at audit time. It is closed: `AI_PIPELINES` went from 12 to 20, and the research spine §12.3 specifies is built, wired and threaded into drafting.

## 12.1 Prompt registry

**409.ai** — 20 prompts in a searchable admin list, each bound to a bot provider: `perplexity`, `perplexity-PRO`, `bedrock-SONNET35`, `Anthropic-SONNET_5`, `Anthropic-OPUS_4_8`, `Anthropic-HAIKU_4_5`. Named prompts include `industry_outlook`, `market_au/si/us/ca/uk/un`, `competitor`, `company_overview`, `industry_overview`, `AI:FindRelevantTags`, `Ai:AnoymizeCaptable`, `Industry_finder`, `FIND_MAPPING_AND_SOURCES`, `FIND_COMPARABLES`, `MISSING_DATA_SUMMARY`, `SUMMARIZE_ATTACHMENT`, `SET_VALUATION_PARAMS`, `CREATE_MISSING_ENTRIES`, `REVIEW_REPORT`.

**N409 status: Built, ahead. Closed.**

The machinery was always better than 409.ai's: `ai_prompts` is one row per pipeline with `model`, `enabled` and `updated_by`; `prompt_versions` (`0045`) versions every edit; `GET /admin/prompts`, `/admin/prompts/models`, `PATCH /admin/prompts/:id`, `/versions`, `/revert`, and a `/test` endpoint that runs a prompt without saving. `BotPromptsPage.tsx` at `/admin/prompts` is the UI.

The **breadth** was thinner, and is not any more. `AI_PIPELINES` was 12 at audit and is 20 now: the original twelve plus `company_profile` (`0151`/`0152`), `tagging` (`0153`/`0154`) and the six research entries seeded by `0117` — `market_research`, `industry_overview`, `industry_outlook`, `competitor_analysis`, `company_overview`, `industry_finder`. Mapping the catalog's 20 onto those:

| 409.ai prompt | N409 equivalent | Status |
|---|---|---|
| MISSING_DATA_SUMMARY | `missing_data` | Built |
| FIND_MAPPING_AND_SOURCES | `extract` | Built |
| FIND_COMPARABLES | `comparables`, `comp_selection` | Built |
| SUMMARIZE_ATTACHMENT | `summarize` + 7 per-category pipelines | Built, ahead |
| REVIEW_REPORT | `qa` + deterministic checks | Built, ahead |
| SET_VALUATION_PARAMS | `assumptions` | Built |
| CREATE_MISSING_ENTRIES | `cap_table` | Built |
| Ai:AnoymizeCaptable | `ai/app/anonymize.py` | Built |
| company_overview | `company_overview` (research) + `company_profile` (agent) | Built, ahead |
| industry_overview | `industry_overview` | Built |
| industry_outlook | `industry_outlook` | Built |
| competitor | `competitor_analysis` | Built |
| market_au, market_si, market_us, market_ca, market_uk, market_un | `market_research` × `RESEARCH_REGIONS` | Built, ahead |
| Industry_finder | `industry_finder` | Built |
| AI:FindRelevantTags | `tagging` | Built |

**How the eleven closed.** They were one coherent family — live market and industry research — and they shipped as one piece of work with §12.3 rather than as eleven rows. Four things are worth recording, because each is a place N409 deliberately does not mirror the catalog:

**The six regional variants are one prompt, not six.** `RESEARCH_REGIONS` in `domain/research.ts` is `us, uk, au, si, ca, un`, and the `market_conditions` topic — the single `market_research` prompt row — takes the region as a parameter, the only topic for which `regionScoped` is true. Six prompt rows differing only in a country name are six rows that drift: an improvement to the question gets made in the one an analyst happened to open, and the other five quietly keep asking the worse version. `researchQuestion` raises `ResearchInputError` on a `market_conditions` call with no region rather than defaulting to one, because a market-conditions paragraph silently written about the United States for a UK engagement is the failure this parameter exists to prevent.

**`company_overview` is two prompts in N409, on opposite sides of the trust boundary, and the split is the point.** The research entry sends a *guideline* company's name out to a search provider and `assertSubjectNotClient` refuses the engagement's own; the `company_profile` agent (`0151`) reads the engagement's confidential documents to draft the business description, classification and scale metrics, and never leaves the redactor. 409.ai has one prompt named for the job; N409 has one per trust domain, because a single prompt spanning both is one prompt away from mailing a client's name to a search engine.

**They are prompt-registry rows and not runnable pipelines.** `NON_RUNNABLE_PIPELINES` covers the six research entries for the same reason it covers `qa`: `POST /valuations/:id/ai/:pipeline` refuses them, and `routes/research.ts` is the only entry point. The research route owns the containment check, the storage and the supersede; a generic second entry point would own none of the three and would look, from the caller's side, exactly as legitimate.

**`tagging` needs a platform constant, and only it does.** `runAiPipeline` ships `tag_catalogue` for that pipeline and no other, read from `domain/valuationTags.ts`. The AI service holds no copy of the vocabulary — two copies drift, and the drift is silent, which is the worst kind on a field the list filter and the precedent query both read.

`promptRegistrySeeds.test.ts` pins the two directions that matter: every seeded prompt is in `AI_PIPELINES`, and every runnable pipeline is seeded. A prompt row for a pipeline that does not exist is dead configuration an operator can edit and never see take effect; a pipeline with no seeded row is a 500 the first time anyone runs it.

## 12.2 Model routing

**409.ai** — six provider/model bindings, most on `perplexity-PRO`, newest on Anthropic Sonnet 5 / Opus 4.8 / Haiku 4.5, one on Bedrock Sonnet 3.5.

**N409 status: Built.** `ai/app/openrouter.py` with a three-model fallback and a `model` column per prompt; `GET /admin/prompts/models` serves the configured set.

`ai/app/bedrock.py` is the Bedrock adapter and `ai/app/llm_router.py` is the dispatch that makes the per-prompt `model` column mean what it looks like it means: a `bedrock/` prefix routes there, everything else to OpenRouter, which stays the default so an installation that has never heard of Bedrock behaves exactly as it did. It is still a deployment-topology choice rather than a capability one — the choice being data residency and procurement, for the firm whose counsel has approved their own AWS account and not a third-party aggregator. No boto3: Converse is one signed POST and SigV4 is forty lines of hmac, against a service whose entire dependency list is four packages. One model and no fallback chain, because every Bedrock invocation is billed to the operator's own account and falling through on a failure would spend more of their money to paper over a bad request. `/ready` reports the credentials and never gates on them.

The real difference: 409.ai routes **per prompt to a provider chosen for the job** — research prompts to Perplexity, drafting prompts to Claude. N409 has both providers and routes only to one of them. §12.3.

## 12.3 Web-grounded market research — was built and unwired, now wired

**N409 status at audit: Partial, and the highest-value P0 in the document. Closed** — see the closure note at the end of this section.

`ai/app/perplexity.py` is a complete, thoughtfully-fenced Sonar client: web-grounded research with citations, its own budget and deadline handling, and a hard refusal of any prompt carrying the redaction placeholders — because their presence is positive proof that confidential client text was routed to a search provider by mistake. `POST /ai/v1/research` exposes it. `tests/test_perplexity.py` and `tests/test_research_route.py` cover it.

And nothing called it. `grep -rn "research" src/services/valuation/src src/services/web-frontend/src` returned three unrelated hits — a comment, and two lines of marketing copy. There was no route in the valuation service, no pipeline entry, no storage for a research result, no UI, and no thread into `report_narrative`.

The consequence was exactly what the previous design document predicted before the adapter was written: industry-conditions and market-outlook paragraphs written from the uploaded corpus and analyst knowledge alone, and the weakest part of a generated draft. The adapter closed the hard half of that problem months before anything collected the benefit.

### Implementation spec

**Database.** New migration `0116_market_research.sql`:

```sql
CREATE TABLE market_research (
  id            ulid PRIMARY KEY,
  valuation_id  ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  topic         text NOT NULL,          -- see the topic registry below
  region        text,                   -- 'us','uk','au','si','ca','un' or NULL
  question      text NOT NULL,          -- what was actually asked
  answer        text NOT NULL,
  citations     jsonb NOT NULL DEFAULT '[]',  -- [{url,title,snippet}]
  model         text NOT NULL,
  requested_by  ulid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz             -- append-only; a re-run supersedes
);
CREATE INDEX market_research_valuation_idx
  ON market_research (valuation_id, topic) WHERE superseded_at IS NULL;
```

Append-only with `superseded_at` rather than an update: a report cites the research it was drafted from, and overwriting it makes the citation a lie. The same reasoning as `qa_reviews`.

Extend `ai_pipeline` in a **separate** migration (Postgres forbids using a new enum value in the transaction that adds it — the same constraint `0107` and `0109` document):

```sql
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'market_research';
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'industry_overview';
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'industry_outlook';
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'competitor_analysis';
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'company_overview';
ALTER TYPE ai_pipeline ADD VALUE IF NOT EXISTS 'industry_finder';
```

**AI service.** A `research` family in `pipelines.py` that — unlike every other pipeline — must **not** route through `_ask`'s redaction, because a redacted question is unanswerable by a search engine. Instead:

- Each research pipeline takes only fields explicitly marked public: industry, SIC code, region, and public comparable tickers. The company's own name, cap table and financials never enter the prompt.
- Build the question from a template, not from client text. This is the enforcement: if the prompt is assembled from a fixed template plus a whitelist of public fields, there is no path by which confidential text reaches Sonar, and the placeholder check in `perplexity.py` remains a second line of defence rather than the only one.
- Add a test asserting that a research prompt built from a valuation containing a distinctive company name does not contain that name.

Topic registry, mapping the eleven missing prompts:

| Topic | Region-scoped | 409.ai prompt |
|---|---|---|
| `industry_overview` | no | industry_overview |
| `industry_outlook` | no | industry_outlook |
| `market_conditions` | **yes** | market_au/si/us/ca/uk/un |
| `competitor_analysis` | no | competitor |
| `company_overview` | no | company_overview |
| `industry_finder` | no | Industry_finder, AI:FindRelevantTags |

`market_conditions` is one prompt with a `region` parameter, not six prompts. 409.ai's six regional variants are the same question with a different market named; six rows is six places to fix a wording change.

**Valuation service.** New `routes/research.ts`:
- `POST /api/v1/valuations/:id/research` — body `{topic, region?}`; assembles the public-field payload, calls `POST /ai/v1/research` over the internal-auth channel, persists a `market_research` row, supersedes the prior row for that `(valuation_id, topic, region)`.
- `GET /api/v1/valuations/:id/research` — current rows with citations.
- `POST /api/v1/valuations/:id/research/refresh-all` — re-run every topic; ops-only, rate-limited.

Register in the route audit plugin and add the partner-scope sweep case, per the pattern in `f883d6a`.

**Frontend.** `pages/valuation/ResearchTab.tsx` at `/valuations/:id/research`: one card per topic showing the answer, its citations as links, when it was retrieved, and a Refresh action. A "stale" marker when `created_at` is more than 90 days before the valuation date — research older than the measurement date is a finding, not a footnote.

**Business logic.** Thread the research into drafting: `report_narrative` receives the current `market_research` rows for the sections whose guidance references market conditions, and the citations flow into the report's source list. This is where the value is actually collected — everything before it is plumbing.

**Integration points.** `routes/evidence.ts` includes research rows and citations in the evidence bundle. `domain/reportExhibits.ts` gains a sources exhibit. `narrative_prompts` guidance text for the industry and market sections should reference the research fields, which is a content edit through the §6.3 UI.

**Priority: P0 · Effort: L. Closed**, and it was the largest single item in the document. `0116_market_research.sql` and `0117_seed_research_prompts.sql` landed as specified; `domain/research.ts` holds the topic registry, the region list and the containment rules; `repos/marketResearch.ts` stores and supersedes; `routes/research.ts` serves `GET /research/topics`, `POST|GET /valuations/:id/research` and `POST /valuations/:id/research/refresh-all`; `ResearchTab.tsx` is the tab. Six things diverged from the spec above, and each is a decision rather than a shortcut:

**The provider dependency was removed rather than satisfied.** Perplexity has no free tier, so the key was never obtainable, and a feature that 503s until procurement finishes is a feature that does not exist. `ai/app/research.py` now chooses between two providers for the same question: Sonar when `PERPLEXITY_API_KEY` is set, and `websearch.py` (DuckDuckGo by default, keyless) plus OpenRouter synthesis when it is not — or when a Sonar call fails for any reason. The fallback is automatic and silent to the caller, and `ResearchResult.model` names which path answered, so a stored row still says how it was produced. Research works on a fresh checkout, which was the more serious defect in the original design.

**The containment check runs once, before a provider is chosen.** `assert_public` is not inside either provider, and `ConfidentialityError` is deliberately not a `ProviderError`, so the fallback cannot catch it. A refusal that fell through to the second provider would forward the same client text to a second search engine — the guarantee inside out, and worse than having no guarantee, because the first refusal would make it look enforced.

**Nothing unsourced comes back, and the two failure halves are handled differently.** If retrieval returns no pages the model is not called at all: an LLM asked a research question with no sources in front of it produces a confident multiple from its weights, and that number landing in an exhibit beside real citations, indistinguishable from them, is the exact failure this path exists to prevent. The mirror case — sources retrieved, synthesis failed, which on a free-tier OpenRouter account is a daily event rather than an outage — returns the sources marked `synthesized=False` with `grounded` false, so an analyst can read them and a report cannot quote them.

**Only grounded rows reach the drafting agent.** `routes/ai.ts` builds `narrativeResearchPayload` from the live rows and ships it as `market_research`; `report_narrative.research_block()` consumes it, and both sides bound how much rides along — an unbounded research block crowds the engagement's own facts out of the context window, and the sections that read research are precisely the ones that would lose. Citations travel with every answer, because a research paragraph arriving without them would read as authoritative and be uncheckable, which is worth less than no research at all.

**Staleness is measured against the valuation date, not today.** Research retrieved after the measurement date is not fresher, it is inadmissible; `isResearchStale` and `RESEARCH_STALE_DAYS` mark it on the tab rather than hiding it, because it is a finding an analyst must see and decide about.

**`refresh-all` exists because the alternative is a stale subset.** Re-running topics one at a time leaves an engagement whose industry outlook is current and whose market conditions are four months old, with nothing on the page saying so. Superseding rather than updating in place keeps the prior answer, since what a draft was written from is part of the audit trail.

## 12.4 Analyst agents

**409.ai** — not observed.

**N409 status: Built, ahead.** Nine agents under `ai/app/agents/`: the original six — `cap_table`, `comp_selection`, `report_narrative`, `assumptions`, `audit_defense`, `roll_forward` — plus `engine`, `company_profile` (`0151`/`0152`) and `tagging` (`0153`/`0154`), each sharing the pipeline-job and prompt-registry machinery, with calculation-dependent agents refusing to run without one. No work.

---

# 13. Email System

## 13.1 Templates

**409.ai** — 12 templates at `/admin/communication_templates`, columns ID, name, subject, content, category, timestamps, grouped Incomplete / Drafted / Unverified / Published, with variables `{{invitation_link}}`, `{{valuation_link}}`, `{{payment_link}}`, `{{user_first_name}}`, `{{sample_report}}`.

**N409 status: Built, ahead.** 32 seeded templates across six categories (`account`, `open`, `in_review`, `drafted`, `published`, `closed`) after `0113`, with 15 declared variables validated at edit time — `renderTemplate` leaves an unknown placeholder verbatim at send time, so an undeclared variable used to reach the client as literal `{{typo}}`. Flagged at the row and in the editor now, and previewable against a real engagement. `routes/communications.ts`, `TemplatesPage.tsx`. No work.

## 13.2 Auto emails and SMS

**409.ai** — 27 sequences (21 email, 6 SMS), tabs All/Email/SMS, columns ID, subject, name, content, category, channel, promotional, timestamps.

**N409 status: Built at parity, one column short.**

`comm_channel` is `('email','sms')`; `auto_emails` carries `trigger_state`, `condition`, `delay_hours`, `repeat_hours`, `max_sends`, `template_key`, `enabled`. `0051` seeded five, `0104` the remaining twenty-two, for 27. The condition vocabulary is richer than 409.ai's: `always, unpaid, no_documents, waiting_on_client, paid, intake_incomplete, no_captable, …`. `POST /admin/auto-emails/run` drives the drip; `notification_preferences` (`0046`) is the client's kill switch; `email_outbox` has a claim protocol (`0095`) so a restart cannot double-send.

**Missing: the `promotional` flag.** `grep -rn "promotional" src/services/valuation` returns nothing. 409.ai marks several campaigns promotional. That flag is not cosmetic — it is the CAN-SPAM / GDPR / PECR distinction between a transactional message a client cannot opt out of and a marketing message they can. Without it, either the renewal and feedback campaigns are being sent as transactional (a compliance exposure) or the unsubscribe suppresses status notifications a client needs (a service failure).

### Implementation spec

**Database.**

```sql
ALTER TABLE auto_emails
  ADD COLUMN promotional boolean NOT NULL DEFAULT false;

-- Marketing-side campaigns from 0104. Everything else stays transactional.
UPDATE auto_emails SET promotional = true
 WHERE template_key IN ('renewal_reminder','report_feedback',
                        'material_event_check_in','ignored_reengagement',
                        'timeout_reengagement','cancelled_followup');
```

Defaulting to `false` is the safe direction: mislabelling a marketing message as transactional is a compliance problem, and mislabelling a transactional one as marketing silences a client's status updates. Neither is acceptable, so the default is the one an operator must consciously change, and the seed above is explicit about which six it changes.

**API.** Accept and return `promotional` on `POST|PATCH /admin/auto-emails`. In the send path, gate promotional campaigns on the marketing consent flag in `notification_preferences` — add one if none exists — and append an unsubscribe footer to promotional sends only.

**Frontend.** A Promotional checkbox column on `CommunicationsPage.tsx`, and the All/Email/SMS tab set the catalog shows.

**Business logic.** Suppression is asymmetric: a marketing opt-out suppresses `promotional = true` only. A transactional send ignores marketing consent. Encode this in one predicate in `domain/communications.ts` and test both directions.

**Priority: P1 · Effort: S. Closed.** `0118_auto_email_promotional.sql` adds the column defaulting to `false` and names the six campaigns it marks, and `0138_email_outbox_promotional.sql` carries the flag onto the outbox row so what was sent records whether it was marketing — a campaign reclassified next quarter must not retroactively change what last quarter's send claimed to be. The asymmetric predicate is `isSuppressed` in `hooks/autoEmails.ts`, checked *before* the outbox row exists rather than after: a suppressed promotional message was never queued, so there is nothing for the retry sweep to find and nothing counting against `max_sends`. A transactional campaign never reaches that branch — a client who unsubscribed from renewal offers still has to be told their draft is ready. The unsubscribe footer lives in `domain/communications.ts` and is appended at send time rather than stored in the template, because promotional is a property of the campaign and one template can be shared by a promotional campaign and a transactional one; `email/mime.ts` sets the matching `List-Unsubscribe` headers. A promotional send with no configured public URL goes without a footer rather than with a broken link.

## 13.3 Outbox and delivery

**409.ai** — not observed.

**N409 status: Built, ahead.** `EmailOutboxPage.tsx`, `POST /admin/outbox/retry`, the claim protocol in `0095`, SMS routed through the same outbox with the phone in `to_email` for `channel = 'sms'`. No work.

---

# 14. API Tokens & Partner API

## 14.1 Token administration

**409.ai** — an API Tokens page listing all 4 tokens across partners, columns User, Partner, Client, Client secret (masked).

**N409 status at audit: Partial.** `GET|POST /api/v1/partners/:partnerId/tokens` and `DELETE /api/v1/api-tokens/:id` exist, and `PartnerDetailPage.tsx` manages tokens for one partner. There is no cross-partner listing, so answering "who currently holds API credentials" means visiting 24 partner pages.

### Implementation spec

**Database.** None.

**API.** `GET /api/v1/admin/api-tokens` — every token, joined to partner and issuing user, returning `token_prefix` and never `token_hash` (the plaintext secret is shown once at creation and stored hashed). `api_tokens` already carries `created_at`, `last_used_at` and `revoked_at` (migration `0020`), so the listing can answer the question actually worth asking of a credential list — which tokens are dormant — with no schema change.

**Frontend.** `pages/AdminApiTokensPage.tsx` at `/admin/api-tokens`: table with partner, user, client id, masked secret, created, last used, and a revoke action per row. Link from `AdminPartnersPage`.

**Priority: P2 · Effort: S. Closed.** Gated on `canManageUsers` rather than `isOps`: this is the whole platform's credential inventory across every firm, and the reviewer and data roles `isOps` admits have no business reading it. Revoked rows are excluded by default so the list opens on what can currently be used, and the summary reports how many live tokens are *dormant* — a live key nobody has used for a quarter is either an integration decommissioned without anyone revoking it or one that was never wired up, and both are credentials outstanding for no reason.

## 14.2 Partner API

**409.ai** — a REST API for partners.

**N409 status: Built, ahead.** `routes/partnerApi.ts`, `ApiDocsPage.tsx` at `/partner/api-docs`, HMAC-signed webhooks with retries, `Idempotency-Key` replay protection. No work.

---

# 15. Inbox & Comments

## 15.1 Shared inbox

**409.ai** — an Inbox listing valuation comments across engagements; columns Thread, Body, User, Kind, Valuation; an unread badge on the nav.

**N409 status: Built, ahead in correctness.**

`0113` added `valuation_comment_reads`. `GET /api/v1/inbox`, `/inbox/unread-count`, `POST /inbox/read`, `/inbox/read-all`. `InboxPage.tsx`. Read state is per `(reader, engagement)` — `last_comment_at` is a property of the thread and unread is a property of the reader, and the scope filter is `valuationScope` reproduced in SQL so filtering happens before `LIMIT` rather than after (filtering after `LIMIT` hands a partner four rows and calls it page one).

## 15.2 Compose from the inbox

**N409 status at audit: Partial — known gap.**

There is no compose box. Replying goes through the engagement's own thread, which is correct — one write path owns the kind rules, mention parsing and the realtime broadcast — but means answering from the inbox is two clicks and a page load.

**Spec.** An inline reply box on each inbox row that POSTs to `/api/v1/valuations/:id/comments`, the existing write path, and optimistically appends. Do **not** add an inbox-specific write endpoint; the second write path is how the mention parsing and the broadcast drift apart.

**Priority: P2 · Effort: S. Closed** exactly as specified — `routes/inbox.ts` still has no POST but the two read marks. Ops get a kind toggle between a client reply and an internal note; a firm reader gets neither, because notes are ops tooling. An inbound email is answered as `chat`, since `canPostComment` refuses kind `email` outright and nothing on this platform sends mail out of a comment box. Sending marks the thread read, because it now has been.

## 15.3 Comment kinds and chat

**409.ai** — per-valuation Chat, and comments of kind `email`.

**N409 status: Built.** `COMMENT_KINDS = ['chat','note','email']`, `email_meta` on the row, pinning, mentions (`0089`), SSE broadcast via `routes/stream.ts`, `POST /api/v1/inbox/email` for inbound. `CommentThread.tsx`. No work.

---

# 16. Intake Wizard

## 16.1 Client-facing onboarding

**409.ai** — not reachable from the admin panel; `/admin/valuations/new` returns Access Denied and `/admin/partner_valuations/new` a 500. The intake wizard is a client-facing flow.

**N409 status: Built, ahead.**

- `GET /api/v1/intake/schema` and `domain/intakeKinds.ts` — per-kind intake sections for all 15 kinds.
- `GET|PUT /valuations/:id/questionnaire`, `POST /questionnaire/submit` (`0072`).
- `GET /api/v1/onboarding/progress` and `OnboardingPage.tsx` — the eight-step wizard.
- `client_intake_links` (`0092`), `routes/clientIntake.ts`, `ClientIntakePage.tsx` at `/intake`, `IntakeLinksPanel.tsx` — tokenised links so a client completes intake without an account.
- `valuationSelector.ts` + `WhichValuationPage.tsx` — the selector quiz.
- `PhoneInput.tsx` — country-code selector (the previous design document's §13.11 gap, closed).
- `dataCompleteness.ts` + `CompletenessTab.tsx` — completeness scoring (§13.3, closed).
- `POST /valuations/:id/remind-documents`.

No work.

## 16.2 Marketing blog

**409.ai** — a 25-article blog.

**N409 status at audit: Missing.** No blog route in `App.tsx`, no article store. Every other marketing surface exists: landing, pricing, compare hub, 14 product pages, static pages, selector quiz.

**Spec.** `help_articles` (`0048`) already models authored content with slugs and rendering; a `blog_posts` table of the same shape plus `published_at`, `author`, `excerpt` and `og_image`, with `/blog` and `/blog/:slug` routes and `Seo.tsx` for meta tags. Content authoring is the bulk of the cost, not the code.

**Priority: P2 · Effort: M** (code S, content L). **Closed**, with one seeded article so `/blog` is a page rather than an empty state on the day it ships. The reading half is genuinely unauthenticated — not "authentication that usually fails" — because a public endpoint whose response depends on a session is one that can be cached wrong; drafts are served only from `/admin/blog`, and the article page falls back to that endpoint for an ops reader so a preview is the real page. `published_at` is separate from both `published` and `created_at`: a post written on Tuesday and published on Friday is a Friday post, and a typo fixed in March must not re-date a January article and reorder the index for every crawler that had indexed it. `author` is text rather than a user reference, because a byline is what the piece was published under and must not change when an account is renamed.

---

# 17. Consolidated gap analysis

## 17.1 Gap table

| # | Gap | Section | Status | Class | Priority | Effort |
|---|---|---|---|---|---|---|
| 1 | Stripe unconfigured in production | 13, 4.3 | **Closed** | Configuration | P0 | S |
| 2 | Web-grounded research built but unwired | 12.3 | **Closed** | Feature — AI | P0 | L |
| 3 | Specialty engine workspace UI absent | 7.2 | **Closed** | Ops UX | P0 | M |
| 4 | Narrative prompt library has no UI | 6.3 | **Closed** | Ops UX | P0 | S |
| 5 | 11 market-research prompts missing | 12.1 | **Closed** | Content + AI | P0 | M |
| 6 | `promotional` flag on auto emails | 13.2 | **Closed** | Compliance | P0 | S |
| 7 | Stale backsolved calculations unlisted | 7.4 | **Closed** | Remediation | P0 | M |
| 8 | Stale QA reviews unlisted | 7.4 | **Closed** | Remediation | P0 | S |
| 9 | Nine named listing tabs | 4.2 | **Closed** | Ops UX | P0 | S |
| 10 | Sidebar bucket counts + unread badges | 3.2 | **Closed** | Ops UX | P0 | S |
| 11 | Dashboard is thin — no activity, SLA or throughput | 3.1 | **Closed** | Ops UX | P1 | M |
| 12 | Network Items / persisted comparable set | 4.5 | **Closed** | Feature + defensibility | P1 | M |
| 13 | Job monitor reports but nothing alerts | — | **Closed** | Ops | P1 | M |
| 14 | Cross-partner API token listing | 14.1 | **Closed** | Ops UX | P2 | S |
| 15 | Inbox compose box | 15.2 | **Closed** | Ops UX | P2 | S |
| 16 | Legacy documents still in `uploads` | 9.2 | **Closed** | Remediation | P2 | S |
| 17 | Per-valuation header counters | 4.6 | **Closed** | Ops UX | P2 | S |
| 18 | Calculations `n/m` nav badge | 7.3 | **Closed** | Ops UX | P2 | S |
| 19 | Partner Valuation saved entry point | 4.4 | **Closed** | Ops UX | P2 | S |
| 20 | Marketing blog | 16.2 | **Closed** | Marketing | P2 | M |
| 21 | Bedrock adapter | 12.2 | **Closed** | Deployment choice | P2 | M |

## 17.2 What the shape of this table says

*Written at audit time, and kept because the prediction it made is the thing worth checking against the outcome.*

Twenty-one gaps. **Six of the ten P0 items were work already finished and not reachable** — Stripe (code complete, no keys), Perplexity (adapter complete, no caller), specialty engines (eight engines, no UI), the narrative library (five endpoints, no page), plus the two data-remediation lists over queries already written down in REVISION. Only two P0 items were genuinely new capability: the market-research prompts and the `promotional` flag.

That was an unusual and favourable position. The expensive work — the engines, the adapters, the schema, the state machine — was done and tested. What remained was disproportionately the last layer: the page, the caller, the config, the list. Nine of the ten P0 items were S or M.

The three P1 items were where new surface actually had to be designed. Everything at P2 was parity or polish.

**How the estimate held.** The "last layer" reading was right about eight of the ten and wrong in one instructive place. Items 3, 4, 9 and 10 were the single missing page or the single missing field the audit said they were. Items 7 and 8 were queries, as predicted. Item 2 was sized L and *was* L, but not for the reason given: the caller was straightforward and the provider was not — the estimate assumed the Perplexity key would arrive, and the real work turned out to be building a second, keyless retrieval path so the feature did not depend on it. Item 5 collapsed from eleven prompts to six registry rows plus a region parameter, which is the one place the audit over-counted by taking the competitor's catalog shape as the target instead of the capability behind it. Item 6 was an S that needed a second migration (`0138`) once it was clear the flag has to be recorded on the send and not only on the campaign.

The general lesson is the one the table's shape suggested and did not quite state: counting a competitor's rows tells you what to be able to do, not how many things to build.

**Every P0, P1 and P2 item on this table is now closed**, and so are the two provider-configuration items that trailed them. Stripe now has a (test-mode) `STRIPE_SECRET_KEY` in `/opt/N409/.env`; its webhook secrets still wait on the endpoints being registered in the Stripe dashboard, which is a console step and not a key to paste. The Perplexity key was never obtainable — Perplexity has no free tier — so the dependency was removed instead of satisfied: `ai/app/websearch.py` retrieves sources from a pluggable provider whose default (DuckDuckGo) needs no key, and `ai/app/research.py` synthesises the answer with the OpenRouter models already in use. Research therefore works on a fresh checkout rather than waiting on procurement, which was the more serious defect in the original design. §12.3.

## 17.3 Sequencing

**Sprint 1 — collect the sunk value.** Items 1, 3, 4, 9, 10. All S or M, no new schema, no new engine. At the end of it Stripe settles, eight specialty engines are in the product, reviewers can edit narrative guidance, and the listing reads like the competitor's.

**Sprint 2 — the research spine.** Items 2 and 5 together; they are one piece of work. Schema, the public-field research pipeline with its containment test, the routes, the tab, and the thread into `report_narrative`.

**Sprint 3 — compliance and remediation.** Items 6, 7, 8 — one migration, one predicate, one remediation-list page hosting both queries.

**Sprint 4 — the P1 surface.** Items 11, 12, 13. Two migrations (`0119_comparable_items`, `0120_job_alerts`), one new tab, three new bands on an existing page, and one background sweep. The peer set is the load-bearing one: it is the first thing an auditor asks a market approach about, and it also changes what the engine is fed — the included rows outrank the AI aggregate, with the aggregate kept as the fallback so an unscreened engagement computes exactly as it did before.

**Sprint 5 — the P2 tail.** Items 14–21. Two migrations (`0121_document_review`, `0122_blog_posts`), four new pages, one inline control, one counters object serving two of the items, one public marketing surface and one provider adapter. Nothing here is load-bearing on a valuation; the through-line is that each item is a place where finished work was not reachable, or a number the platform could compute and did not show.

**Backlog.** Empty. What remains of §17.1 is the two provider keys.

---

# 18. The top ten P0 gaps

**All ten are closed.** This section is kept as written at audit time — ranked by cost of leaving them alone — because the ranking was the argument for the sequencing in §17.3 and reads as evidence only if it is not quietly revised after the fact. Each entry carries the commit-side outcome as a trailing line; the detail is in the section each one cites.

### P0-1 · Stripe is unconfigured in production
`/opt/N409/.env` has no `STRIPE_SECRET_KEY` and no webhook secrets. Every client sees "Online payment is not available yet — we will invoice you instead", none of the payment handlers can fire, and nothing can enter the `paid` state except an ops advance on an engagement someone marked paid by hand. The code is complete and tested; the gate is a configuration step. **Nothing else on this list costs revenue on every single engagement.** See `docs/billing-setup.md`. *Effort: S.* **Closed** — a test-mode `STRIPE_SECRET_KEY` is in `/opt/N409/.env`. The webhook secrets still wait on the endpoints being registered in the Stripe dashboard, which is a console step and not a key to paste.

### P0-2 · Perplexity market research is built and nothing calls it
`ai/app/perplexity.py` and `POST /ai/v1/research` are complete, fenced against leaking client text, and tested. No route, no storage, no UI, no thread into drafting. Industry-conditions and market-outlook paragraphs are still written from the uploaded corpus alone and remain the weakest part of every generated draft. §12.3 specifies the schema, the public-field pipeline, the routes, the tab and the narrative integration. *Effort: L.* **Closed**, and re-scoped in the closing: the Perplexity key was never obtainable, so the feature ships on a keyless retrieval path with Sonar as the upgrade rather than the dependency. §12.3.

### P0-3 · The specialty engines have no workspace UI
`POST|GET /valuations/:id/specialty` and the HMRC form endpoint are live. `App.tsx` has no route and `CalculationsTab` shows only the 409A engines. Eight engines and eleven product kinds are operable only by someone with a bearer token and curl. Frontend-only work; specialty exhibits already consume the stored result. *Effort: M.* **Closed** — `SpecialtyTab.tsx`, ops-only and gated on the engagement's kind. §7.2.

### P0-4 · Eleven market-research prompts are missing
`company_overview`, `industry_overview`, `industry_outlook`, `competitor`, six regional `market_*` variants and `Industry_finder`. One coherent family, and the only substantive AI breadth gap against 409.ai — the other nine of their twenty map onto N409 pipelines that are equal or better. Collapse the six regional variants into one region-parameterised topic. Ships with P0-2. *Effort: M.* **Closed** — and the collapse held: eleven catalog names became six registry rows plus `RESEARCH_REGIONS`. `AI_PIPELINES` is 20. §12.1.

### P0-5 · The narrative prompt library has no editor
34 seeded rows, five endpoints, `default_guidance` preserved for reset, and the payload wired all the way into the drafting agent (`routes/ai.ts:188` → `report_narrative.sections_for()`) — and no page. Migration `0114` exists so a reviewer can change DLOM framing and conclusion wording without a deploy; without the UI they still cannot. Also the mechanism that keeps specialty deliverables from reading as a 409A with the title swapped. One page, no schema, no endpoints, no integration. *Effort: S.* **Closed** — `AdminNarrativePromptsPage.tsx`, and it was exactly the one page. §6.3.

### P0-6 · Auto emails have no `promotional` flag
The CAN-SPAM / GDPR / PECR line between a transactional message a client cannot opt out of and marketing they can. Either the renewal, feedback and re-engagement campaigns are going out as transactional, or a marketing opt-out is silencing status notifications. One column, one asymmetric suppression predicate, one checkbox — and it is a compliance control, not a feature. *Effort: S.* **Closed** — and it was two columns, not one: `0118` on the campaign and `0138` on the outbox row, because what a message *was* has to survive the campaign being reclassified later. §13.2.

### P0-7 · Stale backsolved calculations are unlisted and unflagged
Every calculation stored before `99383b2` that took the single-breakpoint backsolve path with a non-zero option pool holds an equity value low by roughly the pool's share, and any report rendered from one still says so. Nothing re-runs them, nothing flags them. Published opinions cannot be silently rewritten, so this needs the list first: `results.approaches.opm_backsolve.method = 'backsolve_single'` against inputs with `options_outstanding > 0`. *Effort: M.* **Closed** — `repos/dataRemediation.ts` and `AdminDataRemediationPage.tsx`, list-first as specified, with the bulk re-run confined to unpublished engagements. §7.4.

### P0-8 · Stale QA reviews are unlisted
Reviews recorded before `9ed0aa6` graded the parameter rather than the result, so a stored `dlom_range` check on a Chaffee/Finnerty run is either absent or about the wrong figure. Self-correcting for anything re-reviewed; what it does not do is re-open the gate on a valuation already published on one. Same shape as P0-7 — build one remediation-list surface hosting both queries. *Effort: S.* **Closed** on the same surface as P0-7. §7.4.

### P0-9 · The listing has five tabs where the competitor has nine
Incomplete, Unverified, In Progress, Waiting On Client and Ignored are all states N409 stores and can query; the listing collapses them into five groups, so the most-used screen in the product cannot answer "what is stuck unverified" without hand-writing a filter. Define `NAMED_BUCKETS` once in `domain/workflow.ts` and have both the counts and the filter read it. *Effort: S.* **Closed** exactly that way, and the definition now feeds four surfaces rather than two — tab strip, sidebar badges, partner detail tiles and the counts endpoint. §4.2.

### P0-10 · The sidebar shows no counts
409.ai's nav carries a live count and an unread badge on every bucket; N409's carries static labels. The counts exist server-side and `valuation_comment_reads` already models per-reader unread correctly. One endpoint field, one hook, one badge component. The cheapest item on this list and the most visible. *Effort: S.* **Closed** — `AppLayout.tsx` reads the same `buckets` payload the dashboard does, so the two cannot disagree. §3.2.

---

# 19. Appendix A — evidence map

Every status claim above traces to one of these.

| Area | Primary evidence |
|---|---|
| Enumerations | `src/services/valuation/migrations/0001_core.sql`, `0107_paid_state.sql`, `0109_fund_debt_kinds.sql` |
| Roles & RBAC | `0002_seed_roles.sql`, `src/services/valuation/src/domain/permissions.ts`, `auth/rbac.ts` |
| Overwrites | `src/services/valuation/src/domain/overwrites.ts` (68 fields, 6 categories), `routes/overwrites.ts`, `pages/OverwritesSchemaPage.tsx` |
| Workbook | `domain/workbookTabs.ts`, `routes/workbook.ts`, `pages/valuation/WorkbookTab.tsx` |
| Reports | `domain/report.ts` (16 skeletons), `reportExhibits.ts`, `specialtyExhibits.ts`, `navExhibits.ts`, `0010_m2_output_delivery.sql`, `src/services/report/` |
| Narrative library | `0114_narrative_prompt_library.sql`, `routes/narrativePrompts.ts`, `ai/app/agents/report_narrative.py` |
| Engines | `src/services/engine-wrapper/app/engine/` (37 modules), `app/main.py` (31 endpoints) |
| DLOM | `engine/dlom.py` — `MODEL_DLOM_METHODS = {chaffee, finnerty, ghaidarov, longstaff}`, `DLOM_METHODS` adds `restricted_stock`, `qualitative`; `0111_dlom_models_market_horizon.sql` |
| Comparables | `engine/comparables.py`, `engine/market_feed.py`, `ai/app/agents/comp_selection.py` |
| AI service | `ai/app/main.py`, `pipelines.py`, `research.py`, `websearch.py`, `perplexity.py`, `openrouter.py`, `bedrock.py`, `llm_router.py`, `anonymize.py`, `agents/` (9) |
| Prompt registry | `0040_p1p2_features.sql`, `0045_prompt_versions.sql`, `0060_ai_agents.sql`, `0061_seed_agent_prompts.sql`, `domain/pipeline.ts` (`AI_PIPELINES`, 20; `NON_RUNNABLE_PIPELINES`, 7), `0116_market_research.sql`, `0117_seed_research_prompts.sql`, `0151`/`0152` (company profile), `0153`/`0154` (tagging) |
| Communications | `0051_communications.sql`, `0104_notification_sequences.sql` (27 campaigns), `0113_admin_platform.sql` (categories), `domain/templateVariables.ts` |
| Documents | `0105_document_categories.sql`, `0112_document_categories_expand.sql`, `domain/documentCategories.ts` (13) |
| Partners | `0047_partner_management.sql`, `0050_partner_white_label.sql`, `0091_white_label_branding.sql`, `0102_partner_webhooks.sql`, `0103_webhook_retries.sql`, `0106_partner_subdomains.sql`, `0113_admin_platform.sql` |
| Inbox | `0113_admin_platform.sql` (`valuation_comment_reads`), `routes/inbox.ts`, `pages/InboxPage.tsx` |
| Intake | `0072_intake_questionnaire.sql`, `0092_client_intake_links.sql`, `domain/intakeKinds.ts`, `routes/intake.ts`, `clientIntake.ts`, `onboarding.ts` |
| Listing & filters | `pages/ValuationsPage.tsx`, `lib/types.ts` (`STATE_GROUPS`, `VALUATION_STATES`), `0088_saved_views.sql` |
| Router | `src/services/web-frontend/src/App.tsx` |
| Known gaps of record | `REVISION` `gap:` lines |

Counts as audited (2026-08-08): 115 migrations, 86 tables, 80 route modules in the valuation service, 26 workspace tabs, 33 engine modules, 31 engine endpoints, 6 AI agents, 12 AI pipelines, 68 overwrite fields, 13 document categories, 18 role keys, 27 auto-email campaigns, 32 communication templates, 15 valuation kinds, 15 lifecycle states, 16 report skeletons.

Counts as re-verified (2026-08-14, after every item in §17.1 closed): **117 migration files** (latest `0154_seed_tagging_prompt.sql`), **96 tables**, **93 route modules**, **31 workspace tabs**, **37 engine modules**, 31 engine endpoints, **9 AI agents**, **20 AI pipelines**, **9 named buckets**, 68 overwrite fields, 13 document categories, 18 role keys, 27 auto-email campaigns, 32 communication templates, 15 valuation kinds, 15 lifecycle states, 16 report skeletons.

The unchanged figures are the point of listing both rows. Overwrite fields, document categories, roles, campaigns, kinds, states and skeletons are the *parity* counts — the ones taken from the screenshot catalog as targets — and they did not move, because the work since the audit was closing gaps rather than widening the surface. What moved is the machinery underneath: routes, migrations, engines, agents and pipelines. A future reader can use the split to tell a parity claim from an implementation detail without re-deriving which is which.

---

# 20. Appendix B — gaps closed since the last design document

Section 13 of `N409-System-Design.docx` was verified at commit `8861b0c`. The following items from that list, and from `docs/409AI_FEATURE_GAPS.md` (2026-07-10), are now closed. A reader working from either document should not re-do them.

| Old ref | Gap as recorded | Now |
|---|---|---|
| 13.1 | Perplexity market research — "grep -ril perplexity returns nothing" | **Closed.** Adapter built (`ai/app/perplexity.py`, `POST /ai/v1/research`), then wired: `0116`/`0117`, `domain/research.ts`, `routes/research.ts`, `ResearchTab.tsx`, and the thread into `report_narrative`. The Perplexity key was never obtainable, so `websearch.py` + `research.py` give it a keyless default path. §12.3. |
| 13.2 | ~19 narrative prompts missing | **Closed.** `0114` seeded 34 narrative-section rows (plus specialty rows in `0141`/`0145`), and the 11 market-research prompts landed as six registry rows plus a region parameter. §12.1. |
| 13.3 | Missing-data completeness scoring | **Closed** — `domain/dataCompleteness.ts`, `routes/dataCompleteness.ts`, `CompletenessTab.tsx`. |
| 13.4 | Comparables depth | **Closed in the engine** — `comparables.py` has SIC similarity, log/linear proximity, screening reasons, quartiles, primary-multiple selection; `test_comp_multisource.py`. Persistence of the peer set is **closed** too — `0119_comparable_items.sql`, `routes/comparables.ts`, `ComparablesTab.tsx`, Exhibit D-1. |
| 13.5 | Financial anomaly detection | **Closed** — `engine/anomalies.py`. |
| 13.6 | LTM vs NTM multiples | **Closed** — `market_horizon` enum (`0111`), `ebitda_ntm` in the extraction fields. |
| 13.7 | 820 / gifts / ifrs2 engine dispatch | **Closed** — `fair_value_820.py`, `gift_estate.py`, `ifrs2.py`, each with an endpoint. |
| 13.8 | Additional DLOM models | **Closed** — Ghaidarov, Longstaff and restricted-stock studies in `dlom.py`; enum extended in `0111`. |
| 13.9 | Marketing blog | **Closed** — `0122_blog_posts.sql`, `routes/blog.ts`, `/blog` and `/blog/:slug`, admin authoring at `/admin/blog`. |
| 13.10 | Interactive package graph | **Closed** — `routes/packageView.ts`, `pages/valuation/PackageTab.tsx`. |
| 13.11 | Phone country-code selector | **Closed** — `components/PhoneInput.tsx`, `domain/phone.ts`. |
| 13.12 | Specialty pipeline has no workspace UI | Open — P0-3. |
| 13.13 | Stale backsolved equity values | Open — P0-7. |
| 13.14 | Stale QA reviews | Open — P0-8. |
| 13.15 | Stripe unconfigured | Open — P0-1. |
| — | Document categories 6 → 13 | **Closed** — `0112`. Legacy re-filing **closed** too — `routes/adminDocuments.ts`, `domain/documentTriage.ts`, `/admin/documents`. |
| — | Template categories and variable catalog | **Closed** — `0113`, 15 declared variables. |
| — | Role catalog and capability matrix | **Closed** — `domain/permissions.ts`, asserted against `auth/rbac.ts`. |
| — | Partner terms (prepaid, cc_emails, subdomain) | **Closed** — `0113`. |
| — | Job monitor | **Closed as a report and as an alert** — `0120_job_alerts.sql`, `domain/jobAlerts.ts`, `hooks/jobAlerts.ts`, `POST /admin/jobs/alerts/scan`. |
| — | Shared inbox | **Closed** — `0113`, per-reader read state. Compose box **closed** too — an inline reply through the engagement's own write path. |
| — | Cap-table structure graph | **Closed** — `domain/capTableGraph.ts`, `CapTableGraph.tsx`. |

One correction to the record: §1.2 of the existing document states the AI layer has "8 seeded prompts" and that "Perplexity research is absent". As audited, `AI_PIPELINES` carries 12 entries with seeded prompts, `narrative_prompts` carries 34 more rows, and the Perplexity adapter exists with its own route and tests. The characterisation of the gap changes accordingly — it is a wiring and content gap, not an absence, and it is a smaller job than that document scoped.
