# N409 — Enriched Feature Improvements

> **Date:** 2026-07-29 · **Branch:** `main` @ `3b38d8f` · **Scope:** new features and
> enhancements only. No bugs, no security items, no infrastructure hardening — those are
> tracked and closed elsewhere.
>
> Baseline reviewed: 65 route modules / ~259 endpoints in
> `src/services/valuation/src/routes/`, 87 migrations, 24-tab valuation workspace and 46
> pages in `src/services/web-frontend/src/pages/`, 20 engine modules in
> `src/services/engine-wrapper/app/engine/`, 7 AI agents in `src/services/ai/app/agents/`.
> The platform is past parity with 409.ai; everything below is **differentiation**, not
> catch-up. Each item was checked against the code, and the anchor files are cited so the
> reader can confirm what exists before building on it.

**Effort key:** **S** ≤ 2 days · **M** ~1 week · **L** 2+ weeks (one engineer).

---

## 1. Top 12, ranked

Ranked by *revenue or retention impact per unit of effort*, not by category.

| # | Feature | Category | Effort | Why it ranks here |
|---|---|---|---|---|
| 1 | Excel (XLSX) export of workbook + cap table | Reporting | **S** | Every accountant and auditor asks for it; exports today are CSV/PDF only (`routes/exports.ts`). Cheapest credibility win available. |
| 2 | Public instant-quote calculator + embeddable widget | Growth | **S** | Pricing data already modeled (`lib/marketing.ts`); converts the pricing page from reading into a lead. |
| 3 | Outbound event webhooks for partners | Integration | **M** | Partner API tokens and an append-only event spine exist, but no webhooks — inbound Stripe only. This is what makes N409 embeddable by cap-table and accounting platforms. |
| 4 | Slack app (notifications + approvals) | Integration | **M** | Notifications are email + in-app only (`repos/notificationPreferences.ts`). Ops teams live in Slack; approvals-in-Slack cuts review latency measurably. |
| 5 | Data-room Q&A over the document corpus | New capability | **M** | Documents are already extracted, anonymized and chunk-ready; 7 agents exist but none answer questions. Highest-perceived-magic feature in the product. |
| 6 | Anonymized benchmarking product ("how do we compare?") | Reporting / Growth | **M** | N409's own book of valuations is a proprietary dataset no competitor's client sees. Doubles as content-marketing fuel. |
| 7 | Command palette (⌘K) + keyboard-first navigation | UX | **S** | 24 workspace tabs and 46 pages; global search exists (`routes/search.ts`) but no palette. Directly attacks ops clicks-per-valuation. |
| 8 | Saved views / shared worklist filters | UX / Collaboration | **S** | Advanced filters exist but are not persistable. Turns per-user habit into team process. |
| 9 | Secondary-transaction & tender-offer approach | New capability | **M** | A real, frequently-required 409A indication of value; today secondary sales are only a roll-forward adjustment (`engine/rollforward.py:13`). |
| 10 | Annual renewal automation (quote → invoice → kickoff) | Automation | **M** | Monitoring already detects safe-harbor expiry (`domain/monitoring.ts`, `EXPIRY_WARN_MONTHS = 10`) and subscription billing exists — nothing joins them into recurring revenue. |
| 11 | @mentions + assignment in comments | Collaboration | **S** | SSE presence and threads already ship (`routes/stream.ts`); mentions are the missing verb. |
| 12 | Warrant & complex-instrument valuation module | New capability | **M** | SAFEs/convertibles are handled (`engine/debt_valuation.py`); warrants are not valued as instruments at all. Closes the cap-table completeness story. |

---

## 2. User experience

| Feature | What | Effort |
|---|---|---|
| **Command palette (⌘K)** | Fuzzy jump to any valuation, tab, admin page or action. Back it with the existing `/api/v1/search`; add recent-items and action verbs ("advance workflow", "run extraction"). | **S** |
| **Saved views** | Persist worklist filter + column + sort combinations; let ops share a view org-wide ("My reviews due this week", "Unpaid > 7 days"). New table + a dropdown on `ValuationsPage.tsx`. | **S** |
| **Workspace tab overflow + per-role tab sets** | 24 tabs in `ValuationWorkspace.tsx` is past the point of scannability. Group into 5 sections (Intake · Model · Review · Output · Lifecycle), collapse irrelevant tabs by product kind and role, remember the last tab per valuation. | **S** |
| **Client status timeline** | A single client-facing page: where the valuation is, what's blocking it, who's waiting on whom, SLA countdown. States, `delivery_days` and events all exist; this is presentation. Converts opaque waiting into perceived speed. | **S** |
| **Dark mode** | No `prefers-color-scheme` handling anywhere in the design system. Analysts stare at workbooks all day; this is a frequent unprompted request in finance tooling. | **S** |
| **Drag-and-drop bulk upload with AI auto-classification** | Documents have 11 kinds selected by hand. Drop 12 files, let the extractor propose kinds, confirm in one screen. Extraction pipeline already returns confidence scores. | **M** |
| **Guided first-valuation walkthrough** | Product tour tied to the intake questionnaire (`routes/intake.ts`), with a completion meter. Reduces the hand-holding load on support for self-serve clients. | **M** |
| **Localization (i18n) + UK/EU number and date formats** | Zero i18n in the codebase, yet EMI (UK) and CSOP are shipped products (`lib/marketing.ts:147`) and multi-currency exists. Start with en-GB formatting, then de/fr copy for the EU expansion. | **L** |
| **PWA / mobile-first client views** | Founders approve and sign from phones. Board-sign (`BoardSignPage.tsx`) and the status timeline are the two surfaces that must be excellent on mobile; the analyst workspace need not be. | **M** |

---

## 3. New valuation capabilities

| Feature | What | Effort |
|---|---|---|
| **Secondary-transaction / tender-offer approach** | Treat recent secondary sales and tender offers as a weighted indication of value with the standard adjustments (informed-buyer test, volume, staleness, employee-vs-institutional). Currently only a roll-forward nudge. Add as a fifth approach alongside income/market/asset/OPM in `engine/approaches.py`. | **M** |
| **Warrants & complex instruments** | Value warrants, participating preferred with caps, and multiple-liquidation-preference stacks as first-class instruments feeding the waterfall (`engine/waterfall.py`). SAFEs and convertibles are done; warrants are absent. | **M** |
| **Monte-Carlo PWERM / complex-security simulation** | Monte-Carlo exists only for ASC 718 awards (`domain/asc718.ts`). Extend to PWERM scenario trees and path-dependent securities (ratchets, milestone-contingent preferences) with convergence diagnostics and a fixed seed for reproducibility. | **L** |
| **83(b) election tracking & deadline alerts** | Zero references in the codebase. Grants are modeled (`repos/grants.ts`); add the 30-day election clock, evidence upload, and a reminder ladder. Small feature, outsized client gratitude. | **S** |
| **Rule 701 / disclosure-threshold checker** | Track aggregate 12-month grant value against Rule 701 ceilings and flag when enhanced disclosure kicks in. Grant data is already there; this is domain logic plus a health check (`domain/healthChecks.ts` is the natural home). | **S** |
| **Multi-jurisdiction share-scheme pack** | Beyond EMI/CSOP: HMRC-agreement workflow artifacts, French BSPCE, German virtual shares. Product kinds and multi-currency exist; each jurisdiction is a template + rule set, not new engine math. | **L** |
| **Peer-set builder with SIC/NAICS drill-down** | Comparable selection is AI-proposed and ticker-verified (`engine/market_data.py`, `market_feed.py`) but there's no analyst-driven screener: filter by industry code, size, growth, geography; save the peer set; diff it against last year's. NAICS is entirely absent. | **M** |
| **Continuous market-data refresh with drift alerts** | `market_feed.py` fetches on demand and caches per run. Schedule refreshes for live monitored valuations and alert when peer multiples or volatility move enough to threaten the concluded FMV. Feeds directly into monitoring triggers. | **M** |

---

## 4. Reporting and analytics

| Feature | What | Effort |
|---|---|---|
| **XLSX export** | Workbook, cap table, waterfall and grant schedules as a formatted multi-sheet workbook with live formulas where sensible. Exports are CSV + PDF today (`routes/exports.ts`, `domain/csv.ts`). The single most requested artifact from auditors. | **S** |
| **Anonymized benchmarking** | "Your $/share, discount, volatility and revenue multiple vs. N anonymized peers in your industry and stage." Requires a k-anonymity floor (suppress cells under ~10 companies) and an opt-out. A defensible data moat and a content-marketing engine in one. | **M** |
| **Report template body merging** | Templates are versioned and managed (`routes/templates.ts`) but generated reports still use the built-in 409A layout (`domain/report.ts`). Merge template bodies, bump `template_version` on regeneration, and add non-409A layouts (ASC 718, fund/ASC 820, gift & estate). | **M** |
| **Richer report editor** | Add tables, images, links, footnotes and cross-references to the WYSIWYG editor. Adequate for edits today, thin for authoring — which is what keeps report drafting slow. | **M** |
| **Board-ready one-page summary** | Auto-generated single page: concluded FMV, method weights, key assumptions, change vs. prior, and the three sentences a board needs. Bridge and analytics data already exist (`domain/valuationBridge.ts`, `AnalyticsTab.tsx`). | **S** |
| **Firm-level operations analytics** | Cycle time by state and analyst, first-pass QA yield, override frequency by field, revenue per product kind, AI token cost per valuation. The event spine and `ai_jobs` table already hold every input; nothing aggregates them for the business. | **M** |
| **Scheduled digest reports** | Weekly PDF/email digest per role — client (portfolio status), partner (their book), ops (queue health). Outbox and preferences infrastructure exists; add a scheduler and templates. | **S** |

---

## 5. Collaboration

| Feature | What | Effort |
|---|---|---|
| **@mentions + inline assignment** | Mention a user in a comment to notify and optionally assign a review task. Threads, SSE presence and typed review tasks all exist; mentions tie them together. | **S** |
| **Unassigned-email triage queue** | Inbound email that matches no valuation is rejected 422 (`routes/comments.ts`). Route it to a manual-triage queue with a "link to valuation" action. Closes the last hole in the email loop. | **S** |
| **Client-visible review checklist** | Expose a filtered slice of the QA checklist (`domain/qaChecks.ts`) so clients see exactly which of their items are outstanding, rather than a generic "waiting on client". | **S** |
| **Annotation on documents and workbook cells** | Pin a comment to a page of a PDF or a workbook cell so review discussion sits on the number in dispute. Workbook cells are already addressable (`repos/workbook.ts`). | **M** |
| **Real-time collaborative editing of params** | The SSE hub already broadcasts presence; add field-level locking or last-write-wins with conflict surfacing on the params and overwrites tabs so two analysts stop clobbering each other. | **M** |
| **Auditor collaboration workspace** | The auditor portal (`routes/auditorPortal.ts`) is read-only. Add an auditor question thread with a response SLA and an evidence-request tracker — the audit season workflow, not just document access. | **M** |

---

## 6. Automation and workflow

| Feature | What | Effort |
|---|---|---|
| **Annual renewal automation** | Monitoring detects safe-harbor expiry at 10 months; subscription/retainer billing exists. Join them: auto-generate a renewal quote, invoice on acceptance, clone the prior engagement, pre-populate from last year, and open the new valuation. The clearest recurring-revenue lever in this list. | **M** |
| **Deeper clone / true roll-forward** | Clone copies engagement + params only (`repos/valuations.ts`). Carry documents, funding rounds, cap table, workbook and peer set, then run the roll-forward engine (`engine/rollforward.py`) so year two starts at ~90% complete. | **M** |
| **SLA escalation ladder** | Delivery-day SLAs are recorded but breaches are passive. Add tiered escalation (analyst → supervisor → ops lead), auto-reassignment on inactivity, and a breach-risk column on the worklist. | **S** |
| **Workflow rule builder** | A small no-code rule engine over the event spine: *when* `state = ready_for_review` *and* product = 409A *and* value > $50M *then* assign senior reviewer + require two approvals. Today routing rules are hard-coded. | **L** |
| **Document reminder cadence** | Intake reminders exist (`routes/intake.ts`); make them a configurable escalating cadence with per-document specificity and a client-facing "what's missing" page. | **S** |
| **Auto-QA gate before human review** | Run the health checks and QA checklist automatically on state transition and block advancement on hard failures, so reviewers never see an obviously incomplete file. Both check suites exist; the gate does not. | **S** |
| **Batch operations for fund/portfolio clients** | Fund portfolios exist (`routes/funds.ts`). Add batch actions across a portfolio: bulk create valuations for all holdings, bulk advance, bulk export, one consolidated invoice. Highest-value-per-account workflow in the product. | **M** |

---

## 7. Integrations

| Feature | What | Effort |
|---|---|---|
| **Outbound webhooks** | Subscribable events (`valuation.published`, `payment.succeeded`, `monitor.triggered`, …) with HMAC signatures, retry with backoff, a delivery log and a replay button. Only inbound webhooks exist today (`routes/payments.ts`, `routes/billing.ts`). Prerequisite for every partner integration below. | **M** |
| **Slack app** | Notification delivery, `/n409 status <company>`, and approve / request-changes directly from a Slack message. Zero Slack code in the repo. Add `slack` as a third notification channel next to email and in-app. | **M** |
| **Zapier / Make connector** | Once outbound webhooks and a stable token scope exist, a connector is mostly packaging — and it converts long-tail integration requests into self-service. | **S** (after webhooks) |
| **Client SDKs (TypeScript + Python)** | An API docs page exists (`ApiDocsPage.tsx`) but no SDK. Generate typed clients from the OpenAPI surface and publish them; partners integrate in an afternoon instead of a sprint. | **M** |
| **Deepen accounting sync** | QuickBooks/Xero/NetSuite connections exist (`routes/accounting.ts`). Move from pull-financials to two-way: push the ASC 718 expense journal entry, reconcile against the trial balance, flag drift. | **M** |
| **Broaden cap-table sync** | Carta and Pulley are wired (`routes/capTableSync.ts`). Add Shareworks, AngelList, Ledgy, Vestd (UK), plus a generic CSV/XLSX mapping wizard for firms not on any platform — the mapper covers the entire long tail with one build. | **M** |
| **E-signature provider integration** | Board approval uses in-house e-signatures (`routes/boardApproval.ts`). Optional DocuSign/Dropbox Sign routing for enterprises whose policy names a provider — a procurement blocker for larger accounts. | **M** |
| **Google Ads conversion upload** | `gclid` is captured and charted but never sent back to Ads. Uploading offline conversions is what makes paid acquisition optimizable rather than merely measurable. | **S** |
| **Calendar integration** | Push kickoff calls, board-approval deadlines, 83(b) deadlines and renewal dates to Google/Outlook calendars as ICS or via API. | **S** |

---

## 8. Marketing and growth

| Feature | What | Effort |
|---|---|---|
| **Instant-quote calculator** | A public widget: product kind + company stage + cap-table complexity → price and turnaround, with a one-click start that pre-fills the funnel. Pricing is already structured in `lib/marketing.ts`. Also embeddable on partner sites as a lead source. | **S** |
| **Referral program** | `referral` exists as an attribution tag only (`domain/valuation.ts:39`). Make it real: referral codes, tracked attribution, credit or payout, and a referrer dashboard. Accountants and VCs are the natural referrers and they already send this business by email. | **M** |
| **Blog / resource CMS** | Help articles are DB-backed with an admin editor (`routes/help.ts`) — extend the same tables to a public, SEO-indexed resource library. Compare and product landing pages already exist, so the SEO scaffolding is in place. | **S** |
| **Free 409A readiness assessment** | A gated self-check ("are you ready for a valuation, and what will it cost?") built on the intake questionnaire. Produces a lead and a pre-filled intake in one step. | **S** |
| **Public benchmarking report** | Publish the anonymized aggregate annually ("State of Startup Valuations"). Reuses §4's benchmarking work; the highest-leverage top-of-funnel asset a valuation firm can own. | **S** (after benchmarking) |
| **Partner white-label depth** | Branding fields exist (`0050_partner_white_label.sql`). Complete it: custom domain, report logo and color, sender identity, co-branded client portal — so accounting firms resell N409 under their own name. | **M** |
| **In-app trial / freemium tier** | A limited free tier (single draft valuation, watermarked report, no signature) to move self-serve founders from evaluation to purchase without a sales call. Signature gating already provides the natural paywall boundary. | **M** |
| **Lifecycle email campaigns** | Behavior-triggered sequences on the existing outbox: abandoned onboarding, upload stalled 3 days, valuation expiring in 60 days, post-delivery NPS. Infrastructure exists; the sequences don't. | **S** |
| **Customer-facing changelog + status page** | A public changelog (fed by release notes) and a status page for the five services. Cheap trust signal that matters disproportionately in a compliance purchase. | **S** |

---

## 9. Suggested sequencing

**Quarter 1 — cheap wins and the integration substrate.**
XLSX export · instant-quote calculator · command palette · saved views · @mentions ·
unassigned-email triage · board-ready summary · Google Ads conversions · then **outbound
webhooks**, which unblocks Slack, Zapier and partner work.

**Quarter 2 — revenue mechanics and differentiation.**
Annual renewal automation · deeper clone / roll-forward · Slack app · data-room Q&A ·
benchmarking (internal first, then the public report) · secondary-transaction approach.

**Quarter 3 — enterprise and expansion.**
Report template merging + richer editor · batch portfolio operations · auditor
collaboration · client SDKs · partner white-label depth · Monte-Carlo PWERM ·
multi-jurisdiction pack · i18n.

**Two caveats on the ranking.** First, it assumes the go-to-market motion stays
self-serve-plus-partner; if N409 moves upmarket to enterprise deals, the SSO/SCIM,
auditor-collaboration and white-label items outrank several of the top 12. Second,
benchmarking (§4) is the only item with a legal precondition — it needs a data-use
provision in the client terms and a k-anonymity floor before a single aggregate ships.
Everything else is purely an engineering call.
