# Valuation AI — Brainstorm Analysis

**Source:** Handwritten brainstorm notes (3 WhatsApp photos, `docs/1/`), captured 2026-07-20.
**Cross-referenced against:** the N409 codebase (`main`, through commit `10f5291`, deployed to Hetzner).
**Purpose:** Reconcile the "Valuation AI" concept against what is already built, and isolate what is genuinely new.

---

## 1. Summary of the Brainstorm Notes

The three pages sketch a product called **"Valuation AI"** organized into two product families, the deliverable each produces, and the end-to-end AI workflow.

### Page 1 — Product taxonomy ("Step 1")

Two families, each drawn as a table:

- **Equity Compensation**
  - `409A` | `ASC 718 Private` | `ASC 718 Public`
- **Portfolio Valuation**
  - `Equity` | `Debt`

### Page 2 — Deliverables & flow ("Flow / Step 2")

- The Equity Compensation family is repeated (`409A | 718 Private | 718 Public`), and each product **branches into two possible outputs**:
  - a **Valuation Model (VM)** — the full working model *with exhibits*, or
  - a **Valuation Report (VR)** — an **AICPA-compliant** written report.
- Two governing statements:
  1. *"The Valuation AI, based on the request, should be able to create a full valuation model with exhibits **or** an AICPA-compliant report, as per user request."*
  2. *"In order to complete the valuation, the AI will follow the following steps:"* (continued on page 3).

### Page 3 — The AI workflow (the "following steps")

1. **Onboard the client** + a call with an expert.
2. **Gather all information**, specifically:
   - (i) Valuation date
   - (ii) Capitalization table
   - (iii) Accounting information — *either read through uploaded documents **or** connect to accounting software*
   - (iv) Onboarding question list
   - (v) Prior-year analysis
3. → **Dashboard of information** (all of the above consolidated into one view).
4. → **AI reads through it and determines a valuation methodology, with a human in the loop.**
5. → **Runs a first draft of the exhibits or report.**

**One-line thesis:** an AI-driven intake → dashboard → methodology-selection (human-in-loop) → first-draft pipeline, spanning an *equity-compensation* product line and a *portfolio-valuation* product line, each able to emit either a working model-with-exhibits or an AICPA-compliant report.

---

## 2. Current State — What N409 Already Covers (~80%)

The overwhelming majority of the brainstorm is **already built and deployed**. Mapping each element:

### Product families & kinds

| Brainstorm element | Status in N409 | Evidence |
|---|---|---|
| **409A** | ✅ Built (flagship) | `VALUATION_KINDS` includes `409a`; dedicated `TEMPLATE_409A` (`409a.v53` layout) in `domain/report.ts`; full OPM/backsolve/waterfall engine. |
| **ASC 718 Private** | ✅ Built | `domain/asc718.ts` — Black-Scholes-Merton grant-date fair value, Monte-Carlo cross-check, expected-to-vest cost, straight-line amortization. `718` is a first-class kind. |
| **ASC 718 Public** | ⚠️ **Partial / not a distinct mode** — see §3. | The 718 module assumes the underlying is the 409A FMV (a *private* premise). |
| **Portfolio Valuation** (label) | ⚠️ Name exists, **different meaning** — see §3 & §4. | `domain/portfolio.ts` exists but consolidates a corporate *group of entities*, not fund holdings. |
| **Portfolio: Equity** | ⚠️ Partial (as org consolidation, not fund holdings) | see §3. |
| **Portfolio: Debt** | ❌ **Not built** — see §3. | No debt-pricing engine anywhere in `engine-wrapper`. |

> **Note on `820`:** `820` is present in `VALUATION_KINDS`, but it currently has **no dedicated domain logic** — it falls through to `TEMPLATE_GENERIC` and the shared equity approaches. It is a label, not an implemented ASC 820 fund-holdings framework.

### Deliverables — Valuation Model (VM) vs. Valuation Report (VR)

Both output modes already exist as first-class concepts:

- **Valuation Model + exhibits (VM):** `domain/workbook.ts` — a valuation workbook where only input cells are persisted (`workbook_cells`) and derived rows are recomputed on every read; plus the engine's computed approaches, sensitivity tables, waterfall, and CSV/XLSX/PDF export. This *is* the "model with exhibits."
- **AICPA-compliant Report (VR):** `domain/report.ts` — versioned, immutable report templates (`report_versions`, revert = append), the `409a.v53` narrative skeleton, and a `report_narrative` AI pipeline. Rendered to PDF via the stateless report service.

The brainstorm's "VM **or** VR, per user request" branch is therefore already supported.

### The AI workflow (page 3) — nearly complete

| Step | Status | Evidence |
|---|---|---|
| Onboard client + expert call | ✅ (mostly) | 4-step onboarding wizard (`/onboarding`); engagement stages + assigned analyst (`domain/engagement.ts`). A literal "book a call with an expert" scheduler is the only soft gap. |
| (i) Valuation date | ✅ | Core valuation field. |
| (ii) Cap table | ✅ | `domain/capTable.ts` (CSV parse, Carta/Pulley/generic presets, column mapping, validation, `toWaterfallInputs`) + live sync (`capTableSync.ts`). |
| (iii) Accounting info — read docs **or** connect software | ✅ | Document upload + AI `extract` pipeline; **6 accounting OAuth providers** with Xero/QuickBooks P&L import (`clients/accounting.ts`). Exactly the "either/or" the note describes. |
| (iv) Onboarding question list | ✅ | `domain/intake.ts` — sectioned intake questionnaire with completion tracking (`IntakeTab`). |
| (v) Prior-year analysis | ✅ | Clone / roll-forward (`POST /valuations/:id/clone`, `valuation_cloned`); cross-period value-bridge report (`domain/valuationBridge.ts`). |
| → Dashboard of information | ✅ | Dashboard analytics (`/stats/dashboard`), per-valuation Package explorer, progress tracker (`domain/progress.ts`), workspace tabs. |
| → AI determines methodology, human-in-loop | ✅ | AI pipelines (`missing_data`, `comparables`, `comp_selection`, `assumptions`, etc.); **methodology decision log** (`methodology_decisions`, append-only, supersede chains); the full review → overwrite → QA → sign → publish workflow (`domain/workflow.ts`, `publishGate.ts`, `qaChecks.ts`) *is* the human-in-loop. |
| → First draft of exhibits or report | ✅ | `report_narrative` pipeline → draft report; workbook + engine → exhibits. `explain` pipeline adds a plain-English summary. |

**Conclusion:** The *workflow*, the *intake surface*, the *dashboard*, the *human-in-loop methodology governance*, and the *dual VM/VR output* are all built. The ~80% estimate is accurate. What remains is **product-line coverage**, not pipeline plumbing.

---

## 3. Gap Analysis — What Is Genuinely New

Three items are real gaps. They differ sharply in size and risk.

### 3.1 ASC 718 Public — **P1 (high value, extends an existing module)**

**What's new:** The existing `asc718.ts` is built on a *private-company* premise — it takes the concluded **409A FMV as the grant-date underlying price**, uses a SAB 107 simplified expected term, and expects an externally supplied (peer/index-derived) volatility. A **public** ASC 718 engagement differs in ways the current module does not model:

- **Underlying = the issuer's own traded market price** (not a derived 409A FMV) — needs a market-data feed for the *subject* ticker (the engine already has a `market_feed`/`market_data` module for comparables, so the plumbing exists).
- **Expected volatility** from the issuer's own historical/implied vol, not peers.
- **Award types public companies actually grant:** ESPPs (with lookback/discount), RSUs, and **performance/market-condition awards** (TSR-style) that require Monte-Carlo — the module already has a Monte-Carlo estimator to build on.
- **Public-specific expense mechanics:** forfeiture-rate estimation vs. actual, graded-vesting attribution (FIN 28 / straight-line election), modification accounting, and disclosure tables (Level of expense by period, unrecognized comp cost).

**Why P1:** It is genuinely valuable (public issuers are higher-fee, recurring engagements) and it **extends an existing, well-factored module** rather than inventing a domain. Most of the machinery — Black-Scholes-Merton, Monte-Carlo, amortization schedules, the report template hook — is already present. This is an *incremental deepening*, not a new engine.

### 3.2 Portfolio Valuation: Debt — **P2 (new engine domain)**

**What's new:** There is **no debt-valuation capability anywhere** in the codebase. Every occurrence of "debt" in the engine is incidental — it is the `enterprise + cash − debt` equity bridge, a balance-sheet document label, or an AI extraction field. None of it *prices* debt.

A debt engine is a **new quantitative domain**:

- Discounted-cash-flow bond pricing (coupon schedule, yield-to-maturity, credit spread over a risk-free curve).
- Yield-curve handling and spread/OAS logic.
- Credit-risk-adjusted valuation — a structural (Merton-type) model and/or a market-multiple/comparable-yield approach for private credit.
- Convertible/mezzanine instruments (a bridge back to the equity/OPM machinery).

None of the existing OPM/income/market/asset approaches transfer directly. This is the **largest** of the three gaps: a new engine module, new inputs, new exhibits, and new report sections.

### 3.3 Portfolio Valuation: Equity as fund holdings / ASC 820 — **P2 (different from existing org consolidation)**

**What's new — and why it's a trap:** N409 *has* something called "Portfolio" (`domain/portfolio.ts`), but it does something **fundamentally different** from what the brainstorm means.

- **What N409 has:** *corporate-group consolidation* — rolling up the entities of one **organization** (parent / subsidiary / portfolio_company) into a single consolidated equity value, with a convention to avoid double-counting subsidiaries. This is holding-company/subsidiary roll-up.
- **What the brainstorm means:** **fund / LP portfolio valuation under ASC 820** — a fund (VC/PE/credit) periodically fair-values each *portfolio position* it holds (fair-value hierarchy Level 1/2/3, calibration to the last transaction, per-holding methodology, NAV roll-up, unrealized gain/loss). The valuation subject is *the fund's stake in each company*, not the company's own consolidated equity.

These share almost nothing beyond the word "portfolio." The ASC 820 fund-holdings model needs: a **fund** entity above the holdings, per-holding fair-value method + calibration, the ASC 820 leveling/disclosure framework, and NAV/roll-forward reporting. It is a **new product**, adjacent to the existing consolidation feature, not an extension of it.

---

## 4. Architecture Considerations

### 4.1 Naming collision on "Portfolio" — resolve before building

`domain/portfolio.ts` already owns the word "portfolio" for **corporate-group consolidation**. The brainstorm's **Portfolio Valuation** family (fund holdings, ASC 820) is a different concept. Building the new family under the same name will create lasting confusion in code, DB, routes, and UI.

**Recommendation:** rename/namespace deliberately. Options:
- Keep the existing feature as **"Consolidation"** (`domain/consolidation.ts`, "Group consolidation" in UI), and reserve **"Portfolio Valuation"** for the new fund-holdings family; **or**
- Introduce a top-level product-family concept (`family: equity_comp | portfolio_valuation`) and make "consolidation" a sub-mode, keeping "portfolio valuation" for ASC 820 fund work.
Decide this **first** — it is cheap now and expensive after tables and routes ship.

### 4.2 ASC 718 underlying coupling

The current 718 module is **hard-coupled to a private underlying**: it consumes the 409A concluded FMV as the grant-date price. To add Public without regressing Private, introduce an **underlying-source abstraction**:

- `underlying: { source: 'internal_409a' | 'market_price', ... }`
- Private → resolves to the concluded 409A FMV (today's behavior).
- Public → resolves to the issuer's traded price via the existing market-data feed, with issuer-specific volatility.

This keeps one 718 measurement core (BSM + Monte-Carlo + amortization) and swaps only the underlying/volatility resolution. Avoid forking the module into two.

### 4.3 Debt engine as new infrastructure

The debt engine does not fit the existing `approaches.py` (all equity-oriented: OPM, income, market, asset). It should be a **new sibling module** in `engine-wrapper/app/engine/` (e.g. `debt.py` / a `credit/` package) with its own inputs contract, exposed through the same FastAPI compute surface and the same job/params/overwrites machinery the valuation service already uses. Reuse the *plumbing* (jobs, params, exhibits, report sections, sensitivity harness); do **not** try to reuse the *math*. Budget for new market inputs (yield curves) analogous to the existing `market_feed`.

### 4.4 Reuse that already exists (don't rebuild)

Whatever the product line, the following are horizontal and already built — new families should plug into them, not reimplement: intake questionnaire, cap-table ingest, accounting connectors, document extraction, the methodology decision log, QA gate, publish/signature gate, report templating + PDF, workbook exhibits, roll-forward, and the AI pipeline/prompt registry. The "80% done" is precisely this horizontal spine.

---

## 5. Recommendations — Prioritized Roadmap

Effort estimates assume the established per-feature pattern (migration + pure domain module + repo + routes + `app.ts` registration + Vitest unit & integration + frontend tab/page), calibrated to the feature waves already shipped.

| Priority | Item | Scope | Est. effort |
|---|---|---|---|
| **P0 (pre-work)** | **Resolve the "Portfolio" naming collision** (§4.1) | Naming/architecture decision + light rename of the existing consolidation feature. Do before any Portfolio Valuation code. | **0.5–1 wk** |
| **P1** | **ASC 718 Public** (§3.1, §4.2) | Underlying-source abstraction; issuer market-price + own-volatility path; ESPP + performance/market-condition (TSR, Monte-Carlo) awards; public expense mechanics (forfeiture true-up, graded vesting, disclosure tables); report/exhibit sections. Extends `asc718.ts`. | **3–5 wks** |
| **P2** | **Portfolio Valuation: Equity (ASC 820 fund holdings)** (§3.3) | New `fund` entity above holdings; per-holding fair-value method + calibration-to-transaction; ASC 820 Level 1/2/3 framework; NAV roll-up + unrealized gain/loss + roll-forward; disclosure exhibits. Reuses intake/cap-table/report spine. | **5–8 wks** |
| **P2** | **Portfolio Valuation: Debt** (§3.2, §4.3) | New engine module (DCF bond pricing, YTM, credit spread/OAS, yield curve, structural/comparable-yield credit model, convertibles); inputs contract; exhibits + report sections; yield-curve market inputs. Largest single item. | **6–10 wks** |
| **P3 (polish)** | Expert-call scheduling in onboarding | The one soft gap in the page-3 workflow (§2). Light — likely a calendar-link/booking integration on the existing onboarding/engagement flow. | **0.5–1 wk** |

**Suggested sequence:** P0 naming → P1 ASC 718 Public (fast, high ROI, extends existing) → P2 ASC 820 fund equity (reuses more of the spine than debt does) → P2 Debt engine (heaviest, most isolated, can proceed in parallel once the engine sibling module is scaffolded).

**Framing for stakeholders:** the platform is not being extended by 5 features — it is being extended by **~2.5 net-new capabilities** (718-Public deepening, ASC 820 fund holdings, and a debt engine). Everything else the brainstorm describes — the intake→dashboard→methodology→draft pipeline, the human-in-loop governance, and the dual VM/VR output — already exists and is deployed.

---

## 6. Note on the Voice Memo

`docs/1/WhatsApp Audio 2026-07-20 at 14.53.16.opus` (≈411 KB, **~3:01 duration**) accompanies the handwritten pages and almost certainly contains spoken context or elaboration on the same brainstorm.

**It could not be transcribed** for this analysis: no audio-transcription tooling (e.g. Whisper) is available in this environment, and no transcription service was invoked (doing so would send the audio to an external service — out of scope without explicit authorization).

**Recommendation:** transcribe it separately — locally with `whisper`/`whisper.cpp`, or by pasting a transcript here — and reconcile it against §1–§5. If the memo introduces nuances (e.g. a specific stance on the ASC 718 public/private split, on what "portfolio" is meant to cover, or on prioritization), update this document accordingly. Until then, this analysis reflects **only the handwritten pages**.

---

*This document is working analysis for `docs/1/` (untracked). It is intentionally not committed to git.*
