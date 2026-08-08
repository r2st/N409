# 409.ai Application Screenshot Catalog

**Date:** August 7, 2026
**Application:** https://onboard.app.409.ai (Admin Dashboard)
**Logged in as:** Akshay Arora (aarora@409.ai)
**Version:** 0.10.1

---

## Application Overview

409.ai is a valuation services platform providing 409A, ASC 718, ASC 820, FMV, Gifts, IFRS2, IP, and NAV valuations. The admin dashboard at `onboard.app.409.ai` is a Rails-based application with a dark-themed sidebar navigation.

---

## Sidebar Navigation Structure

### PARTNER Section
- **Dashboard** — Main admin overview
- **Documentation** — Opens Overwrites Explorer in new tab
- **Inbox** — Valuation Comments listing (2 unread)
- **Partner Valuation** — Partner-scoped valuation listing

### VALUATIONS Section
- **Valuations** — All valuations (979 total, 6 unread)
- **Incomplete** — 359 incomplete valuations
- **Unverified** — 2 unverified
- **In Progress** — 21 (4 unread)
- **Waiting On...** — 22 (6 unread)
- **Drafted** — 41
- **Published** — 0

### SETTINGS Section
- **Users** — User management
- **API Tokens** — API credential management
- **Prompts** — AI prompt configuration
- **Templates** — Email template management
- **Auto Emails** — Automated email/SMS sequences
- **Partners** — Partner organization management

### Per-Valuation Sidebar (visible when viewing a specific valuation)

#### REPORT
- Calculations (with count badge, e.g. 0/5, and refresh button)
- Report Editor (with version badge, e.g. #1861.v0)
- Report PDF
- Overwrites & Edits (with count badge)
- Versions

#### DATA
- Details
- Valuation Workbook
- Valuation Params
- Ai/Attachments
- Bot Prompts
- Network Items
- Captables
- Finances
- Chat

---

## Screenshots Captured

### 1. Login & Authentication
- **Login page** — Sign-in form at `/sign_in` with email/password fields

### 2. Dashboard
- **Main dashboard** — Overview with valuation stats, recent activity
- **Dashboard scrolled** — Additional dashboard content below the fold

### 3. Valuations Listing (Admin View)
- **All Valuations** — 979 total with tabs: All, Incomplete (317), Unverified (17), In Progress (29), Drafted (41), Published (575), Unread (6), Waiting On Client (22), Ignored (326)
- **Valuation cards** — Each shows: Action badge, ID, kind, UUID, payment status, company, user, email, phone, dates (Created, Started, Completed, Due, Drafted, Published), message count

### 4. Partner Valuation Listing
- **Partner Valuation view** — 349 total with tabs: All, Incomplete (26), Unverified (5), In Progress (17), Drafted (12), Published (294), Unread (140), Waiting On Client (7)
- **In Progress filter** — Filtered view showing 17 in-progress valuations
- **Sort & Search sidebar** — Sort by Created at (Asc/Desc), search by UUID, Company Name, User Email, User First/Last Name, Partner

### 5. Valuation Detail View — Valuation #1 (from previous session)
- **Details tab** — User & Business Info, Application Details (UUID, Status, State, Kind), Dates section, Comments
- **Calculations tab** — Calculation engine interface
- **Report Editor** — HAML template editor with report content
- **Overwrites & Edits** — Override fields for valuation parameters
- **Workbook Editor** — 4 tabs: Company Overview, Captable, Financials, Valuation Params
- **Ai/Attachments** — Document upload interface with 13+ document categories
- **Bot Prompts** — AI bot prompt management per valuation
- **Network Items** — Network/comparable items list
- **Captables** — Cap table data entry
- **Finances** — Financial data entry
- **Chat** — Internal chat/communication

### 6. Valuation Detail View — Valuation #1861 (Assembler AI Technology Inc.)
- **Details page (top)** — User & Business Info: Bretislav Beranek, brett.beranek@assembler-ai.com, 14387797738, Company: Assembler AI Technology Inc., Report requestor: Brett Beranek CEO
- **Application Details** — UUID: 01KZ9GPKSH30CS7GZR0RT8KMDF, Status: Verifying submitted data, State: Work in progress, Kind: 409a
- **Dates section** — Valuation started: 2026-08-05, Onboarding completed: 2026-08-07, Valuation date: 2026-08-07
- **Comments section** — 2 automated emails from Adam Czach (In Progress notification and welcome email)
- **Top-right action buttons** — Pending files (2), My tasks (0), All tasks (2), Chat 2

### 7. Workbook Editor Tabs (from previous session)
- **Company Overview** — Company information fields
- **Captable** — Cap table data with share classes
- **Financials** — Financial projections/historical data
- **Valuation Params** — Valuation methodology parameters

### 8. Report Preview/Generation (from previous session)
- **Report Editor** — HAML template rendering with report sections
- **Report PDF** — Opens as chrome-extension:// URL (not screenshotable)

### 9. Overwrite/Override Configuration (from previous session)
- **Overwrites Explorer** — 68 configurable fields across 6 categories, opened via Documentation sidebar link
- All 6 overwrite categories paginated and captured

### 10. Document Upload Interface (from previous session)
- **Ai/Attachments page** — Document upload with dropdown showing 13+ categories:
  - Cap table, Financial, Corporate documents, Pitch deck, IP, Misc, Articles of incorporation, Shareholder agreement, Stock option plan, Board resolution, Certificate of good standing, Bylaws, Operating agreement, and more

### 11. Users Management
- **Users listing** — 1,402 total users with role-based tabs: All (1,402), Valuation Users (1,245), Admin (47), Auto (4), Contributing Reviewer (1), Data (2), Data Supervisor (1), God (8), Investor (0), Main Reviewer (1), Member (109), Partner (29), Reviewer (14), Spa (9), Supervisor (1), Support (2), Support Supervisor (0), Ignored (26)
- **User table columns** — ID, First name, Last name, Email, Roles, Partner, Phone, Verified, SSO
- **Search sidebar** — ID, Partner, User Email, User First Name, User Last Name, User Phone, Verified, SSO Provider
- **Actions** — Download CSV, Toggle actions sidebar, + button for new user

### 12. API Tokens
- **API Tokens listing** — 4 API tokens total
  - Alex Bretherton / Vestd / API_VESTD
  - Promissory Production / Promissory / PROMI
  - Blake Marcotte / DonateEquity / DONATEQ
  - Reins Admin / Reins / ReinsKey
- **Columns** — User, Partner, Client, Client secret (masked)

### 13. Prompts (AI Configuration)
- **Prompts listing** — 20 prompts total with search sidebar (Name, Content)
- **Bot providers used:**
  - perplexity (older prompts, Oct 2024)
  - perplexity-PRO (majority of prompts)
  - bedrock-SONNET35 (1 prompt)
  - Anthropic-SONNET_5 (newer, May-Jul 2026)
  - Anthropic-OPUS_4_8 (newer, Jun-Jul 2026)
  - Anthropic-HAIKU_4_5 (1 prompt)
- **Prompt names include:**
  - industry_outlook, market_au/si/us/ca/uk/un, competitor, company_overview, industry_overview
  - AI:FindRelevantTags, Ai:AnoymizeCaptable, Industry_finder
  - FIND_MAPPING_AND_SOURCES, FIND_COMPARABLES, MISSING_DATA_SUMMARY
  - SUMMARIZE_ATTACHMENT, SET_VALUATION_PARAMS, CREATE_MISSING_ENTRIES, REVIEW_REPORT

### 14. Email Templates
- **Templates listing** — 12 email templates at `/admin/communication_templates`
- **Templates by category:**
  - Incomplete: InviteLink-raw, Valuation Link-Raw, payment link-raw, Invite Client, Partner Confirmation Email, Renewal Followup, Invite Client-Fidelity, Sample Report-raw, Customer feedback
  - Drafted: Send Draft
  - Unverified: Customer Paid-Follow Up
  - Published: Final Report
- **Columns** — ID, Name, Subject, Content, Category, Created at, Updated at
- **Template variables** — {{invitation_link}}, {{valuation_link}}, {{payment_link}}, {{user_first_name}}, {{sample_report}}

### 15. Auto Emails (Notification Sequences)
- **Auto Emails listing** — 27 total, with tabs: All (27), Email (21), SMS (6)
- **Email sequences by category:**
  - Incomplete: incomplete_1 through incomplete_5, payment_1 through payment_9
  - Drafted: drafted_1 through drafted_4
  - Unverified: unverified_1
  - In Progress: in_progress_1
  - Published: published_1
- **SMS messages:** SMS 1-6 (incomplete_sms_1 through incomplete_sms_6)
- **Columns** — ID, Subject, Name, Content, Category, Channel, Promotional (checkbox), Created at, Updated at
- **Promotional flags** — Several emails marked as promotional (green checkmarks)

### 16. Partners
- **Partners listing** — 24 partners total
- **Columns** — ID, Name, Subdomain, Prepaid, Cc emails
- **Partners include:** dummy, Fidelity (fmr), Reins, Nexusvc, Promissory, DeepFlows, Gust, DonateEquity, kjk, Hexa, fairmint, bookandstreet, Waterstonecapital, cake, Vestd, Initiocapital, Mantis, DealCycl, Sundial, mantle, OWM, JPM, Seedlegals, Futureproof
- **Prepaid status** — Mix of true/false/None
- **CC emails** — Some partners have CC email addresses configured (Fidelity: filings.pvt@fmr.com, Promissory: monica@promissory.com, Vestd: 409a@vestd.com)

### 17. Inbox (Valuation Comments)
- **Inbox listing** — 1 valuation comment displayed
- **Columns** — Thread, Body, User, Kind, Valuation
- **Thread from** Yash Gawande (email kind)

### 18. Overwrites Explorer (Documentation)
- **Overwrites Explorer** — Opened in separate tab at `/admin/overwrites_doc`
- **68 fields across 6 categories** — All categories paginated and captured

### 19. Intake Wizard / New Valuation
- **Not accessible from admin panel** — `/admin/valuations/new` returns "Access Denied", `/admin/partner_valuations/new` returns 500 error
- **Note:** The intake wizard is a client-facing flow, not available through the admin dashboard

---

## Key Data Points Observed

| Metric | Count |
|--------|-------|
| Total Valuations | 979 |
| Published Valuations | 575 |
| Incomplete Valuations | 317 |
| Ignored Valuations | 326 |
| Total Users | 1,402 |
| Valuation Users | 1,245 |
| Admin Users | 47 |
| Partners | 24 |
| API Tokens | 4 |
| AI Prompts | 20 |
| Email Templates | 12 |
| Auto Emails | 27 (21 Email + 6 SMS) |
| Overwrite Fields | 68 across 6 categories |
| User Roles | 16 distinct roles |

---

## Valuation Workflow States

```
Pending → Incomplete → Unverified → In Progress → Waiting On Client → Drafted → Published
                                                                            ↑
                                                                       (can loop back)
```

**Additional states:** Ignored (326 valuations)

---

## Technology Stack Observations

- **Backend:** Ruby on Rails (HAML templates, ActiveAdmin-style admin panel)
- **AI Integration:** 
  - Perplexity API (older prompts)
  - Anthropic Claude (Sonnet 5, Opus 4.8, Haiku 4.5 — newer prompts)
  - AWS Bedrock (Sonnet 3.5 — 1 prompt)
- **Automated Communications:** Email + SMS channels
- **Partner System:** White-label subdomains per partner
- **Payment Integration:** Paid/Unpaid status tracking on valuations
- **Version:** 0.10.1
