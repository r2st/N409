# 409.ai — Feature Gap Analysis

Compares the as-built product ([`features.md`](./features.md)) against valuation-industry best
practice and competitors (Carta, Pulley, Cake Equity, Eqvista, Aranca, Scalar, Preferred Return,
Vestd). Gaps feed [`improvements.md`](./improvements.md) and [`implementation-plan.md`](./implementation-plan.md).

Severity: 🔴 high (competitive/compliance risk) · 🟠 medium · 🟡 low.

## A. Client experience
| # | Gap | Sev | Notes |
|---|-----|-----|-------|
| A1 | No self-serve **status tracker / progress timeline** for clients | 🟠 | Clients email to ask "where's my valuation?" (see Inbox load). Competitors show a live pipeline. |
| A2 | No **client dashboard** listing all their valuations / historical reports | 🟠 | Repeat customers & multi-entity founders need portfolio view. |
| A3 | Onboarding is **document-upload heavy**, no guided data entry / integrations | 🔴 | Carta/Pulley auto-pull cap table; here it's manual uploads + AI extraction. |
| A4 | No **cap-table integrations** (Carta, Pulley, Cake, AngelList) to import instead of uploading PDFs | 🔴 | Biggest UX + accuracy lever. |
| A5 | Limited **self-service quoting/checkout** clarity (custom amounts handled by ops) | 🟡 | |

## B. AI & automation
| # | Gap | Sev | Notes |
|---|-----|-----|-------|
| B1 | AI extraction is **run manually** per pipeline by analysts | 🟠 | Could auto-trigger on upload + auto-advance workflow. |
| B2 | No visible **confidence scores / human-in-the-loop review UI** on AI-extracted values | 🔴 | Auditors need provenance; analysts need to know what to trust. |
| B3 | Comparable-company selection is AI-proposed but **no explainability** surfaced | 🟠 | Why these comps? Store rationale + let analyst accept/reject with reason. |
| B4 | Prompts are global; no **A/B testing / eval harness / regression** on prompt changes | 🟠 | Prompt edits ship blind. |
| B5 | No **automated QA checks** (sanity bounds on FMV, DLOM ranges, math cross-foot) before draft | 🔴 | Reduces reviewer load & error risk. |

## C. Valuation engine & methodology
| # | Gap | Sev | Notes |
|---|-----|-----|-------|
| C1 | Engine coupled as a single R service; **no versioned, pinned engine per valuation** visible | 🔴 | Reproducibility/compliance requires pinning. |
| C2 | **Backsolve/OPM** only surfaced; PWERM/hybrid methods not evident | 🟠 | Later-stage companies often need PWERM or hybrid scenarios. |
| C3 | No **audit narrative auto-generation** tying numbers → assumptions in the report | 🟠 | |
| C4 | Sensitivity limited to OPM inputs; no **scenario/what-if** on weights or multiples | 🟡 | |

## D. Review, compliance & audit
| # | Gap | Sev | Notes |
|---|-----|-----|-------|
| D1 | Review tasks exist but **no immutable audit log** of every input/override/state change surfaced | 🔴 | Core to defensibility under IRS/auditor scrutiny. |
| D2 | No explicit **AICPA practice-aid checklist** baked into review | 🟠 | Competitors market audit-ready compliance. |
| D3 | **Signature** flow present but e-sign provenance / signer credentials not surfaced | 🟠 | |
| D4 | No **conflict-of-interest / independence** attestation workflow | 🟡 | |

## E. Partner channel
| # | Gap | Sev | Notes |
|---|-----|-----|-------|
| E1 | Partner API exists but **no partner self-service portal** (branding, webhooks, usage) observed | 🟠 | |
| E2 | No **white-label / co-branded** report output per partner | 🟠 | Vestd etc. would value this. |
| E3 | No **webhook events** for partners (valuation.published etc.) — only pull | 🟠 | |

## F. Platform / non-functional
| # | Gap | Sev | Notes |
|---|-----|-----|-------|
| F1 | Version **0.10.1**, single admin monolith + one R service — **scaling & isolation limits** | 🟠 | See target architecture. |
| F2 | No visible **observability/tracing** across web→engine→AI | 🟠 | Stuck workflows found only by humans. |
| F3 | SLA/`due_date` tracked but **no automated escalation** on overdue reviews (only an Overdue count) | 🟠 | |
| F4 | Manual **recalculate report (stage/prod)** implies environment coupling in the app | 🟡 | |
| F5 | No **rate limiting / cost controls** on AI spend surfaced | 🟠 | Opus 4.8 at volume is a cost center. |

## Prioritized top 10 (impact × effort)
1. **D1** immutable audit log + provenance (compliance foundation).
2. **B2** human-in-the-loop AI review UI with confidence & sources.
3. **A4** cap-table platform integrations (import instead of PDF).
4. **B5/B1** auto-run AI on upload + automated QA/sanity gates + workflow auto-advance.
5. **C1** pin engine + template + prompt versions per valuation (reproducibility).
6. **A1/A2** client status tracker + client portal.
7. **E1/E3** partner portal + webhooks.
8. **F2** end-to-end observability & stuck-workflow alerting.
9. **F3** SLA escalation automation.
10. **B4** prompt eval/regression harness + **F5** AI cost controls.
