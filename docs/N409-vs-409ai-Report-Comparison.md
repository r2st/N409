# N409 vs 409.ai — Report Comparison

> Generated 2026-08-09. Based on live inspection of 409.ai admin (valuation #1777 TakaHuman, 409a.v9) and N409 codebase (`src/services/valuation/src/domain/report.ts` template `409a.v55`).

---

## Executive Summary

N409's report engine is architecturally more mature in several areas (tagged PDF, vector charts, exhibit system, white-label branding, multi-type templates). However, 409.ai's production report includes significant content and workflow features that N409 is missing — particularly AI-generated narrative content, automated research, financial appendices, a report review/QA pipeline, and several data-rich subsections.

**Key gap count**: 31 missing or partially-missing items identified below.

---

## 1. Report Sections — Side-by-Side

### Legend
- ✅ = Present and feature-complete
- ⚠️ = Present but incomplete or different
- ❌ = Missing entirely
- N/A = Not applicable

### 1.1 Cover Page & Front Matter

| Feature | 409.ai | N409 | Gap? |
|---------|--------|------|------|
| Cover page with company name | ✅ | ✅ Brand-color band, partner logo, meta facts | — |
| Report title & engagement reference | ✅ | ✅ | — |
| Valuation date on cover | ✅ | ✅ | — |
| "Prepared in partnership with" (white-label) | ✅ (partner field in admin) | ✅ Partner logo + accent color | — |
| Table of contents | ✅ | ✅ Auto-enabled at ≥4 sections, dot-leaders, clickable links | — |
| Page numbering footer | ✅ | ✅ "Company · Confidential · Page i of N" | — |
| Running headers (section name) | Unknown | ✅ Company (left) / section heading (right) | — |
| Confidentiality notice on every page | ✅ | ✅ In footer | — |

### 1.2 Executive Summary / Summary of Findings

| Feature | 409.ai | N409 | Gap? |
|---------|--------|------|------|
| Headline FMV per share | ✅ (`summary-of-findings--2`: styled box with FMV + "Value Per 1% Membership Interest") | ✅ Headline FMV to 4 decimals | — |
| Key figures grid | ✅ | ✅ Equity value, shares, allocation method, DLOC, DLOM, key assumptions (σ, T) | — |
| Conclusion statement paragraph | ✅ (`conclusionbottom--1`) | ✅ Prose opinion sentence | — |
| **Stage of enterprise development** | ✅ (`state-of-enterprise-development--3`: "stage 3 of enterprise development" text) | ❌ Not in summary or any section | **GAP #1** |
| **Value per class table** (marketable vs non-marketable) | ✅ (`summary-of-dlom-conclusion-of-value--2`: Class / Value per 1% (Marketable) / Less DLOM / Value per 1% (Non-Marketable)) | ❌ Exhibit H has per-share only, no per-class marketable/non-marketable breakdown table in summary | **GAP #2** |
| Bar chart (equity by approach) | ✅ | ✅ | — |
| Donut chart (approach weighting) | ✅ | ✅ (suppressed if <2 approaches) | — |
| Waterfall chart (DLOC/DLOM) | Unknown | ✅ | — |
| FMV history line chart | Unknown | ✅ (suppressed if <2 prior valuations) | — |

### 1.3 Main Report Body — Narrative Sections

| # | Section | 409.ai | N409 | Gap? |
|---|---------|--------|------|------|
| 1 | **Introduction** | ✅ | ✅ Engagement ref, currency, purpose | — |
| 2 | **Standard & Premise of Value** | ✅ | ✅ Rev. Rul. 59-60, going-concern | — |
| 3 | **Sources of Information** | ✅ | ✅ Bulleted list | — |
| 4 | **Company Overview** | ✅ AI-generated via `company_overview` prompt (Perplexity) | ⚠️ Free-text placeholder only — **no AI generation** | **GAP #3** |
| 5 | **Capital Structure** | ✅ (`understanding-capital-structure--3`) | ✅ References Exhibit A, rights list | — |
| 6 | **Economic Outlook** | ✅ (hidden in this valuation via `industry-outlook` edit) | ✅ New in v55 | — |
| 7 | **Industry & Market Analysis** | ✅ AI-generated via `industry_overview` + `industry_outlook` + `market_us/uk/ca/au/si/un` prompts | ⚠️ Placeholder only — **no AI-generated market research** | **GAP #4** |
| 8 | **Financial Analysis** | ✅ (`financial-analysis` section key) | ✅ Historical performance, projections | — |
| 9 | **Valuation Methodology** | ✅ | ✅ Bulleted list of approaches | — |
| 10 | **Income Approach** | ✅ (`income-approach2--1`) | ✅ DCF description, references Exhibit C | — |
| 11 | **Market Approach** | ✅ (`market-approach-backsolve-calculation`) | ✅ GPC/GTM methods, references Exhibit D | — |
| 12 | **Asset Approach** | ✅ (`asset-approach--5`: includes VC/Angel rates of return table from Pepperdine) | ✅ NAV / cost-to-replicate, references Exhibit E | ⚠️ See GAP #5 |
| — | **VC/Angel Rates of Return Table** | ✅ Detailed table: Investment Category / Return Range (Interquartile) / Median Return, sourced from Pepperdine Private Capital Markets Report | ❌ Not present anywhere in report | **GAP #5** |
| — | **Adjustment Factor — Market Movement** | ✅ (`adjustment-factor-market-movement` section key) | ❌ No market-movement adjustment section | **GAP #6** |
| 13 | **Reconciliation of Value Indications** | ✅ | ✅ Weighting narrative, references Exhibit B | — |
| 14 | **Allocation of Equity Value** | ✅ (`equity-allocation`, `equity-allocation--1`) | ✅ OPM/Black-Scholes, references Exhibit F | — |
| — | **Selected Volatility Analysis** | ✅ (`selected-volatilityae--5`, `selected-volatilityae--6` sections) | ❌ No standalone volatility analysis section | **GAP #7** |
| — | **Class Volatility Calculations** | ✅ (`class-volatility-calculations` section key) | ❌ No class-level volatility section | **GAP #8** |
| 15 | **Discount for Lack of Control** | ✅ | ✅ New in v55, references Exhibit H | — |
| 16 | **Discount for Lack of Marketability** | ✅ (`summary-of-dlom-conclusion-of-value--1`: DLOM Method / Weight / Selected DLOM table with Qualitative Marketability Assessment footnote) | ✅ Chaffee/Finnerty/qualitative, references Exhibit H | ⚠️ See GAP #9 |
| — | **DLOM Method Selection Table** | ✅ Table showing DLOM Method / Weight / Selected DLOM (e.g., "Qualitative Marketability Assessment 100.00% 20.00%") with detailed footnote explaining rationale | ⚠️ Exhibit H has the step-down but **no method-weighting table** or detailed qualitative footnote in the DLOM section body | **GAP #9** |
| 17 | **Conclusion of Value** | ✅ | ✅ FMV per share, references Exhibit H | — |
| 18 | **ASC 718 Stock-Based Compensation** | ✅ | ✅ Assumptions table (FV, exercise price, expected term, volatility, RFR, dividend yield, grant-date FV, total comp cost) | — |
| 19 | **Assumptions & Limiting Conditions** | ✅ | ✅ Standard disclaimer | — |
| 20 | **Section 409A Safe Harbor** | ✅ | ✅ New in v55 | — |
| 21 | **Appraiser Certification** | ✅ | ✅ 5-item bulleted list | — |
| 22 | **Qualifications of the Valuation Analyst** | ✅ | ✅ Name, credentials, experience, participation | — |
| 23 | **Index of Exhibits** | ✅ | ✅ Lists A–H, conditional on approach usage | — |

### 1.4 Exhibits

| Exhibit | 409.ai | N409 | Gap? |
|---------|--------|------|------|
| **A — Capitalization Table** | ✅ | ✅ Class-by-class or aggregate mode | — |
| **B — Reconciliation of Approaches** | ✅ | ✅ Approach/Method/EV/Equity/Weight/Weighted | — |
| **C — Income Approach (DCF)** | ✅ | ✅ Forecast table + bridge table | — |
| **D — Market Approach Multiples** | ✅ | ✅ Guideline observations + bridge | — |
| **D-1 — Guideline Company Set** | ✅ (included + excluded comps with screening) | ✅ Included table (screen scores) + excluded table (exclusion basis) | — |
| **E — Asset Approach** | ✅ | ✅ Assets/liabilities or cost-to-replicate | — |
| **F — Allocation of Equity Value** | ✅ | ✅ Up to 5 sub-tables: inputs, aggregate, Monte Carlo params, breakpoints, by-class | — |
| **G — PWERM Scenarios** | Unknown | ✅ Scenario/Type/Prob/Exit EV/Years/PV; null if Monte Carlo | — |
| **H — Discounts and Concluded Value** | ✅ | ✅ Step-down: marketable controlling → DLOC → minority → DLOM → FMV | — |

### 1.5 Appendices (409.ai-specific)

| Appendix | 409.ai | N409 | Gap? |
|----------|--------|------|------|
| **Appendix: Historical Financials** | ✅ (`appendix-historical-financials` section key) | ❌ Not in template — financial data only in body text | **GAP #10** |
| **Appendix: OPM Calculations** | ✅ (`appendix-opm-calculations` section key) | ❌ OPM details in Exhibit F only — no standalone appendix | **GAP #11** |
| **Appendix: WACC Inputs** | ✅ (`appendix-wacc-inputs` section key) | ❌ WACC components not broken out into appendix | **GAP #12** |
| **Core Time Series Data** | ✅ (`core-time-series--22`, `core-time-series--23`) | ❌ No time-series data appendix | **GAP #13** |

---

## 2. AI/Automation Features

| Feature | 409.ai | N409 | Gap? |
|---------|--------|------|------|
| **AI-generated Company Overview** | ✅ `company_overview` prompt via Perplexity | ❌ Free-text placeholder only | **GAP #3** (same as above) |
| **AI-generated Industry Overview** | ✅ `industry_overview` + `Industry_finder` prompts via Perplexity-PRO | ❌ Placeholder only | **GAP #4** (same as above) |
| **AI-generated Industry Outlook** | ✅ `industry_outlook` prompt via Perplexity-PRO | ❌ Placeholder only | **GAP #14** |
| **AI-generated Market Analysis (by region)** | ✅ `market_us`, `market_uk`, `market_ca`, `market_au`, `market_si`, `market_un` — region-specific market research via Perplexity-PRO | ❌ No automated market research at all | **GAP #15** |
| **AI competitor analysis** | ✅ `competitor` prompt via Perplexity-PRO — "50 word overview" | ❌ No competitor research | **GAP #16** |
| **AI comparables discovery** | ✅ `FIND_COMPARABLES` prompt via Anthropic Opus — automated comp selection | ❌ Comps are manual input only | **GAP #17** |
| **AI data extraction from attachments** | ✅ `SUMMARIZE_ATTACHMENT` (Haiku) + `FIND_MAPPING_AND_SOURCES` (Sonnet) + `CREATE_MISSING_ENTRIES` (Sonnet) | ❌ No automated data extraction from uploaded docs | **GAP #18** |
| **AI missing data detection** | ✅ `MISSING_DATA_SUMMARY` prompt via Anthropic Opus | ❌ No automated gap detection in input data | **GAP #19** |
| **AI valuation parameter setting** | ✅ `SET_VALUATION_PARAMS` via Sonnet — automated parameter suggestions | ❌ All params manual | **GAP #20** |
| **AI report review/QA** | ✅ `REVIEW_REPORT` via Anthropic Opus — "Review the attached 409A va..." | ❌ Only template-placeholder QA gate; no content-level AI review | **GAP #21** |
| **AI cap table anonymization** | ✅ `Ai:AnoymizeCaptable` via Bedrock Sonnet 3.5 | ❌ No anonymization capability | **GAP #22** |
| **AI tag/classification** | ✅ `AI:FindRelevantTags` via Perplexity-PRO | ❌ No auto-tagging | **GAP #23** |

---

## 3. Calculation & Data Pipeline

| Feature | 409.ai | N409 | Gap? |
|---------|--------|------|------|
| **Calculation engine** | "gandalf" — 5-step pipeline: aggregate → accounting → market → weights → render | Custom calc engine in `src/services/valuation` | ⚠️ Different architecture, functionally equivalent |
| **Valuation Workbook** | ✅ Dedicated UI page per valuation | ✅ `workbook_cells` table, but no dedicated workbook UI | **GAP #24** |
| **Income Statement Anomalies detection** | ✅ Anomaly detection table in Calculations page | ❌ No financial anomaly detection | **GAP #25** |
| **Balance Sheet Anomalies detection** | ✅ Anomaly detection table in Calculations page | ❌ No financial anomaly detection | **GAP #25** (same) |
| **Finances page** | ✅ Dedicated Finances section in admin | ⚠️ Financial data in calculation input but no dedicated finance management UI | **GAP #26** |

---

## 4. Workflow & Admin Features

| Feature | 409.ai | N409 | Gap? |
|---------|--------|------|------|
| **Report versioning** | ✅ Versions page in admin sidebar | ✅ `report_versions` table, version history sidebar | — |
| **Per-section overwrites/edits** | ✅ Overwrites & Edits page with per-section key editing, hidden/visible toggle | ✅ `overwrites` table (68 fields), WYSIWYG editor | ⚠️ Different granularity |
| **Section hide/show toggle** | ✅ Hidden/Visible badges per section edit | ❌ No per-section hide/show — all template sections render | **GAP #27** |
| **Report status workflow** | ✅ published/drafted/in_progress/incomplete/unverified/waiting_on_client | ✅ Draft/Accepted/Changes requested/Published | ⚠️ 409.ai has more states |
| **Chat/messaging** | ✅ Chat (16 messages), Team Support | ❌ No in-app chat or messaging | **GAP #28** |
| **Pending files management** | ✅ Pending files (5) in toolbar | ❌ No pending file tracking | **GAP #29** |
| **Task management** | ✅ My tasks / All tasks in toolbar | ❌ No task tracking per valuation | **GAP #30** |
| **Reapplication/cloning** | ✅ "Clone Valuation", "Reapplication" badge | ❌ No clone or reapplication workflow | **GAP #31** |
| **Recalculate controls** | ✅ "Recalculate accounting", "Recalculate bot", "Recalculate report (stage/prod)" | ✅ Report render on demand | ⚠️ 409.ai has more granular recalc |
| **Auto emails** | ✅ Auto Emails settings page, 10 email templates | ❌ No outbound email transport (noted in remaining-gaps.md) | Already tracked |
| **Payment tracking** | ✅ Paid/payment status on valuations | ❌ No Stripe/payments (noted in remaining-gaps.md) | Already tracked |

---

## 5. N409 Advantages Over 409.ai

| Feature | N409 | 409.ai |
|---------|------|--------|
| **Tagged/accessible PDF** | ✅ Structure tree, H1-H6, Table, Figure with alt-text, /Lang | Unknown |
| **Vector-only charts** | ✅ Hand-drawn pdfkit primitives, B&W-photocopy legible | Unknown (likely raster) |
| **15 report types** | ✅ 409A, QSBS, PPA, Impairment, ESOP, SMB, EMI, CSOP, IP, ASC 718, ASC 820, Gift & Estate, IFRS 2, Fund, Debt | Only 409A observed |
| **Waterfall chart** | ✅ DLOC/DLOM step-down visualization | Not observed |
| **FMV history line chart** | ✅ Multi-valuation trend | Not observed |
| **PWERM exhibit (G)** | ✅ Scenario table with probabilities | Not observed |
| **Font safety** | ✅ `fontSafe()` transliterates Greek/math symbols | Unknown |
| **DoS/perf hardening** | ✅ Soft-hyphen breaking, scanner replacement, codePoint guard | Unknown |
| **Multi-currency** | ✅ Reporting currency in cover | Unknown |

---

## 6. Priority Implementation Roadmap

### P0 — Critical (blocks competitive parity)

| Gap # | Item | Effort | Implementation |
|-------|------|--------|----------------|
| **#3** | AI-generated Company Overview | Medium | Add Perplexity/Anthropic integration for `company_overview` section; store in `reports` table keyed by section |
| **#4** | AI-generated Industry & Market Analysis | Medium | Add multi-region market research prompts; inject into `industry_market` section |
| **#14** | AI-generated Industry Outlook | Medium | Add `industry_outlook` prompt; inject into `economic_outlook` section |
| **#15** | AI Market Research (by region) | Large | Build region-aware market research pipeline with Perplexity-PRO |
| **#17** | AI Comparables Discovery | Medium | Add `FIND_COMPARABLES` prompt; pre-populate guideline company set |
| **#21** | AI Report Review/QA | Medium | Add `REVIEW_REPORT` prompt that reviews generated report for errors/inconsistencies |

### P1 — Important (significant product gaps)

| Gap # | Item | Effort | Implementation |
|-------|------|--------|----------------|
| **#1** | Stage of Enterprise Development | Small | Add `stage_of_development` field to valuation model; render in executive summary |
| **#2** | Per-class Marketable/Non-marketable Table | Small | Extend Exhibit H or summary to include per-class breakdown with marketable and non-marketable values |
| **#5** | VC/Angel Rates of Return Table | Small | Add static Pepperdine data table to asset approach section |
| **#9** | DLOM Method Selection Table | Small | Add method-weighting table to DLOM section body (not just Exhibit H step-down) |
| **#10** | Appendix: Historical Financials | Medium | Create new exhibit/appendix from `workbook_cells` financial data |
| **#12** | Appendix: WACC Inputs | Small | Create WACC breakdown appendix (risk-free rate, equity risk premium, size premium, company-specific risk, beta, etc.) |
| **#18** | AI Data Extraction from Attachments | Large | Integrate Anthropic Haiku/Sonnet for parsing uploaded financials, cap tables, etc. |
| **#19** | AI Missing Data Detection | Medium | Add prompt that analyzes input data completeness and flags gaps |
| **#20** | AI Valuation Parameter Suggestions | Medium | Auto-suggest discount rates, multiples, growth rates from market data |
| **#27** | Section Hide/Show Toggle | Small | Add `hidden` boolean per section in `reports` table; skip in PDF render |

### P2 — Nice to Have

| Gap # | Item | Effort | Implementation |
|-------|------|--------|----------------|
| **#6** | Market Movement Adjustment Section | Small | Add optional section for post-valuation-date market movements |
| **#7** | Selected Volatility Analysis Section | Small | Add standalone section explaining volatility selection methodology |
| **#8** | Class Volatility Calculations Section | Small | Add section showing per-class volatility assumptions |
| **#11** | Appendix: OPM Calculations | Small | Extract OPM math details from Exhibit F into standalone appendix |
| **#13** | Core Time Series Appendix | Medium | Add time-series data appendix for key financial metrics |
| **#16** | AI Competitor Analysis | Small | Add competitor research prompt |
| **#22** | Cap Table Anonymization | Small | Add anonymization function for sample/demo reports |
| **#23** | AI Auto-tagging | Small | Add classification prompt for valuation categorization |
| **#24** | Dedicated Valuation Workbook UI | Large | Build spreadsheet-like workbook interface |
| **#25** | Financial Anomaly Detection | Medium | Add automated checks for income statement / balance sheet inconsistencies |
| **#26** | Dedicated Finances Management UI | Medium | Build financial data input/management interface |
| **#28** | In-app Chat/Messaging | Large | Add real-time chat per valuation |
| **#29** | Pending Files Tracking | Small | Track uploaded files awaiting review |
| **#30** | Task Management per Valuation | Medium | Add task/checklist system per valuation |
| **#31** | Valuation Clone/Reapplication | Medium | Add clone + reapplication workflow for recurring valuations |

---

## 7. Data Model Changes Required

### New fields on `valuations` table
- `stage_of_development` (integer, 1-9, maps to standard stage descriptions)
- `source` (enum: new/repeat/reapplication)

### New fields on `reports` / `report_sections` table
- `section_hidden` (boolean per section, for hide/show toggle)

### New tables
- `ai_research_results` — store AI-generated research (company overview, industry analysis, market data) keyed by valuation + section
- `ai_review_results` — store AI review/QA findings
- `valuation_tasks` — per-valuation task tracking
- `valuation_messages` — in-app chat messages
- `financial_anomalies` — detected anomaly records

### New API endpoints
- `POST /api/v1/valuations/:id/ai/research` — trigger AI research generation
- `POST /api/v1/valuations/:id/ai/review` — trigger AI report review
- `POST /api/v1/valuations/:id/ai/comparables` — trigger AI comparables discovery
- `POST /api/v1/valuations/:id/clone` — clone valuation
- `GET/POST /api/v1/valuations/:id/tasks` — task management
- `GET/POST /api/v1/valuations/:id/messages` — messaging

---

## Appendix: 409.ai Admin Structure Reference

### Sidebar sections per valuation
```
DATA
├── Details (#1777.v9, 409a)
├── Valuation Workbook
├── Valuation Params
├── Ai / Attachments
├── Bot Prompts (4)
├── Network Items (33)
├── Captables (1)
├── Finances (0)
├── Chat (0 unread)
└── Team Support (0)

REPORT
├── Calculations (5/5)
├── Final Report
├── Overwrites & Edits (39)
└── Versions

SETTINGS
├── Users
├── API Tokens
├── Prompts
├── Templates
├── Auto Emails
└── Partners
```

### 409.ai AI Prompts (20 total)
| ID | Name | Provider | Purpose |
|----|------|----------|---------|
| 1 | company_overview | perplexity | Company description |
| 2 | industry_overview | perplexity-PRO | Industry analysis |
| 3 | industry_outlook | perplexity-PRO | Industry outlook |
| 5 | competitor | perplexity-PRO | Competitor overview |
| 6 | market_us | perplexity-PRO | US market research |
| 7 | market_ca | perplexity-PRO | Canada market |
| 8 | market_au | perplexity | Australia market |
| 9 | market_si | perplexity | Singapore market |
| 13 | AI:FindRelevantTags | perplexity-PRO | Auto-tagging |
| 50 | Ai:AnoymizeCaptable | bedrock-SONNET35 | Cap table anonymization |
| 51 | market_uk | perplexity-PRO | UK market |
| 52 | market_un | perplexity-PRO | UN/global market |
| 85 | Industry_finder | perplexity-PRO | Industry classification |
| 119 | SET_VALUATION_PARAMS | Anthropic-SONNET_5 | Auto-set valuation parameters |
| 120 | CREATE_MISSING_ENTRIES | Anthropic-SONNET_5 | Extract missing data |
| 121 | FIND_MAPPING_AND_SOURCES | Anthropic-SONNET_5 | Map data to fields |
| 122 | MISSING_DATA_SUMMARY | Anthropic-OPUS_4_8 | Identify missing data |
| 123 | SUMMARIZE_ATTACHMENT | Anthropic-HAIKU_4_5 | Summarize attachments |
| 124 | FIND_COMPARABLES | Anthropic-OPUS_4_8 | Discover comparable companies |
| 125 | REVIEW_REPORT | Anthropic-OPUS_4_8 | QA review of final report |

### 409.ai Calculation Pipeline
```
gandalf aggregate → gandalf accounting → gandalf market → gandalf weights → gandalf render
```

### 409.ai Report Section Keys (from Edits tab)
```
industry-outlook
equity-allocation
equity-allocation--1
asset-approach--5
income-approach2--1
market-approach-backsolve-calculation
adjustment-factor-market-movement
understanding-capital-structure--3
selected-volatilityae--5
selected-volatilityae--6
class-volatility-calculations
appendix-historical-financials
appendix-opm-calculations
appendix-wacc-inputs
core-time-series--22
core-time-series--23
financial-analysis
summary-of-dlom-conclusion-of-value--1
summary-of-dlom-conclusion-of-value--2
conclusionbottom--1
summary-of-findings--2
state-of-enterprise-development--3
```
