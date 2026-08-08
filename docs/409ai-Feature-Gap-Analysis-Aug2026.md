# 409.ai vs N409 — Feature Gap Analysis

**Date:** August 8, 2026  
**Method:** Systematic page-by-page exploration of 409.ai (https://onboard.app.409.ai) via Chrome browser tools, compared against full N409 codebase analysis at `/Users/dev/projects/Products/N409`.

**Platforms compared:**
- **409.ai (legacy):** Ruby on Rails server-rendered admin dashboard, Version 0.10.1, "gandalf" computation engine
- **N409 (new):** Node.js/TypeScript (Fastify) + Python/FastAPI microservices, React 19 SPA, PostgreSQL + Redis

---

## 1. Features 409.ai Has That N409 Is Missing

These are features observed in the live 409.ai application that have no direct equivalent found in the N409 codebase.

### 1.1 Overwrites/Documentation Explorer (`/admin/overwrites_doc`)

409.ai provides a dedicated page to browse all "overwrites" — admin-editable field overrides grouped into 6 categories (Company Information: 7 fields, Financial Metrics: 17, Forecasts and Projections: 12, Valuation Parameters: 15, Market and Comparables: 16, Reporting and Filing: 1). Each field shows its Class, Min, Max, and Example value. The page supports Table/Card view toggle.

**N409 status:** No equivalent overwrites explorer UI was found. N409 has overrides/adjustments within individual valuation workspaces but lacks a centralized documentation view of all overridable fields with their constraints and examples. The engine-wrapper has `validate.py` for field validation but no user-facing catalog.

**Gap severity:** Medium. Useful for admin training and consistency but not a core workflow blocker.

### 1.2 Bot Prompts Management (`/admin/bot_prompts/{UUID}`)

409.ai has per-valuation bot prompt management with Perplexity and Perplexity-PRO as providers. Each valuation can have multiple bot prompts (industryOutlook, companyOverview, industryOverview, market_us) that can be created, edited, and deleted individually.

**N409 status:** N409 has an AI service (`src/services/ai/`) with 7 endpoints and uses OpenRouter, Amazon Bedrock, and Perplexity Sonar. However, there is no per-valuation bot prompt editor UI. AI prompts appear to be managed in code rather than through a UI. N409 has `prompt_templates` table but no visible admin UI for per-valuation prompt customization.

**Gap severity:** Medium. The ability to tweak prompts per-valuation is valuable for edge cases, but N409's more structured AI pipeline may compensate.

### 1.3 Granular Calculation Inspection (`/admin/calculations/{UUID}`)

409.ai exposes the gandalf engine's 5-step pipeline (aggregate → accounting → market → weights → render) with full JSON/RAW request and response for each step, plus an anomaly detection view (Income Statement Anomalies, Balance Sheet Anomalies) directly in the calculations tab.

**N409 status:** N409's engine-wrapper has more computation modules (30+) but the codebase shows calculation results stored in `engine_results` and `engine_runs` tables. The frontend has workspace tabs for various outputs, but no equivalent "raw request/response inspector" that shows the exact payload sent to and received from each engine step. N409 does have `anomalies.py` in the engine but the inspection UI granularity differs.

**Gap severity:** Medium-High. Essential for debugging calculation issues. N409 engineers currently need to check logs or database directly.

### 1.4 Network Items View (`/admin/ais/{UUID}` — Network Items tab)

409.ai shows "Network Items" — external API calls made during valuation (aggregate, render, accounting, market, weights from "ai" provider, plus stock ticker lookups from "ivolatility"). Each shows ID, Name, Provider, and raw Request/Response.

**N409 status:** N409 uses `market_data.py` and `market_feed.py` for market data and has `comparables.py` for comparable company data. However, there is no UI that shows all external network calls made during a valuation computation as a consolidated list with raw payloads.

**Gap severity:** Medium. Useful for debugging data sourcing issues.

### 1.5 "Recalculate" Granular Actions

409.ai's valuation detail sidebar offers 4 distinct recalculation triggers:
- Recalculate accounting
- Recalculate bot
- Recalculate report (stage)
- Recalculate report (prod)

**N409 status:** N409 has engine computation endpoints (`POST /engine/compute`, etc.) and report generation (`/report` service), but the granularity of recalculating individual pipeline stages (accounting only, bot only, stage vs prod report) was not found as distinct UI actions. N409 appears to recalculate the entire valuation or regenerate the full report.

**Gap severity:** Medium. Granular recalculation saves time when only one stage needs updating.

### 1.6 Inbox — Centralized Comment Stream (`/admin/inbox`)

409.ai has a dedicated Inbox page listing all valuation comments across the system (Thread, Body, User, Kind, Valuation) in a single view.

**N409 status:** N409 has per-valuation comments/activity and notifications, but no centralized "inbox" view that aggregates comments from all valuations into one feed. The frontend has notification components but not a dedicated inbox page.

**Gap severity:** Medium. Useful for admins managing many valuations simultaneously.

### 1.7 "Waiting on Client" Workflow State

409.ai has an explicit "Waiting on Client" state (tab in valuations list with count, plus a toggle button in the valuation detail sidebar).

**N409 status:** N409 has valuation states (draft, in_progress, review, etc.) tracked in the database, but "Waiting on Client" as a distinct filterable state was not found as a named workflow state. N409 may handle this through status or tags but it's not as prominently surfaced.

**Gap severity:** Low-Medium. Could be implemented as a status flag; the workflow concept exists but naming/filtering differs.

### 1.8 "Pending Files" Button

409.ai's valuation detail has a "Pending files" button in the top bar, suggesting a workflow for tracking which required documents haven't been uploaded yet.

**N409 status:** N409 has document/attachment management and a data completeness module (`data-completeness` workspace tab), which may serve a similar purpose but is framed differently. No explicit "pending files" action button was found.

**Gap severity:** Low. N409's data completeness feature likely subsumes this.

### 1.9 Valuation Versions (`Versions` sidebar item)

409.ai has a "Versions" item in the REPORT section of the valuation sidebar, implying version history tracking of reports.

**N409 status:** N409 has `report_versions` and version tracking in the database, so the backend likely supports this. However, the specific UI for browsing versions needs verification.

**Gap severity:** Low. Backend likely exists; may be a frontend exposure gap only.

### 1.10 "Overwrites & Edits" Report View

409.ai has an "Overwrites & Edits" item in the REPORT section, showing which fields were manually overridden and edited for a given valuation report.

**N409 status:** N409 has audit logging and tracks changes, but a dedicated "here's everything that was overridden" summary view for a specific valuation report was not identified as a distinct page.

**Gap severity:** Medium. Important for audit trail and reviewer transparency.

### 1.11 Team Support Section

409.ai's valuation sidebar has a "Team Support" item under the DATA section.

**N409 status:** No equivalent found. N409 has assignment and reviewer workflows but not a "Team Support" specific feature.

**Gap severity:** Low. Unclear what this does in 409.ai without deeper exploration.

### 1.12 Auto Emails with SMS Channel (`/admin/auto_emails`)

409.ai supports both Email (21) and SMS (6) auto-send channels, with a promotional flag toggle.

**N409 status:** N409 has email notifications and templates (notification service endpoints, email templates), but SMS as a notification channel was not found in the codebase. No Twilio or SMS provider integration was identified.

**Gap severity:** Low-Medium. SMS reminders can improve client response rates but are not core to valuation workflow.

### 1.13 iVolatility Integration for Stock Tickers

409.ai's Network Items show data sourced from "ivolatility" provider for stock ticker lookups.

**N409 status:** N409 has `market_data.py` and `market_feed.py` but the specific data providers used are configured differently. Need to verify if iVolatility is among them or if N409 uses alternative volatility data sources.

**Gap severity:** Low. N409 likely uses equivalent or better market data sources; this is a provider-level detail.

---

## 2. Features N409 Has That 409.ai Doesn't

N409 is significantly more feature-rich. The following are major capabilities with no equivalent in the 409.ai application.

### 2.1 Additional Valuation Types (8 extra)

| Valuation Type | N409 | 409.ai |
|---|---|---|
| 409A | ✅ | ✅ |
| FMV | ✅ | ✅ |
| 718 (ASC 718) | ✅ | ✅ |
| Gifts/Estate | ✅ | ✅ |
| IFRS2 | ✅ | ✅ |
| IP | ✅ | ✅ |
| NAV | ✅ (as Fund) | ✅ |
| **820 (ASC 820 Fair Value)** | ✅ | ❌ |
| **QSBS** | ✅ | ❌ |
| **CSOP** | ✅ | ❌ |
| **EMI** | ✅ | ❌ |
| **PPA (Purchase Price Allocation)** | ✅ | ❌ |
| **Goodwill (Impairment)** | ✅ | ❌ |
| **ESOP** | ✅ | ❌ |
| **Debt Instruments** | ✅ | ❌ |

N409 supports 15 valuation types vs 409.ai's 7.

### 2.2 Advanced Allocation Methods

N409 engine modules include:
- **PWERM** (Probability-Weighted Expected Return Method) — `pwerm.py`
- **Current Value Method (CVM)** — `current_value.py`
- **Hybrid Method** — `hybrid.py`
- **Waterfall analysis** — `waterfall.py`
- **Black-Scholes / OPM** — `bs.py`
- **Newton's method solver** — `newton.py`

409.ai uses OPM and basic approaches but doesn't expose PWERM, CVM, or Hybrid as distinct methods.

### 2.3 Sensitivity Analysis

N409 has `sensitivity.py` in the engine and `sensitivity.ts` in the domain layer, plus a dedicated frontend workspace tab. This allows running valuations across ranges of key assumptions.

409.ai has no equivalent.

### 2.4 Scenarios / What-If Analysis

N409 has scenario modeling capabilities allowing multiple assumption sets to be compared side-by-side.

409.ai has no equivalent.

### 2.5 Value Bridge Analysis

N409 has `valuationBridge.ts` in the domain layer, providing period-over-period value bridge decomposition showing what drove changes in valuation between periods.

409.ai has no equivalent.

### 2.6 Board Approval & E-Signatures

N409 has board approval workflows and electronic signature capabilities for finalizing valuations.

409.ai has no equivalent — publishing appears to be an admin-only action without formal board approval workflow.

### 2.7 Auditor Portal

N409 has a dedicated auditor portal allowing external auditors to review valuations with appropriate access controls.

409.ai has no equivalent. Auditors would need admin access.

### 2.8 SAML SSO, SCIM Provisioning, and MFA

N409 supports enterprise authentication:
- SAML SSO integration
- SCIM 2.0 automated user provisioning
- Multi-factor authentication (MFA/2FA)

409.ai has basic email/password auth with role-based access but no SSO, SCIM, or MFA.

### 2.9 Client Intake Wizard & Onboarding Flow

N409 has a multi-step client intake wizard and guided onboarding flow for new clients.

409.ai's client-facing flow is minimal — the admin manually manages valuations.

### 2.10 Engagement Pipeline

N409 has engagement management — tracking valuations from initial client inquiry through scoping, pricing, and delivery — like a CRM for valuation engagements.

409.ai has no pipeline concept; valuations appear as flat list items.

### 2.11 QA Checks & Health Checks

N409 has:
- `qaChecks.ts` — automated quality assurance checks on valuation outputs
- `healthChecks.ts` — system health monitoring
- `publishGate.ts` — pre-publish validation gate

409.ai has anomaly detection in calculations but no formal QA gate before publishing.

### 2.12 Post-Valuation Monitoring

N409 has `monitoring.ts` for ongoing post-valuation monitoring, tracking whether assumptions still hold after the valuation date.

409.ai has no equivalent.

### 2.13 Fund Portfolio Management (ASC 820)

N409 has `fund_valuation.py` and dedicated fund portfolio management for investment funds requiring ASC 820 fair value measurements across multiple holdings.

409.ai has NAV but not full portfolio-level fund management.

### 2.14 Debt Instrument Valuation

N409 has `debt_valuation.py` for valuing debt instruments (convertible notes, term loans, etc.).

409.ai has no debt valuation capability.

### 2.15 Intangible Asset Valuation

N409 has `intangibles.py` for valuing intangible assets (customer relationships, technology, trade names) typically needed in purchase price allocations.

409.ai has IP valuation but not the broader intangibles framework.

### 2.16 Impairment Testing

N409 has `impairment.py` for goodwill and asset impairment testing under ASC 350/360.

409.ai has no equivalent.

### 2.17 WACC Computation

N409 has `wacc.py` — a dedicated weighted average cost of capital computation module.

409.ai uses discount rates but doesn't expose a standalone WACC calculator.

### 2.18 Projection / Forecasting Module

N409 has `projection.py` for financial projections and forecast modeling.

409.ai captures forecasts as input data but doesn't have a projection engine.

### 2.19 Roll-Forward Engine

N409 has `rollforward.py` — a dedicated module for rolling forward prior valuations to new dates.

409.ai has a "Rolling Forward" checkbox in params but the computation appears simpler.

### 2.20 Payment & Billing (Stripe Integration)

N409 has Stripe-based payment processing with:
- Pricing calculator
- Payment plans
- Invoice management
- Billing endpoints

409.ai tracks Paid?/Payment amount/Paid at but payment processing appears external.

### 2.21 Marketing & Public Pages

N409 has full marketing infrastructure:
- Landing pages, product pages
- Pricing page with calculator
- Blog / Help center CMS
- Product comparison pages
- SEO-optimized public routes

409.ai is admin-only with no public-facing pages.

### 2.22 Real-Time Collaboration (SSE)

N409 has Server-Sent Events for real-time presence, showing who else is viewing/editing a valuation.

409.ai has no real-time collaboration features.

### 2.23 Command Palette

N409 has a command palette (Cmd+K style) for quick navigation and actions.

409.ai has no equivalent.

### 2.24 Saved Views

N409 allows users to save custom filter/sort configurations as named views.

409.ai has fixed tabs with predefined filters only.

### 2.25 Data Retention & Legal Holds

N409 has data retention policies and legal hold capabilities for compliance.

409.ai has no equivalent.

### 2.26 White-Label / Branding

N409 supports white-label branding for partners beyond simple subdomain mapping.

409.ai has Partner with subdomain but limited branding customization.

### 2.27 HRIS & Accounting Connections

N409 has integrations for connecting to HR information systems and accounting platforms.

409.ai has no equivalent integrations.

### 2.28 Comprehensive Comparables Module

N409 has `comparables.py` in the engine and `comparables.ts` in the domain layer with dedicated frontend workspace tabs for comparable company selection, filtering, and analysis.

409.ai has market approach with comparable data but less structured management.

### 2.29 SMB-Specific Valuation

N409 has `smb.py` — dedicated small/medium business valuation logic with potentially different approaches suited for smaller companies.

409.ai has no SMB-specific module.

### 2.30 ASC 718 Public Company Module

N409 has `asc718Public.ts` — a separate module for public company stock compensation valuations, distinct from private company 718.

409.ai handles 718 as a single type without public/private distinction.

---

## 3. Backend Engine Gaps

### 3.1 Computation Architecture

| Aspect | 409.ai (gandalf) | N409 (engine-wrapper) |
|---|---|---|
| Language | Unknown (called via network) | Python / FastAPI |
| Pipeline steps | 5 (aggregate, accounting, market, weights, render) | 30+ modules, composable |
| Endpoints | ~5 network calls per valuation | 31 endpoints |
| Allocation methods | OPM, basic approaches | OPM, PWERM, CVM, Hybrid, Waterfall |
| Market data | iVolatility | market_data.py, market_feed.py |
| Anomaly detection | Income/Balance Sheet anomalies | anomalies.py + validate.py |
| DLOM models | Qualitative, Chaffee, Finnerty | dlom.py (same + potentially more) |

### 3.2 Modules N409 Has With No 409.ai Equivalent

| N409 Module | Purpose |
|---|---|
| `sensitivity.py` | Multi-variable sensitivity analysis |
| `pwerm.py` | Probability-weighted expected return |
| `current_value.py` | Current value method allocation |
| `hybrid.py` | Hybrid allocation method |
| `waterfall.py` | Equity waterfall distribution |
| `newton.py` | Numerical solver for implied values |
| `wacc.py` | Weighted average cost of capital |
| `projection.py` | Financial projection modeling |
| `rollforward.py` | Valuation roll-forward engine |
| `debt_valuation.py` | Debt instrument valuation |
| `fund_valuation.py` | Fund portfolio (ASC 820) |
| `intangibles.py` | Intangible asset valuation |
| `impairment.py` | Goodwill/asset impairment testing |
| `esop.py` | Employee stock ownership plans |
| `emi_csop.py` | UK EMI/CSOP schemes |
| `fair_value_820.py` | ASC 820 fair value measurement |
| `gift_estate.py` | Gift/estate tax valuation |
| `qsbs.py` | Qualified small business stock |
| `smb.py` | Small/medium business valuation |

### 3.3 API Scale

- **409.ai:** Rails CRUD — estimated ~50-80 endpoints based on standard Rails resource routing
- **N409:** 445 endpoints across 85 route files in the valuation service alone, plus 31 engine-wrapper endpoints, 7 AI endpoints, and 1 report endpoint = **484 total**

### 3.4 Database Scale

- **409.ai:** Unknown exact count, Rails migrations likely ~30-50 tables
- **N409:** 92 database tables across 124 migration files

---

## 4. UI/UX Differences

### 4.1 Architecture

| Aspect | 409.ai | N409 |
|---|---|---|
| Rendering | Server-rendered (Rails ERB/partials) | Client-side SPA (React 19) |
| Routing | Full page reloads | Client-side routing (React Router v7) |
| Styling | Bootstrap-style | Tailwind CSS v4 |
| Build tool | Rails asset pipeline | Vite 7 |
| Responsiveness | Basic responsive | Modern responsive SPA |

### 4.2 Navigation

| Aspect | 409.ai | N409 |
|---|---|---|
| Primary nav | Left sidebar, always visible | Left sidebar + command palette |
| Valuation nav | Left sidebar with DATA/REPORT/SETTINGS sections | Tabbed workspace with 30+ tabs |
| Search | Per-page filter fields | Global search + per-page filters + saved views |
| Quick actions | Sidebar buttons | Command palette (Cmd+K) |

### 4.3 Valuation Workspace

409.ai uses a left-sidebar navigation with ~10 items grouped under DATA, REPORT, and SETTINGS. Each item loads a new page.

N409 uses a tabbed workspace with 30+ tabs organized by function. The user stays in one workspace and switches between tabs. Known N409 workspace tabs include: overview, cap-table, financials, approaches, allocation, dlom, sensitivity, scenarios, comparables, market-data, documents, activity, qa-checks, data-completeness, report-preview, and many more per valuation type.

### 4.4 Data Entry

| Aspect | 409.ai | N409 |
|---|---|---|
| Params editing | Single long form page with Save button | Structured workspace tabs per section |
| Cap table | Simple table (Stakeholder/Options/Rights) | Rich cap table editor with more fields |
| Financials | Basic tabular display | Structured financial data entry with validation |
| Inline editing | Limited | Extensive inline editing throughout |

### 4.5 Collaboration

| Aspect | 409.ai | N409 |
|---|---|---|
| Chat | Email-threaded, in-page chat tab | Per-valuation activity/comments |
| Notifications | "Notify client" checkbox on chat | Structured notification system |
| Real-time | None | SSE-based presence indicators |
| Assignments | "Reassign To" dropdown | Assignment workflows with reviewer roles |

### 4.6 Reporting

| Aspect | 409.ai | N409 |
|---|---|---|
| Report generation | Recalculate report (stage/prod) | Dedicated report service |
| Report versions | Versions sidebar item | Report version tracking |
| Overwrites view | Dedicated "Overwrites & Edits" page | Audit trail (different framing) |
| Final report | "Final Report" sidebar item | Report preview tab + PDF generation |

### 4.7 Admin/Settings

| Aspect | 409.ai | N409 |
|---|---|---|
| User roles | 16 role types | Role-based with SAML/SCIM |
| API tokens | Simple 4-column table | API key management |
| Prompts | Perplexity-focused prompt editor | AI prompt templates (code-managed) |
| Email templates | Category-organized template list | Notification templates |
| Partners | Basic partner config | White-label partner management |

---

## 5. Priority Ranking of Missing Features

Features 409.ai has that N409 should consider adding, ranked by impact.

### Priority 1 — High (Address Soon)

| # | Feature | Rationale |
|---|---|---|
| 1 | **Calculation step inspector** | Essential for debugging engine outputs. Without this, engineers must query the database or parse logs to understand why a valuation produced specific numbers. |
| 2 | **Overwrites & Edits audit view** | Reviewers and auditors need to see exactly what was manually overridden. Critical for compliance and quality control. |
| 3 | **Granular recalculation triggers** | Recalculating only the accounting step or only the report saves significant time during iterative review. Full recalculation is wasteful for targeted fixes. |
| 4 | **Centralized comment inbox** | Admins managing 50+ active valuations need a single view of all unread comments. Currently requires checking each valuation individually. |

### Priority 2 — Medium (Plan for Next Quarter)

| # | Feature | Rationale |
|---|---|---|
| 5 | **Per-valuation bot prompt editor** | Edge cases require prompt customization. Code-managed prompts don't allow per-valuation tuning without deployments. |
| 6 | **Network items / external call log** | Useful for debugging market data issues and understanding which external APIs were consulted for a given valuation. |
| 7 | **"Waiting on Client" workflow state** | Explicit client-blocking state helps teams prioritize work and track bottlenecks. |
| 8 | **Overwrites documentation explorer** | Self-service reference for which fields can be overridden and their valid ranges reduces support burden. |
| 9 | **SMS notification channel** | Some clients respond faster to SMS than email, especially for time-sensitive items. |

### Priority 3 — Low (Nice to Have)

| # | Feature | Rationale |
|---|---|---|
| 10 | **Pending files tracker** | N409's data completeness module likely covers this; verify and close the gap if not. |
| 11 | **Team Support section** | Unclear functionality in 409.ai; assess whether N409's assignment system covers the same need. |
| 12 | **Report versions UI** | Backend likely exists in N409; verify frontend exposure. |
| 13 | **iVolatility-specific integration** | Verify N409's market data providers cover the same data; only add if there's a coverage gap. |

---

## Summary Statistics

| Metric | 409.ai | N409 |
|---|---|---|
| Valuation types | 7 | 15 |
| Engine modules | 5 pipeline steps | 30+ modules |
| API endpoints | ~50-80 (est.) | 484 |
| Database tables | ~30-50 (est.) | 92 |
| Frontend pages | ~15 admin pages | 45+ pages + 30 workspace tabs |
| User roles | 16 types | RBAC + SAML/SCIM |
| AI providers | Perplexity, Anthropic | OpenRouter, Bedrock, Perplexity Sonar |
| Auth methods | Email/password | Email/password + Google SSO + SAML + MFA |
| Real-time features | None | SSE presence |
| Payment integration | External | Stripe |

**Bottom line:** N409 is a substantially more capable platform than 409.ai across every dimension — more valuation types, more computation methods, more API surface area, more enterprise features, and a modern SPA architecture. The gaps from 409.ai are primarily around admin tooling for debugging and inspecting engine internals (calculation step inspector, network call logs, overwrites documentation) and a few workflow conveniences (centralized inbox, granular recalculation, waiting-on-client state). These are important for operational efficiency but represent a small fraction of the overall feature surface.
