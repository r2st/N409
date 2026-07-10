# 409.ai — Comprehensive Feature Documentation

> **Source:** Live exploration of the admin back-office at `https://onboard.app.409.ai`
> (version **0.10.1**) and client-facing onboarding flow, logged in as an admin user.
> This document covers **every page, feature, UI element, workflow, and integration**
> observed in the live production system.
>
> **Date of exploration:** July 2026
>
> **Purpose:** Detailed enough that someone could rebuild the entire platform from this
> document alone.

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Information Architecture & Navigation](#2-information-architecture--navigation)
3. [Authentication & Client Onboarding](#3-authentication--client-onboarding)
4. [Dashboard](#4-dashboard)
5. [Valuations List & Scoped Views](#5-valuations-list--scoped-views)
6. [Valuation Detail — The Core Object](#6-valuation-detail--the-core-object)
7. [Valuation Sub-Pages: REPORT Section](#7-valuation-sub-pages-report-section)
8. [Valuation Sub-Pages: DATA Section](#8-valuation-sub-pages-data-section)
9. [Valuation Sub-Pages: ANALYSIS Section](#9-valuation-sub-pages-analysis-section)
10. [AI Layer](#10-ai-layer)
11. [Reviews & Task Management](#11-reviews--task-management)
12. [Inbox & Email Ingestion](#12-inbox--email-ingestion)
13. [Sensitivity Dashboard](#13-sensitivity-dashboard)
14. [Partner Channel](#14-partner-channel)
15. [Settings & Administration](#15-settings--administration)
16. [Communication System](#16-communication-system)
17. [Documentation & Explorer Tools](#17-documentation--explorer-tools)
18. [Architecture & Technology Stack](#18-architecture--technology-stack)
19. [Data Model (as observable from UI)](#19-data-model-as-observable-from-ui)
20. [User Flows](#20-user-flows)
21. [Unique & Differentiating Features](#21-unique--differentiating-features)
22. [Public-Facing Website (www.409.ai)](#22-public-facing-website-www409ai)
23. [Accounting Software Integrations](#23-accounting-software-integrations)

---

## 1. Product Overview

### What 409.ai Is

**409.ai** is an **AI-assisted valuation platform** for a valuation firm that produces
independent, defensible business valuations. The core product is **IRC §409A common-stock
valuations** for venture-backed private companies, with a family of adjacent valuation products.

The platform combines five major subsystems:

1. **Client Onboarding Funnel** (`onboard.app.409.ai`) — Founders/companies request a valuation, sign up, pay, and upload financial documents.
2. **AI Ingestion & Extraction Layer** — Reads uploaded documents (cap tables, income statements, balance sheets, decks, projections) and auto-populates valuation inputs, selects public comparables, and drafts narrative sections.
3. **Quantitative Valuation Engine** — An R package exposed as a REST microservice that runs the finance math: Option Pricing Model (Black-Scholes backsolve), income/market/asset approaches, DLOM/DLOC discounts, roll-forwards, and sensitivity analysis.
4. **Analyst/Reviewer Back-Office** — The admin app where a large ops team reviews, overrides, drafts, reviews, signs, and publishes the final valuation report.
5. **Partner Channel** — Accounting firms, cap-table platforms, and equity-management providers submit valuations on behalf of their customers via API and a partner-scoped view.

### Valuation Product Lines (`kind`)

| Kind | Full Name | Description |
|------|-----------|-------------|
| `409a` | IRC §409A | Common-stock fair market value (core product) |
| `fmv` | Fair Market Value | General FMV valuations |
| `718` | ASC 718 | Stock-based compensation expense |
| `820` | ASC 820 | Fair-value measurement |
| `gifts` | Gift/Estate | Gift and estate-tax valuations |
| `qsbs` | QSBS | Qualified Small Business Stock attestation |
| `csop` | CSOP | UK Company Share Option Plan valuation |
| `emi` | EMI | UK Enterprise Management Incentive valuation |
| `ifrs2` | IFRS 2 | International share-based payment |
| `ppa` | PPA | Purchase Price Allocation |
| `goodwill` | Goodwill | Goodwill impairment testing |
| `esop` | ESOP | Employee Stock Ownership Plan |
| `ip` | IP | Intellectual-property valuation |
| `smb` | SMB | Small/Medium Business valuation (general FMV for loans, sales, partners) |
| `portfolio` | Portfolio | Investment fund portfolio/holdings valuation |
| `nav` | NAV | Net Asset Value valuation |

> **Note:** The public website also lists "Impairment Testing Valuation" as a product, which maps to the `goodwill` kind internally. The `fmv` kind may map to the public-facing "SMB Valuation" branding.

Each valuation instance carries a **versioned template** tag (e.g., `409a.v0` through `409a.v53`, `gifts.v37`). The version increments as the report/template is regenerated or revised.

### Service Countries

The platform supports multi-jurisdiction valuations for: US, UK, CA (Canada), AU (Australia), SG (Singapore), and potentially more via the `service_countries[]` field.

### Marketing Taglines (from sign-up page & landing page)

- "Get your valuation range in real-time."
- "Expert reviewed report in 24 hours."
- Page title: "Valuation Services | 409A, SMB, ASC 718, ASC 820, EMI, CSOP & More"
- Landing page hero: "Easier [rotating: 409A / ASC 820 / Gift & Estate Taxes / ...] Valuations"
- Landing page subtext: "Get your expert-reviewed and audit-defensible valuation in as quick as 24 hours, starting at only $899."
- CTA: "Start Valuation" / "Start My Valuation" / "Start My Valuation!"
- Trust badges: "No Credit Card Required" · "No Commitment"
- Value props (animated counters): "2X FASTER" · "67% CHEAPER" · "21 Day DELIVERY*"

---

## 2. Information Architecture & Navigation

### Global Navigation Sidebar (Admin)

The left sidebar is the primary navigation, organized into these sections:

**TOP-LEVEL PAGES:**
| Nav Item | Route | Badge/Count | Description |
|----------|-------|-------------|-------------|
| Dashboard | `/admin/dashboard` | — | Ops overview with stage pivot |
| Documentation | `/admin/overwrites_doc` | — | Overwrites schema browser |
| Package Explorer | `/admin/package_explorer_doc` | — | R engine dependency graph |
| Inbox | `/admin/inbox` | `1` | Email ingestion center |
| Sensitivity Dashboard | `/admin/investor` | — | OPM stress-test tables |

**VALUATIONS SECTION:**
| Nav Item | Route | Badge/Count | Description |
|----------|-------|-------------|-------------|
| Valuations | `/admin/valuations` | `890 / 1 unread` | Main worklist |
| Incomplete | `/admin/valuations?scope=incomplete` | `325` | Incomplete valuations |
| Unverified | `/admin/valuations?scope=unverified` | `3` | Unverified valuations |
| In Progress | `/admin/valuations?scope=in_progress` | `12 / 1 unread` | Active valuations |
| Waiting On... | `/admin/valuations?scope=waiting` | `14 / 1 unread` | Waiting on client |
| Drafted | `/admin/valuations?scope=drafted` | `37` | Draft complete |
| Published | `/admin/valuations?scope=published` | `0` | Published/delivered |
| Reviews | `/admin/reviews` | — | Task management |
| Partner Valuation | `/admin/partner_valuations` | — | Partner-scoped list |

**SETTINGS SECTION:**
| Nav Item | Route | Badge/Count | Description |
|----------|-------|-------------|-------------|
| Users | `/admin/users` | — | User/role management |
| API Tokens | `/admin/api_tokens` | — | Partner API credentials |
| Prompts | `/admin/prompts` | — | AI prompt registry |
| Templates | `/admin/communication_templates` | — | Email/SMS templates |
| Auto Emails | `/admin/auto_emails` | — | Automated drip campaigns |
| Partners | `/admin/partners` | — | Partner management |

### Global Header Bar

- **409.ai logo** (origami crane icon) — top-left
- **Unread email badge** — e.g., "1 unread" (green)
- **Unassigned emails badge** — e.g., "1 unassigned emails" (yellow)
- **User dropdown** — "Akshay Arora ▼" with profile/logout
- **Search icon** (magnifying glass) — global search

### Per-Valuation Sidebar Navigation

When viewing a specific valuation, the sidebar adds per-valuation sub-page navigation:

**REPORT section:**
| Sub-page | Badge | Description |
|----------|-------|-------------|
| Calculations | `0/5` + refresh (↻) | Engine computation results |
| Report Editor | `#1766.v0` | WYSIWYG report editor |
| Report PDF | — | PDF render/download |
| Overwrites & Edits | `0` | Manual overrides |
| Versions | — | Report version history |

**DATA section:**
| Sub-page | Badge | Description |
|----------|-------|-------------|
| Details | `#1766.v0 (409a)` | Meta-editor (all valuation fields) |
| Valuation Workbook | — | Working spreadsheet/model |
| Valuation Params | — | Finance methodology inputs |
| Ai / Attachments | — | Document uploads + AI pipelines |
| Bot Prompts | `0` | Per-valuation AI prompt state |
| Amount Raised | `0` | Funding round history |
| Transaction History | `0` | Securities transactions |
| Network Items | `0` | Extracted comparable companies / market data |
| Captables | `0` | Cap table data management |
| Projections | `0` | Financial projections |
| Historical Data | `0` | Historical financial data |
| Finances | `0` | Financial statements |
| Chat | `0 unread` | Per-valuation chat (also accessible from top bar) |
| Journals | `0` | Audit/change journals |
| Team Support | `0` | Internal team support notes |

> **Note:** Network Items also appears as Tab 3 of the AI/Attachments page. Chat appears both in the per-valuation sidebar and in the top action bar. All DATA-section sub-pages display a badge count. The previous documentation listed Captables through Team Support under a separate "ANALYSIS section," but in the current UI they appear as continuation items in the DATA section sidebar without a separate section header.

### Per-Valuation Action Bar (Top)

- **My tasks** — badge with count (e.g., `0`)
- **All tasks** — badge with count (e.g., `1`)
- **Chat** — badge with count (e.g., `Chat 1`)
- **Toggle actions sidebar** — show/hide right sidebar

### Per-Valuation Right Sidebar (Actions)

- **Waiting on client** checkbox
- **Sticky notes** textarea (with "Last note: N/A" indicator)
- **Save Note** button (green)
- **New Comment** button
- **Notes & Comments** section (expandable, green indicator dot)
- **Reassign To** button (yellow)
- **Clone Valuation** button (yellow)
- **Recalculate accounting** button (peach/orange)
- **Recalculate bot** button (peach/orange)
- **Recalculate report (stage)** button (blue-gray)
- **Recalculate report (prod)** button (blue-gray)

---

## 3. Authentication & Client Onboarding

### Sign-Up Page (`/sign_up`)

**Layout:** Split-screen with dark green/black gradient background.

**Left panel:**
- 409.ai logo (origami crane, green)
- Heading: "SMB Valuation" (green underlined) *(previously "409A Valuation"; changed to broader branding)*
- Subtext: "Get your valuation range in real-time. Expert reviewed report in 24 hours."

**Right panel — Sign Up form:**
- **Tab switcher:** Sign In | Sign Up (Sign Up highlighted in green)
- **Fields:**
  - First Name (text input)
  - Last Name (text input)
  - Work E-Mail (placeholder: `you@company.com`)
  - Password (with "Show" toggle)
  - Phone (with country-code selector, US flag default, placeholder: `(XXX) XXX-XXXX`)
- **Sign Up** button (green/yellow, full-width)
- **Divider:** "or"
- **Sign up with Google** button (Google G icon, outlined)
- **Link:** "Already have an account? Log in here"

**External elements:**
- **Intercom** chat bubble (bottom-left corner)

### Sign-In Page (`/sign_in`)

**Left panel:**
- Heading: "SMB Valuation" (green underlined) *(previously "409A Valuation")*
- Subtext: "Login to complete or view your valuation."

**Right panel — Sign In form:**
- **Tab switcher:** Sign In (highlighted) | Sign Up
- **Fields:**
  - Business E-Mail (placeholder: `you@company.com`)
  - Password (with "Show" toggle and "Reset it here" link)
- **Sign In** button (green/yellow)
- **Divider:** "or"
- **Sign in with Google** button
- **Link:** "Don't have an account yet? Sign Up"

### Authentication Methods

1. **Email/Password** — Standard signup with email verification (`verified` flag on users)
2. **Google OAuth SSO** — "Sign in/up with Google" button; users with SSO show `sso: google` in admin

### Password Reset

- Available via "Reset it here" link on the sign-in page

---

## 4. Dashboard

**Route:** `/admin/dashboard`

### Overview

The ops dashboard provides a bird's-eye view of all valuations across product lines and lifecycle stages.

### Valuation Stage Pivot Table

A matrix showing counts of valuations by **product line** (rows) vs **lifecycle stage** (columns):

| Product | Pending | Incomplete | Reviewed | Drafted | Published | Total |
|---------|---------|------------|----------|---------|-----------|-------|
| 409a | — | — | — | — | — | 862 |
| 718 | — | — | — | — | — | 8 |
| Gifts | — | — | — | — | — | 12 |
| Nav | — | — | — | — | — | 1 |
| **All** | — | — | — | — | — | **883** |

(Exact per-cell counts vary; the All row shows the total.)

### Stage Pie Chart

A **Chart.js** pie chart visualizing the distribution of valuations across lifecycle stages. Color-coded by stage.

### Date Range Filters

- **Started at** — date range picker (from/to)
- **Published at** — date range picker (from/to)

---

## 5. Valuations List & Scoped Views

**Route:** `/admin/valuations`

### List Layout

The main operational worklist with a three-column layout:

1. **Filter sidebar** (left)
2. **Valuation list** (center) — sortable table with row-level badges
3. **Bulk actions sidebar** (right, toggleable)

### Tabbed Scopes (with live counts)

Each scope is a first-class nav item with its own filtered view:

| Scope | Count | Description |
|-------|-------|-------------|
| All Valuations | 890 | All valuations in system |
| Incomplete | 325 | Not yet finished by client |
| Unverified | 3 | Need data verification |
| In Progress | 12 | Being actively worked on |
| Waiting On Client | 14 | Blocked on client response |
| Drafted | 36 | Draft report complete |
| Published | 543 | Delivered to client |
| Unread | 1 | Valuations with unread messages |
| Waiting On Client | 14 | Blocked on client response |
| Ignored | 319 | Marked as ignored/inactive |

> **Note:** The "Unread" and "Ignored" scopes appear as horizontal filter tabs on the Valuations list page, in addition to the sidebar navigation counts. These two scopes were not previously documented.

### Filter Sidebar

**Searchable/filterable fields:**

| Filter | Type | Description |
|--------|------|-------------|
| Kind | Dropdown | Product type (409a, 718, gifts, etc.) |
| State | Dropdown | Lifecycle state |
| ID | Text | Valuation number |
| UUID | Text | ULID identifier |
| Workflow ID | Text | Orchestration engine ID |
| Reviewer | Dropdown | Assigned reviewer |
| Partner | Dropdown | Submitting partner |
| Source | Dropdown | Attribution source |
| Company | Text | Company name search |
| Email | Text | Client email search |
| First Name | Text | Client first name |
| Last Name | Text | Client last name |
| Started At | Date range | When valuation started |
| Published At | Date range | When published |

### List Columns

| Column | Description |
|--------|-------------|
| Checkbox | Multi-select for bulk actions |
| # | Valuation number (e.g., #1766) |
| Company | Company name |
| Kind | Product type badge |
| State | Lifecycle state badge |
| Assigned | Reviewer name |
| Messages | Count + unread indicator |
| Created | Creation timestamp |

### Row-Level Badges & Indicators

Each valuation row can display:
- **Payment status** badge (Paid / Unpaid / Paid-by-partner)
- **Partner** badge (if submitted via partner)
- **Reapplication** indicator
- **Waiting on client** indicator
- **Dashboard upload** indicator
- **Unread** indicator (green dot)

### Actions

- **New Valuation** button — creates a new valuation
- **Download CSV** — exports the current filtered view
- **Bulk select** — checkboxes with a bulk actions sidebar
- **Quick actions per row:** Company Overview, Uploads, Summary

### Sorting

Multi-column sort capability across all list columns.

---

## 6. Valuation Detail — The Core Object

**Route:** `/admin/meta_editor/:uuid` (redirected from `/admin/valuations/:uuid`)

### Identity & Routing

- **Sequential number** for humans: `#1766`
- **ULID** for URLs: `01KWVHK7A0EMYXFSTQHSV2YTDR`
- **Workflow ID** for the orchestration engine
- **UUID** for internal references

### Lifecycle State Machine

```
pending → started → onboarding_completed → user_finished → completed
        → (paid) → review → reviewed → drafted → draft_accepted
                                              ↘ draft_changes ↗
        → published
   side states: timeout, cancelled, ignored
   flag: waiting_on_client (overlay on any state)
```

### Meta-Editor Fields (Details Page)

The Details page is the comprehensive field editor for a valuation:

**Company Information:**
| Field | Type | Example |
|-------|------|---------|
| Company name | Text input | "Vivosens Inc." |
| Company profile | Modal/popup editor | `modal_ui_data` |
| Partner | Dropdown select | (blank) |
| Service name | Text input | — |
| State | Dropdown select | started |
| Source | Dropdown select | -- NONE -- |
| Kind | Dropdown select | 409a |
| QSBS Attestation | Checkbox | unchecked |

**Requester/User Information:**
| Field | Type | Example |
|-------|------|---------|
| User name | Link | "George Radman" (clickable) |
| Email | Text | george@vivoo.io |
| Phone | Text | — |
| Verified | Status | — |

**Commercial Fields:**
| Field | Type | Description |
|-------|------|-------------|
| Paid? | Status | Unpaid / Paid / Paid-by-partner |
| Amount | Currency | e.g., $899, $809, $1,200 |
| Custom payment amount | Currency input | Override amount |
| Paid at | Timestamp | Payment timestamp |
| Delivery days | Number | SLA in days |
| Amount raised | Currency | Total funding raised |

**Attribution:**
| Field | Type | Description |
|-------|------|-------------|
| Source | Dropdown | Partner / Referral / Ads / Repeat |
| Partner | Reference | Submitting partner |
| GCLID | Text | Google Ads click ID |

**Lifecycle Timestamps:**
| Field | Description |
|-------|-------------|
| Created at | Initial creation |
| Started at | When work began |
| User finished at | Client completed onboarding |
| Due date | SLA deadline |
| Completed at | Data complete |
| Drafted at | Draft report done |
| Draft accepted at | Client accepted draft |
| Published at | Final delivery |
| Admin read at | Last admin read |
| User read at | Last client read |
| Last comment at | Latest comment |

### Top Action Buttons

- **Save Valuation** (green) — persists all field changes
- **Restart Workflow** (blue) — re-kicks the orchestration engine

### Company Profile Modal

Accessible via the blue info (ℹ) button next to the company name. Opens a modal with editable company profile data (`modal_ui_data`). An adjacent yellow edit (✏) button provides alternative editing.

---

## 7. Valuation Sub-Pages: REPORT Section

### 7.1 Calculations (`/admin/calculations/:uuid`)

**Purpose:** Shows the output of the R valuation engine computation.

**Layout:**
- Title: "Editing Valuation Calculation"
- Subtitle: "#1766 uuid: 01KWVHK7A0EMYXFSTQHSV2YTDR"
- Progress badge in sidebar: `0/5` (number of completed calculations out of total)
- Refresh (↻) icon to trigger recalculation

**Calculation triggers (from right sidebar):**
1. **Recalculate accounting** — recompute accounting-level values
2. **Recalculate bot** — recompute AI-derived values
3. **Recalculate report (stage)** — recompute for staging environment
4. **Recalculate report (prod)** — recompute for production

### 7.2 Report Editor (`/admin/editor/:uuid/edit`)

**Purpose:** WYSIWYG rich-text editor for composing the deliverable valuation report.

**Technical architecture (observed from error traces):**
- Uses **HAML templates** (`.html.haml` files) for report sections
- Report is organized by **numbered sections**, e.g.:
  - `04-company_overview/co_section` — Company overview
  - `10-dlom/dlom_section` — DLOM section
- Uses `editable_content` / `editable_content_tag` system for in-place editing
- Helper modules: `reports_helper.rb`, `editor_helper.rb`
- Templates are product-specific: `reports/409a/04-company_overview/...`
- Bound to the valuation's **template version** (e.g., `#1766.v0`)

**Observed report template sections (from Rails paths):**
- `reports/409a/04-company_overview/co_financial_analysis`
- `reports/409a/04-company_overview/co_section`
- `reports/409a/10-dlom/dlom_section`
- `reports/409a/10-dlom/dlom_quantitative_analysis`
- `reports/show.html.haml` — Main report container

### 7.3 Report PDF

**Purpose:** Renders and downloads the final PDF deliverable from the current report content.

### 7.4 Overwrites & Edits (`/admin/overwrites_doc`)

**Purpose:** Manual analyst overrides of computed/AI-generated values.

- Count badge shows number of active overrides (e.g., `0`)
- **68 overridable fields** across 6 categories (see §17 Documentation Explorer)
- Each override preserves the **original value** for audit trail

### 7.5 Versions

**Purpose:** Report version history tracking.

- Shows all historical versions of the report
- Enables rollback/comparison between versions
- Version tags follow pattern: `#1766.v0`, `#1766.v1`, etc.

---

## 8. Valuation Sub-Pages: DATA Section

### 8.1 Details (Meta-Editor)

See §6 above for full field documentation.

### 8.2 Valuation Workbook

**Purpose:** The working financial model/spreadsheet for the valuation. Contains the intermediate calculations and data that feed into the engine.

### 8.3 Valuation Params

**Route:** `/admin/valuation_params/:uuid`

**Purpose:** Captures the financial methodology inputs an analyst uses to run a multi-approach 409A valuation.

**Company / Context section:**
| Field | Type | Options/Description |
|-------|------|---------------------|
| Rolling forward? | Toggle | Is this a roll-forward of a prior valuation |
| Inception date | Date picker | Company inception |
| Fiscal year-end | Date picker | — |
| Exit timeline | Dropdown/number | Expected time to exit (years) |
| Business overview | Text area | Company description |
| Revenue status | Dropdown | Pre-Revenue / Post-Revenue Unprofitable / Post-Revenue Profitable |
| Last financing round | Text/dropdown | Most recent round (Seed, Series A, etc.) |
| Last-year revenue | Currency | — |
| YTD revenue | Currency | — |
| Runway | Number | Months of cash runway |

**Approach Weights section:**
| Approach | Weight | Description |
|----------|--------|-------------|
| Asset | 0-100% | Cost-to-replicate, Net Asset Value |
| OPM | 0-100% | Option Pricing Model / Black-Scholes backsolve |
| Income | 0-100% | DCF (Discounted Cash Flow) |
| Market | 0-100% | Guideline public companies |

**Market Approach sub-fields:**
| Field | Description |
|-------|-------------|
| Revenue multiples | Revenue-based valuation |
| EBITDA multiples | Earnings-based valuation |
| LTM (Last Twelve Months) | Trailing multiples |
| NTM (Next Twelve Months) | Forward multiples |
| Custom multiple ranges | Analyst-defined ranges |

**Discounts section:**
| Discount | Model | Description |
|----------|-------|-------------|
| DLOC | — | Discount for Lack of Control |
| DLOM (Chaffee) | Protective-put | Chaffee put-option model |
| DLOM (Finnerty) | Average-strike put | Finnerty put-option model |
| DLOM (Qualitative) | Override | Manual qualitative adjustment |

### 8.4 AI / Attachments

**Route:** `/admin/ais/:uuid`

See §10 (AI Layer) for full documentation.

### 8.5 Bot Prompts

**Purpose:** Per-valuation AI prompt execution state. Shows which prompts have been run, their status, and results for this specific valuation.

- Badge count (e.g., `0`) indicates number of active/pending prompts

### 8.6 Amount Raised

**Purpose:** Funding round history for the company being valued.

- Badge count (e.g., `0`) indicates number of rounds recorded
- Captures each financing event with details

### 8.7 Transaction History

**Purpose:** Securities transactions and financing events for the company.

- Badge count (e.g., `0`) indicates number of transactions
- Records the company's equity transaction history

---

## 9. Valuation Sub-Pages: ANALYSIS Section

These pages were discovered in the per-valuation navigation and represent additional data-entry and analysis workspaces:

### 9.1 Captables

**Purpose:** Cap table data management — entry and viewing of the company's capitalization table including share classes, shareholders, options pools, warrants, and convertible instruments. This data feeds directly into the OPM backsolve calculation.

### 9.2 Projections

**Purpose:** Financial projections data entry — revenue, expenses, and cash flow projections used by the income approach (DCF) and for determining exit timeline and terminal value.

### 9.3 Historical Data

**Purpose:** Historical financial performance data — revenue, margins, growth rates, and other historical metrics used for trend analysis and as inputs to valuation models.

### 9.4 Finances

**Purpose:** Detailed financial statement data — income statements, balance sheets, and cash flow statements from the company's financial documents.

### 9.5 Journals

**Purpose:** Audit/change journal — tracks changes, notes, and audit entries made during the valuation process. Provides an audit trail of analyst decisions.

### 9.6 Team Support

**Purpose:** Internal team support and collaboration notes — enables team members to communicate about the valuation, flag issues, and coordinate work.

---

## 10. AI Layer

AI is central to the platform — it's in the name. The AI system spans multiple surfaces:

### 10.1 AI / Attachments Page (`/admin/ais/:uuid`)

**Three tabs:**

#### Tab 1: Attachments

**Attachment Upload:**
- **New** button (green) to create a new attachment record
- **Attachment kind** dropdown with these document types:
  1. Articles
  2. Decks
  3. Exports
  4. Captable documents
  5. Monthly income statements
  6. Annual income statements
  7. Balance sheets
  8. Projections files
  9. Uploads
  10. Draft reports
  11. Previous valuations
  12. Mail attachments
- **File upload** area: "Choose a files or drop them here" (drag-and-drop enabled)
- **Attachments table** columns: ID, Created At, Name, Tags, Size

**AI Pipelines (always visible at bottom):**

| Pipeline | Icon | Badge | Actions | Description |
|----------|------|-------|---------|-------------|
| Missing Data | ⚠️ Warning | — | Expand (∨), Edit (✏), Run (▶) | Identifies missing data points |
| Data Extraction | 📦 Package | — | Expand (∨), Edit (✏), Run (▶) | Extracts structured data from documents |
| Public Comparables | 📊 Chart | `0` (count) | Expand (∨), Edit (✏), Run (▶) | Finds comparable public companies |

**Additional AI Actions (from previous documentation):**
- **Find Mappings and Sources** — maps extracted data to valuation fields
- **Set Valuation Parameters** — auto-fills the valuation params form
- **Summarize Attachments** — generates summaries of uploaded documents
- **Create Missing Entries** — fills in identified gaps

#### Tab 2: AI Jobs

Displays a table of all AI job executions for this valuation:

| Column | Description |
|--------|-------------|
| ID | Sequential job ID (e.g., 1434, 1435, 1436) |
| Provider | AI provider used (e.g., "Anthropic-OPUS_4_8") |
| Name | Job name (e.g., "Find-Comparables", "Create-Missing-Entries", "Find-Missing-Data") |
| Content | Links to "Request" and "Response" payloads |
| Updated At | Timestamp (e.g., "06 Jul 20:14") |
| Actions | View (👁 green), Edit (✏ yellow), Delete (🗑 red) |

**Observed job names:**
- `Find-Comparables` — finds comparable public companies
- `Create-Missing-Entries` — fills in missing data points
- `Find-Missing-Data` — identifies what data is still needed

#### Tab 3: Network Items

Stores extracted comparable companies and market data (network data) discovered by AI during the comparables search.

### 10.2 Prompt Registry (`/admin/prompts`)

The AI prompt registry is a first-class admin page for managing all prompts used across the platform.

**Prompt list columns:**
| Column | Description |
|--------|-------------|
| Name | Prompt identifier |
| Bot | AI model/provider binding |
| Updated At | Last modification |
| Actions | Edit, Delete |

**27 named prompts observed:**

| # | Prompt Name | Bot/Model |
|---|------------|-----------|
| 1 | anonymize_captable | bedrock-SONNET35 |
| 2 | business_overview | perplexity |
| 3 | company_description | perplexity |
| 4 | company_overview | perplexity |
| 5 | competitors | bedrock-LLAMA33 |
| 6 | csop_market | perplexity |
| 7 | emi_market | perplexity |
| 8 | FIND_COMPARABLES | Anthropic-OPUS_4_8 |
| 9 | FIND_MAPPING_AND_SOURCES | Anthropic-OPUS_4_8 |
| 10 | ifrs2_market | perplexity |
| 11 | industry_outlook | perplexity |
| 12 | market_au | perplexity-PRO |
| 13 | market_ca | perplexity-PRO |
| 14 | market_si | perplexity-PRO |
| 15 | market_uk | perplexity |
| 16 | market_un | perplexity |
| 17 | market_us | perplexity |
| 18 | MISSING_DATA_SUMMARY | Anthropic-OPUS_4_8 |
| 19 | process_captable | Anthropic-OPUS_4_8 |
| 20 | revenue_discussion | perplexity |
| 21 | risks | perplexity |
| 22 | SET_VALUATION_PARAMS | Anthropic-OPUS_4_8 |
| 23 | SUMMARIZE | perplexity |
| 24-27 | (additional prompts) | various |

### 10.3 AI Provider / Model Routing

| Bot / Model ID | Provider | Technology | Use Cases |
|----------------|----------|------------|-----------|
| `perplexity` | Perplexity AI | Perplexity API | Market research, industry analysis, company overview, risks, industry outlook |
| `perplexity-PRO` | Perplexity AI | Perplexity Pro API | Country-specific market analysis (AU, CA, SI) |
| `bedrock-LLAMA33` | AWS Bedrock | Llama 3.3 | Competitor extraction |
| `bedrock-SONNET35` | AWS Bedrock | Claude Sonnet 3.5 | **Cap-table anonymization** (privacy-critical step) |
| `Anthropic-OPUS_4_8` | Anthropic API | Claude Opus 4.8 | Core structured extraction: FIND_MAPPING_AND_SOURCES, MISSING_DATA_SUMMARY, FIND_COMPARABLES, SET_VALUATION_PARAMS, process_captable |

### 10.4 Cap-Table Anonymization

A deliberate **privacy control**: cap tables are **anonymized** by an LLM (`bedrock-SONNET35`) before any downstream AI processing. This ensures sensitive shareholder and equity data is not exposed to other AI providers. The `anonymize_captable` prompt handles this step.

### 10.5 AI Data Flow

```
Client uploads documents (cap tables, financials, decks)
    ↓
AI extracts structured data (Data Extraction pipeline)
    ↓
Cap tables anonymized (bedrock-SONNET35)
    ↓
Missing data identified (Find-Missing-Data)
    ↓
Missing entries created (Create-Missing-Entries)
    ↓
Comparables found (Find-Comparables via Anthropic-OPUS_4_8)
    ↓
Valuation params auto-set (SET_VALUATION_PARAMS)
    ↓
Market research gathered (Perplexity: industry, risks, market)
    ↓
Analyst reviews/overrides → Engine calculates → Report drafts
```

---

## 11. Reviews & Task Management

**Route:** `/admin/reviews`

### Overview

A granular **task-assignment system** layered over valuations. At crawl time: **5,703** review records.

### Review Task Types (Sections)

Each valuation can spawn multiple typed review tasks:

| Task Section | Purpose |
|--------------|---------|
| Entire valuation | Full valuation review |
| Data task | Data verification and cleanup |
| Support task | Client communication/support |
| Full | Full scope review |
| Approve draft report | Draft approval gate |
| Review draft report | Detailed draft review |
| Send draft report | Deliver draft to client |
| Manual publish | Manual publishing step |
| Publish report | Automated publish |
| Assign | Assignment step |
| Signature (main) | Primary signatory approval |
| Signature (second) | Secondary signatory approval |

### Review Task States

| State | Description |
|-------|-------------|
| New | Created, not yet started |
| Started | Work in progress |
| Completed | Done |
| Cancelled | Cancelled/skipped |
| Overdue | Past due date |
| Assigned To Me | Personal view filter |

### Task Fields

- **Assigned to** — team member responsible
- **Due date** — deadline
- **Finished at** — completion timestamp
- **Valuation reference** — linked valuation

### Workflow Routing

Tasks route valuations through the full lifecycle:
```
Data entry → Analyst review → Reviewer → Signer (main) → Signer (second) → Publish
```

---

## 12. Inbox & Email Ingestion

**Route:** `/admin/inbox`

### Email-to-Valuation Integration

The inbox powers a bidirectional email integration:

**Inbound flow:**
1. Client sends email to 409.ai
2. System matches email to a valuation (by email address / thread reference)
3. Matched emails become **valuation comments** attached to the right valuation
4. Unmatched emails appear as **unassigned emails** for manual routing

**Key features:**
- **Unread indicators** per valuation (admin and user read tracking)
- **Unassigned emails** queue for routing to the correct valuation
- **Message count** and **last message at** per valuation
- **Admin read at** / **User read at** timestamps

### Global Email Indicators

- Header badge: "1 unread" (green) — unread emails
- Header badge: "1 unassigned emails" (yellow) — emails needing routing

---

## 13. Sensitivity Dashboard

**Route:** `/admin/investor`

### OPM Sensitivity Analysis

Provides Black-Scholes **sensitivity analysis tables** showing how the concluded share price moves as OPM inputs are stressed.

**Three sensitivity matrices:**

| Matrix | Row Variable | Column Variable |
|--------|-------------|-----------------|
| Matrix 1 | Term (years to exit) | Volatility (%) |
| Matrix 2 | Risk-Free Rate (%) | Volatility (%) |
| Matrix 3 | Risk-Free Rate (%) | Term (years to exit) |

Each cell shows both:
- **Implied** value — the model-implied metric
- **Price** variation — the resulting share price

### Use Cases

- Analyst: validate sensitivity of inputs
- Reviewer: confirm reasonable input ranges
- Investor: understand valuation range (read-only `Investor` role)

---

## 14. Partner Channel

### 14.1 Partner Management (`/admin/partners`)

**Purpose:** Manage external partners who submit valuations on behalf of their customers.

**Partner list observed:**

| Partner | Subdomain | Description |
|---------|-----------|-------------|
| Promissory | `promissory.app.409.ai` | Equity management platform |
| Vestd | `vestd.app.409.ai` | UK share scheme platform |
| DonateEquity | `donateequity.app.409.ai` | Equity donation platform |
| Reins | `reins.app.409.ai` | — |
| Gust | `gust.app.409.ai` | Startup platform |
| JPM | `jpm.app.409.ai` | JP Morgan |
| (Additional partners) | Various subdomains | — |

**Key feature:** Each partner gets a **white-label subdomain** (`<partner>.app.409.ai`), providing a branded experience for their customers.

### 14.2 Partner Valuations (`/admin/partner_valuations`)

**Purpose:** Partner-scoped view of valuations submitted through the partner channel.

- **323** partner valuations at crawl time
- Simplified status model: **Work in progress / Waiting on client / Published**
- Partner filters for scoping
- Backed by the Partner REST API

### 14.3 Partner API & Tokens (`/admin/api_tokens`)

**Purpose:** API credentials for partner integrations.

**Token structure:**
| Field | Description |
|-------|-------------|
| Client ID | Public API identifier |
| Client Secret | Masked secret key |
| Partner | Associated partner |
| User | Associated user account |

**Active API integrations observed:**
- Promissory
- Vestd
- DonateEquity
- Reins

**API capabilities (inferred):**
- Create valuations on behalf of partner customers
- Query valuation status
- Receive webhooks/callbacks on status changes
- Token-based authentication
- Partner-scoped data isolation (partners see only their own valuations)

---

## 15. Settings & Administration

### 15.1 Users (`/admin/users`)

**Total users:** 1,308 at crawl time

**User fields:**
| Field | Description |
|-------|-------------|
| Name | Full name |
| Email | Email address |
| Roles | Comma-separated role list |
| Partner | Associated partner (if any) |
| Phone | Phone number |
| Verified | Email verification status |
| SSO | SSO provider (e.g., "google") |
| GCLID | Google Ads click ID |
| Valuation count | Number of valuations |

**Actions:** Download CSV export

### 15.2 Role-Based Access Control (RBAC)

**18+ roles observed** with counts:

| Role | Count | Description |
|------|-------|-------------|
| Valuation User | ~1,200+ | Client/founder requesting valuation |
| Admin | ~5 | Full admin access |
| God | ~2 | Superadmin, unrestricted |
| Supervisor | ~3 | Team oversight |
| Support | ~4 | Client communication |
| Support Supervisor | ~2 | Support team lead |
| Reviewer | ~5 | Reviews valuations |
| Main Reviewer | ~3 | Primary reviewer |
| Contributing Reviewer | ~3 | Secondary reviewer |
| Data | ~4 | Data entry/verification |
| Data Supervisor | ~2 | Data team lead |
| Partner | ~10 | External partner users |
| Member | ~15 | General members |
| Investor | ~3 | Read-only sensitivity view |
| Auto | ~2 | System/automation accounts |
| Signatory | ~3 | Authorized signatories |
| Spa | ~1 | Special purpose |
| Ignored | ~5 | Deactivated/ignored |

### 15.3 API Tokens (`/admin/api_tokens`)

See §14.3 above.

### 15.4 Prompts (`/admin/prompts`)

See §10.2 above.

### 15.5 Communication Templates (`/admin/communication_templates`)

**Purpose:** Mustache/Handlebars-style email and SMS templates used in automated and manual communications.

**Template list observed:**

| Template Name | Description |
|---------------|-------------|
| missing_data_email | Request for missing documents/data |
| valuation_complete | Notification that valuation is done |
| draft_ready | Draft report ready for review |
| payment_reminder | Payment reminder to client |
| welcome_email | Welcome/onboarding email |
| document_upload_reminder | Reminder to upload documents |
| draft_accepted_email | Confirmation of draft acceptance |
| published_email | Final report published notification |
| (additional templates) | Various lifecycle communications |

**Template features:**
- **Handlebars/Mustache** variable interpolation (e.g., `{{company_name}}`, `{{user.first_name}}`)
- Preview capability
- Create/Edit/Delete operations
- Tied to valuation lifecycle stages

### 15.6 Auto Emails (`/admin/auto_emails`)

**Purpose:** Automated email and SMS drip campaigns triggered by valuation lifecycle events.

**Auto email sequences observed:**

| Sequence Name | Type | Trigger |
|---------------|------|---------|
| onboarding_welcome | Email | On sign-up |
| document_upload_nudge | Email | After sign-up, no uploads |
| payment_reminder_1 | Email | Unpaid after X days |
| payment_reminder_2 | Email | Unpaid follow-up |
| draft_notification | Email | Draft ready |
| sms_payment_reminder | SMS | Payment reminder via SMS |
| sms_document_reminder | SMS | Document upload via SMS |
| (additional sequences) | Email/SMS | Various lifecycle triggers |

**Key features:**
- **Email sequences** — multi-step drip campaigns
- **SMS sequences** — text message reminders (noted as "SMS" type)
- **Lifecycle triggers** — tied to valuation state transitions
- **Timing rules** — delays between messages
- **Enable/disable** per sequence

### 15.7 Partners (`/admin/partners`)

See §14.1 above.

---

## 16. Communication System

### 16.1 Chat

**Per-valuation real-time chat** between the admin team and the client.

- Accessible via **Chat** button in the per-valuation action bar (with message count badge)
- Shows conversation history
- Supports text messages
- Linked to the valuation record

### 16.2 Comments

**Per-valuation comment threads** for internal team communication and client-facing notes.

- Accessible via **New Comment** button in the right sidebar
- **Notes & Comments** section shows combined view
- Comments can be created by:
  - Manual entry by team members
  - Inbound emails (auto-converted to comments)
  - System-generated notifications

### 16.3 Sticky Notes

**Quick analyst notes** attached to a valuation.

- Textarea in the right sidebar
- **Save Note** button
- **Last note: N/A** indicator shows most recent note
- Designed for quick, informal annotations

### 16.4 Email Communications

- **Outbound:** Template-based emails triggered by lifecycle events (via Auto Emails)
- **Inbound:** Email ingestion converts client emails to valuation comments (via Inbox)
- **Templates:** Handlebars/Mustache templates with variable interpolation

### 16.5 SMS Communications

- **SMS-based notifications** for payment and document reminders
- Integrated into the Auto Emails system as "SMS" type sequences

---

## 17. Documentation & Explorer Tools

### 17.1 Overwrites / Documentation Explorer (`/admin/overwrites_doc`)

**Purpose:** Self-documenting schema browser for the Overwrites configuration.

**Layout:** Toggle between **Table view** and **Card view**.

**68 overridable fields across 6 categories:**

| Category | Count | Example Fields |
|----------|-------|----------------|
| Company Information | 7 | `industry_id`, `currency`, `service_countries[]`, `yearend` |
| Financial Metrics | 17 | Revenue, EBITDA, growth rates, margins |
| Forecasts & Projections | 12 | Revenue projections, growth forecasts |
| Valuation Parameters | 15 | `exit_timeline`, approach weights, discount rates |
| Market & Comparables | 16 | Comparable companies, multiples, market data |
| Reporting & Filing | 1 | Report-specific overrides |

**Field metadata shown:**
- **Class:** numeric, date, character
- **Min/Max:** allowed ranges
- **Example values:** sample data

**Key override fields observed:**
- `industry_id` — industry classification
- `valuation_date` — as-of date
- `exit_timeline` — expected exit timeframe
- `currency` — valuation currency
- `service_countries[]` — jurisdictions
- `yearend` — fiscal year end
- `bootstrap_assets` — asset approach flag

### 17.2 Package Explorer (`/admin/package_explorer_doc`)

**Purpose:** Interactive **visNetwork dependency graph** of the R calculation engine package.

**Features:**
- **Interactive network visualization** using vis.js/visNetwork library
- **Color-coded nodes** by type:
  - Green: R scripts
  - Additional colors for: Script, C/C++, YAML, Leaf nodes
- **"Select by group"** dropdown filter
- **Dependency Levels** sidebar listing:
  - **L0 (Entry):** 47 items — the entry-point functions and data files

**Key engine components identified (L0 entry level):**

| Component | Type | Purpose |
|-----------|------|---------|
| `BLACK_SCHOLES` | R | Black-Scholes option pricing |
| `CHAFFEE` | R | DLOM Chaffee protective-put model |
| `CALCULATE_RATE` | R | Rate calculations |
| `calculate_single_debt` | R | Debt calculations |
| `BETAS` | R | Beta calculations for CAPM |
| `cjsAddScale` | R | Chart.js scale additions |
| `chartjsOutput` | R | Chart.js output rendering |
| `renderChartjs` | R | Chart.js rendering |
| `DATA_ERROR` | R | Error handling |
| `import_common_functions` | R | Shared function imports |
| `PUSH_PAYLOAD` | R | API payload handling |
| `STARTING_MESSAGE` | R | Pipeline initialization |
| `TEST_PAYLOAD.R` | R | Test fixtures |
| `use_pipe.R` | R | Pipe operator setup |
| `testthat.R` | R | Test framework |
| `zzz.R` | R | Package initialization |
| `mergeLists` | R | List merging utility |
| `baseOptions` | R | Base configuration |
| `createOptions` | R | Options construction |

**Deeper dependency levels (from previous docs):**
- `back_solve` / `run_bsm` / `sa_bsm` — Black-Scholes backsolve implementations
- `FINNERTY` — Finnerty DLOM model
- `EBITDAM` — EBITDA multiples
- `REVM` — Revenue multiples
- `newton_raphson` — **C++ root-finder** for backsolve/IRR
- `ANNUALIZE_*` — Annualization functions
- `COMPARABLES` — Comparable companies module
- `FUNDAMENTALS` — Financial fundamentals
- `WEIGHTS` — Approach weighting
- `FRODO` / `ROLL_FRODO` — Roll-forward engine
- `plumber.R` — REST API endpoint definitions
- `LAUNCH_API` — API server launcher
- `monitor.R` — Health monitoring
- Topic-modeling/NLP matchers — For comparable company matching

---

## 18. Architecture & Technology Stack

### 18.1 Web Application

| Component | Technology | Evidence |
|-----------|------------|----------|
| Framework | **Ruby on Rails** | `/admin/*` routes, CRUD conventions, HAML views, `.rb` files |
| Template Engine | **HAML** | `.html.haml` file extensions in error traces |
| View Pattern | Server-rendered | Full-page renders, not SPA |
| CSS/UI | Custom dark theme | Green/black gradient, gold accents |
| JavaScript Charts | **Chart.js** | Dashboard pie charts |
| Network Graphs | **vis.js / visNetwork** | Package Explorer |
| Support Widget | **Intercom** | Chat bubble on sign-up page |
| Version | **0.10.1** | Shown in footer: "Powered by 409.ai" + "Version: 0.10.1" |

### 18.2 Valuation Engine

| Component | Technology | Evidence |
|-----------|------------|----------|
| Language | **R** | Package structure, R scripts throughout |
| API Framework | **Plumber** | `plumber.R`, REST microservice |
| C++ Integration | **Rcpp** | `newton_raphson` C++ root-finder |
| Containerization | **Docker** | `docker-base-image.yml`, `docker-image.yml` |
| CI/CD | **Travis CI** | CI pipeline |
| Configuration | **YAML** | `constants.yml`, `overwrites.yml`, `projections.yml`, `functions.yaml` |

### 18.3 AI Services

| Provider | Models Used | Integration |
|----------|------------|-------------|
| **Perplexity AI** | perplexity, perplexity-PRO | REST API for market research |
| **AWS Bedrock** | Llama 3.3 (`bedrock-LLAMA33`), Claude Sonnet 3.5 (`bedrock-SONNET35`) | Managed inference |
| **Anthropic** | Claude Opus 4.8 (`Anthropic-OPUS_4_8`) | Direct API for core extraction |

### 18.4 Authentication & Security

| Feature | Implementation |
|---------|---------------|
| Password auth | Email + password with `verified` flag |
| SSO | Google OAuth (sign in/up with Google) |
| RBAC | 18+ roles with fine-grained permissions |
| Password reset | "Reset it here" link |
| Cap-table privacy | LLM-based anonymization before processing |

### 18.5 Integrations

| Integration | Type | Description |
|-------------|------|-------------|
| Partner REST API | Token-authenticated | Partner valuations CRUD |
| Email Ingestion | Inbound processing | Emails → valuation comments |
| Google Ads | Attribution | GCLID tracking |
| Google OAuth | SSO | Sign in/up with Google |
| Intercom | Support | Embedded chat widget |
| Payment (likely Stripe) | Commerce | `paid_at`, `amount` fields |
| SMS | Notifications | Auto email system includes SMS |
| Xero | Accounting | Financial data import via OAuth |
| QuickBooks | Accounting | Financial data import via OAuth |
| FreshBooks | Accounting | Financial data import via OAuth |
| Oracle NetSuite | Accounting (ERP) | Financial data import via OAuth |
| Sage | Accounting | Financial data import via OAuth |
| Wave | Accounting | Financial data import via OAuth |

### 18.6 Infrastructure (Inferred)

| Component | Likely Technology |
|-----------|-------------------|
| Database | PostgreSQL (assumed from Rails conventions) |
| Background Jobs | Sidekiq or similar (workflow engine references) |
| File Storage | S3 or similar (document uploads) |
| Hosting | AWS (Bedrock integration suggests AWS ecosystem) |
| Domain | `onboard.app.409.ai` with partner subdomains |

---

## 19. Data Model (as observable from UI)

### Core Entities

```
┌──────────────────────────────────────────────────────┐
│                    VALUATION                          │
│ ─────────────────────────────────────────────────── │
│ id (sequential: #1766)                               │
│ uuid (ULID: 01KWVHK7A0EMYXFSTQHSV2YTDR)           │
│ workflow_id                                          │
│ kind (409a, 718, gifts, etc.)                       │
│ template_version (e.g., 409a.v0)                    │
│ state (pending → ... → published)                    │
│ waiting_on_client (boolean flag)                     │
│ ─────────────────────────────────────────────────── │
│ company_name, service_name                           │
│ source, partner_id, gclid                           │
│ paid, amount, custom_amount, paid_at                │
│ delivery_days, due_date                              │
│ amount_raised, qsbs_attestation                     │
│ ─────────────────────────────────────────────────── │
│ created_at, started_at, user_finished_at            │
│ completed_at, drafted_at, draft_accepted_at         │
│ published_at, admin_read_at, user_read_at           │
│ last_comment_at                                      │
└──────────────────────┬───────────────────────────────┘
                       │
     ┌─────────────────┼─────────────────┐
     ▼                 ▼                 ▼
┌─────────┐    ┌──────────────┐    ┌───────────┐
│  USER   │    │ ATTACHMENT   │    │  REVIEW   │
│─────────│    │──────────────│    │───────────│
│ id      │    │ id           │    │ id        │
│ name    │    │ kind         │    │ section   │
│ email   │    │ name         │    │ state     │
│ phone   │    │ tags         │    │ user_id   │
│ roles[] │    │ size         │    │ due_date  │
│ partner │    │ created_at   │    │ finished  │
│ verified│    │ valuation_id │    │ val_id    │
│ sso     │    └──────────────┘    └───────────┘
│ gclid   │
└─────────┘    ┌──────────────┐    ┌───────────┐
               │   AI_JOB     │    │  COMMENT  │
     ┌─────────│──────────────│    │───────────│
     ▼         │ id           │    │ id        │
┌─────────┐    │ provider     │    │ body      │
│ PARTNER │    │ name         │    │ user_id   │
│─────────│    │ request      │    │ val_id    │
│ id      │    │ response     │    │ source    │
│ name    │    │ valuation_id │    │ (email?)  │
│ subdomain│   │ updated_at   │    └───────────┘
│ api_token│   └──────────────┘
└─────────┘                        ┌───────────┐
               ┌──────────────┐    │  PROMPT   │
               │  OVERWRITE   │    │───────────│
               │──────────────│    │ id        │
               │ field        │    │ name      │
               │ old_value    │    │ bot       │
               │ new_value    │    │ content   │
               │ valuation_id │    │ updated_at│
               └──────────────┘    └───────────┘

┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  API_TOKEN   │   │   TEMPLATE   │   │  AUTO_EMAIL  │
│──────────────│   │──────────────│   │──────────────│
│ client_id    │   │ id           │   │ id           │
│ client_secret│   │ name         │   │ name         │
│ partner_id   │   │ body         │   │ type (email/ │
│ user_id      │   │ variables    │   │       sms)   │
└──────────────┘   └──────────────┘   │ trigger      │
                                      │ enabled      │
                                      └──────────────┘
```

### Key Relationships

- A **Valuation** belongs to a **User** (requester) and optionally a **Partner**
- A **Valuation** has many **Attachments**, **AI Jobs**, **Comments**, **Reviews**, and **Overwrites**
- A **User** has many **Roles** (many-to-many)
- A **Partner** has many **API Tokens** and **Valuations**
- **Reviews** are assigned to **Users** and belong to a **Valuation**
- **AI Jobs** reference a **Prompt** via the job name and are scoped to a **Valuation**

---

## 20. User Flows

### 20.1 Client Onboarding Flow

```
1. Client visits 409.ai → Sign Up page
2. Creates account (email/password or Google OAuth)
   - First Name, Last Name, Work Email, Password, Phone
3. Email verification → verified flag set
4. Selects valuation kind (409a, 718, gifts, etc.)
5. Enters company details
6. Makes payment (fixed or custom amount)
   - Payment recorded: paid_at, amount
   - Partner-paid = $0 to client
   - SLA calculated: delivery_days → due_date
7. Uploads documents by kind:
   - Cap tables, Income statements, Balance sheets
   - Projections, Decks, Prior valuations
8. State: onboarding_completed → user_finished
9. Receives automated emails (welcome, reminders)
10. Reviews draft report → accept or request changes
11. Receives final published report (PDF)
```

### 20.2 Analyst/Ops Workflow

```
1. Valuation appears in Valuations list (state: started/user_finished)
2. Analyst opens valuation → Details page
3. Reviews uploaded documents (AI/Attachments page)
4. Runs AI pipelines:
   a. Data Extraction → auto-fills structured data
   b. Missing Data → identifies gaps
   c. Public Comparables → finds peer companies
5. Reviews/adjusts Valuation Params:
   - Approach weights (Asset/OPM/Income/Market)
   - DLOM models (Chaffee/Finnerty/Qualitative)
   - Market multiples (Revenue/EBITDA, LTM/NTM)
6. Triggers engine calculation (Recalculate buttons)
7. Reviews Calculations output (0/5 → 5/5)
8. Reviews/edits Overwrites (68 possible fields)
9. Edits Report in Report Editor (HAML template sections)
10. Generates Report PDF
11. Submits for review (state → review)
```

### 20.3 Review & Publish Flow

```
1. Reviewer receives review tasks (Reviews page)
2. Reviews valuation: Data task → Review draft → Approve draft
3. State: review → reviewed → drafted
4. Draft sent to client (Send draft report task)
5. Client accepts draft (draft_accepted) or requests changes (draft_changes)
6. If changes: analyst revises → re-submit for review
7. Signatures applied: main signature → second signature
8. State: drafted → draft_accepted → published
9. Final PDF delivered to client
10. Published report accessible to client
```

### 20.4 Partner Flow

```
1. Partner creates API token (admin sets up)
2. Partner submits valuation via REST API
   - Authentication: client_id + client_secret
   - Creates valuation with source = "Partner"
3. Valuation appears in Partner Valuations list
4. Same analyst/review workflow as direct valuations
5. Partner views status: Work in progress / Waiting / Published
6. Partner's white-label subdomain: partner.app.409.ai
```

### 20.5 Email Communication Flow

```
Outbound:
1. Lifecycle event triggers auto email
2. Template rendered with Handlebars variables
3. Email/SMS sent to client

Inbound:
1. Client emails 409.ai
2. System matches email to valuation
3. Matched → becomes valuation comment
4. Unmatched → queued as unassigned in Inbox
5. Admin routes unassigned email to correct valuation
```

---

## 21. Unique & Differentiating Features

### 21.1 Multi-Provider AI Orchestration

Unlike single-model AI integrations, 409.ai routes different tasks to the best-fit AI provider:
- **Perplexity** for real-time market research (has internet access)
- **AWS Bedrock** for privacy-sensitive tasks (cap-table anonymization)
- **Anthropic Claude** for complex structured extraction
- **Prompts are first-class managed records** — editable without deployment

### 21.2 Cap-Table Anonymization Pipeline

A deliberate privacy control where cap tables are anonymized by an LLM before any downstream AI processing, protecting sensitive shareholder data.

### 21.3 Self-Documenting Overwrites Schema

The `/admin/overwrites_doc` page serves as a living schema browser showing all 68 overridable fields with their types, ranges, and examples — documentation built into the product itself.

### 21.4 R Engine Dependency Explorer

The Package Explorer provides an interactive visual dependency graph of the entire R calculation engine, giving analysts and engineers visibility into how the quantitative models are structured.

### 21.5 White-Label Partner Subdomains

Each partner gets a dedicated subdomain (`partner.app.409.ai`), providing a branded experience without separate deployments.

### 21.6 Email Ingestion → Comment Threads

Inbound client emails are automatically matched to valuations and converted to comment threads, creating a unified communication history.

### 21.7 Multi-Approach Valuation Methodology

The engine supports simultaneous OPM, income, market, and asset approaches with configurable weights, and multiple DLOM models (Chaffee protective-put, Finnerty average-strike put), which is more comprehensive than typical single-method platforms.

### 21.8 Workflow Engine with State Machine

A restartable workflow engine orchestrates the full valuation lifecycle with a complex state machine supporting side states (timeout, cancelled, ignored) and overlay flags (waiting_on_client).

### 21.9 Versioned Report Templates

Reports are bound to versioned templates (e.g., `409a.v53`), ensuring reproducibility — the same inputs with the same template version produce the same report.

### 21.10 SMS + Email Drip Campaigns

The auto-email system supports both email and SMS sequences tied to valuation lifecycle stages, enabling multi-channel client engagement.

---

## 22. Public-Facing Website (www.409.ai)

> **This entire section was missing from the original documentation.** The public marketing website at `www.409.ai` is a separate property from the admin back-office at `onboard.app.409.ai`.

### 22.1 Global Header Navigation

| Nav Item | Type | Description |
|----------|------|-------------|
| 409.AI logo | Link | Home page |
| Products | Dropdown | 14 valuation product pages |
| Pricing | Link | Interactive pricing calculator |
| Which Valuation? | Link | Guided quiz/wizard |
| Log In | Link | → `onboard.app.409.ai/sign_in` |
| Start Valuation | CTA button (green/yellow) | → Sign-up/onboarding flow |

### 22.2 Products Dropdown (16 Product Pages)

The Products dropdown reveals individual product landing pages:

**Left column:**
1. 409A Valuation
2. ASC 718 Valuation
3. ASC 820 Valuation
4. CSOP Valuation
5. EMI Valuation
6. ESOP Valuation
7. Gift & Estate Tax Valuation

**Right column:**
8. IFRS 2 Valuation
9. Impairment Testing Valuation
10. IP Valuation
11. Portfolio Valuation
12. Purchase Price Allocation
13. QSBS Attestation
14. SMB Valuation

### 22.3 Landing Page (`/`)

**Hero section:**
- Rotating headline: "Easier [409A / ASC 820 / Gift & Estate Taxes / EMI / ...] Valuations"
- Subtext: "Get your expert-reviewed and audit-defensible valuation in as quick as 24 hours, starting at only $899."
- "Start Valuation" CTA button
- Trust badges: "No Credit Card Required" · "No Commitment"
- "Scroll to explore" hint

**Animated stats section:**
- "2X FASTER"
- "67% CHEAPER"
- "21 Day DELIVERY*" (asterisk: "Only available for certain valuation types")

**Partner logo carousel:**
Wave, Techstars, Vestd, Promissory, DeepFlows, Mantle, Fidelity, SaaS (horizontal scrolling)

**"Do I need a valuation?" section:**
Explains why valuations matter (stock option pricing, financial protection, audit defensibility).

**"How it works" — 3 Simple Steps:**

| Step | Title | Description |
|------|-------|-------------|
| 01 | Onboarding Form | Complete a quick set of questions, upload select documents, and connect your accounting software in a few minutes. |
| 02 | Draft Report | Review and discuss a draft report to understand your valuation and ask questions. |
| 03 | *(Final report delivery — implied)* | — |

**Integrations section:**
"Save hours of work with integrations" — highlights 6 accounting software integrations (see §23).

**Customer testimonials carousel:**
3 testimonial cards with navigation arrows (< >) showing customer quotes.

**Blog section:**
- "OUR BLOG" label
- "Be the finance superhero." tagline
- "View all articles →" link
- 3 blog article preview cards with "Learn more →" links

**CTA banner:**
"Put AI into Action" — "Start your valuation for free. Receive a draft report in just 24 hours." with "Start My Valuation!" button.

**Contact & Demo section:**
- "Chat with Us!" — "Questions? Concerns? Requests? Talk to us." with "Book A Call" button
- "Watch a demo" — "Short on time? Get a quick 5-min look at how 409 AI works." with "Watch The Demo" button (video)

**Recent Activity social proof toasts:**
Bottom-right corner popups showing real-time activity, e.g., "A startup in Houston started a 409A valuation." (with timestamp). These cycle automatically.

### 22.4 Pricing Page (`/pricing`)

**Interactive Pricing Calculator:**

| Element | Type | Description |
|---------|------|-------------|
| Report type | Dropdown | Default: "409A Valuation" (all product types available) |
| Amount raised | Slider | Range: $0-999k to $20M+ |
| Base price | Display | $899 (varies by report type and amount raised) |
| Delivery time | Display | 7 business days (standard) |
| Express Delivery | Checkbox add-on | +$500 — "Receive your report in 1 business day instead of 7 business days." |
| QSBS Attestation Letter | Checkbox add-on | +$500 — "Add documentation and support for QSBS tax status." |
| Get The Report | CTA button | Proceeds to sign-up/payment |
| Quiz link | Text link | "Not sure which report you need? Take the 30-second quiz" |

**Comparison Table:**
"Faster, clearer, and built for founders" — compares 409.AI vs Accounting Firms vs Cap Table Providers:

| Feature | 409.AI | Accounting Firm | Cap Table Provider |
|---------|--------|----------------|-------------------|
| Onboarding | Online form + software connect | Email + document back-and-forth | Mostly email or manual uploads |
| Time Required | 15 minutes | 8-20+ hours | 1-5 hours |
| First Draft Availability | 24 hours | 4-12 weeks | 3-8 weeks |
| Final Report Delivery | 7 business days standard; 1 business day Express | 4-12 weeks | 3-8 weeks |
| Software Integrations | QuickBooks, Xero, FreshBooks, and more | Manual document collection | Limited or platform-dependent |
| Report Quality | AI-assisted draft + expert review | Manual analyst process | Platform-dependent |
| Expert Sign-off | ✓ | ✓ | ✓ |
| Report Revisions | Included | Limited or extra fees | Varies |

### 22.5 Which Valuation Quiz (`/which-valuation`)

A **multi-step guided wizard** that routes users to the correct report type.

**Step 1: "What's driving the need for a valuation?"**

| # | Option | Subtitle | Routes To |
|---|--------|----------|-----------|
| 1 | I'm giving employees stock options and need a price to set them at | — | 409A Valuation |
| 2 | I need to report equity compensation on my financial statements | — | ASC 718 |
| 3 | I just acquired, or am acquiring, a company | Allocating the purchase price | PPA |
| 4 | I need to value my business for a loan, sale, or new partner | — | SMB Valuation |
| 5 | I'm transferring or gifting company shares | Tax or estate planning | Gift & Estate |
| 6 | I run an investment fund and need to value my holdings | — | Portfolio |
| 7 | I have, or am setting up, an employee stock ownership plan (ESOP) | — | ESOP |
| 8 | I need to value a specific patent, trademark, or software asset | — | IP |
| 9 | I need to document QSBS eligibility | — | QSBS |
| 10 | I'm not sure | — | (guided follow-up) |

Each option leads to follow-up questions and ultimately presents the recommended report type with pricing.

### 22.6 Competitor Comparison Pages

Seven dedicated comparison pages accessible from the footer:

| Page | URL Path | Competitor |
|------|----------|-----------|
| 409.AI vs Carta | `/compare/carta` | Cap table & valuation platform |
| 409.AI vs Pulley | `/compare/pulley` | Cap table platform |
| 409.AI vs Eqvista | `/compare/eqvista` | Valuation & cap table |
| 409.AI vs Kruze Consulting | `/compare/kruze` | Startup accounting firm |
| 409.AI vs Eton Venture Services | `/compare/eton` | Valuation firm |
| 409.AI vs Aranca | `/compare/aranca` | Valuation & research firm |
| 409.AI vs Scalar | `/compare/scalar` | Valuation platform |

### 22.7 Footer

**PRODUCTS** — Links to all 14 product pages (same as Products dropdown)

**COMPARE** — Links to 7 competitor comparison pages

**COMPANY:**
- Home
- About
- Which Valuation?
- Pricing
- Articles (blog)
- Contact Us

**LEGAL:**
- Terms of Service
- Privacy Policy

**Social Media:** Twitter/X icon, LinkedIn icon

**Copyright:** "© 2026 All rights reserved by 409.AI."

### 22.8 Additional Public Page Elements

- **Intercom chat widget** — bottom-left on all pages (with proactive greeting message)
- **Decorative icon** — top-right corner (snowflake/geometric pattern)
- **Recent Activity toast** — bottom-right social proof popups cycling recent valuation starts

---

## 23. Accounting Software Integrations

> **This section was entirely missing from the original documentation.**

The platform integrates with **6 accounting software providers** to auto-import financial data during client onboarding, reducing manual document upload and data entry:

| Provider | Logo | Type |
|----------|------|------|
| **Xero** | ✓ | Cloud accounting |
| **QuickBooks** (Intuit) | ✓ | Cloud/desktop accounting |
| **FreshBooks** | ✓ | Cloud accounting/invoicing |
| **Oracle NetSuite** | ✓ | Enterprise ERP/accounting |
| **Sage** | ✓ | Cloud/desktop accounting |
| **Wave** | ✓ | Free cloud accounting |

**Integration purpose:** "Our onboarding connects with the software your business already uses, saving you hours of report generation time."

**Where referenced:**
- Landing page "Integrations" section
- Pricing page comparison table ("Software Integrations: QuickBooks, Xero, FreshBooks, and more")
- Onboarding flow Step 1 description ("connect your accounting software")

**Integration mechanism (inferred):** OAuth-based API connections during the onboarding flow that pull income statements, balance sheets, and financial metrics directly into the valuation data model.

---

## Appendix A: Complete URL/Route Map

| Route | Page | Section |
|-------|------|---------|
| `/sign_in` | Sign In | Auth |
| `/sign_up` | Sign Up | Auth |
| `/admin/dashboard` | Dashboard | Top-level |
| `/admin/overwrites_doc` | Documentation Explorer | Top-level |
| `/admin/package_explorer_doc` | Package Explorer | Top-level |
| `/admin/inbox` | Inbox | Top-level |
| `/admin/investor` | Sensitivity Dashboard | Top-level |
| `/admin/valuations` | Valuations List | Valuations |
| `/admin/reviews` | Reviews | Valuations |
| `/admin/partner_valuations` | Partner Valuations | Valuations |
| `/admin/meta_editor/:uuid` | Valuation Details | Per-valuation |
| `/admin/valuation_params/:uuid` | Valuation Params | Per-valuation |
| `/admin/ais/:uuid` | AI/Attachments | Per-valuation |
| `/admin/calculations/:uuid` | Calculations | Per-valuation |
| `/admin/editor/:uuid/edit` | Report Editor | Per-valuation |
| `/admin/users` | Users | Settings |
| `/admin/api_tokens` | API Tokens | Settings |
| `/admin/prompts` | Prompts | Settings |
| `/admin/communication_templates` | Templates | Settings |
| `/admin/auto_emails` | Auto Emails | Settings |
| `/admin/partners` | Partners | Settings |
| `/` | Landing Page | Public Website |
| `/pricing` | Pricing Calculator | Public Website |
| `/which-valuation` | Quiz Wizard | Public Website |
| `/compare/carta-409a-valuation-alternative` | Competitor Comparison | Public Website |
| `/compare/pulley-409a-valuation-alternative` | Competitor Comparison | Public Website |
| `/compare/kruze-409a-valuation-alternative` | Competitor Comparison | Public Website |
| `/compare/aicpa-409a-valuation-alternative` | Competitor Comparison | Public Website |
| `/compare/eqvista-409a-valuation-alternative` | Competitor Comparison | Public Website |
| `/compare/aranca-409a-valuation-alternative` | Competitor Comparison | Public Website |
| `/compare/andersen-409a-valuation-alternative` | Competitor Comparison | Public Website |
| `/about` | About Page | Public Website |
| `/contact` | Contact Page | Public Website |
| `/articles` | Blog Listing | Public Website |
| `/terms-of-service` | Terms of Service | Public Website |
| `/privacy-policy` | Privacy Policy | Public Website |
| `/products/409a-valuation` | Product Landing | Public Website |
| `/products/asc-718-valuation` | Product Landing | Public Website |
| `/products/irc-83b-valuation` | Product Landing | Public Website |
| `/products/smb-valuation` | Product Landing | Public Website |
| `/products/portfolio-valuation` | Product Landing | Public Website |
| `/products/nav-valuation` | Product Landing | Public Website |
| `/products/impairment-testing` | Product Landing | Public Website |
| `/products/tender-offer-valuation` | Product Landing | Public Website |
| `/products/estate-gift-tax-valuation` | Product Landing | Public Website |
| `/products/financial-reporting-valuation` | Product Landing | Public Website |
| `/products/audit-support` | Product Landing | Public Website |
| `/products/acquisition-valuation` | Product Landing | Public Website |
| `/products/ma-fairness-opinion` | Product Landing | Public Website |
| `/products/purchase-price-allocation` | Product Landing | Public Website |

## Appendix B: Feature Checklist

- [x] Client onboarding funnel (sign up, payment, document upload)
- [x] Google OAuth SSO + email/password auth
- [x] Password reset flow
- [x] Multi-product valuations (13 kinds) with versioned templates
- [x] Valuation lifecycle state machine + workflow engine (restartable)
- [x] Ops dashboard (stage × product pivot + pie charts)
- [x] Valuation worklist with rich filter/sort/scopes + CSV export
- [x] Analyst meta-editor (all valuation fields)
- [x] Valuation Params (multi-approach 409A methodology inputs)
- [x] Valuation Workbook (working model)
- [x] R-based calculation engine (OPM/income/market/asset, DLOM Chaffee/Finnerty, roll-forward)
- [x] Sensitivity analysis dashboard (OPM stress tables)
- [x] AI document ingestion + data extraction + comparable selection + param setting
- [x] AI prompt registry with multi-provider model routing (4 providers)
- [x] Cap-table anonymization (privacy-first AI pipeline)
- [x] Manual Overwrites system (68 fields) + self-documenting schema explorer
- [x] Report editor (HAML templates, section-based, version-tagged)
- [x] Report PDF rendering + download
- [x] Report version history
- [x] Review/task management (12 task types, assignment, SLA, dual signatures, publish)
- [x] Email inbox integrated to valuation comment threads
- [x] Unassigned email routing
- [x] Client chat per valuation
- [x] Sticky notes per valuation
- [x] Comments system (manual + email-generated)
- [x] Partner channel: API tokens + partner-scoped valuations
- [x] White-label partner subdomains
- [x] RBAC with 18+ roles
- [x] User management + CSV export
- [x] Communication templates (Handlebars/Mustache)
- [x] Auto email/SMS drip campaigns tied to lifecycle stages
- [x] Partner management with subdomain configuration
- [x] Marketing attribution (source, gclid, Google Ads)
- [x] Package/dependency explorer for the engine codebase (visNetwork)
- [x] Intercom support widget
- [x] Multi-jurisdiction support (US, UK, CA, AU, SG)
- [x] Cap table management (Captables sub-page)
- [x] Financial projections (Projections sub-page)
- [x] Historical financial data (Historical Data sub-page)
- [x] Financial statements (Finances sub-page)
- [x] Audit journals (Journals sub-page)
- [x] Team support notes (Team Support sub-page)
- [x] Amount raised / funding history
- [x] Transaction history (securities events)
- [x] Bot prompts per valuation (AI state tracking)
- [x] Bulk valuation actions (multi-select + bulk sidebar)
- [x] Unread tracking (admin + user read timestamps)
- [x] Company profile modal editor
- [x] Clone valuation (for roll-forwards / re-applications)
- [x] Reassign reviewer
- [x] Multiple recalculate triggers (accounting, bot, report-stage, report-prod)
- [x] Global search
- [x] Phone with country-code selector (international support)
- [x] Public marketing website with product pages (14 products)
- [x] Interactive pricing calculator with add-on options (Express Delivery, QSBS Letter)
- [x] "Which Valuation?" guided quiz wizard (10 product options)
- [x] 7 competitor comparison landing pages (vs Carta, Pulley, Kruze, AICPA, Eqvista, Aranca, Andersen)
- [x] 6 accounting software integrations (Xero, QuickBooks, FreshBooks, Oracle NetSuite, Sage, Wave)
- [x] Social proof real-time toasts on marketing pages
- [x] Animated live counters (valuations completed, hours saved, raised by clients)
- [x] Blog / articles section
- [x] Demo video modal on landing page
- [x] Network Items per valuation (sidebar sub-page)
- [x] Chat with badge counts per valuation (sidebar sub-page)
- [x] Unread / Ignored valuation list scope tabs

## Appendix C: Items NOT Directly Observed (Inferred)

These features are referenced in UI elements or field names but were not directly explored:

1. **Payment processor** — Likely Stripe (inferred from paid/amount/paid_at fields and pricing page checkout flow)
2. **E-signature provider** — Signature tasks exist but provider not directly observed
3. **Webhook/callback system** — Partner API likely supports webhooks
4. **Background job system** — Workflow engine implies Sidekiq or similar
5. **File storage** — Document uploads imply S3 or similar
6. **Valuation Workbook details** — Page exists but specific spreadsheet UI not explored
7. **Report PDF rendering engine** — PDF generation exists but rendering engine not identified
8. **Client dashboard** — Post-login client view not explored (admin session only)
9. **Mobile responsiveness** — Not tested
10. **Notification preferences** — Not directly observed
11. **Accounting OAuth flows** — 6 integrations listed but OAuth connection flows not directly tested
12. **Individual product landing pages** — 14 product URLs inferred from Products dropdown but not all individually visited
13. **Blog article detail pages** — `/articles` listing seen but individual article pages not explored
14. **Contact form submission** — Contact page likely exists but form not tested
15. **About page content** — Page URL inferred from footer navigation but not visited
