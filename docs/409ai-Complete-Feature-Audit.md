# 409.ai Complete Feature Audit

**Platform:** https://onboard.app.409.ai  
**Audit Date:** August 8, 2026  
**App Version:** 0.10.1  
**Purpose:** Document every feature, page, workflow, form field, and UI element so N409 has zero gaps.

---

## 1. Architecture Overview

- **Backend:** Ruby on Rails with HAML template rendering
- **Frontend:** Dark-themed admin dashboard (dark navy/charcoal background, gold/olive accent colors)
- **Auth:** Email/password + Google OAuth SSO
- **Routing:** UUID-based (`/admin/meta_editor/{UUID}`)
- **Versioning:** Valuations are versioned (e.g., `409a.v9`, `409a.v23`)
- **AI Integration:** Perplexity AI (standard + PRO providers), custom "Gandalf" AI engine
- **White-label:** Partner subdomain system with prepaid billing
- **Real-time:** Chat system per valuation, comment inbox

---

## 2. Global Navigation Structure

### 2.1 Top-Level Sidebar (Always Visible)

| Sidebar Item | Route | Description |
|---|---|---|
| Dashboard | `/admin/dashboard` | Valuation stage matrix overview |
| Documentation | `/admin/overwrites_doc` | Documentation page (returns 404 — broken) |
| Inbox | `/admin/inbox` | Valuation comments inbox with unread count |

### 2.2 Partner Section

| Item | Route | Description |
|---|---|---|
| Partner Valuation | `/admin/partner_valuations` | Partner-specific valuation list |

### 2.3 Valuations Section

| Item | Route | Badge | Description |
|---|---|---|---|
| Valuations | `/admin/valuations` | `984 / 5 unread` | Main valuation list with filters |
| Incomplete | `/admin/incomplete_valuations` | `361` | Unfinished client submissions |
| Unverified | `/admin/unfinished_valuations` | `2` | Submissions needing verification |
| In Progress | `/admin/reviewed_valuations` | `24 / 5 unread` | Valuations being worked on |
| Waiting On Cl... | `/admin/valuations?scope=waiting_on_client` | `22 / 5 unread` | Awaiting client input |
| Drafted | `/admin/drafted_valuations` | `40` | Draft reports ready for review |
| Published | `/admin/published_valuations` | `0` | Published/delivered reports |

### 2.4 Valuation-Scoped Sidebar (Per-Valuation Context)

Appears when viewing a specific valuation. Organized into sections:

**DATA Section:**

| Item | Route Pattern | Description |
|---|---|---|
| Details | `/admin/meta_editor/{UUID}` | Main valuation detail/edit page |
| Valuation Workbook | `/admin/valuation_workbook/{UUID}` | Multi-tab data workbook |
| Valuation Params | `/admin/valuation_params/{UUID}/edit?task_group=data` | Calculation parameters |
| Ai / Attachments | `/admin/ais/{UUID}` | AI analysis + file management |
| Bot Prompts | `/admin/bot_prompts/{UUID}?task_group=data` | AI prompt configuration |
| Network Items | `/admin/network_items/{UUID}` | API call logs |
| Captables | `/admin/captables/{UUID}` | Cap table management |
| Finances | `/admin/finances/{UUID}` | Financial data (historical, projections) |
| Chat | `/admin/chat/{UUID}` | Valuation-specific chat thread |
| Team Support | `/admin/memberships?vid={UUID}` | Team member management |

**REPORT Section:**

| Item | Route Pattern | Description |
|---|---|---|
| Calculations | `/admin/calculations/{UUID}` | Calculation engine results (shows X/Y progress) |
| Final Report | `/admin/editor/{UUID}/edit` | Report editor/viewer |
| Overwrites & Edits | `/admin/overwrites/{UUID}` | Data override audit trail |
| Versions | `/admin/report_versions/{UUID}?task_group=data` | Report version history |

### 2.5 Settings Section

| Item | Route | Description |
|---|---|---|
| Users | `/admin/users` | User management |
| API Tokens | `/admin/api_tokens` | API token management |
| Prompts | `/admin/prompts` | AI prompt templates |
| Communication Templates | `/admin/communication_templates` | Email/SMS templates |
| Auto Emails | `/admin/auto_emails` | Automated email sequences |
| Partners | `/admin/partners` | Partner/white-label management |
| Account | `/admin/account` | Account settings |

---

## 3. Dashboard (`/admin/dashboard`)

### 3.1 Valuation Stage Matrix

Grid layout showing valuation counts by stage across valuation types.

**Stages (columns):**
- Incomplete
- Unverified
- In Progress
- Waiting on Client
- Drafted
- Published

**Valuation Types (rows):**
- 409a
- 718
- FMV (Fair Market Value)
- Gifts
- IFRS2
- IP (Intellectual Property)
- NAV (Net Asset Value)

Each cell is clickable and shows the count of valuations in that stage/type combination.

### 3.2 Top Action Bar

Present on most pages:
- **Pending files** (badge with count) — files awaiting review
- **My tasks** (badge with count) — tasks assigned to current user
- **All tasks** (badge with count) — all open tasks
- **Chat {N}** — chat shortcut with count
- **Toggle actions sidebar** — shows/hides right sidebar

### 3.3 Right Sidebar (Actions Panel)

Appears on valuation-specific pages:
- **Waiting on client** checkbox
- **Other Valuations** — links to related valuations for same company
- **Sticky notes** textarea with "Save Note" and "New Comment" buttons
- **Notes & Comments** section (expandable)
- **Reassign To** button (blue)
- **Clone Valuation** button (blue)
- **Recalculate accounting** button (teal)
- **Recalculate bot** button (teal)
- **Recalculate report (stage)** button (green, on Valuation Params page)
- **Recalculate report (prod)** button (green, on Valuation Params page)

---

## 4. Valuations List (`/admin/valuations`)

### 4.1 Search & Filter Bar

**Filter fields:**
- Search text input
- Kind dropdown (409a, 718, FMV, Gifts, IFRS2, IP, NAV)
- State dropdown (valuation states/stages)
- Source dropdown
- Scope tabs/links for filtered views

**Scope URL parameters:**
- `?scope=drafted_or_published`
- `?scope=waiting_on_client`
- `?scope=unread`

### 4.2 Valuation List Table

**Columns:**
- # (valuation number, e.g., #1777)
- Company name
- Kind (e.g., 409a)
- State/Stage
- Version (e.g., v9, v23)
- Date fields
- Status indicators

### 4.3 New Valuation

- "New Valuation" button (role-restricted — returns "Access Denied" for some roles)
- Route: `/admin/valuations/new`

---

## 5. Valuation Detail / Meta Editor (`/admin/meta_editor/{UUID}`)

### 5.1 Header

- Company name with valuation number and version (e.g., "#1777.v9 (409a)")
- Breadcrumb: Home / Valuations / Editing Valuation
- "Save Valuation" button (top-right, green)

### 5.2 Valuation Fields

**Core fields (from valuation detail page):**
- Company name
- Valuation type/kind (409a, 718, FMV, etc.)
- Valuation date
- State/stage
- Version number
- UUID identifier
- Assigned appraiser
- Partner association

### 5.3 Reapplication Workflow

- "Reapply" functionality for repeat/rolling valuations
- Rolling Forward flag (YES/NO)
- Links to previous valuations for the same company

---

## 6. Valuation Workbook (`/admin/valuation_workbook/{UUID}`)

Multi-tab workbook interface with the following tabs:

### 6.1 Summary Tab
- Key valuation results overview
- Final value display

### 6.2 Company Tab
- Company information and overview
- Business description
- Revenue status
- Latest funding round details

### 6.3 Captable Tab
- Equity structure with share classes
- Issued On, Type, Seniority, Stakeholder, Foot Notes, Price, Fully Diluted columns
- Checkbox selection for active entries

### 6.4 Accounting Tab
- Financial data summary
- Sunk cost information
- Asset values

### 6.5 Market Tab
- Public comparable companies data
- Market multiples
- Revenue/EBITDA comparisons

### 6.6 Weights Tab
- Valuation methodology weightings
- Asset/OPM/Income/Market weight allocation

### 6.7 Allocation Tab
- Equity allocation results
- Black-Scholes model inputs
- Volatility calculations

### 6.8 DLOM Tab
- Discount for Lack of Marketability calculations
- Qualitative, Chaffee, and Finnerty model results

### 6.9 Result Tab
- Final valuation conclusion
- Per-share/per-unit value

---

## 7. Valuation Params (`/admin/valuation_params/{UUID}/edit?task_group=data`)

Editable calculation parameters that drive the valuation engine.

### 7.1 Overview Section

| Field | Type | Example |
|---|---|---|
| Rolling Forward | Text (YES/NO) | NO |
| Inception date | Date | 2025-03-05 |
| Exit Timeline | Date | 2029-07-14 |
| Overview written by the business | Text | (company description) |
| Company revenue status | Text | Pre-Revenue |
| When was the latest round? | Text | Common Stock issued:2025-03-05 |
| Last year revenue | Currency | $0.00 |
| YTD Revenue | Currency | $0.00 |
| Runway in months | Number | 0 |

### 7.2 Weights Section

| Field | Type | Example |
|---|---|---|
| Asset | Number | 1.0 |
| Opm | Number | 0.0 |
| Income | Number | 0.0 |
| Market | Number | 0.0 |

### 7.3 DLOC Section

| Field | Type | Example |
|---|---|---|
| DLOC (Example 0.1 for 10%) | Number | 0 |

### 7.4 DLOM Section

| Field | Type | Example |
|---|---|---|
| Qualitative | Number | 1.0 |
| Qualitative discount | Number | 0.2 |
| Chaffee | Number | 0.0 |
| Finnerty | Number | 0.0 |

### 7.5 Market Approach

| Field | Type | Options/Example |
|---|---|---|
| Market approach method | Radio | Revenue / Ebitda |
| Market approach ltm | Number | 1 |
| Market approach ntm | Number | 0 |
| Use custom ranges | Checkbox | unchecked |

### 7.6 Asset Approach

| Field | Type | Options/Example |
|---|---|---|
| Asset approach | Radio | Cost to replicate method / Net asset value method |
| Sunk cost type | Dropdown | Amount ($) |
| Sunk Cost | Number | 467179.0 |
| VC ROR | Number | 0.25 |

### 7.7 Dates

| Field | Type | Example |
|---|---|---|
| Exit timeline | Date picker | 07/14/2029 |
| Valuation date | Date picker | 07/15/2026 |
| Roll Forward? | Checkbox | unchecked |

### 7.8 Action Buttons (Right Sidebar)

- **Recalculate bot** — re-runs AI analysis
- **Recalculate report (stage)** — regenerates staging report
- **Recalculate report (prod)** — regenerates production report

---

## 8. AI / Attachments (`/admin/ais/{UUID}`)

### 8.1 AI Analysis Tools

Four AI-powered analysis modules:

1. **Missing Data** — Identifies gaps in submitted data
2. **Data Extraction** — Extracts structured data from uploaded documents
3. **Public Comparables** — Finds comparable public companies
4. **Report Reviewer** — AI review of draft report quality

### 8.2 File Attachments

- File upload interface
- Attachment list with metadata
- "Pending files" badge system for unreviewed uploads

---

## 9. Bot Prompts (`/admin/bot_prompts/{UUID}?task_group=data`)

### 9.1 Task Groups

Prompts organized by `task_group` parameter:
- `data` — data analysis prompts
- (potentially others)

### 9.2 Prompt Configuration

- Configurable AI prompts per valuation
- Provider selection (Perplexity, Perplexity PRO)
- Prompt text editing
- Response viewing

---

## 10. Calculations (`/admin/calculations/{UUID}`)

### 10.1 Calculation Engine

- Progress indicator: "5/5" format showing completed/total calculations
- Refresh/recalculate button (circular arrow icon)
- Five calculation steps executed by the "Gandalf" engine

### 10.2 Gandalf Engine API Calls

Based on Network Items data, the engine makes these API calls:
1. **gandalf aggregate** — aggregates valuation data
2. **gandalf accounting** — processes financial/accounting data
3. **gandalf market** — runs market approach calculations
4. **gandalf weights** — applies methodology weightings
5. **gandalf render** — generates report content

Each call has JSON request/response payloads viewable in Network Items.

---

## 11. Network Items (`/admin/network_items/{UUID}`)

### 11.1 Tabs

| Tab | Description | Example Count |
|---|---|---|
| Ai | AI/Gandalf engine calls | 5 |
| Ivolatility | Volatility data API calls | 24 |
| Perplexity | Standard Perplexity AI calls | 1 |
| Perplexity Pro | Perplexity PRO API calls | 3 |
| All | All network items combined | 33 |

### 11.2 Table Columns

- **Created At** — timestamp
- **Name** — API endpoint name (e.g., "gandalf aggregate")
- **Request** — JSON | RAW view links
- **Response** — JSON | RAW view links
- **ID / Status** — request ID and HTTP status code

---

## 12. Report Editor (`/admin/editor/{UUID}/edit`)

### 12.1 Report Structure (409A Valuation Report)

Full report rendered as HAML templates with section-level edit controls (eye icon for visibility, edit icon for editing).

**Complete Report Sections:**

1. **Engagement Letter & Summary of Findings**
   - 1.1 Objective and Scope
   - 1.2 Summary of Findings
2. **Table of Contents** (auto-generated)
3. **Engagement Details**
   - 3.1 Company Engagement and Date of Valuation
   - 3.2 Engagement Purpose and Scope
   - 3.3 Standard of Value
   - 3.4 Premise of Value
4. **Company Overview** (company description)
5. **Economic Outlook**
6. **Valuation Methodology**
   - 6.1 Asset Approach
   - 6.2 Income Approach
   - 6.3 Market Approach
7. **Valuation Methods Calculated**
   - 7.1 Asset Approach
   - 7.2 Income Approach
   - 7.3 Market Approach
   - 7.4 Market Approach - Backsolve Calculation
8. **Blended Equity Weightings and Results**
   - 8.1 Adjustment Factor: Market Movement
   - 8.2 Valuation Weightings and Results
   - 8.3 Blended Equity Value
9. **Equity Allocation**
   - 9.1 Understanding Capital Structure
   - 9.2 Input Value (Black-Scholes)
   - 9.3 Selected Volatility
   - 9.4 Conclusion Pre DLOM
10. **Discount for Lack of Marketability**
    - 10.1 Quantitative Analysis: Stout Restricted Stock Study
    - 10.2 Qualitative Analysis: Option Based Methods
    - 10.3 Chaffee Approach
    - 10.4 Finnerty Approach
    - 10.5 Class Volatility Calculations
    - 10.6 Summary of DLOM & Conclusion of Value
11. **Valuation Analyst Representation**
    - 11.1 Valuation Representation
12. **Conclusion**
    - 12.1 Purpose of Report
    - 12.2 Assumptions
    - 12.3 Limiting Conditions
    - 12.4 Use of Report
    - 12.5 Distribution
    - 12.6 Subsequent Events
    - 12.7 Legal Matters
    - 12.8 Testimony

### 12.2 Report UI Features

- **Cover page** — "409A VALUATION REPORT" title, company name, value display
- **Value display** — highlighted box showing final value (e.g., "$19,625.228 Value Per 1% Membership Interest")
- **Appraiser signatures** — Primary Appraiser and Contributing Appraiser with digital signatures, names, and titles
- **Section visibility toggles** — eye icon per section to show/hide
- **Section edit links** — external link icon to edit section content
- **PDF download** — Adobe PDF icon (bottom-right) for PDF export
- **Template variables** — dynamic content populated from valuation data

### 12.3 Report Rendering

- HAML-based templates with Ruby on Rails backend
- Template variable substitution for company name, dates, values, etc.
- Rendering errors shown inline when data is incomplete (e.g., "no implicit conversion of nil into String")

---

## 13. Captables (`/admin/captables/{UUID}`)

### 13.1 Tabs

- **Valuation Date** — shares as of valuation date
- **Transaction Date** — shares by transaction date
- **Transaction History** — historical transactions

### 13.2 Table Columns

| Column | Description |
|---|---|
| Issued On | Date shares were issued |
| Type | Security type (Common Stock, Preferred, Options, etc.) |
| Seniority | Liquidation seniority ranking |
| Stakeholder | Holder name or class description |
| Foot Notes | Additional notes (voting rights, membership interest details) |
| Price | Price per share/unit |
| Fully Diluted | Fully diluted share count |

### 13.3 Actions per Row

- **Add note** button (green)
- **Edit** button (yellow)
- **Delete** button (red)

---

## 14. Finances (`/admin/finances/{UUID}`)

### 14.1 Tabs

- **Historical** — past financial data
- **Projections** — forward-looking financial projections
- **Accounting Connection** — external accounting system integration

### 14.2 Data Import

- File upload (Choose File button)
- **Import** button
- **Actions** dropdown menu

### 14.3 Financial Data Columns

- Year
- Total Revenue
- Total Cost of Sales
- Gross Profit
- Operating Expenses
- EBITDA
- Other Expenses
- Net Income
- Cash and Equivalents (truncated in UI as "Cash an...")

---

## 15. Overwrites & Edits (`/admin/overwrites/{UUID}`)

### 15.1 Tabs

- **Overwrites** — manual value overrides
- **Edits** — edit history
- **All Overwrites** — combined view

### 15.2 Overwrite Table Columns

| Column | Description |
|---|---|
| Key | Dot-notation path (e.g., `insights.comparables.symbol`) |
| Value | Override value |
| Comment | Optional comment |
| Creator | User who made the change |
| Time | Timestamp |
| Delete | Delete button per row |

### 15.3 Common Override Keys

- `insights.comparables.symbol` — public comparable stock symbols
- `insights.weights.weights` — methodology weightings hash
- `insights.weights.marketApproachMethod` — market approach method
- `insights.weights.assetApproachMethod` — asset approach method
- `insights.weights.marketApproachLTM` — LTM market flag
- `insights.weights.marketApproachNTM` — NTM market flag
- `insights.accounting.sunkCost` — sunk cost value
- `insights.accounting.ROR` — rate of return

---

## 16. Report Versions (`/admin/report_versions/{UUID}?task_group=data`)

### 16.1 Version Table

| Column | Description |
|---|---|
| Select | Checkbox for version selection |
| Version Number | Auto-incrementing version (e.g., 5, 7, 9) |
| Created At | Timestamp of version creation |
| Current? | Flag indicating active version |

Versions are not necessarily sequential (gaps possible: v5 → v7 → v9).

---

## 17. Team Support / Memberships (`/admin/memberships?vid={UUID}`)

### 17.1 Membership Table

| Column | Description |
|---|---|
| First name | Team member first name |
| Last name | Team member last name |
| Email | Team member email |
| First login | Date of first login |

### 17.2 Actions

- **New team member** button (top-right, green)

---

## 18. Chat (`/admin/chat/{UUID}`)

### 18.1 Features

- Per-valuation chat thread
- Unread message count badge
- Real-time messaging interface
- Accessible from both sidebar and top action bar ("Chat {N}" button)

---

## 19. User Management (`/admin/users`)

### 19.1 User List

- Searchable/filterable user list
- User details: name, email, role, status

### 19.2 Roles System

16+ roles observed in the system:
- Admin
- Appraiser
- Analyst
- Reviewer
- Partner
- Client
- Team Member
- (and others — role-based access controls throughout)

### 19.3 Role-Based Access

- Certain routes return "Access Denied" for insufficient roles (e.g., `/admin/valuations/new`)
- Sidebar items show/hide based on role
- Action buttons conditionally visible

---

## 20. API Tokens (`/admin/api_tokens`)

### 20.1 Token Management

- Create new API tokens
- List existing tokens
- Token details (name, key, permissions)
- Delete/revoke tokens

---

## 21. AI Prompt Management (`/admin/prompts`)

### 21.1 Prompt Templates

- Configurable AI prompts used by the valuation engine
- Provider configuration (Perplexity, Perplexity PRO)
- Task group organization
- Prompt text with template variables

---

## 22. Communication Templates (`/admin/communication_templates`)

### 22.1 Email Templates

- HTML email templates with template variables
- Stage-triggered template association
- Template variable system for dynamic content

### 22.2 Template Variable System

Variables available for dynamic substitution in templates (based on valuation and user data):
- Company name
- Valuation date
- Valuation number
- User name/email
- Report links
- Status information

---

## 23. Auto Emails (`/admin/auto_emails`)

### 23.1 Automated Email Sequences

- Stage-triggered email automation
- Configurable delay/timing
- Template association
- Enable/disable per sequence

### 23.2 Trigger Points

Emails can be triggered by valuation stage transitions:
- New submission → Welcome email
- Incomplete → Reminder
- In Progress → Status update
- Drafted → Review notification
- Published → Delivery notification

---

## 24. Partners (`/admin/partners`)

### 24.1 Partner Management

- White-label partner system
- Partner creation and editing
- Subdomain configuration
- Branding customization

### 24.2 Partner Billing

- Prepaid credit system
- Per-valuation pricing
- Usage tracking

### 24.3 Partner Valuations (`/admin/partner_valuations`)

- Filtered view of valuations by partner
- Partner-specific metrics

---

## 25. Account Settings (`/admin/account`)

### 25.1 Settings

- Account profile management
- Password change
- Notification preferences
- SSO configuration (Google OAuth)

---

## 26. Inbox (`/admin/inbox`)

### 26.1 Comment Inbox

- Aggregated view of all valuation comments/notes
- Unread count badge
- Quick navigation to source valuation

---

## 27. Valuation Workflow

### 27.1 Lifecycle Stages

```
Client Submission → Incomplete → Unverified → In Progress → Waiting on Client → Drafted → Published
```

### 27.2 Stage Transitions

1. **Client submits** via onboarding form → Status: Incomplete
2. **Data verified** by analyst → Status: Unverified → In Progress
3. **Analysis begins** → Bot prompts run, calculations execute
4. **Client follow-up** needed → Status: Waiting on Client
5. **Report drafted** → Status: Drafted (report generated)
6. **Review & approval** → Appraiser signs
7. **Published** → Status: Published (client can download)

### 27.3 Reapplication Flow

- Companies can reapply for updated valuations
- Previous valuation data carries forward
- "Rolling Forward" flag controls data inheritance
- Version number increments (e.g., v9 → v10)

---

## 28. Valuation Methodology Engine

### 28.1 Approaches Supported

1. **Asset Approach**
   - Cost to replicate method
   - Net asset value method
   - Sunk cost calculation (Amount $ or Percentage)

2. **Income Approach**
   - DCF (Discounted Cash Flow)
   - VC ROR (Venture Capital Rate of Return)

3. **Market Approach**
   - Revenue multiples (LTM and/or NTM)
   - EBITDA multiples
   - Backsolve calculation
   - Public comparable companies analysis

4. **OPM (Option Pricing Model)**
   - Black-Scholes model
   - Volatility analysis (iVolatility data source)
   - Capital structure allocation

### 28.2 Weighting System

- Each approach assigned a weight (0.0 to 1.0)
- Weights must sum to 1.0
- Blended equity value calculated from weighted approaches
- Market movement adjustment factor applied

### 28.3 DLOM (Discount for Lack of Marketability)

Three models supported with configurable weights:
1. **Qualitative** — qualitative discount percentage
2. **Chaffee** — Chaffee put option model
3. **Finnerty** — Finnerty average-strike put option model

Additional DLOM components:
- Stout Restricted Stock Study (quantitative)
- Class Volatility Calculations

### 28.4 DLOC (Discount for Lack of Control)

- Percentage-based discount (e.g., 0.1 = 10%)

### 28.5 External Data Sources

- **iVolatility** — historical volatility data (24 API calls observed)
- **Perplexity AI** — market research and comparable company analysis
- **Perplexity PRO** — enhanced AI research capabilities

---

## 29. UI Patterns & Components

### 29.1 Layout

- **Sidebar navigation** — collapsible, dark theme, with badge counts
- **Main content area** — white/dark content, scrollable
- **Right sidebar** — contextual actions panel (togglable)
- **Breadcrumbs** — Home / Section / Subsection navigation
- **Top header** — user menu, notifications (unread mail badge), search icon

### 29.2 Common UI Elements

- **Green action buttons** — primary actions (Save, Import, New)
- **Blue buttons** — secondary actions (Reassign, Clone)
- **Teal buttons** — calculation actions (Recalculate)
- **Yellow buttons** — edit actions
- **Red buttons** — delete/destructive actions
- **Badge counts** — numeric badges on sidebar items (gold/olive)
- **Unread indicators** — "X / Y unread" format
- **Tab interfaces** — horizontal tabs for sub-views
- **Table views** — sortable columns with action buttons
- **Date pickers** — calendar icon with date input
- **Radio buttons** — for mutually exclusive options
- **Checkboxes** — for boolean toggles
- **Dropdown selects** — for enumerated options
- **Text inputs** — standard form fields
- **Textarea** — multi-line text (sticky notes, comments)
- **File upload** — "Choose File" with Import button
- **JSON/RAW viewers** — for API request/response inspection

### 29.3 User Header

- Username display with dropdown (e.g., "Akshay Arora")
- Unread mail notification badge (e.g., "5 unread")
- User avatar/icon
- Search icon (magnifying glass)
- Settings icon

### 29.4 Footer

- "Powered by 409.ai"
- Version display (e.g., "Version: 0.10.1")

---

## 30. Valuation Types

| Type | Code | Description |
|---|---|---|
| 409A | 409a | IRS Section 409A fair market value (most common) |
| 718 | 718 | ASC 718 stock compensation valuation |
| FMV | fmv | General fair market value |
| Gifts | gifts | Gift tax valuation |
| IFRS2 | ifrs2 | International financial reporting standard for share-based payments |
| IP | ip | Intellectual property valuation |
| NAV | nav | Net asset value |

---

## 31. Key Data Structures

### 31.1 Valuation Object

```
{
  id: Integer (e.g., 1777),
  uuid: String (e.g., "01KX838M8QJN8222VTNYHGA2JV"),
  kind: String (409a, 718, fmv, gifts, ifrs2, ip, nav),
  state: String (lifecycle stage),
  version: Integer (e.g., 9),
  version_label: String (e.g., "409a.v9"),
  company_name: String,
  valuation_date: Date,
  inception_date: Date,
  exit_timeline: Date,
  partner_id: Reference,
  assigned_to: Reference (user),
  rolling_forward: Boolean,
  created_at: DateTime,
  updated_at: DateTime
}
```

### 31.2 Overwrite Object

```
{
  key: String (dot-notation path, e.g., "insights.weights.weights"),
  value: Mixed (string, number, hash, array),
  comment: String (optional),
  creator: String (user name),
  time: DateTime
}
```

### 31.3 Network Item Object

```
{
  id: Integer,
  name: String (e.g., "gandalf aggregate"),
  provider: String (ai, ivolatility, perplexity, perplexity_pro),
  request: JSON,
  response: JSON,
  status: Integer (HTTP status code),
  created_at: DateTime
}
```

### 31.4 Cap Table Entry

```
{
  issued_on: Date,
  type: String (Common Stock, Preferred, Options, Warrants),
  seniority: Integer,
  stakeholder: String,
  foot_notes: Text,
  price: Decimal,
  fully_diluted: Decimal,
  selected: Boolean (checkbox)
}
```

### 31.5 Finance Record

```
{
  year: Integer,
  total_revenue: Decimal,
  total_cost_of_sales: Decimal,
  gross_profit: Decimal,
  operating_expenses: Decimal,
  ebitda: Decimal,
  other_expenses: Decimal,
  net_income: Decimal,
  cash_and_equivalents: Decimal,
  type: String (historical, projection)
}
```

---

## 32. API & Integration Points

### 32.1 Internal API Endpoints (Gandalf Engine)

| Endpoint | Purpose |
|---|---|
| gandalf/aggregate | Aggregate valuation data |
| gandalf/accounting | Process financial data |
| gandalf/market | Market approach calculations |
| gandalf/weights | Apply methodology weights |
| gandalf/render | Generate report content |

### 32.2 External Integrations

| Service | Purpose |
|---|---|
| Perplexity AI | AI-powered research (standard) |
| Perplexity PRO | Enhanced AI research |
| iVolatility | Historical volatility data for equity allocation |
| Google OAuth | SSO authentication |

### 32.3 API Token System

- Token-based API authentication
- Managed at `/admin/api_tokens`
- Create/delete/list operations

---

## 33. Known Issues & Observations

1. **Documentation link broken** — `/admin/overwrites_doc` returns 404
2. **Role restrictions** — `/admin/valuations/new` returns "Access Denied" for non-admin roles
3. **Report rendering errors** — incomplete valuations show "no implicit conversion of nil into String" and "invalid date" errors in the report editor
4. **URL pattern inconsistency** — Chat uses singular `/admin/chat/{UUID}` while most others use plural (e.g., `/admin/captables/`)
5. **Version numbering gaps** — report versions can have gaps (v5 → v7 → v9)
6. **Truncated column headers** — "Cash an..." in Finances table (responsive issue)
7. **Sidebar scroll** — long sidebar navigation requires scrolling; some items hidden below fold

---

## 34. Feature Checklist for N409 Parity

### Must-Have Features

- [ ] Multi-type valuation support (409a, 718, FMV, Gifts, IFRS2, IP, NAV)
- [ ] UUID-based routing
- [ ] Valuation lifecycle workflow (Incomplete → Published)
- [ ] Dashboard with stage matrix
- [ ] Valuation Workbook with multi-tab interface
- [ ] Valuation Params editor with all calculation fields
- [ ] Cap table management (Valuation Date, Transaction Date, Transaction History)
- [ ] Financial data management (Historical, Projections, Accounting Connection)
- [ ] Report generation engine (12-section 409A report with HAML templates)
- [ ] Report versioning system
- [ ] Calculation engine (5-step Gandalf pipeline)
- [ ] DLOM calculations (Qualitative, Chaffee, Finnerty)
- [ ] DLOC calculations
- [ ] Market approach (Revenue/EBITDA, LTM/NTM, Backsolve)
- [ ] Asset approach (Cost to replicate, Net asset value)
- [ ] Income approach
- [ ] OPM (Option Pricing Model) with Black-Scholes
- [ ] Weighted blended equity valuation
- [ ] Overwrites & Edits system with audit trail
- [ ] AI/Attachments with Missing Data, Data Extraction, Public Comparables, Report Reviewer
- [ ] Bot Prompts configuration (Perplexity + Perplexity PRO)
- [ ] Network Items logging (API call audit)
- [ ] Chat system per valuation
- [ ] Team Support/Memberships per valuation
- [ ] PDF report export
- [ ] Appraiser digital signatures
- [ ] User management with role-based access (16+ roles)
- [ ] API token management
- [ ] Communication templates with variable system
- [ ] Auto email sequences (stage-triggered)
- [ ] Partner/white-label system with subdomain support
- [ ] Reapplication/rolling forward workflow
- [ ] Comment inbox
- [ ] Sticky notes and comments per valuation
- [ ] Search and filtering across valuations
- [ ] Pending files management
- [ ] Task management system (My tasks, All tasks)
- [ ] Reassign To functionality
- [ ] Clone Valuation functionality
- [ ] Recalculate actions (bot, report stage, report prod, accounting)
- [ ] SSO (Google OAuth)

---

*End of Audit*
