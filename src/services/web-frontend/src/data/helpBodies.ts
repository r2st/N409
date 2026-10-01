/**
 * Markdown bodies for the in-repo help articles, keyed by article id.
 *
 * These live apart from `helpContent.ts` for one reason: size. The prose is
 * ~48 kB of the 70 kB help chunk, and `HelpIcon` — the "?" next to a section
 * header — used to pull all of it into the graph of every page that renders
 * one. That was 51 of the 121 built chunks, so an analyst opening the
 * dashboard downloaded the entire knowledge base to draw a question mark, and
 * the marketing Features page did the same for a category blurb.
 *
 * Metadata (title, category, summary, keywords) stays eager because callers
 * need it to *label* the affordance; the body is only ever needed once
 * somebody asks to read the article, so it arrives then. Two consumers import
 * this module directly and both are entitled to: the Help Center route, which
 * is the article corpus, and its tests.
 *
 * Every id here must have a matching entry in `HELP_ARTICLES` and vice versa —
 * `helpContent.test.ts` asserts the two sides in both directions.
 */
export const HELP_BODIES: Record<string, string> = {
  'what-is-409a': `# What is a 409A valuation?

A **409A valuation** is an independent appraisal of the fair market value (FMV) of your company's common stock. It's named after Section 409A of the U.S. Internal Revenue Code, which governs how private companies price the stock options they grant to employees.

## Why it matters

When you grant stock options, the IRS expects the **strike price** (the price an employee pays to exercise) to be at least the FMV of the common stock on the grant date. Set it too low and both the company and the employee can face significant tax penalties. A defensible 409A valuation from a qualified, independent provider gives you a **safe harbor** — the IRS presumes your strike price is reasonable unless it can show the valuation was grossly unreasonable.

## When you need one

- Before your **first** option grants.
- Every **12 months**, at minimum.
- After any **material event** — a priced financing round, a major acquisition, a big change in your business, or an impending IPO.

## What goes into it

A valuation combines three lenses — the **asset**, **income** and **market** approaches — to estimate the total equity value, then allocates that value across your share classes using a method like the [Option Pricing Method](/help/methodology-opm) or [PWERM](/help/pwerm-overview). Discounts for lack of marketability and control are applied to arrive at the common-stock FMV.

Ready to begin? See [Creating a valuation](/help/creating-a-valuation).`,

  'getting-started-guide': `# Getting started

A valuation moves through a predictable set of steps. You can always jump around, but this is the natural order.

1. **Set up your company.** Start a new valuation and enter your company's legal name, the product kind (409A, ESOP, patent, …) and currency.
2. **Build the cap table.** Add your share classes, option pool and any preferences. See [Cap table basics](/help/cap-table-basics).
3. **Provide financial data.** Upload statements and fill in the [financial model](/help/financial-data-overview).
4. **Choose a methodology.** Pick how equity value is allocated — [OPM, PWERM, Hybrid or CVM](/help/methodology-overview).
5. **Set assumptions.** Volatility, discount rate, DLOM and approach weights. See [Assumptions](/help/assumptions-overview).
6. **Run the valuation.** The engine computes the FMV; [health checks](/help/health-checks-overview) flag anything odd.
7. **Generate the report.** [Draft, review and publish](/help/report-overview) the audit-ready document.
8. **Get board approval.** [Route the final value](/help/board-approval-overview) to your board for sign-off.

The **Getting Started checklist** on your dashboard tracks these steps and links straight to each one. It disappears once you've worked through it.`,

  'dashboard-overview': `# Using the dashboard

The dashboard is your home base. It summarizes everything you have in flight so you can see status without opening each valuation.

## What you'll see

- **Stat cards** — totals by state: how many are open, in review, drafted or published.
- **Recent valuations** — a quick list of your latest work; click any row to open its workspace.
- **Analytics** (operations and partners) — a pivot of valuations by product kind and state, with a date-range filter. Every cell is a **drill-through link**: click a number to open the matching worklist.

Clients see a focused view without the analytics pivot, since it's noise for one or two engagements.

## Getting around

Use the left sidebar to reach Valuations, Portfolio, Search and your account. New here? The [Getting Started checklist](/help/getting-started-guide) walks you through your first valuation.`,

  'valuations-overview': `# Managing valuations

The **Valuations** page lists every engagement you can access. Operations see all valuations; clients see their own; partners see their channel.

## Filtering and finding work

Filter by state, product kind or date, or use global [Search](/help/settings-overview) to jump straight to a company. Column headers sort the list.

## The valuation workspace

Open any valuation to reach its **workspace** — a set of tabs that mirror the process:

- **Overview** — status, the client chat thread and next actions.
- **Intake / Company / Documents** — the inputs.
- **Cap table / Model / Params** — the [cap table](/help/cap-table-basics), [financial model](/help/financial-data-overview) and [methodology](/help/methodology-overview).
- **Calculations / Health / QA** — running the engine and checking the result.
- **Report / Decisions** — drafting and approvals.

Working tabs like Workbook, Overwrites and AI are operations-only.`,

  'creating-a-valuation': `# Creating a valuation

Click **New valuation** in the sidebar, or use the guided onboarding flow the first time.

## What you'll enter

- **Company legal name** — as it appears on your incorporation documents.
- **What you need** — most startups issuing options need a **409A**. Other kinds (ESOP, patent, purchase-price allocation) are available too.
- **Currency** — the reporting currency for the engagement.

## What happens next

The valuation is created in the **pending** state and appears on your dashboard. From there you upload documents, our analysts (and [AI digital robots](/help/ai-agents-overview)) extract the data, and the engagement moves through its [lifecycle](/help/engagement-overview). You'll get an email at every milestone.

Have your **cap table**, **latest financials**, **projections** and **articles of incorporation** ready — the more you provide up front, the faster the first draft.`,

  'methodology-overview': `# Valuation methodology

Every valuation answers two questions: **what is the whole company worth**, and **how is that value split across share classes**.

## Estimating total value — three approaches

- **Asset approach** — net asset value or cost to replicate. Best for early-stage, pre-revenue companies.
- **Income approach** — a discounted cash flow (DCF) of your projections.
- **Market approach** — multiples from [comparable companies](/help/comparables-overview) and transactions.

Each approach gets a **weight**; the four weights (asset, OPM, income, market) must sum to **1.0**. You set these on the **Params** tab.

## Allocating value to common stock

Once total equity value is known, it's allocated with one of four methods:

- **[OPM](/help/methodology-opm)** — Option Pricing Method (Black-Scholes).
- **[PWERM](/help/pwerm-overview)** — Probability-Weighted Expected Return Method.
- **[Hybrid](/help/methodology-hybrid)** — a blend of OPM and PWERM.
- **[CVM](/help/methodology-cvm)** — Current Value Method (liquidation waterfall).

Finally, [discounts](/help/assumptions-dlom) for lack of marketability and control bring you to the common-stock FMV.`,

  'methodology-opm': `# Option Pricing Method (OPM)

The **OPM** treats each class of equity as a call option on the company's total value. It uses the Black-Scholes model to price those options at a series of **breakpoints** — the values at which preferences convert, options are in the money, and so on.

## When to use it

OPM is the workhorse for most 409A valuations, especially when an exit is **uncertain or far off**. It captures the value of preferences and the optionality of common stock without requiring you to name specific exit outcomes.

## Key inputs

- **Total equity value** — from the weighted approaches (often anchored by an OPM **backsolve** to your latest round price).
- **[Volatility](/help/assumptions-volatility)** — how much the equity value could move.
- **Time to liquidity** — driven by your expected exit date.
- **Risk-free rate** — from the Treasury curve at the valuation date.

The **backsolve** variant solves for the total equity value that reproduces the price paid in your most recent financing, then re-allocates to common.`,

  'methodology-hybrid': `# Hybrid method

The **Hybrid** method blends two allocation models:

- A **PWERM leg** for **near-term, discrete** outcomes you can name — an imminent IPO or acquisition.
- An **OPM leg** for the **continuation** case, where the company keeps operating and the exit is uncertain.

You assign a weight to each leg; the **OPM weight** and **PWERM weight** must sum to **1.00**.

## When to use it

Hybrid shines when a specific exit is **plausible but not certain** — for example, a company in acquisition talks that might also just keep growing. It avoids forcing you to choose between the precision of PWERM and the flexibility of OPM.

Set it up on the **Params** tab: choose *Hybrid* as the allocation method, enter the near-term [exit scenarios](/help/pwerm-overview), and set the two blend weights.`,

  'methodology-cvm': `# Current Value Method (CVM)

The **CVM** allocates the company's **current** equity value directly through the liquidation waterfall — paying preferences first, then distributing the remainder to common — as if a liquidity event happened today.

## When to use it

CVM is appropriate for a narrow set of cases:

- **Very early-stage**, pre-revenue companies with little optionality.
- **Distressed** companies where a near-term wind-down is the realistic outcome.

Because it ignores the time value and optionality that OPM and PWERM capture, CVM usually produces a **conservative** common-stock value. For most operating startups, OPM or Hybrid is the better fit.

Select *CVM* as the allocation method on the **Params** tab.`,

  'cap-table-basics': `# Cap table basics

The **cap table** describes who owns what. It's the backbone of the allocation step, so accuracy here drives everything downstream.

## What to include

- **Common shares** — founders and employees.
- **Preferred shares** — by series (Seed, A, B, …), each with its **liquidation preference**, whether it's **participating**, and its **conversion ratio**.
- **Options and warrants** — the pool, with **strike prices**.

## Why preferences matter

Liquidation preferences and participation rights change how proceeds are split in an exit. A 1x non-participating preferred behaves very differently from a 2x participating one. The engine builds the **breakpoints** in the [OPM](/help/methodology-opm) — or the [waterfall](/help/methodology-cvm) — directly from these terms.

## Keeping it current

You can enter the cap table by hand on the **Cap table** tab, or [sync it live](/help/cap-table-sync) from Carta or Pulley so it stays in step with your equity records.`,

  'cap-table-sync': `# Syncing your cap table

Instead of entering the cap table by hand, you can connect your equity-management system and pull it in automatically.

## Supported providers

- **Carta**
- **Pulley**

## How it works

1. On the **Cap table** tab, open the **Sync** panel.
2. Connect your provider with a scoped, read-only API key.
3. Review the imported share classes, options and preferences.
4. Confirm to apply — the imported structure replaces the working cap table.

Re-run the sync any time your equity records change. We only ever **read** your cap table; we never write back to your provider.`,

  'comparables-overview': `# Comparable companies

The **market approach** values your company by looking at what the market pays for similar businesses. Two kinds of comps feed it:

- **Public comps** — trading multiples of publicly listed peers.
- **Transaction comps** — multiples paid in M&A deals for similar companies.

## Multiples we use

Depending on your stage we apply a **revenue multiple** or an **EBITDA multiple**, over either the **last twelve months (LTM)** or **next twelve months (NTM)** horizon. You choose the metric and horizon on the **Params** tab.

## Choosing good comps

Strong comps share your **industry, business model, growth rate and stage**. The [AI digital robots](/help/ai-agents-overview) suggest a peer set from your business overview, which analysts then refine. A tight, well-justified comp set is far more defensible than a broad one.`,

  'financial-data-overview': `# Financial data and the model

The financial model turns your company's numbers into engine inputs. You can enter it by hand on the **Model** tab, or let the [AI digital robots](/help/ai-agents-overview) extract it from documents you upload.

## Statements to provide

- **Income statement** — revenue and expenses.
- **Balance sheet** — assets, liabilities and equity.
- **Projections** — your forward plan, used by the income (DCF) approach.
- **Cash and debt** — to bridge enterprise value to equity value.

## Model inputs

Beyond the statements, the model captures **shares outstanding** (common and preferred), the **valuation date**, and the [assumptions](/help/assumptions-overview) — volatility, risk-free rate and time to exit — that drive the [OPM](/help/methodology-opm).

Once the model is complete and approach weights are set, run the valuation from the **Calculations** tab.`,

  'assumptions-overview': `# Valuation assumptions

Assumptions are the judgment calls that shape the result. Each is defensible on its own terms, and the report documents why each was chosen.

## The big four

- **[Volatility](/help/assumptions-volatility)** — how much the equity value could swing; a core OPM input.
- **[Discount rate](/help/assumptions-discount-rate)** — the required return used to bring future value to today.
- **[DLOM / DLOC](/help/assumptions-dlom)** — discounts for lack of marketability and control.
- **Approach weights** — how much each of the asset, OPM, income and market approaches counts. They must sum to **1.0**.

## Where to set them

Approach weights, DLOM/DLOC and company-profile assumptions live on the **Params** tab. Volatility, risk-free rate and time to exit live on the **Model** tab. Hover the **?** next to any field for an inline explanation, or [run a sensitivity analysis](/help/sensitivity-overview) to see how much each one actually moves the FMV.`,

  'assumptions-volatility': `# Volatility

**Volatility** measures how much your company's equity value might move over the time to a liquidity event. It's expressed as an annualized standard deviation — e.g. \`0.60\` means 60%.

## Why it matters

Volatility is a central input to the [Option Pricing Method](/help/methodology-opm). Higher volatility increases the value of the optionality embedded in common stock, so it generally **raises** the common-stock FMV, all else equal.

## How it's estimated

We typically derive volatility from the **historical equity volatility of comparable public companies**, matched to your industry and your expected **time to exit**. Because private companies have no trading history of their own, the peer set is the anchor.

Not sure how sensitive your result is to this input? A [sensitivity analysis](/help/sensitivity-overview) shows exactly how the FMV responds as volatility changes.`,

  'assumptions-discount-rate': `# Discount rate

The **discount rate** is the annual rate of return used to convert future value into today's value. A dollar received at exit is worth less than a dollar today, and the discount rate quantifies exactly how much less.

## Where it's used

- **Income approach (DCF)** — discounts projected cash flows.
- **[PWERM](/help/pwerm-overview)** — discounts each exit scenario's payoff back to the valuation date. You can set a per-scenario rate, or leave it blank to use the engagement default.

## How it's set

The rate reflects the **risk and stage** of the company — early-stage startups carry higher required returns than late-stage ones. It's often built up from a risk-free base plus equity and company-specific risk premiums (a venture-adjusted cost of capital).

A higher discount rate lowers present value, which tends to **reduce** the common-stock FMV.`,

  'assumptions-dlom': `# DLOM and DLOC

Two discounts bring the allocated value down to a defensible common-stock FMV.

## DLOM — Discount for Lack of Marketability

Private common stock can't be sold freely, so it's worth less than otherwise-identical liquid stock. The **DLOM** captures that. We support:

- **Chaffee** — models the discount as the cost of a protective put over the holding period.
- **Finnerty** — an average-strike put model, often producing a somewhat lower discount.
- **Qualitative** — a manually justified percentage when a model isn't appropriate.

Chaffee and Finnerty are computed by the engine from your volatility and time to liquidity; the qualitative method takes a fraction you enter.

## DLOC — Discount for Lack of Control

Minority holders can't direct the company, so a **DLOC** (a fraction between 0 and 1) may be applied to reflect that lack of control. Set both on the **Params** tab under **Discounts**.`,

  'ai-agents-overview': `# AI digital robots

Automated extraction, gap checks, peer-set proposals, and draft narratives — always human-reviewed.

- **Data extraction** — cap tables, financials, and projections → model inputs.
- **Missing-data checks** — flags gaps against the engagement's requirements.
- **Comparable suggestions** — proposes a peer set from your business overview.
- **Drafting help** — first-draft narrative sections for analysts to edit.

Nothing a digital robot produces is final. The AI tab shows every run, input, and output for auditability.`,

  'report-overview': `# Generating the report

The **Report** tab holds the deliverable: a sectioned, audit-ready document with a full version history.

## How it works

1. **Draft** — sections are assembled from the engagement data (with [AI](/help/ai-agents-overview) drafting help) and edited by analysts.
2. **Version** — every render is captured as an **immutable version**, so you always have a clean audit trail of what changed and when.
3. **Publish** — publishing renders the final PDF and **locks** the engagement.

## Who sees what

The report becomes visible to clients once the valuation reaches the **draft** states. Publishing makes the final version available for download and moves the engagement toward [board approval](/help/board-approval-overview).

Report **templates** (operations) let you standardize structure and branding across engagements.`,

  'board-approval-overview': `# Board approval

A 409A valuation only sets a defensible strike price once your **board formally adopts it**. The platform routes the final value for sign-off and records the approval.

## The flow

1. The valuation reaches a final, published value.
2. A **board resolution** is prepared referencing that value and the report.
3. Board members receive a secure link to **review and sign** — no account required; the link carries a scoped token.
4. Signatures are captured and stored with the engagement as part of the record.

## Why it matters

The signed resolution is the evidence that the board adopted the FMV as of a specific date. Keep it with your option-grant records — auditors and future 409A providers will look for it.`,

  'grants-overview': `# Grant management & ASC 718 (private company)

Once you have an FMV, **ASC 718** governs how you book the cost of stock-based compensation on your financial statements. The **Grants** tab manages this for a **private company**, measuring **option** expense off the concluded **[409A FMV](/help/what-is-409a)**.

> **Public company?** If your shares are publicly traded — or you grant ESPPs, RSUs or relative-TSR awards — use the [ASC 718 public-company engine](/help/asc718-public-overview) instead. It prices off your own market price and volatility and handles those award types.

## What it computes

- **Grant-date fair value** — the value of each option grant, typically via Black-Scholes.
- **Expense recognition** — the fair value spread across the **vesting period**.
- **Schedules** — period-by-period expense you can drop into your books.

## Where the data comes from

Grants can be entered directly, imported with your [cap-table sync](/help/cap-table-sync), or pulled from your [HRIS/payroll system](/help/hris-overview) so headcount and grant changes flow through automatically. The valuation's FMV feeds the fair-value calculation, keeping your 409A and your ASC 718 expense consistent.`,

  'health-checks-overview': `# Health checks

**Health checks** are automated validations that run over an engagement and flag anything that could undermine the result — before it reaches a client or auditor.

## Examples of what they catch

- Approach weights that don't sum to 1.0, or scenario probabilities that don't sum to 1.
- A cap table whose totals don't reconcile.
- Missing required documents or model inputs.
- Assumptions that fall outside typical ranges for the company's stage.

## Reading the results

Each check reports a **status** — pass, warning or error. Errors block publication; warnings are advisory and can be acknowledged with a rationale. The **Health** and **QA** tabs show the full list, so you can clear issues methodically before drafting the report.`,

  'sensitivity-overview': `# Sensitivity analysis

A **sensitivity analysis** shows how much the final FMV moves when you change one input at a time. It's the fastest way to see which assumptions actually matter — and to defend them.

## What you can flex

- [Volatility](/help/assumptions-volatility)
- [Discount rate](/help/assumptions-discount-rate)
- Time to exit
- Total equity value
- [DLOM](/help/assumptions-dlom)

## Reading it

The analysis re-runs the engine across a range for each input and reports the resulting FMV. Inputs that move the FMV a lot deserve the most scrutiny and the clearest justification in the report; inputs that barely move it are lower risk. Run it from the **Sensitivity** view on a valuation (operations).`,

  'pwerm-overview': `# PWERM

The **Probability-Weighted Expected Return Method** values common stock by naming concrete **exit scenarios**, working out what common receives in each, and weighting those payoffs by how likely each scenario is.

## Building scenarios

On the **Params** tab, add a row per outcome — for example:

- **IPO** — high exit value, longer horizon.
- **Acquisition** — moderate exit value, near term.
- **Continuation** — the company keeps operating.
- **Liquidation / dissolution** — a downside case.

For each, enter a **probability**, an **exit equity value**, the **time to exit** in years, and an optional per-scenario [discount rate](/help/assumptions-discount-rate). Probabilities must sum to **1.0**.

## When to use it

PWERM is strongest when exits are **reasonably foreseeable** — a later-stage company with a clear path to IPO or sale. When outcomes are murkier, [OPM](/help/methodology-opm) or the [Hybrid](/help/methodology-hybrid) method is often more appropriate.`,

  'value-bridge-overview': `# Value bridge

A **value bridge** explains *why* the FMV changed between two valuation dates. Instead of just reporting old and new numbers, it decomposes the movement into its **drivers**.

## What it shows

Starting from the prior FMV, the bridge walks step by step to the current FMV, attributing the change to factors such as:

- New financing or a change in total equity value.
- Updated projections or financial performance.
- Changes in [volatility](/help/assumptions-volatility) or time to exit.
- Cap-table changes.
- Updated [discounts](/help/assumptions-dlom).

## Why it's useful

It turns a bare number into a story your board, employees and auditors can follow — and it makes each period's valuation consistent with the last. Open it from the **Bridge** tab of a valuation.`,

  'client-portal-overview': `# The client & partner portal

The portal is the client-facing side of an engagement. It's deliberately focused: clients see their own valuations and the actions they need to take, without the operations machinery.

## For clients

- Track each valuation's **status** and what's blocking it.
- **Upload documents** and respond to requests.
- **Chat** with the analyst team on the Overview tab.
- **Download** the report once it's published.

## For partners

Partners (accounting firms, fund managers) get a **channel** view of all the valuations they've referred or manage, with optional **white-label** branding on their own login page. Roles control who can see and do what — see [Settings & roles](/help/settings-overview).`,

  'engagement-overview': `# The engagement lifecycle

Every valuation moves through a **14-state lifecycle**, from initial request to a published, board-ready report. The state is always visible on the valuation's Overview tab.

## The shape of it

- **Pending / started** — created, gathering inputs.
- **Waiting on client** — we need something from you; check the chat thread for what's blocking.
- **In review** — analysts are building and checking the valuation.
- **Drafted** — a report draft exists and is client-visible.
- **Published** — final and locked.
- **Closed** — the engagement is complete.

## Keeping things moving

A **"Waiting on client"** flag is the most common cause of delay — it means the ball is in your court. The [portal](/help/client-portal-overview) and email notifications tell you exactly what's needed. Operations manage the pipeline across all engagements from the **Engagement pipeline** view.`,

  'mfa-overview': `# Multi-factor authentication (MFA)

**MFA** (also called 2FA) adds a second step to sign-in, so a stolen password alone can't get into your account. We support **TOTP** — the six-digit codes from apps like Google Authenticator, 1Password or Authy.

## Turning it on

1. Go to **Settings → Security**.
2. Choose **Enable MFA**.
3. Scan the QR code with your authenticator app.
4. Enter the current six-digit code to confirm.
5. **Save your recovery codes** somewhere safe — they're the only way back in if you lose your device.

## Signing in with MFA

After your password, you'll be asked for the current code from your app. Given the sensitivity of valuation data, we strongly recommend every user enables MFA, and administrators can require it.`,

  'monitoring-overview': `# Valuation monitoring

A 409A valuation is only valid until the earlier of **12 months** or the next **material event**. Monitoring watches for both so you're never caught with a stale valuation.

## What it tracks

- **Time-based expiry** — a countdown to the 12-month mark.
- **Material events** — new financing rounds, acquisitions, or major changes in the business.
- **Cap-table drift** — meaningful changes synced from your equity system.

## What happens

When a monitored valuation approaches expiry or a triggering event is detected, the platform **alerts** you (and your analyst team) so you can start a refresh before your safe harbor lapses. Operations manage watched valuations from the **Monitored valuations** view; the [value bridge](/help/value-bridge-overview) then explains what changed at the next valuation.`,

  'organizations-overview': `# Organizations & multi-entity

If you manage more than one company — a fund with many portfolio companies, or a group with several subsidiaries — the platform organizes them under a single account.

## How it's structured

- An **organization** groups related entities and their valuations.
- The **Portfolio** view rolls up status and value across every entity you can see.
- **Access and billing** can be scoped per organization, so the right people see the right entities.

## Who it's for

- **Venture and PE funds** valuing a book of portfolio companies.
- **Accounting firms** managing many clients.
- **Holding structures** with multiple operating subsidiaries.

Assign a valuation to its entity from the workspace; the Portfolio dashboard aggregates the rest.`,

  'billing-overview': `# Billing & payments

The **Billing** page shows your plan, invoices and payment methods in one place.

## Ways to pay

- **Per-valuation** — pay for a single engagement, often at onboarding, to move it to the front of the queue.
- **Subscription / retainer** — an ongoing plan for firms and funds running many valuations.
- **Invoice** — if online payment isn't available for your engagement, we'll send an invoice to settle by transfer.

## Managing it

Update your card, download past invoices and review your current plan from **Billing**. Card payments are processed securely by Stripe — we never store your full card details. Questions about a charge? Use the [help widget](/help/settings-overview) to reach the operations team.`,

  'auditor-portal-overview': `# The external auditor portal

Audit season is smoother when your auditors can pull the valuation evidence themselves. The **auditor portal** gives them scoped, **read-only** access — no full account required.

## How it works

1. An administrator grants an auditor access to a specific valuation (or set of valuations).
2. The auditor receives a secure link carrying a scoped token.
3. They review the **report, key inputs, assumptions and supporting evidence** — but can't change anything.

## Why it helps

- Auditors get a **complete, consistent evidence package** instead of emailed PDFs.
- Access is **limited** to exactly what they need to see.
- Every access is logged, so there's a clear record of who reviewed what.

Manage auditor access from the workspace's access panel; revoke it when the audit is done.`,

  'sso-overview': `# Enterprise SSO (SAML & SCIM)

Enterprises can connect the platform to their identity provider so people sign in with corporate credentials and access is managed centrally.

## SAML 2.0 — single sign-on

We act as a **SAML Service Provider**. Configure a connection to your IdP (Okta, Azure AD/Entra, Google Workspace, OneLogin, …) and users authenticate there instead of with a local password. Benefits: central control, enforced [MFA](/help/mfa-overview) at the IdP, and instant off-boarding.

## SCIM 2.0 — user provisioning

With **SCIM**, your IdP pushes user lifecycle events to us automatically:

- **Create** accounts when someone joins.
- **Update** roles and attributes when they change.
- **Deactivate** access the moment they're off-boarded.

Set both up under **Administration → Enterprise SSO**. You'll need administrator rights and your IdP's metadata.`,

  'data-retention-overview': `# Data retention & legal holds

Valuation records are sensitive and often subject to retention rules. Administrators control how long data is kept and can suspend deletion when litigation or an audit requires it.

## Retention policies

Set policies that define how long different record types are retained. When a record passes its retention period, it becomes eligible for **automated deletion** — keeping you compliant without manual cleanup.

## Legal holds

A **legal hold** freezes deletion for the records it covers, regardless of any retention policy, until the hold is lifted. Use it when records are relevant to litigation, an investigation or an audit.

Configure both under **Administration → Data retention**. Changes are logged for compliance.`,

  'hris-overview': `# HRIS & payroll integration

For companies tracking stock-comp expense under [ASC 718](/help/grants-overview), keeping grant and employment data current by hand is tedious and error-prone. The **HRIS integration** syncs it from your HR/payroll system.

## Supported providers

- **Rippling**
- **Gusto**
- **Deel**

## What it syncs

- **Employees** — active headcount and status changes.
- **Grants** — new option grants and modifications tied to each person.
- **Terminations** — so vesting stops and forfeitures are handled correctly.

## Why it matters

Accurate, up-to-date employment data means your **ASC 718 expense** stays correct as people join, get grants, and leave — no manual reconciliation. Set up the connection on the **HRIS** panel, review the imported data, and confirm to apply. As with the cap-table sync, we only **read** from your system.`,

  'settings-overview': `# Settings, profile & roles

The **Settings** page is where you tune your account and, if you're an administrator, the whole workspace.

## Your account

- **Profile** — name, email and contact details.
- **Security** — password and [multi-factor authentication](/help/mfa-overview).
- **Notifications** — which events email you.

## Roles & permissions

Access is role-based:

- **Clients** see their own valuations.
- **Partners** see their channel.
- **Operations** run the valuations.
- **Administrators** manage users, roles, [SSO](/help/sso-overview), [retention](/help/data-retention-overview) and system settings.

## System settings (admins)

Administrators configure workspace-wide defaults and integrations under **Administration → System settings**. Need help with something not covered here? Open the **help widget** in the bottom-right corner and message the operations team.`,

  'asc718-public-overview': `# ASC 718 for public companies

The **ASC 718** tab measures the grant-date fair value and expense schedule of stock-based compensation. It works for both private and public issuers — flip the **Company type** toggle to switch between them.

## Private vs. public underlying

- **Private** — options are measured off the concluded **[409A FMV](/help/what-is-409a)**, and volatility comes from a comparable-company peer set. This is the same expense that the private-company [Grants tab](/help/grants-overview) produces.
- **Public** — the underlying is the issuer's **own market price**, auto-fetched from a **ticker**, with its **own historical volatility**. Switching to public also unlocks the award types public issuers grant.

## What public issuers can value

- **Options** — with a choice of [expected-term method](/help/asc718-expected-term) (SAB 107 simplified, a binomial lattice, or historical exercise data).
- **[ESPPs](/help/asc718-espp)** — employee stock purchase plans, including the lookback provision.
- **RSUs** — service, performance and market-condition restricted stock units.
- **[Relative TSR awards](/help/asc718-tsr)** — market-condition awards valued with a Monte Carlo simulation against a peer group.

## Running it

Set the company type (and ticker, for public), add your grants, ESPPs and RSUs, then **Run ASC 718**. The result shows total compensation cost, the per-grant fair values and the expense-by-year schedule. Everything is operations-only — measurement lives with the valuation team.`,

  'asc718-expected-term': `# Expected term & exercise behaviour

The **expected term** is how long, on average, options are expected to remain outstanding before exercise or forfeiture. Because employees rarely hold options to full contractual maturity, the expected term is shorter than the contract — and it materially affects the Black-Scholes fair value. Choose one of three methods:

## SAB 107 simplified

The **simplified method** from SEC Staff Accounting Bulletin 107 estimates the expected term as the **average of the vesting period and the full contractual term**. It's appropriate for "plain-vanilla" options when a company lacks sufficient historical exercise data — common for newly public issuers.

## Binomial lattice (exercise behaviour)

A **lattice** model builds a tree of possible price paths and models **early exercise** explicitly: at each node, employees are assumed to exercise once the stock price reaches an **exercise multiple** of the strike (e.g. 2× the exercise price). This captures suboptimal early exercise and post-vesting termination far more richly than a single expected-term input — the effective term emerges from the modelled behaviour rather than being assumed.

## Historical exercise data

If you have enough of your own **historical exercise and post-vesting cancellation data**, you can derive the expected term directly from it — the most defensible approach once a track record exists.

Set the method on the **Expected-term method** control; it applies to every option grant in the run.`,

  'asc718-espp': `# ESPP valuation with lookback

An **Employee Stock Purchase Plan (ESPP)** lets employees buy shares at a discount, often with a **lookback** provision. Under ASC 718 a compensatory ESPP has a real fair value that must be expensed — it is not simply the headline discount.

## The three components

The engine decomposes each offering into:

- **Purchase discount** — the stated discount (e.g. 15%) applied to the purchase price.
- **Call component** — the value of the lookback's upside: employees buy at a price based on the **lower** of the offering-date and purchase-date prices, so they hold a call on the appreciation over the **lookback period**.
- **Put component** — the value of the downside protection the discount provides.

## Key inputs

- **Discount %** — the plan's stated purchase discount.
- **Lookback months** — the length of the lookback window; a longer lookback is worth more because the embedded call has more time to run.
- **Grant-date price** and **risk-free rate** — the option-pricing inputs.

Add an offering under **ESPP (public)** on the ASC 718 tab; the result reports the fair value per share and the component breakdown.`,

  'asc718-tsr': `# Relative TSR (market conditions)

A **relative total-shareholder-return (TSR)** award pays out based on how the company's stock performs **against a peer group** over a performance period — for example, target vesting at the median and 200% at the 75th percentile. TSR is a **market condition** under ASC 718.

## Why Monte Carlo

Market conditions are baked into the **grant-date fair value** — you do *not* true them up for actual outcomes. Because the payoff depends on the joint path of your stock and every peer, there's no closed form, so the engine runs a **Monte Carlo simulation**: it simulates correlated price paths for the issuer and the **peer group**, computes each award's payout under the vesting schedule, and averages the discounted payoffs.

## What drives the value

- **TSR peer group** — the comparator companies; their volatilities and correlations shape the distribution of relative outcomes.
- **Payout schedule** — the percentile-to-payout curve (threshold, target, maximum).
- **Volatility and the risk-free rate** — standard option-pricing inputs.

The result reports the fair value per unit, the **expected percentile** and the **expected payout ratio**. Because it's a market condition, the expense is recognised over the service period **regardless** of whether the market target is ultimately met.`,

  'fund-holdings-overview': `# Fund holdings & ASC 820

The **Fund Portfolios** page is for investment funds — venture, PE, growth and credit — that must report their positions at **fair value** under **ASC 820**. It is distinct from the corporate-group roll-up on the Portfolio page: here a fund marks each position, aggregates them into NAV, and distributes proceeds through an LP waterfall.

## The workflow

1. **Create a fund** — set its type, currency and vintage year.
2. **Add positions** — each holding (common, preferred, SAFE, note, warrant) with its cost basis and a default [mark method](/help/fund-fair-value-hierarchy).
3. **Record marks** — at each measurement date, mark every position to fair value and the engine assigns its [ASC 820 level](/help/fund-fair-value-hierarchy).
4. **Read NAV** — positions roll up into [net asset value](/help/fund-nav) with a Level 1/2/3 disclosure.
5. **Run the waterfall** — model the [LP distribution](/help/fund-waterfall) including preferred return, carry and clawback.

## Who it's for

Fund managers and their finance teams preparing quarterly fair-value marks and LP reporting. The page is operations-only.`,

  'fund-fair-value-hierarchy': `# ASC 820 fair-value hierarchy (Levels 1–3)

ASC 820 classifies every fair-value measurement into a **three-level hierarchy** based on how observable its inputs are. The level drives your financial-statement disclosures, and Level 3 gets the most auditor scrutiny.

## The three levels

- **Level 1 — quoted prices.** Unadjusted quoted prices in active markets for identical assets. In the app, the **Market** mark method (a quoted price × quantity) produces a Level 1 mark — typical for a publicly traded holding.
- **Level 2 — observable inputs.** Prices for the asset are not directly quoted, but observable market inputs are — for instance the price of a recent financing round. The **Last round** mark method produces a Level 2 mark.
- **Level 3 — unobservable inputs.** Fair value relies on the fund's own assumptions and a model. The **[Calibrated OPM](/help/fund-calibrated-opm)** mark method and plain **Cost** produce Level 3 marks — typical for illiquid private positions.

## Choosing a mark method

Set a **default mark method** per position, then pick the specific method when you record each mark. The engine assigns the level from the method, and the NAV view shows the **Level 1 / 2 / 3 breakdown** you disclose in the notes.`,

  'fund-calibrated-opm': `# Calibrated-OPM backsolve for illiquid positions

Most fund positions are **illiquid** private securities with no quoted price. The most defensible way to mark them is a **calibrated Option Pricing Method** — the same [OPM backsolve](/help/methodology-opm) used in a 409A, anchored to the position's own transaction history.

## How calibration works

1. **Backsolve at the calibration date.** At the last observable transaction (usually the financing round in which the fund invested), solve for the total equity value that reproduces the price paid — this **calibrates** the model to a real, arm's-length data point.
2. **Roll forward.** At each later measurement date, adjust the calibrated equity value for changes in the company's performance, comparable multiples and time, then re-allocate through the OPM to the fund's specific security.
3. **Mark.** The allocated value becomes the position's fair value — a **Level 3** measurement because it depends on unobservable, model-based inputs.

## Why it's preferred

Calibrating to the entry round keeps the mark grounded in a real transaction rather than a bare assumption, which is exactly what auditors look for in a Level 3 measurement. Record it with the **Calibrated OPM** method and supply the model value on the mark form.`,

  'fund-nav': `# Net asset value (NAV)

A fund's **net asset value (NAV)** is the total fair value of everything it holds, net of liabilities. It's the headline number LPs care about and the basis for the fair-value marks in the financial statements.

## How it's built

- **Gross asset value** — the sum of every position's latest fair-value [mark](/help/fund-fair-value-hierarchy).
- **Less liabilities** — fund-level obligations.
- **= Net asset value.**

Alongside NAV the view reports the **total cost basis** and **total unrealized gain** (fair value minus cost), so you can see the portfolio's markup at a glance.

## The Level 1 / 2 / 3 disclosure

NAV is broken down by ASC 820 level, so you can drop the **Level 1 / Level 2 / Level 3** split straight into your fair-value note. A portfolio weighted toward Level 3 signals to auditors and LPs that most of the value rests on model-based marks — expect more diligence there.

NAV recomputes whenever you record a new mark, so it always reflects the latest measurement date.`,

  'fund-waterfall': `# LP waterfall & carried interest

When a fund distributes proceeds, the **LP waterfall** governs how much goes to limited partners versus the general partner's **carried interest**. The calculator models the standard tiers.

## The distribution tiers

1. **Return of capital** — LPs get their contributed capital back first.
2. **Preferred return** — LPs earn a **hurdle** (e.g. 8%) on their capital before the GP shares in profits.
3. **GP catch-up** — if enabled, the GP then receives a run of distributions until it has earned its carry percentage of profits above the return of capital.
4. **Carry split** — remaining proceeds split by the **carry percentage** (commonly 80/20 to LPs/GP).

## Key inputs

- **Committed / contributed capital** — the LP commitment and how much has been drawn.
- **Preferred return rate** — the hurdle.
- **Carry %** — the GP's share of profits above the hurdle (the **carry percentage**).
- **GP catch-up** — whether the catch-up tier applies.

## Clawback

If earlier distributions overpaid the GP relative to the fund's lifetime performance, a **clawback** is owed back to the LPs. The result surfaces the LP distribution, the GP carry and any clawback owed.`,

  'debt-valuation-overview': `# Debt valuation engine

The **Debt Instruments** page fair-values fixed-income and hybrid instruments: straight **bonds**, **term loans**, **convertible notes**, **SAFEs** and **credit-spread** bonds. Create an instrument, set its parameters, and value it.

## What each instrument uses

- **Bonds & term loans** — a **[yield-based DCF](/help/debt-yield-dcf)** with duration and convexity analytics; term loans can amortize.
- **Credit-spread bonds** — priced off a **[benchmark yield plus a credit spread](/help/debt-credit-spread)** driven by rating and seniority.
- **Convertible notes** — the **[Tsiveriotis-Fernandes](/help/debt-convertible)** binomial tree that splits value into debt and equity components.
- **SAFEs** — **[cap-and-discount](/help/debt-safe)** conversion into the next priced round.

## Analytics

Beyond fair value, the engine returns the **cash-flow schedule**, **modified duration** and **convexity**, and a one-click **yield / spread / discount sensitivity** table so you can see how the value responds to rate moves. Results are illustrative and not investment advice. The page is operations-only.`,

  'debt-yield-dcf': `# Yield DCF, duration & convexity

A bond or term loan is worth the **present value of its future cash flows**, discounted at the rate the market demands — its **yield to maturity (YTM)**. That's the yield-based DCF at the core of the engine.

## Price

The engine builds the coupon (and, for **amortizing** loans, principal) schedule, discounts every cash flow at the market yield, and reports:

- **Dirty price** — the full present value, including interest accrued since the last coupon.
- **Clean price** — the dirty price minus **accrued interest** (the quoted price).

A market yield **above** the coupon rate prices the instrument at a discount; **below** it, at a premium.

## Interest-rate risk

- **Modified duration** — the approximate **% change in price for a 1% change in yield**. Higher duration means more rate sensitivity.
- **Convexity** — the curvature the duration estimate misses; it corrects the linear approximation for larger yield moves.

Use the **yield sensitivity** button to re-value across a range of yield shifts and see duration and convexity in action.`,

  'debt-credit-spread': `# Credit-spread pricing

For a corporate bond, the discount yield isn't a single number you observe — it's a risk-free **benchmark** plus a **credit spread** that compensates lenders for default risk.

## All-in yield = benchmark + spread

- **Benchmark yield** — the risk-free base (e.g. the matching Treasury).
- **Credit spread** — the extra yield for the issuer's credit risk. Leave the spread blank and the engine infers it from the **rating** (AAA down to CCC), adjusted for **seniority** and whether the debt is **secured**. A senior secured BBB loan carries a tighter spread than subordinated unsecured paper.
- **All-in yield** — the sum, which becomes the DCF discount rate.

## Why seniority and security matter

In a default, senior and secured lenders recover more, so they accept a smaller spread. The engine reflects this: moving from subordinated to senior, or unsecured to secured, narrows the spread and **raises** the bond's price.

Enter the credit terms on the **Credit terms** panel for a credit-spread instrument; the result reports the resulting credit spread and all-in yield.`,

  'debt-convertible': `# Convertible notes (Tsiveriotis-Fernandes)

A **convertible note** is a bond the holder can convert into shares, so its value blends debt and equity. The engine prices it with the **Tsiveriotis-Fernandes** binomial tree — the standard method for handling the two different discount rates a convertible needs.

## The key insight

Cash flows that will be paid in **stock** carry equity risk and are discounted at the **risk-free rate**; cash flows that will be paid in **cash** carry credit risk and are discounted at the **risky rate** (risk-free + [credit spread](/help/debt-credit-spread)). Tsiveriotis-Fernandes tracks these separately at every node of the tree, so each part is discounted correctly.

## Inputs and outputs

- **Conversion ratio** — shares received per note on conversion; times the stock price gives the **conversion parity** (the note's value as pure equity).
- **Stock price, volatility, risk-free rate, credit spread** — the tree's option-pricing inputs.

The result decomposes fair value into the **straight-debt value** (the bond floor) and the **option value** (the conversion upside), and reports the conversion parity. Run the **spread sensitivity** to see how a wider credit spread lowers the debt floor.`,

  'debt-safe': `# SAFE valuation (cap & discount)

A **SAFE** (Simple Agreement for Future Equity) isn't debt and has no maturity — it converts into equity at the **next priced round**. Its value comes from the conversion terms that reward the early investor: a **valuation cap** and a **discount**.

## How conversion is priced

At the next round, the SAFE converts at the price that's **better for the investor** of:

- **Cap amount** — the **valuation cap** sets a maximum effective price. If the round prices above the cap, the SAFE converts as if the company were worth the cap, handing the investor extra ownership.
- **Discount** — the **discount rate** (e.g. 20%) gives a percentage off the round price.

The engine computes the **conversion price**, the **shares received**, the resulting **ownership %** and the **MOIC** (multiple of invested capital) implied by the modelled round.

## Inputs

- **Investment** — the amount put in.
- **Valuation cap** and **discount** — the SAFE's terms.
- **Next-round pre-money** and **shares** — the priced round the SAFE converts into.

Run the **discount sensitivity** to see how the value moves as the modelled round price changes.`,
};
