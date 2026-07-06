# 409.ai — Improvements & UX Recommendations

Actionable recommendations addressing the gaps in [`feature-gap-analysis.md`](./feature-gap-analysis.md),
grounded in the as-built product ([`features.md`](./features.md)) and industry best practice.
Each item: **what**, **why**, **how**.

## 1. Compliance & audit (do first — it's the moat)
- **Immutable audit trail.** *What:* append-only event log of every field change, override, AI
  output, state transition, and who/when. *Why:* 409A defensibility under IRS/auditor review is
  the product's core value. *How:* event-sourced `valuation_events` table + a per-valuation
  "Audit" tab showing a human-readable timeline; sign each event with actor + source (human/AI/engine).
- **Reproducibility pinning.** *What:* store engine version, template version, and prompt
  versions on each valuation. *Why:* re-run a 3-year-old valuation and get the identical number.
  *How:* immutable `valuation_snapshot` at publish; engine served as versioned, containerized
  releases addressed by digest.
- **AICPA practice-aid checklist** embedded in the review flow; block publish until required
  checks pass.

## 2. AI: from manual tool to trustworthy co-pilot
- **Auto-run on upload + auto-advance.** Trigger Data Extraction / Missing Data / Comparables the
  moment documents land; move the workflow to "ready for analyst" automatically.
- **Human-in-the-loop review UI.** Every AI-extracted value shows **confidence**, **source
  document + page/cell**, and an accept/edit/reject control with a reason. Nothing reaches the
  model unreviewed above a risk threshold.
- **Automated QA gates.** Sanity bounds before draft: FMV within X of last round, DLOM in
  defensible range, statements cross-foot, weights sum to 100%. Fail → task, not a silent draft.
- **Prompt eval harness.** Golden-set of past valuations; every prompt change runs regression +
  diff before promotion. Version prompts; A/B by cohort.
- **AI cost controls.** Per-valuation and monthly budgets, model-tier routing (cheap model for
  easy docs, Opus for hard ones), caching, and a spend dashboard.
- **Explainable comparables.** Store and show *why* each guideline company was selected
  (industry match score, size, growth) and let analysts swap with a logged reason.

## 3. Client experience
- **Live status tracker.** A client-facing pipeline ("Data received → In analysis → Draft ready
  → Signed → Delivered") with the SLA date. Directly reduces the Inbox "where is it?" load.
- **Client portal.** All of a client's valuations, historical reports (re-download), roll-forward
  request in one click, and secure messaging replacing email ping-pong.
- **Cap-table integrations.** Import from Carta, Pulley, Cake, AngelList instead of PDF uploads —
  the single biggest accuracy + speed win.
- **Guided intake.** Replace raw uploads with a smart wizard that asks only for what's missing
  (driven by the Missing Data pipeline).

## 4. Ops & reviewer efficiency
- **SLA escalation automation.** Auto-notify + reassign on overdue; surface at-risk valuations on
  the dashboard, not just an "Overdue (3)" count.
- **Reviewer workbench.** Side-by-side source doc ↔ extracted value ↔ report section; keyboard-
  driven accept/override; bulk actions.
- **Smart assignment.** Auto-route review tasks by workload, product expertise, and jurisdiction.

## 5. Partner channel growth
- **Partner portal** with self-serve API keys, usage/billing, and branding.
- **Webhooks** (`valuation.created/updated/drafted/published`) so partners don't poll.
- **White-label reports** with partner logo/colors.

## 6. Platform & engineering
- **Split the monolith** into web + workflow + engine + AI services (see [`architecture.md`](./architecture.md)).
- **End-to-end observability** (traces web→engine→AI, per-job cost/latency, stuck-workflow alerts).
- **Decouple environments** from the app (remove "recalculate report (stage/prod)" from the UI;
  use proper deploy pipelines).
- **Idempotent, retryable jobs**; never lose an upload or double-charge a payment.

## 7. Quick wins (low effort, high value)
- Auto-trigger AI on upload (B1).
- Weights-sum + FMV-vs-last-round validation before draft (B5).
- Overdue escalation notifications (F3).
- Client status email on each state transition (A1).
- Show source-doc citation on extracted values (B2, incremental).
- AI spend dashboard from existing AI-job records (F5).
