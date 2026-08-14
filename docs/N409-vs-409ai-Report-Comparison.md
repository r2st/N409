# N409 vs 409.ai — Report Comparison

> First generated 2026-08-09 against 409.ai admin (valuation #1777 TakaHuman, `409a.v9`) and N409 template `409a.v55`.
>
> **Re-verified 2026-08-14 against template `409a.v59`.** Every ❌ in the original was re-checked against the
> code rather than carried forward. 28 of the 31 gaps are closed; 3 remain open. The roadmap in §6 now lists
> only those 3.

---

## How to read this document, and how it went wrong

The 2026-08-09 revision was a snapshot that then sat still while the codebase moved, and a stale gap list is
worse than no gap list: it is read as a work order. Two rounds were planned against premises this file
asserted and the code had already refuted —

- **"AI comparables discovery ❌ — comps are manual input only" (GAP #17).** The `comp_selection` agent
  existed when that was written. What was actually missing was the *apply* path from the agent's result to
  the peer set, which is a much smaller and quite different piece of work.
- **"Add Perplexity integration" (§6 P0, gaps #3/#4/#14/#15/#16).** Perplexity was removed from this
  platform at `f2f3c61`. Research runs on keyless DuckDuckGo retrieval plus OpenRouter synthesis. A roadmap
  recommending a provider the project deliberately dropped is not a roadmap.
- **"Add static Pepperdine data table" (GAP #5).** The table shipped as Appendix III and is deliberately
  *not* attributed to Pepperdine — see `domain/requiredReturns.ts`, which explains at length why hardcoding
  one edition of an annually-revised survey while printing its name would go stale silently. The gap was
  real; the prescription was wrong.

So: **the status column is the claim, and it is only as good as its date.** Before planning against any ❌
here, grep for the thing. The `Verified` column names the file that settles it.

---

## Executive Summary

N409's report engine leads on structure and rigour (tagged PDF, vector charts, a 19-schedule exhibit system,
white-label branding, 15 report types). The 2026-08-09 content and automation gaps against 409.ai's
production report have since been closed, in this platform's own shape rather than by copying 409.ai's
architecture — most visibly, research is contained behind a public-fields whitelist instead of sending the
subject company's name to a search provider.

**Gap count: 31 identified, 28 closed, 3 open** (#11 OPM appendix, #13 core time-series appendix,
#23 AI auto-tagging). All three are P2.

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

| Feature | 409.ai | N409 | Gap? | Verified |
|---------|--------|------|------|----------|
| Headline FMV per share | ✅ | ✅ Headline FMV to 4 decimals | — | |
| Key figures grid | ✅ | ✅ Equity value, shares, allocation method, DLOC, DLOM, key assumptions (σ, T) | — | |
| Conclusion statement paragraph | ✅ | ✅ Prose opinion sentence | — | |
| **Stage of enterprise development** | ✅ | ✅ "Stage of enterprise development" row, AICPA six-stage scale | **GAP #1 — CLOSED** | `domain/reportSummary.ts`, `domain/developmentStage.ts` |
| **Value per class table** (marketable vs non-marketable) | ✅ | ✅ `Class / Type / Shares / Value per share — marketable / — non-marketable` | **GAP #2 — CLOSED** | `domain/reportExhibits.ts` (Exhibit H per-class block) |
| Bar chart (equity by approach) | ✅ | ✅ | — | |
| Donut chart (approach weighting) | ✅ | ✅ (suppressed if <2 approaches) | — | |
| Waterfall chart (DLOC/DLOM) | Unknown | ✅ | — | |
| FMV history line chart | Unknown | ✅ (suppressed if <2 prior valuations) | — | |

### 1.3 Main Report Body — Narrative Sections

Section keys below are N409's own (`domain/report.ts`), not 409.ai's.

| # | Section | 409.ai | N409 | Gap? |
|---|---------|--------|------|------|
| 1 | **Introduction** | ✅ | ✅ Engagement ref, currency, purpose | — |
| 2 | **Standard & Premise of Value** | ✅ | ✅ Rev. Rul. 59-60, going-concern | — |
| 3 | **Sources of Information** | ✅ | ✅ Bulleted list | — |
| 4 | **Company Overview** | ✅ AI-generated via `company_overview` prompt (Perplexity) | ✅ `company_overview` + `company_analysis` keys; drafted by the `company_profile` agent from the engagement's **own documents**, then fed to the narrative agent through a field whitelist | **GAP #3 — CLOSED** (differently — see note below) |
| 5 | **Capital Structure** | ✅ | ✅ References Exhibit A, rights list | — |
| 6 | **Economic Outlook** | ✅ | ✅ `economic_outlook` | — |
| 7 | **Industry & Market Analysis** | ✅ AI-generated via `industry_overview` / `industry_outlook` / `market_*` | ✅ `industry_market` key, fed by the research topics in `domain/research.ts` | **GAP #4 — CLOSED** |
| 8 | **Financial Analysis** | ✅ | ✅ Historical performance, projections | — |
| 9 | **Valuation Methodology** | ✅ | ✅ Bulleted list of approaches | — |
| 10 | **Income Approach** | ✅ | ✅ DCF description, references Exhibits C / C-1 | — |
| 11 | **Market Approach** | ✅ | ✅ GPC/GTM methods, references Exhibits D / D-1 | — |
| 12 | **Asset Approach** | ✅ | ✅ NAV / cost-to-replicate, references Exhibit E | — |
| — | **Required rates of return by stage** | ✅ (as a Pepperdine VC/Angel table) | ✅ **Appendix III**, stage-banded VC-method ranges | **GAP #5 — CLOSED, prescription rejected** |
| — | **Adjustment Factor — Market Movement** | ✅ | ✅ `market_movement` section key | **GAP #6 — CLOSED** |
| 13 | **Reconciliation of Value Indications** | ✅ | ✅ Weighting narrative, references Exhibits B / B-1 / B-2 | — |
| 14 | **Allocation of Equity Value** | ✅ | ✅ OPM/Black-Scholes, references Exhibit F | — |
| — | **Selected Volatility Analysis** | ✅ | ✅ `selected_volatility` section key + **Exhibit F-1** | **GAP #7 — CLOSED** |
| — | **Class Volatility Calculations** | ✅ | ✅ Per-class volatility schedule, incl. the value-weighted aggregate common row | **GAP #8 — CLOSED** |
| 15 | **Discount for Lack of Control** | ✅ | ✅ References Exhibit H; Exhibit B-1 states the level of value | — |
| 16 | **Discount for Lack of Marketability** | ✅ | ✅ Seven DLOM models, references Exhibits H / H-1 | — |
| — | **DLOM Method Selection Table** | ✅ Method / Weight / Selected DLOM | ✅ `methodWeightingBlock` in **Exhibit H-1**; nil-weighted methods stay in the table | **GAP #9 — CLOSED** |
| 17 | **Conclusion of Value** | ✅ | ✅ FMV per share, references Exhibit H | — |
| 18 | **ASC 718 Stock-Based Compensation** | ✅ | ✅ Assumptions table | — |
| 19 | **Assumptions & Limiting Conditions** | ✅ | ✅ Standard disclaimer | — |
| 20 | **Section 409A Safe Harbor** | ✅ | ✅ | — |
| 21 | **Appraiser Certification** | ✅ | ✅ 5-item bulleted list | — |
| 22 | **Qualifications of the Valuation Analyst** | ✅ | ✅ | — |
| 23 | **Index of Exhibits** | ✅ | ✅ Derived from `SCHEDULE_CATALOGUE`, conditional on approach usage | — |

> **On GAP #3.** 409.ai's `company_overview` prompt asks Perplexity about the subject of the valuation.
> N409's `company_profile` agent reads the engagement's *own uploaded documents* through the standard
> redactor and never sees the company's name (`[COMPANY]` is what reaches the model). This is a deliberate
> divergence, not a partial implementation: `domain/research.ts` is fenced so no path from a client's name to
> a search provider exists, and a description drafted from the deck is the better input anyway, because a
> reviewer can follow it back to a document in the engagement. See commit `61c5e09`.

### 1.4 Exhibits and Appendices

The authoritative list is `SCHEDULE_CATALOGUE` in `domain/reportExhibits.ts` — the exhibit index, the
builders' headings and the public sample page all derive from it, so a schedule cannot exist without an entry.

| Schedule | 409.ai | N409 | Gap? |
|----------|--------|------|------|
| **Exhibit A — Capitalization Table** | ✅ | ✅ Always rendered | — |
| **Exhibit B — Reconciliation of Valuation Approaches** | ✅ | ✅ Always rendered | — |
| **Exhibit B-1 — Level of Value** | Not observed | ✅ | — |
| **Exhibit B-2 — Roll-Forward from the Prior Valuation** | Not observed | ✅ | — |
| **Exhibit C — Income Approach (Discounted Cash Flow)** | ✅ | ✅ | — |
| **Exhibit C-1 — Basis of the Cash-Flow Forecast** | Not observed | ✅ | — |
| **Exhibit D — Market Approach (Guideline Multiples)** | ✅ | ✅ | — |
| **Exhibit D-1 — Guideline Company Set** | ✅ | ✅ Included + excluded, with exclusion basis | — |
| **Exhibit E — Asset Approach** | ✅ | ✅ | — |
| **Exhibit F — Allocation of Equity Value** | ✅ | ✅ Up to 5 sub-tables | — |
| **Exhibit F-1 — Selected Volatility** | ✅ | ✅ | **GAP #7 — CLOSED** |
| **Exhibit F-2 — Allocation Sensitivity** | Not observed | ✅ | — |
| **Exhibit F-3 — Risk-Free Rate Sensitivity** | Not observed | ✅ | — |
| **Exhibit G — Probability-Weighted Expected Return Scenarios** | Unknown | ✅ | — |
| **Exhibit H — Discounts and Concluded Value** | ✅ | ✅ Always rendered | — |
| **Exhibit H-1 — Marketability Discount: Derivation** | ✅ (as a section) | ✅ | **GAP #9 — CLOSED** |
| **Appendix I — Discount Rate Build-Up (WACC)** | ✅ (`appendix-wacc-inputs`) | ✅ | **GAP #12 — CLOSED** |
| **Appendix II — Historical Financial Statements** | ✅ (`appendix-historical-financials`) | ✅ | **GAP #10 — CLOSED** |
| **Appendix III — Required Rates of Return by Stage of Development** | ✅ (in `asset-approach--5`) | ✅ | **GAP #5 — CLOSED** |
| **Appendix: OPM Calculations** | ✅ (`appendix-opm-calculations`) | ❌ OPM detail is in Exhibit F's sub-tables; no standalone appendix | **GAP #11 — OPEN** |
| **Core Time Series Data** | ✅ (`core-time-series--22/23`) | ❌ No time-series appendix | **GAP #13 — OPEN** |

---

## 2. AI/Automation Features

| Feature | 409.ai | N409 | Gap? | Verified |
|---------|--------|------|------|----------|
| **AI-generated Company Overview** | ✅ via Perplexity | ✅ `company_profile` agent, from the engagement's own documents | **#3 — CLOSED** | `ai/app/agents/company_profile.py`, migrations 0151/0152 |
| **AI-generated Industry Overview** | ✅ | ✅ `industry_overview` research topic | **#4 — CLOSED** | `domain/research.ts` |
| **AI-generated Industry Outlook** | ✅ | ✅ `industry_outlook` research topic | **#14 — CLOSED** | `domain/research.ts` |
| **AI Market Analysis (by region)** | ✅ six `market_*` prompts | ✅ One `market_research` topic parameterised by `RESEARCH_REGIONS` (us/uk/au/si/ca/un) — six rows being six places to fix a wording change | **#15 — CLOSED** | `domain/research.ts` |
| **AI competitor analysis** | ✅ | ✅ `competitor_analysis` research topic | **#16 — CLOSED** | `domain/research.ts` |
| **AI comparables discovery** | ✅ `FIND_COMPARABLES` | ✅ `comp_selection` agent → `POST /ai/comp_selection/apply` → peer set; **"Find peers with AI" on the Comparables tab** | **#17 — CLOSED** | `ai/app/agents/comp_selection.py`, `domain/aiComparables.ts`, `ComparablesTab.tsx` |
| **AI data extraction from attachments** | ✅ 3 prompts | ✅ `extract` + `summarize` pipelines, with `sanitizeExtractedInputs` bounding what may be written | **#18 — CLOSED** | `routes/ai.ts`, `routes/engineInputs.ts` |
| **AI missing data detection** | ✅ | ✅ `missing_data` pipeline | **#19 — CLOSED** | `domain/pipeline.ts` |
| **AI valuation parameter setting** | ✅ `SET_VALUATION_PARAMS` | ✅ `extract` auto-applies engine inputs to params | **#20 — CLOSED** | `routes/ai.ts` (`autoApply`) |
| **AI report review/QA** | ✅ `REVIEW_REPORT` | ✅ `qa` pipeline, wired to the publish gate so the deterministic checks and the review row always ride along | **#21 — CLOSED** | `domain/pipeline.ts`, `domain/publishGate.ts` |
| **AI cap table anonymization** | ✅ | ✅ `POST /valuations/:id/ai/anonymize`, plus the `anonymize` option on every pipeline | **#22 — CLOSED** | `routes/ai.ts` |
| **AI tag/classification** | ✅ `AI:FindRelevantTags` | ❌ No tagging model, no `valuation_tags` table | **#23 — OPEN** | — |
| — | — | **N409 only:** analyst agents with no 409.ai counterpart — `cap_table`, `assumptions`, `audit_defense`, `roll_forward`, `report_narrative` | — | `ai/app/agents/` |

---

## 3. Calculation & Data Pipeline

| Feature | 409.ai | N409 | Gap? |
|---------|--------|------|------|
| **Calculation engine** | "gandalf" — 5-step pipeline | Custom engine in `src/services/valuation` + Python engine, with a recorded per-stage trace (`engine/trace.py`) the inspector reads | ⚠️ Different architecture |
| **Valuation Workbook** | ✅ Dedicated UI page | ✅ `workbook_cells` + `WorkbookTab.tsx` | **GAP #24 — CLOSED** |
| **Income/Balance Sheet anomaly detection** | ✅ | ✅ `domain/financialAnomalies.ts`, surfaced in the workbook | **GAP #25 — CLOSED** |
| **Finances page** | ✅ | ✅ `FinancialModelPanel.tsx` | **GAP #26 — CLOSED** |

---

## 4. Workflow & Admin Features

| Feature | 409.ai | N409 | Gap? |
|---------|--------|------|------|
| **Report versioning** | ✅ | ✅ `report_versions`, version history sidebar | — |
| **Per-section overwrites/edits** | ✅ | ✅ `overwrites` table, WYSIWYG editor | ⚠️ Different granularity |
| **Section hide/show toggle** | ✅ | ✅ `hidden` per chapter, applied at the render boundary | **GAP #27 — CLOSED** |
| **Report status workflow** | ✅ 6 states | ✅ Draft/Accepted/Changes requested/Published | ⚠️ 409.ai has more states |
| **Chat/messaging** | ✅ | ✅ `CommentThread`, Communications, Inbox, Support inbox | **GAP #28 — CLOSED** |
| **Pending files management** | ✅ | ✅ Document `reviewed_at` (0121), `pending_files` chip in the workspace header | **GAP #29 — CLOSED** |
| **Task management** | ✅ | ✅ `review_tasks`, `TasksPanel`, Tasks page, SLA/due chips | **GAP #30 — CLOSED** |
| **Reapplication/cloning** | ✅ | ✅ `cloneValuation`, used by the monitoring and operations routes | **GAP #31 — CLOSED** |
| **Recalculate controls** | ✅ granular | ✅ Per-approach recalculation + report render on demand | — |
| **Auto emails** | ✅ 10 templates | ✅ Email outbox, workflow emails, unsubscribe | — |
| **Payment tracking** | ✅ | ⚠️ Billing UI present; Stripe provider key unset | Tracked in `REVISION` |

---

## 5. N409 Advantages Over 409.ai

| Feature | N409 | 409.ai |
|---------|------|--------|
| **Tagged/accessible PDF** | ✅ Structure tree, H1-H6, Table, Figure with alt-text, /Lang | Unknown |
| **Vector-only charts** | ✅ Hand-drawn pdfkit primitives, B&W-photocopy legible | Unknown (likely raster) |
| **15 report types** | ✅ 409A, QSBS, PPA, Impairment, ESOP, SMB, EMI, CSOP, IP, ASC 718, ASC 820, Gift & Estate, IFRS 2, Fund, Debt | Only 409A observed |
| **19-schedule exhibit system** | ✅ A–H-1 plus three appendices, catalogue-driven | ~9 observed |
| **Sensitivity exhibits (F-2, F-3)** | ✅ Conclusion tested against the soft inputs and the risk-free rate | Not observed |
| **Roll-forward bridge (B-2)** | ✅ Prior 409A carried to this date | Not observed |
| **Research containment** | ✅ Public-fields whitelist + placeholder tripwire + `assertPublic` — the subject company's name structurally cannot reach a search provider | ❌ Company name sent to Perplexity |
| **Waterfall / FMV history charts** | ✅ | Not observed |
| **Font safety** | ✅ `fontSafe()` transliterates Greek/math symbols | Unknown |
| **DoS/perf hardening** | ✅ Soft-hyphen breaking, scanner replacement, codePoint guard | Unknown |
| **Multi-currency** | ✅ Reporting currency in cover | Unknown |

---

## 6. Remaining Work

Three gaps are open. All were P2 in the original roadmap and none blocks parity.

| Gap # | Item | Effort | Notes |
|-------|------|--------|-------|
| **#11** | Appendix: OPM Calculations | Small | Exhibit F already carries the inputs, the aggregate, the Monte Carlo params, the breakpoints and the by-class table. Decide first whether a standalone appendix adds anything a reader cannot get from F — this may be a "won't do" rather than a "not yet". |
| **#13** | Core Time Series Appendix | Medium | Needs a decision on the source: `workbook_cells` holds the financial history that Appendix II already prints, so this is only distinct if it means a *metric* time series (ARR, headcount, burn) that nothing currently stores. |
| **#23** | AI Auto-tagging | Small | No `valuation_tags` table and no consumer for one. Worth a use case before a prompt. |

### Closed since 2026-08-09

#1, #2, #3, #4, #5, #6, #7, #8, #9, #10, #12, #14, #15, #16, #17, #18, #19, #20, #21, #22, #24, #25, #26,
#27, #28, #29, #30, #31 — 28 of 31.

### Data model changes from the original §7 — status

- `stage_of_development` → shipped as `valuation_params.development_stage` (AICPA 1–6, not 1–9).
- `section_hidden` → shipped as `hidden` per chapter in the report content model.
- `ai_research_results` → shipped as `market_research` (migrations 0116/0117), append-only with supersede.
- `ai_review_results` → shipped as `ai_jobs` rows for the `qa` pipeline, plus the publish-gate review row.
- `valuation_tasks` → shipped as `review_tasks`.
- `valuation_messages` → shipped as comments + communications.
- `financial_anomalies` → shipped as `domain/financialAnomalies.ts`, computed rather than stored.
- `source` (new/repeat/reapplication) → **not shipped.** Clone exists; the provenance enum does not. Nothing
  currently reads it, which is why it has not been added.

---

## Appendix: 409.ai Admin Structure Reference

Kept as the record of what was observed on 2026-08-09. Nothing below is a claim about N409.

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

> N409 does not mirror this table. The `market_*` family is one parameterised topic here, the Perplexity
> rows have no N409 counterpart by design (see §5, "Research containment"), and N409 runs five analyst
> agents 409.ai has none of.

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
