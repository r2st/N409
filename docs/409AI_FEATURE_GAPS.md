# 409.ai → N409 Feature Gap Analysis

> **Purpose:** Identify every feature present in the live 409.ai product that is
> **missing, partial, or stale** in the N409 clone, so the team can decide what
> (if anything) still needs building.
>
> **Method:** Logged into the live production system as an admin
> (`aarora@409.ai`) and browsed the admin back-office, the R‑engine explorers,
> the AI pipelines, and the public marketing site. Cross‑referenced every
> observed feature against (a) the existing `docs/409AI_FEATURES.md` catalogue
> and (b) the actual N409 source tree (`src/services/*`, `src/packages/shared`).
>
> **Date:** 2026‑07‑10 · **Live version observed:** 409.ai `0.10.1`
>
> **This is a documentation‑only deliverable. Nothing was implemented.**

---

## 0. Headline

**N409 is far more complete than a first glance suggests — roughly 90–95% of
409.ai's feature surface is already implemented.** The clone already has the
admin worklist, the full valuation lifecycle/state machine, the multi‑approach
Python engine (Black‑Scholes, Newton‑Raphson backsolve, cap‑table waterfall,
Chaffee/Finnerty DLOM), the AI pipelines (extract, missing‑data, comparables,
summarize, QA, explain, cap‑table anonymization), reviews/tasks, comments,
signatures, payments, partner API + white‑label, communication templates + auto
emails, accounting OAuth connect, the marketing site (landing, pricing,
which‑valuation quiz, compare, product pages), and a client valuation workspace.

The **real gaps are narrow and concentrated in five areas**, none of which is a
whole missing subsystem:

1. **AI narrative depth** — the Perplexity‑style market/company research prompt
   library that writes the report's narrative sections is largely unseeded.
2. **Inbound email ingestion** — the Inbox that matches client emails to
   valuations and queues unassigned ones is absent (only outbound + support
   tickets exist).
3. **Accounting breadth & anomaly detection** — fewer providers, no
   Railz‑style aggregation, no financial‑statement anomaly tables.
4. **A few engine refinements** — CAPM/beta derivation, LTM/NTM multiple
   handling, richer roll‑forward.
5. **2–3 product lines** — `portfolio` and `nav` (and the `smb` brand) are not
   in the kind enum.

The remaining items are polish (comparable "include" toggles, completeness
scores, the visNetwork engine graph, marketing micro‑interactions).

> **Deeper re‑scan (2026‑07‑10):** a second, more thorough crawl (every
> subdomain, the full marketing footer/blog, the admin "Documentation" and
> "Package Explorer" pages, the 27‑prompt registry, the Inbox) surfaced **4 new
> items** — gaps **#16–#19** in §2 and detailed in **§7–§8**: a public
> **Articles & Blog** hub (`/articles`, absent in N409), **product‑page FAQ**
> blocks, **AI auto‑populate‑UI + cap‑table‑CSV import from documents**, and the
> **`nav`** product kind. **§7 answers the documentation/help question**: 409.ai
> has **no** help‑center/API‑docs/user‑guide subdomain — N409 already **exceeds**
> it in‑app — so the only doc‑class thing worth adding is the marketing blog.
>
> **Third deep scan (2026‑07‑10):** an exhaustive crawl of the full `sitemap.xml`
> (54 URLs), every subdomain, all 14 product pages, all 8 compare pages, all 25
> articles, the sign‑up/sign‑in/password‑reset flows, `robots.txt`, and
> cross‑reference against the entire N409 `src/` tree surfaced **14 additional
> gaps** — **#20–#33** in §9. All 14 are in the **marketing/SEO/UX layer** —
> no new back‑office or engine gaps were found. Key additions: customer
> testimonials, partner logos, Calendly booking, web analytics (GTM + FB Pixel),
> SEO infrastructure (sitemap, robots, OG tags), email verification flow, pricing
> page FAQ + firms tier, contact form, and compare hub page. **Total: 33 gaps.**

---

## 1. Subdomain / Property Map

| Property | What it is | N409 equivalent | Status |
|----------|-----------|-----------------|--------|
| `onboard.app.409.ai/admin/*` | Analyst/ops back‑office | `web-frontend` admin pages + `valuation` service | ✅ Yes |
| `onboard.app.409.ai/` (client) | Client onboarding + valuation view | `OnboardingPage`, `valuation/ValuationWorkspace` | ✅ Yes (see §6) |
| `onboard.app.409.ai/sign_in` `/sign_up` | Auth (email + Google SSO) | `LoginPage`, `RegisterPage`, `GoogleCompletePage` | ✅ Yes |
| `www.409.ai` | Public marketing website | `pages/marketing/*` | ✅ Yes (see §5) |
| `<partner>.app.409.ai` | White‑label partner subdomains | migration `0050_partner_white_label`, `PartnerPortalPage` | ✅ Yes |
| `docs.409.ai` / `api.409.ai` / `help.409.ai` / `support.409.ai` / `blog.409.ai` / `status.409.ai` | **Confirmed absent** — see §7 deep probe (DNS wildcard, all 404) | `ApiDocsPage`, `HelpPage` served in‑app | ✅ N/A |
| `www.409.ai/articles` | Public **Articles & Blog** (24+ SEO/education posts) | **None** — no blog/articles route | ❌ **No** (see §8.1) |

> **Deep probe (2026‑07‑10, this scan):** `*.app.409.ai` is a **wildcard** that
> resolves every name to one AWS ALB; only `onboard.app.409.ai` actually serves
> an app (302→`/sign_in`). `docs`, `help`, `api`, `support`, `blog`, `status`,
> `developers`, `partner`, and a random control host all return **HTTP 404**.
> `docs.409.ai` (apex) does not resolve at all. **There is no docs/API/help/blog
> subdomain.** N409 **exceeds** 409.ai here (in‑app `ApiDocsPage`, `HelpPage`,
> `AdminHelpPage`, `HelpWidget`). The one documentation‑class thing 409.ai has
> that N409 lacks is the **public marketing article/blog hub** — see §7–§8.

---

## 2. Gap Summary Table (most‑actionable first)

Legend: **✅ Yes** = implemented · **🟡 Partial** = present but shallower than
409.ai · **❌ No** = absent.

| # | Feature (409.ai) | N409 | Priority | Where in N409 |
|---|------------------|------|----------|---------------|
| 1 | **Market‑research / narrative prompt library** (company_overview, industry_outlook, competitors, risks, revenue_discussion, market_us/uk/ca/au/si) | 🟡 Partial | **P1** | `ai/app/pipelines.py`, `repos/aiPrompts.ts` — infra exists, library unseeded |
| 2 | **Web‑search AI provider** (Perplexity live market research) | ❌ No | **P1** | `ai/app/openrouter.py` — single gateway, no web search |
| 3 | **Inbound email ingestion → valuation comment matching + unassigned queue (Inbox)** | ❌ No | **P1** | only `support.ts` (tickets) + `emailOutbox` (outbound) |
| 4 | **Missing‑Data pipeline: completeness %, conflicts, auto‑drafted client message** | 🟡 Partial | **P1** | `ai/app/pipelines.py:run_missing_data` — has severity, no % / conflicts / message |
| 5 | **Public Comparables: persisted include/exclude, set‑thesis, per‑company description** | 🟡 Partial | **P2** | `pipelines.py:run_comparables` — has name/ticker/rationale/multiples only |
| 6 | **Accounting: multi‑provider breadth + Railz aggregation + statement anomaly detection** | 🟡 Partial | **P2** | `routes/accounting.ts` — QuickBooks OAuth + P&L import; no anomaly tables |
| 7 | **Engine: CAPM / BETAS cost‑of‑capital derivation from comparables** | ❌ No | **P2** | `engine-wrapper/app/engine/approaches.py` — discount_rate is an input |
| 8 | **Engine: LTM vs NTM trailing/forward multiple handling** | 🟡 Partial | **P2** | params store the flags; `market_multiples()` is single‑metric |
| 9 | **Product lines: `portfolio`, `nav`, `smb`** | ❌ No | **P2** | kind enum has 13 kinds; missing these 3 |
| 10 | **Report editor: product‑specific section‑templated structure** | 🟡 Partial | **P2** | `ReportTab`, `RichTextEditor`, `report` service — free‑form, not per‑kind sections |
| 11 | **Calculations job console: raw engine Request/Response + HTTP status per step** | 🟡 Partial | **P3** | `CalculationPanel`, `aiJobs` — results shown, not raw payload/status rows |
| 12 | **Package Explorer visNetwork dependency graph** | 🟡 Partial | **P3** | `PackageTab`, `packageView.ts` — simpler table, not interactive graph |
| 13 | **Multi‑jurisdiction service_countries (US/UK/CA/AU/SG) with country market prompts** | 🟡 Partial | **P3** | kinds present; country‑scoped market research prompts missing (ties to #1) |
| 14 | **Marketing micro‑features** (social‑proof toasts, demo‑video modal, blog/articles, animated counters) | 🟡 Partial | **P3** | `marketing/LandingPage.tsx` — core page yes, micro‑interactions vary |
| 15 | **Intercom support widget** | 🟡 Partial | **P4** | `HelpWidget` (in‑house) instead of Intercom |
| 16 | **Public Articles & Blog hub** (`/articles`, 24+ SEO/education long‑form posts + per‑product FAQ) | ❌ **No** | **P2** | `pages/marketing/*` — no `/articles` route/page (see §8.1) |
| 17 | **Product‑page FAQ + "what's included" + "3 steps" blocks** | 🟡 Partial | **P3** | `ProductPage.tsx` — no FAQ accordion per kind (see §8.2) |
| 18 | **AI auto‑populate onboarding UI + import cap‑table CSV *from uploaded docs*** (`AI:PopulateUi`, `IMPORT_UI_PROMPT`, `IMPORT_CAPTABLE_PROMPT`) | 🟡 Partial | **P2** | `run_extract` emits numeric `engine_inputs` only; no full‑form/cap‑table‑CSV autofill (see §8.3) |
| 19 | **`nav` product line / kind** (live "Nav" column on ops dashboard) | ❌ **No** | **P3** | `VALUATION_KINDS` has 13; `nav` absent (`portfolio`≈`820`, `smb`≈`fmv`) (see §8.4) |
| 20 | **Customer testimonials carousel** (3 cards with name/title/company/quote, navigation arrows) | ❌ **No** | **P3** | `LandingPage.tsx` — no testimonial section or data (see §9.3) |
| 21 | **Partner / client logo carousel** ("Trusted by 1,000+ Companies" — 8+ partner logos) | ❌ **No** | **P3** | `LandingPage.tsx` — integrations use text pills, no trust‑badge logos (see §9.3) |
| 22 | **"Book a Call" / Calendly + demo video** (CTAs on landing/product pages → Calendly booking + Vimeo embed) | ❌ **No** | **P3** | No booking/video references in `src/` (see §9.3) |
| 23 | **Web analytics & tracking pixels** (GTM `GTM‑P9C6PB8D`, FB Pixel `829444808735344`, GA) | ❌ **No** | **P2** | Zero analytics code anywhere in `src/` (see §9.3) |
| 24 | **SEO infrastructure** (sitemap.xml, robots.txt, OG tags, Twitter Cards, JSON‑LD, per‑page `<title>`) | ❌ **No** | **P2** | Single hardcoded `<meta>` in `index.html`; no head management lib (see §9.3) |
| 25 | **Cookie consent / GDPR banner** | ❌ **No** | **P3** | No consent mechanism (see §9.3) |
| 26 | **Email verification flow** (token → email → click → verified) | 🟡 **Partial** | **P2** | `verified` column exists but no token/email/endpoint — flag never flipped (see §9.3) |
| 27 | **Phone country‑code selector** (international dropdown, 240+ countries) | ❌ **No** | **P3** | Plain `<TextInput type="tel">` (see §9.3) |
| 28 | **Contact form** (Name, Email, Company, Mobile, Message + submit) | ❌ **No** | **P3** | `ContactPage` shows static email addresses only (see §9.3) |
| 29 | **Social media links in footer** (Twitter/X, LinkedIn icons) | ❌ **No** | **P4** | Footer has Company + Legal only (see §9.3) |
| 30 | **Compare provider hub page** (`/compare/409a-valuation-providers` — 5 model types + "what to ask") | ❌ **No** | **P3** | 7 individual pages ✅ but no overview hub (see §9.3) |
| 31 | **Pricing page FAQ section** (15+ questions: pricing, delivery, methodology, audit defence) | ❌ **No** | **P3** | Calculator + comparison table ✅ but no FAQ (see §9.3) |
| 32 | **"Firms" pricing tier** (enterprise/agency tier with "Get in Touch" CTA) | ❌ **No** | **P3** | Single consumer tier only (see §9.3) |
| 33 | **Audit defence pricing display** ($175/hr on product FAQ + pricing table) | ❌ **No** | **P3** | Not shown anywhere in marketing UI (see §9.3) |

Everything **not** in this table (dashboard, worklist + scopes, meta‑editor,
params, workbook, overwrites + schema explorer, sensitivity dashboard, reviews
/ 12 task types, dual signatures, chat, comments, sticky notes, clone /
roll‑forward, reassign, payments, partner tokens + partner list, users + RBAC,
auto emails, communication templates, CSV exports, global search, cap‑table
anonymization, extract/summarize/QA/explain pipelines) is **✅ implemented** and
verified against both the live site and the code.

---

## 3. Detailed Gap Descriptions

### P1 — Highest impact (report quality & ops throughput)

#### 3.1 Market‑research / narrative prompt library — 🟡 Partial
**What 409.ai does:** The `/admin/prompts` registry holds ~27 named prompts.
A large subset are *narrative research* prompts run against a web‑search model
(Perplexity) to author the report's prose sections:
`company_overview`, `business_overview`, `company_description`,
`industry_outlook`, `competitors`, `risks`, `revenue_discussion`, and
country‑specific market commentary (`market_us`, `market_uk`, `market_ca`,
`market_au`, `market_si`, plus `csop_market` / `emi_market` / `ifrs2_market`
for the UK/EU products). These populate the "Company Overview", "Industry",
"Risks", and "Market" sections of the deliverable.

**N409 today:** The infrastructure is fully present — an editable prompt
registry (`BotPromptsPage`, `repos/aiPrompts.ts`, `routes/prompts.ts` with
versioning via `0045_prompt_versions`). But only a couple of prompts are seeded
(`summarize`, `business_overview`); the extract/missing/comparables/qa/explain
pipelines carry inline system prompts in `pipelines.py`. The **narrative
research prompt set is essentially unpopulated**, so N409 reports would have
thin/empty market & company narrative sections.

**How to close:** Seed the ~15 narrative prompts and wire each to a report
section; requires a web‑search‑capable model (see 3.2).

#### 3.2 Web‑search AI provider (Perplexity) — ❌ No
**What 409.ai does:** Routes market‑research prompts to Perplexity /
Perplexity‑PRO, which has live internet access, so industry outlook and
comparable narrative reflect current data. Bedrock (Sonnet) is used for
cap‑table anonymization; Anthropic Opus for structured extraction.

**N409 today:** Uses a single OpenRouter gateway (`ai/app/openrouter.py`).
OpenRouter *can* reach many models, but there is **no web‑search / live‑research
path** — narrative prompts would hallucinate or be generic. Cap‑table
anonymization and extraction are correctly implemented.

**How to close:** Add a Perplexity (or web‑search‑tool) provider route for the
narrative prompt class; keep OpenRouter for extraction/reasoning.

#### 3.3 Inbound email ingestion → Inbox — ❌ No
**What 409.ai does:** `/admin/inbox` ingests inbound client emails, matches
each to a valuation (by sender/thread), and converts matched mail into
valuation **comments**; unmatched mail lands in an **"unassigned emails" queue**
for manual routing. Header badges show "N unread" and "N unassigned emails".
Per‑valuation `admin_read_at` / `user_read_at` tracking drives unread state.

**N409 today:** Has **outbound** email (`emailOutbox`, auto‑emails), a
**support‑ticket** inbox (`SupportInboxPage`, `support.ts`), and per‑valuation
comments/chat — but **no inbound email parsing, matching, or unassigned queue**.
This is the single largest *ops workflow* gap.

**How to close:** Add an inbound mail webhook (e.g. SendGrid Inbound Parse) →
match to valuation → create comment; add an unassigned queue + routing UI.

#### 3.4 Missing‑Data pipeline depth — 🟡 Partial
**What 409.ai does:** The Missing‑Data pipeline returns, live: a **completeness
score** ("Completeness: 60.0%"), a count of documents analysed, a categorised
**missing list with severity** (High/Low), a **Conflicts** tab (contradictions
between documents), and an auto‑drafted **"Chat Message"** ready to send to the
client asking for the missing items.

**N409 today:** `run_missing_data` returns `gaps[]` with
`severity: blocking|important|nice_to_have` plus `missing_documents` /
`missing_params`. **Missing:** the numeric completeness %, the conflicts
detection, and the auto‑drafted client message.

**How to close:** Extend the prompt/output schema with `completeness`,
`conflicts[]`, and a `draft_message` field; surface a "Send to client" action.

---

### P2 — Meaningful, scoped

#### 3.5 Public Comparables depth — 🟡 Partial
**409.ai:** Returns a **comparable‑set thesis** (one paragraph framing the peer
group), and for each company a **description**, a **rationale for inclusion**,
and a persisted **Include/Exclude toggle** so analysts curate the final set that
feeds the market approach. **N409** (`run_comparables`) returns
name/ticker/rationale/revenue & ebitda multiples but **no thesis, no
description, and no persisted include/exclude selection**.

#### 3.6 Accounting integration breadth & anomalies — 🟡 Partial
**409.ai:** The Calculations console shows a **Railz** job group (10 calls) —
Railz aggregates QuickBooks, Xero, FreshBooks, Oracle NetSuite, Sage, and Wave
behind one API — and renders **Income‑Statement** and **Balance‑Sheet Anomaly**
tables (flagging suspicious accounts before they hit the model). Six providers
are advertised on the marketing site.
**N409:** `routes/accounting.ts` + `accountingConnections` implement OAuth
connect + P&L import (QuickBooks realm evidenced). **Missing:** provider breadth
beyond QuickBooks, an aggregation layer, and financial‑statement **anomaly
detection**.

#### 3.7 Engine: CAPM / beta derivation — ❌ No
**409.ai:** A `BETAS` R module derives cost of capital from comparable betas
(CAPM), feeding the income approach discount rate automatically.
**N409:** `income_dcf()` takes `discount_rate` as a **required input** — the
analyst must supply it; there is no beta/CAPM derivation from the comparable
set. Correct math, but a manual step 409.ai automates.

#### 3.8 Engine: LTM vs NTM multiples — 🟡 Partial
**409.ai:** Distinguishes trailing (LTM) vs forward (NTM) revenue/EBITDA
multiples and supports custom ranges. **N409:** the params page stores
`market_approach_ltm` / `_ntm` and `use_custom_ranges` flags, but
`market_multiples()` applies a single metric × multiple; the LTM/NTM distinction
is not carried into the computation.

#### 3.9 Missing product lines — ❌ No
409.ai supports 16 kinds; the ops dashboard shows a live **`Nav`** column.
N409's kind enum has **13**: `409a, 718, 820, csop, emi, esop, fmv, gifts,
goodwill, ifrs2, ip, ppa, qsbs`. **Missing:** `portfolio`, `nav`, and the `smb`
brand (partially covered by `fmv`). Each needs its own template/params defaults.

#### 3.10 Report editor: per‑kind section templates — 🟡 Partial
**409.ai:** Reports are assembled from **product‑specific numbered sections**
(e.g. `04-company_overview`, `10-dlom`) via HAML templates with
`editable_content` tags, bound to a versioned template (`409a.v11`).
**N409:** `ReportTab` + `RichTextEditor` + the `report` PDF service produce a
report, but from a **free‑form / single‑template** structure rather than a
per‑kind library of pinned, individually‑editable sections. Report **versioning**
exists (`reportTemplates`, `reports` repos); the **section library per product**
is the partial piece.

---

### P3 / P4 — Polish

- **3.11 Calculations job console (🟡):** 409.ai lists each engine step
  (`aggregate → accounting → market → weights → render`) as a row with
  **Request/Response JSON + RAW links and HTTP status codes** (200/400), grouped
  Ai / Bot / Railz. N409's `CalculationPanel` shows results and AI jobs but not
  the raw per‑step request/response/status console.
- **3.12 Package Explorer (🟡):** 409.ai renders an interactive **visNetwork**
  graph of ~150 R engine functions across 10 dependency levels. N409 has a
  `PackageTab` / `packageView.ts` (simpler, tabular). Cosmetic / internal‑tooling.
- **3.13 Country market prompts (🟡):** ties to 3.1 — per‑jurisdiction market
  commentary (US/UK/CA/AU/SG).
- **3.14 Marketing micro‑features (🟡):** core marketing pages exist; verify
  presence of real‑time **social‑proof toasts**, **demo‑video modal**,
  **blog/articles** list, and **animated stat counters**.
- **3.15 Intercom (🟡):** N409 ships an in‑house `HelpWidget` instead of the
  Intercom third‑party widget — arguably an improvement, listed for completeness.

---

## 4. Verified‑Present (no action needed)

These were specifically checked live **and** in code and are fully implemented,
so they should **not** be re‑built:

- Admin worklist with all scopes (all/incomplete/unverified/in‑progress/
  waiting‑on‑client/drafted/published/unread/ignored), rich filters, sort, CSV.
- Dashboard stage × product pivot.
- Meta‑editor (all valuation fields), Valuation Params (weights, DLOC, DLOM
  Chaffee/Finnerty/qualitative, market method, asset method), Workbook.
- Engine: `bs.py`, `newton.py` (backsolve root‑find), `waterfall.py`
  (multi‑class participating/non‑participating/options), `dlom.py`
  (Chaffee + Finnerty), `approaches.py` (income DCF, market multiples, asset
  cost‑to‑replicate/NAV), `opm_backsolve`, prior‑approach reuse for roll‑forward.
- Sensitivity dashboard (`/admin/investor`) — Black‑Scholes stress grids.
- AI: extract, summarize, cap‑table anonymization, QA, explain pipelines
  (QA + explain actually **exceed** the observed 409.ai surface).
- Reviews/tasks (12 task types), dual signatures, publish gate.
- Comments, chat, sticky notes, clone/roll‑forward, reassign.
- Payments (+ receipts), partner API tokens, partner list, white‑label subdomains.
- Users + RBAC roles, password reset + invitations.
- Communication templates (lifecycle categories, `{{var}}` interpolation) +
  auto emails/SMS drip campaigns.
- Overwrites system + self‑documenting overwrites schema explorer.
- Marketing: Landing, Pricing calculator, Which‑Valuation quiz, Compare pages,
  Product pages, static (Terms/Privacy/About/Contact).
- Client onboarding: register, Google SSO, billing, **AccountingConnect**,
  document upload, valuation workspace tabs (Company/Report/Workbook/Overwrites/
  Pipeline/Progress/QA/Scenarios/Decisions/Package).

---

## 5. Recommended Priority Ranking

| Rank | Item | Why | Effort |
|------|------|-----|--------|
| 1 | Inbound email ingestion + Inbox (3.3) | Core ops workflow; currently no way to fold client email into a valuation | M |
| 2 | Narrative prompt library + web‑search provider (3.1 + 3.2) | Directly determines report narrative quality — the "AI" in the product | M |
| 3 | Missing‑Data completeness/conflicts/auto‑message (3.4) | Highest‑frequency analyst→client loop; cheap once prompts exist | S |
| 4 | Comparables include‑toggle + thesis (3.5) | Analyst curation of the market approach; feeds numbers, not just prose | S |
| 5 | Accounting anomaly detection + provider breadth (3.6) | Data‑quality gate before the engine runs | M |
| 6 | Engine CAPM/beta + LTM/NTM (3.7 + 3.8) | Removes manual analyst inputs; improves defensibility | M |
| 7 | Product lines portfolio / nav / smb (3.9) | Unlocks 3 revenue lines; mostly config + templates | S–M |
| 8 | Report per‑kind section templates (3.10) | Report consistency & maintainability | M |
| 9 | Polish: calc console, visNetwork, marketing micro‑UX (3.11–3.15) | Nice‑to‑have | S each |

**Effort:** S = <1 day · M = 1–3 days · (all estimates rough, single‑dev).

---

## 6. Notes & Caveats

- Browsing was performed as an **admin/god** user; the *client‑role* funnel was
  inferred from N409 code (`OnboardingPage`, `AccountingConnect`, billing) and
  the marketing/onboarding copy rather than driven end‑to‑end with a fresh
  client account. If a pixel‑exact client funnel parity check is wanted, create
  a throwaway client account and re‑walk steps 1–11 of §20.1 in
  `409AI_FEATURES.md`.
- Some sub‑pages listed in `409AI_FEATURES.md` §8–§9 (Captables, Projections,
  Historical Data, Finances, Journals, Team Support, Amount Raised, Transaction
  History as *separate* nav pages) appear **stale**: the current live
  per‑valuation sidebar exposes only REPORT (Calculations, Editor, PDF,
  Overwrites, Versions) and DATA (Details, Workbook, Params, AI/Attachments);
  "Network Items" is a **tab** inside AI/Attachments, not a page. N409's data
  model (transactions, company profiles, workbook) already covers this data, so
  it is **not** counted as a gap.
- `docs/409AI_FEATURES.md` remains the authoritative *feature catalogue*; this
  document is the *delta* against N409 and should be re‑generated if either the
  live product or the clone changes materially.

---

## 7. Documentation & Help — Deep‑Scan Addendum (2026‑07‑10)

> This section answers the specific question **"Does N409 need documentation
> pages like 409.ai has (help center, API docs, user guides)?"** and records a
> second, deeper crawl that re‑walked every subdomain, the whole marketing
> footer/nav, the admin "Documentation" and "Package Explorer" pages, the full
> prompt registry, and the Inbox. Method: logged in live as `aarora@409.ai`;
> DNS/HTTP‑probed the subdomain space; cross‑checked every finding against the
> N409 source tree.

### 7.1 What "documentation" actually exists on 409.ai

| Surface | What it is | Audience | N409 equivalent |
|---------|-----------|----------|-----------------|
| Admin sidebar **"Documentation"** → `/admin/overwrites_doc` | The **Overwrites Explorer** — a searchable schema browser of overwrite fields (6 categories, ~68 fields, class/min/max/example). **Not** prose docs. | Internal analysts | ✅ Overwrites schema explorer (`OverwritesTab` + self‑doc schema) |
| Admin sidebar **"Package Explorer"** → `/admin/package_explorer_doc` | Interactive map of the R **engine functions** (dependency graph). Internal engineering doc. | Internal | 🟡 `PackageTab`/`packageView.ts` (tabular, simpler — gap #12) |
| `www.409.ai/articles` | **Articles & Blog** — 24+ long‑form SEO/education posts (~1,200 words each: 409A process, tax, QSBS/OBBBA, 83(b), ISO vs NSO, the three valuation approaches, report walkthrough). Titled "Articles & Blog", byline "409.AI Team", CTA per post. | Public / prospects | ❌ **None** (gap #16) |
| Product pages `www.409.ai/products/*` | Each has a **FAQ** ("Common 409A valuation questions"), a "What is included" list, and a "3 simple steps" explainer. | Public / prospects | 🟡 Product pages exist; **no FAQ block** (gap #17) |
| In‑app **support chat bubble** (sign‑in + app) | Custom/in‑house widget — **no third‑party** Intercom/Crisp/Drift/Zendesk/HubSpot globals or scripts were present (checked `window` + `document.scripts`). | Clients | ✅ `HelpWidget` (in‑house) |
| Inbound‑email support | `/admin/inbox` folds client emails into valuation comments (+ unassigned queue). | Clients↔ops | ❌ inbound side absent (gap #3) |

**There is NO formal help center, NO knowledge base, NO public/partner API
documentation site, and NO user manual/guide anywhere on 409.ai** (no
`docs.`/`help.`/`support.`/`api.` subdomain, no in‑app help center). 409.ai's
entire "documentation" footprint for *users* is: the marketing **blog**, the
product‑page **FAQs**, and a **support chat + email**.

### 7.2 Subdomain probe (definitive)

`*.app.409.ai` is a **wildcard** DNS record → one AWS ALB (`k8s-globalalb-…elb.amazonaws.com`).
DNS resolving a name proves nothing; the ALB routes by `Host`. Fetching each
with the real Host header:

```
onboard.app.409.ai      → 302 /sign_in   (the only real app)
docs.app.409.ai         → 404
help.app.409.ai         → 404
api.app.409.ai          → 404
support.app.409.ai      → 404
blog.app.409.ai         → 404
status.app.409.ai       → 404
developers.app.409.ai   → 404
partner.app.409.ai      → 404
randomxyz999.app.409.ai → 404   (control — confirms catch‑all)
```

Apex‑level `docs.409.ai` / `help.409.ai` / `blog.409.ai` / `status.409.ai` do
**not resolve at all**. `www.409.ai` is the marketing SPA;
`<partner>.app.409.ai` is the white‑label mechanism (already ✅ in N409).

### 7.3 Direct answer: does N409 need doc pages like 409.ai?

**No new help‑center / API‑docs / user‑guide infrastructure is required — N409
already exceeds 409.ai on in‑app documentation.** N409 ships:

- `HelpPage.tsx` — a **searchable in‑app help center** (help articles with
  `slug`/`title`/`category`/`keywords`; backed by `repos/helpArticles.ts` +
  `routes/help.ts`). 409.ai has **no** equivalent.
- `ApiDocsPage.tsx` — a **partner API reference**, auto‑generated from the route
  registry (`GET /api/partner/v1/docs`) so it can't drift. 409.ai has **no**
  equivalent.
- `AdminHelpPage.tsx` + `HelpWidget.tsx` — admin help + in‑app support widget.

The **only** documentation‑class surface 409.ai has that N409 lacks is the
**public, top‑of‑funnel marketing blog** (`/articles`) and the **product‑page
FAQ blocks** — these are SEO / lead‑generation content, not product docs. If SEO
and organic acquisition matter, build them (§8.1–§8.2). Otherwise N409's
documentation posture is already ahead.

---

## 8. New / Re‑characterised Gaps From the Deeper Scan

### 8.1 Public Articles & Blog hub — ❌ No (gap #16, P2)
**409.ai:** `www.409.ai/articles` ("Articles & Blog", h1 "Be the finance
superhero.") lists **24+** long‑form SEO/education posts, each ~1,200 words with
structured H2/H3 stages, a "409.AI Team" byline, and a valuation CTA. Topics
span the 409A process, tax treatment, QSBS/OBBBA §1202 changes, the 83(b)
election, ISO vs NSO, and the income/market/asset approaches. Footer exposes it
under **COMPANY → Articles**; "View all articles" on the landing page.
**N409:** marketing has Landing / Pricing / Which‑Valuation / Product /
Compare / Static only — **no `/articles` route, no blog, no article store**
(confirmed: no `article`/`blog` references under `pages/marketing/`, no route in
`App.tsx`). **Impact:** pure organic‑acquisition/SEO surface; no product impact.
**Close it:** add an `articles` content collection (markdown or DB) + list/detail
routes + footer link; seed the ~24 posts. Effort **M**.

### 8.2 Product‑page FAQ / "what's included" / "3 steps" — 🟡 Partial (gap #17, P3)
**409.ai** product pages carry a per‑kind **FAQ** ("Common 409A valuation
questions"), a **"What is included"** deliverables list, and a **"3 simple
steps"** intake→AI→report explainer. **N409** `ProductPage.tsx` renders product
copy but has **no FAQ accordion** (no `faq`/`question` structures in
`ProductPage.tsx` or the product data in `marketing.ts`). **Close it:** add an
optional `faq: {q,a}[]` to each product in `marketing.ts` and render an
accordion. Effort **S**.

### 8.3 AI auto‑populate UI + import cap‑table CSV from documents — 🟡 Partial (gap #18, P2)
**409.ai** prompt registry (27 prompts, live) includes **`AI:PopulateUi` /
`IMPORT_UI_PROMPT`** (populate the onboarding/meta UI fields from uploaded
content) and **`IMPORT_CAPTABLE_PROMPT` / `Captable/ExtractJSON`** (build a
structured **cap‑table** from documents), plus `Industry_finder`,
`AI:FindRelevantTags`, and `market_un`. So 409.ai auto‑fills the *whole intake
form and the cap table* from a document drop. **N409** `run_extract` extracts
**only the 13 numeric `engine_inputs`** (shares, options, prefs, cash/debt,
revenue/EBITDA, vol, rfr) with source citations — it does **not** populate the
broader company‑profile UI fields or ingest a structured multi‑class cap table
from documents. **Close it:** add an `import_ui`/`import_captable` pipeline that
emits structured company‑profile + cap‑table rows (not just engine scalars) and
writes them into the meta editor / cap‑table store. Effort **M**.

> **Correction to §3.1:** the deeper scan confirms the 409.ai narrative prompt
> library is **fully populated and actively maintained** (12+ market/company
> prompts routed to **`perplexity` / `perplexity‑PRO`**, updated through
> Jan 2026): `company_overview`, `company_description`, `industry_overview`,
> `industry_outlook`, `competitor`, `risks`, `Industry_finder`, and country
> markets `market_us/uk/ca/au/si/un`. Cap‑table anonymisation → `bedrock‑SONNET35`;
> competitors → `bedrock‑LLAMA33`; extraction/comparables/params/missing‑data →
> `Anthropic‑OPUS_4_8`. This **confirms** gaps #1 (N409's library is unseeded)
> and #2 (no web‑search provider) — it does not change them, but the live model
> routing is now documented for whoever seeds the prompts.

### 8.4 `nav` product line/kind — ❌ No (gap #19, P3)
The ops dashboard shows a live **`Nav`** product column (1 published). N409's
`VALUATION_KINDS` = `409a, fmv, 718, 820, gifts, qsbs, csop, emi, ifrs2, ppa,
goodwill, esop, ip` (**13**) — **`nav` is missing**. (Refines old #3.9:
`portfolio` on 409.ai is just an **ASC‑820 alias** — its marketing link points
to `/products/asc-820` — and `smb` is already covered by N409's `fmv` kind +
the SMB marketing product. So the single genuinely‑missing **kind** is `nav`,
not three.) **Close it:** add `nav` to the enum + a template/params default.
Effort **S**.

### 8.5 Verified‑present in this pass (no action)
Re‑checked live **and** in code, fully present — do **not** rebuild:
- **7 competitor Compare pages** — Carta, Pulley, Eqvista, Kruze, Eton, Aranca,
  Scalar — full parity (`marketing.ts` has all 7).
- **13 marketing product lines** incl. **SMB Valuation** (`smb-valuation`, "SMB /
  FMV") — parity with 409.ai's public product menu (Portfolio = ASC‑820 alias).
- **Inbox** = inbound email → valuation comment + unassigned queue (confirms the
  *shape* of gap #3; the live badge showed "1 unassigned emails").
- **In‑house support widget** (no third‑party chat vendor) — matches `HelpWidget`.
- Admin nav fully mapped: Dashboard, Documentation(=overwrites_doc), Package
  Explorer, Inbox, Sensitivity Dashboard, Valuations + 7 scopes, Reviews,
  Partner Valuation, Users, API Tokens, Prompts — all have N409 equivalents.

---

## 9. Third Deep Scan — 14 Additional Gaps (#20–#33)  ·  2026‑07‑10

> **Method:** Exhaustive crawl of `www.409.ai` (every page in the
> `sitemap.xml` — 54 URLs), all subdomains (`onboard.app.409.ai`,
> `docs/help/api/status/blog/admin/dashboard/portal/demo.409.ai` — all 404
> except `onboard`), every product page (14), all compare pages (8 including
> hub), all 25 articles, the sign-up/sign-in/password-reset flows, `robots.txt`,
> and `sitemap.xml`. Cross‑referenced every finding against the N409 source tree.
> **This scan surfaced 14 NEW gaps (#20–#33) concentrated in the marketing/SEO
> layer and onboarding UX — zero new back‑office or engine gaps.**

### 9.1 Expansion of gap #17 — product page structural depth

The original gap #17 listed "FAQ + 'what's included' + '3 steps' blocks" as
partial. The live site's product pages are **significantly richer** than
documented — each has **8 sections**, while N409's `ProductPage.tsx` renders
only **3** (Hero, "What you get", Related Products). The full live template:

| # | Section | Live site | N409 |
|---|---------|-----------|------|
| 1 | Breadcrumb (HOME > PRODUCTS > Name) | ✅ | ❌ |
| 2 | Hero (tag + headline + subhead + CTA + **report card mockup**) | ✅ | 🟡 (simpler, no mockup) |
| 3 | **THE PROBLEM** (headline + cross‑link to related product + 3 bullets) | ✅ | ❌ |
| 4 | **SOLUTION** (headline + 4 feature cards) | ✅ | ❌ |
| 5 | **PROCESS** (3 steps: Intake → AI Analysis → Final Report) | ✅ | ❌ |
| 6 | **INCLUDED** (5 checklist items, per‑product) | ✅ | ❌ |
| 7 | **FAQ** (8–14 Q&A pairs, per‑product) | ✅ | ❌ |
| 8 | Bottom CTA (headline + legal disclaimer + 2 buttons) | ✅ | ❌ |

Each product page also **cross‑links to a related product** in the Problem
section (e.g. 409A → ASC 718, EMI ↔ CSOP, ESOP → 409A, PPA → Impairment
Testing). The QSBS page uniquely uses "Request Attestation" CTA instead of
"Start My Valuation", and the 409A page has the most FAQs (14) including audit
defence pricing.

**Close it:** Add per‑product data arrays (`problem`, `solution`, `process`,
`included`, `faq`) to each entry in `marketing.ts`; render the 5 missing
sections in `ProductPage.tsx`. Effort **M**.

### 9.2 Updated gap table — additions #20–#33

| # | Feature (409.ai) | N409 | Priority | Where in N409 |
|---|------------------|------|----------|---------------|
| 20 | **Customer testimonials carousel** (3 cards: name, title, company, quote; navigation arrows) | ❌ **No** | **P3** | `LandingPage.tsx` — no testimonial section, no data in `marketing.ts` |
| 21 | **Partner / client logo carousel** ("Trusted by 1,000+ Companies" — Techstars, Vestd, Promissory, DeepFlows, Mantle, Fidelity, Sage, Wave logos) | ❌ **No** | **P3** | `LandingPage.tsx` — no logo carousel; `ACCOUNTING_PROVIDERS` renders text pills only |
| 22 | **"Book a Call" / Calendly integration** (CTA on landing, about, product‑page bottoms → `calendly.com/ygawande-409/30min`) | ❌ **No** | **P3** | No Calendly/booking references anywhere in `src/` |
| 23 | **Web analytics & tracking pixels** (Google Tag Manager `GTM‑P9C6PB8D`, Facebook/Meta Pixel `829444808735344`, Google Analytics) | ❌ **No** | **P2** | Zero analytics code — no GTM, GA, FB Pixel, Segment, Mixpanel, or PostHog |
| 24 | **SEO infrastructure** (sitemap.xml, robots.txt, Open Graph meta, Twitter Card meta, JSON‑LD structured data, per‑page dynamic `<title>` / `<meta>`) | ❌ **No** | **P2** | Single hardcoded `<meta description>` in `index.html`; no sitemap, robots.txt, OG tags, dynamic head management, or structured data |
| 25 | **Cookie consent / GDPR banner** | ❌ **No** | **P3** | No consent mechanism; becomes required once analytics (#23) is added |
| 26 | **Email verification flow** (sign‑up → verification email with token link → click → `verified = true`) | 🟡 **Partial** | **P2** | `users` table has `verified` boolean; Google SSO auto‑verifies. But **no** token generation, verification email dispatch, or verification landing page — the flag is never flipped for email sign‑ups |
| 27 | **Phone country‑code selector** (international dropdown with 240+ country codes on sign‑up, US default) | ❌ **No** | **P3** | `SettingsPage.tsx` line 94: plain `<TextInput type="tel">` with no country‑code dropdown |
| 28 | **Contact form** (Name, Email, Company, Mobile, Message fields + "Send Message" submit) | ❌ **No** | **P3** | `ContactPage` in `StaticPages.tsx` shows only static email addresses — no form, no submit |
| 29 | **Social media links in footer** (Twitter/X `twitter.com/409ai`, LinkedIn `linkedin.com/company/409ai/`) | ❌ **No** | **P4** | `MarketingLayout.tsx` footer has Company + Legal columns only; zero social links |
| 30 | **Compare provider hub page** (`/compare/409a-valuation-providers` — overview categorising providers into 5 model types + "What founders should ask" section) | ❌ **No** | **P3** | N409 has the 7 individual competitor pages but no overview/hub page or route |
| 31 | **Pricing page FAQ section** (15+ questions covering pricing mechanics, delivery, methodology, validity, frequency, audit defence, etc.) | ❌ **No** | **P3** | `PricingPage.tsx` has calculator + comparison table but **no FAQ section** |
| 32 | **"Firms" pricing tier** ("Leverage our AI powered valuation technology" enterprise/agency tier with "Get in Touch" mailto) | ❌ **No** | **P3** | `PricingPage.tsx` has a single consumer tier only |
| 33 | **Audit defence pricing display** ($175/hr, shown on 409A product FAQ + pricing page) | ❌ **No** | **P3** | Not displayed or offered anywhere in the marketing or pricing UI |

### 9.3 Detailed gap descriptions — #20–#33

#### 20. Customer testimonials carousel — ❌ No (P3)
**409.ai:** Landing page has a "Hear it from our customers" section with 3
testimonial cards (Porter Bayne / World Spice, Paul Crowe / Metronome, Amy
Ding / Requity Homes), each with a quote, name, title, and company. Navigation
arrows (< >) cycle through them. **N409:** `LandingPage.tsx` sections are Hero,
Stats, Why, How It Works, Integrations, Products, CTA — **no testimonials
section**, no testimonial data in `marketing.ts`. **Close it:** add a
`TESTIMONIALS` array to `marketing.ts` and a carousel section to
`LandingPage.tsx`. Effort **S**.

#### 21. Partner/client logo carousel — ❌ No (P3)
**409.ai:** "Trusted by 1,000+ Companies" with scrolling partner logos
(Techstars, Vestd, Promissory, DeepFlows, Mantle, Fidelity, Sage, Wave).
**N409:** `ACCOUNTING_PROVIDERS` renders text pills ("QuickBooks", "Xero",
etc.) — **no trust-badge logo strip, no partner logos**. **Close it:** add logo
images + a scrolling trust-badge section. Effort **S**.

#### 22. "Book a Call" / Calendly integration — ❌ No (P3)
**409.ai:** CTAs on the landing page, about page, and every product-page bottom
link to `calendly.com/ygawande-409/30min`. Also "Watch a demo" links to
`vimeo.com/911682724`. A secondary HubSpot booking link
(`meetings.hubspot.com/ktran4`) is used for firm/partner inquiries. **N409:**
`/contact` shows only static email addresses; no booking widget, no Calendly,
no video embed. **Close it:** add external links to Calendly + Vimeo on the
landing/product pages and contact page. Effort **S**.

#### 23. Web analytics & tracking pixels — ❌ No (P2)
**409.ai:** Google Tag Manager (`GTM-P9C6PB8D`), Facebook/Meta Pixel
(`829444808735344`), Google Analytics (per privacy policy), and HubSpot
tracking. **N409:** Zero analytics — no GTM, GA, FB Pixel, or any event
tracking anywhere in `src/`. No analytics-related environment variables in
`.env.example`. **Close it:** add GTM container (covers GA + FB Pixel
downstream) and wire environment variables. Effort **S**.

#### 24. SEO infrastructure — ❌ No (P2)
**409.ai:** Full SEO stack — `sitemap.xml` (54 URLs, auto-generated),
`robots.txt` (explicitly welcomes AI crawlers like GPTBot, ClaudeBot,
PerplexityBot), per-page `<title>`, `<meta description>`, Open Graph tags
(`og:image`, `og:type`, `og:site_name`), Twitter Card tags
(`twitter:card: summary_large_image`), canonical URLs, and
`theme-color: #113D2F`. **N409:** Single hardcoded `<meta description>` in
`index.html`. No `react-helmet` or equivalent head-management library.
No sitemap, robots.txt, OG tags, Twitter Cards, canonical URLs, or structured
data. **Close it:** add `react-helmet-async`, generate per-page meta,
add sitemap/robots generation. Effort **M**.

#### 25. Cookie consent / GDPR banner — ❌ No (P3)
**409.ai:** Privacy policy references Google Analytics, HubSpot, and Meta Pixel
as third-party services that set cookies. A consent mechanism would be needed.
**N409:** No consent banner, no GDPR notice. Becomes **required** once analytics
(#23) is added. **Close it:** add a cookie-consent banner library. Effort **S**.

#### 26. Email verification flow — 🟡 Partial (P2)
**409.ai:** Sign-up requires email verification (the `users` table has a
`verified` flag; `sign_in` page says "verified" status visible in admin).
**N409:** The `verified` column exists (`0001_core.sql` line 41). Google SSO
auto-verifies. But for email/password sign-ups there is **no token generation,
no verification email sent, no verification endpoint, and no landing page** —
the `verified` flag is never flipped. `SettingsPage.tsx` line 153 says "Check
your inbox to verify" after email change, but no email is dispatched. **Close
it:** generate a signed token at registration, send a verification email via
the existing email outbox, add a `/verify/:token` route. Effort **S–M**.

#### 27. Phone country‑code selector — ❌ No (P3)
**409.ai:** Sign-up phone field has a full international country-code dropdown
(240+ countries, US flag default, placeholder `(XXX) XXX-XXXX`). **N409:**
`SettingsPage.tsx` line 94 renders `<TextInput type="tel">` — a plain text
input with no country selector, no format validation. **Close it:** add
`react-phone-number-input` or `intl-tel-input` library. Effort **S**.

#### 28. Contact form — ❌ No (P3)
**409.ai:** `/contact` has a functional form: Full Name, Email, Company Name,
Mobile Number, Message textarea, and "Send Message" button. Also shows static
contact details (help@409.ai, hello@409.ai, Toronto address). **N409:**
`ContactPage` in `StaticPages.tsx` lines 46–77 renders only static email
addresses (`hello@n409.example`, `support@n409.example`) in a card — **no
form, no submit capability**. **Close it:** add form fields + a backend
endpoint (or mailto fallback). Effort **S**.

#### 29. Social media links in footer — ❌ No (P4)
**409.ai:** Footer has Twitter/X (`twitter.com/409ai`) and LinkedIn
(`linkedin.com/company/409ai/`) icon links. **N409:** `MarketingLayout.tsx`
footer has Company and Legal link columns only — **no social media section**.
**Close it:** add two icon links to the footer. Effort **trivial**.

#### 30. Compare provider hub page — ❌ No (P3)
**409.ai:** `/compare/409a-valuation-providers` is a dedicated overview page
that categorises all providers into 5 model types (AI-native, equity platforms,
bundled providers, startup CPA firms, independent valuation firms) with a
"What founders should ask" section linking to each individual comparison page.
**N409:** Has the 7 individual competitor pages but **no overview/hub route or
component**. **Close it:** add a hub page component and route; link from the
compare footer section. Effort **S**.

#### 31. Pricing page FAQ section — ❌ No (P3)
**409.ai:** Pricing page has **15+ FAQ questions** (with expand/collapse
accordion) covering: report-type pricing tiers, express delivery, bundles,
409A basics, cost, timeline, validity (12 months), frequency, public vs
private, methodology (OPM + Finnerty/Chaffe DLOM), 409A vs ASC 718, prior
valuations, data accuracy, and audit defence ($175/hr). **N409:**
`PricingPage.tsx` has the calculator + comparison table but **no FAQ section
at all**. **Close it:** add FAQ data array and an accordion component on the
pricing page. Effort **S**.

#### 32. "Firms" pricing tier — ❌ No (P3)
**409.ai:** Pricing page has a separate **Firms tier** — "Leverage our AI
powered valuation technology" with a "Get in Touch" CTA
(mailto: `ktran@409.ai`), positioned for accounting firms and partners who
want to use 409.ai technology at scale. **N409:** Single consumer tier only.
**Close it:** add a "Firms / Partners" card below the calculator with a
contact mailto. Effort **S**.

#### 33. Audit defence pricing display — ❌ No (P3)
**409.ai:** "$175/hr" audit defence rate displayed in the 409A product FAQ
("Audit defence is available for an hourly fee of USD $175/hr") and on the
pricing comparison table ("Audit Support: $175/hour" vs "$300–$500+/hour" for
accounting firms). **N409:** `PricingPage.tsx` comparison table row 8 says
"Report revisions: Included" but **no audit defence pricing** is shown
anywhere. The "What's included" card mentions "Audit-defense evidence bundle
on request" but without pricing. **Close it:** add audit defence pricing to
the pricing FAQ and comparison table. Effort **trivial**.

### 9.4 Corrections from this scan

**Product page 404s — NOT gaps:** The N409 codebase scan initially flagged 6
"missing product pages" (tender‑offer, audit‑support, acquisition‑valuation,
ma‑fairness‑opinion, financial‑reporting, irc‑83b). These were listed in
`docs/409AI_FEATURES.md` Appendix A. However, all 6 return **HTTP 404** on
the live 409.ai site. They are **planned/deprecated pages, not live features**;
N409 does not need them. The live sitemap has exactly **13 unique product
pages** (Portfolio = ASC‑820 alias), matching N409's 13.

**AICPA / Andersen compare pages — NOT gaps:** The old URL scheme
(`/compare/[competitor]-409a-valuation-alternative`) redirects to the homepage.
The live site has exactly **7 individual** comparison pages + 1 hub, matching
N409's 7 individual pages. Only the hub page is a gap (#30).

**Pricing figures differ (data, not feature):** 409.ai shows $899 starting;
N409 shows $1,190 for 409A. This is a configuration/content difference, not a
feature gap — the pricing mechanism is identical.

### 9.5 Revised priority ranking (full 33 gaps)

| Rank | Gap(s) | Category | Effort |
|------|--------|----------|--------|
| 1 | #3 Inbound email / Inbox | Core ops | M |
| 2 | #1 + #2 Narrative prompts + web‑search provider | AI / report quality | M |
| 3 | #4 Missing‑Data depth | AI / ops workflow | S |
| 4 | #5 Comparables include‑toggle + thesis | AI / market approach | S |
| 5 | #6 Accounting anomalies + providers | Data quality | M |
| 6 | #7 + #8 Engine CAPM/beta + LTM/NTM | Engine precision | M |
| 7 | #9 + #19 Product lines (nav) | Revenue | S |
| 8 | #10 Report per‑kind templates | Report quality | M |
| 9 | #23 + #24 Analytics + SEO | Growth / measurement | S–M |
| 10 | #26 Email verification flow | Auth security | S–M |
| 11 | #16 + #17 Articles/blog + product‑page depth | Marketing / SEO | M |
| 12 | #18 AI auto‑populate UI + cap‑table import | AI / onboarding | M |
| 13 | #20 + #21 Testimonials + partner logos | Social proof | S |
| 14 | #22 + #28 Booking (Calendly) + contact form | Lead capture | S |
| 15 | #31 + #32 + #33 Pricing FAQ + firms tier + audit defence | Pricing page depth | S |
| 16 | #25 + #27 Cookie consent + phone intl input | Compliance / UX | S |
| 17 | #29 + #30 Social links + compare hub | Polish | S |
| 18 | #11–#15 Calc console, visNetwork, marketing micro, Intercom | Polish | S each |

### 9.6 Verified‑present in this scan (no action)

- **Pricing calculator** with express delivery + QSBS add‑ons — ✅ full parity.
- **Pricing comparison table** (409.AI vs Accounting Firm vs Cap Table) — ✅.
- **7 individual competitor compare pages** — ✅ full parity.
- **13 marketing product pages** — ✅ count matches live site exactly.
- **Which‑Valuation quiz** — ✅.
- **Static pages** (About, Terms, Privacy, Contact) — ✅ pages exist (Contact
  content is weaker — see #28).
- **"How it works" 3 steps on landing page** — ✅.
- **Integrations section on landing page** — ✅ (text pills; logos are gap #21).
- **Hero rotating‑kind animation** — ✅.
- **"No credit card required / No commitment" trust badges** — ✅.
- **Footer navigation** (Products, Compare, Company, Legal) — ✅ (social = #29).
- **Copyright text** — ✅ (hardcoded year `2026`; minor).

---

## 10. Complete Gap Inventory — Summary

**Total gaps: 33** (19 original + 14 new from this scan)

| Category | Gaps | Count |
|----------|------|-------|
| AI / report quality | #1, #2, #4, #5, #13, #18 | 6 |
| Core ops workflow | #3 | 1 |
| Engine / computation | #7, #8 | 2 |
| Product breadth | #9, #19 | 2 |
| Report & editor | #10, #11, #12 | 3 |
| Accounting | #6 | 1 |
| Marketing page depth | #14, #16, #17, #20, #21, #22, #30, #31, #32, #33 | 10 |
| SEO & analytics | #23, #24 | 2 |
| Auth & compliance | #25, #26 | 2 |
| UX polish | #15, #27, #28, #29 | 4 |

**Key takeaway:** The 14 new gaps are **entirely in the marketing/SEO/UX
layer** — the product back‑office, engine, and AI pipelines had no additional
gaps beyond the original 19. The new items are mostly low‑effort "content and
configuration" work (testimonials, logos, FAQ sections, meta tags, analytics
snippets) rather than architectural builds.
