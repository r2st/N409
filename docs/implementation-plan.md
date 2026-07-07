# 409.ai — Implementation Plan

Prioritized milestones + ready-to-file GitHub issues for the rebuild. Grounded in
[`requirements.md`](./requirements.md), [`feature-gap-analysis.md`](./feature-gap-analysis.md),
and the target [`architecture.md`](./architecture.md). Strategy = **strangler migration**: build
new services beside the existing Rails+R app, cut over surface-by-surface, retire the monolith last.

> **Docs-before-code:** every milestone updates the relevant design doc before implementation, per
> the project brief. This file is the source of truth for scope/sequence.

## Guiding priorities (from the gap analysis)
1. Compliance/audit foundation (immutable events, reproducibility pinning).
2. Trustworthy AI (human-in-the-loop, auto-run, QA gates, cost control).
3. Client & partner experience (status tracker, portal, integrations, webhooks).
4. Platform hardening (service split, observability, SLA automation).

---

## Milestone 0 — Foundations (repo, CI, skeleton) · ~1–2 wks ✅ (2026-07-06)
Goal: a deployable skeleton with the aggregate root and audit spine.
- [x] **#1** Monorepo + service scaffolding (web, valuation, ai, engine-wrapper, report); lint/format/test/CI (GitHub Actions); Docker; Terraform baseline (VPC, RDS Postgres, S3, Redis).
- [x] **#2** Core schema migrations: `valuations`, `valuation_params`, `users/roles`, `valuation_events` (append-only). Seed enums/roles.
- [x] **#3** AuthN/Z: email+password, **Google OIDC SSO**, session/JWT, RBAC policy layer (17 role keys) + partner scoping.
- [x] **#4** Observability baseline: OpenTelemetry, structured logging (PII-redacted), health checks.

**Exit:** ✅ create a valuation via API; every change writes a `valuation_event`; traces exported when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set. Verified by the integration suite
(`src/services/valuation/test/integration/`) and a live smoke test.

> M0 notes: the observed role set is 17 keys (not 15 as first estimated). LLM calls will go through
> **OpenRouter** (free-tier models) rather than direct provider SDKs — reflected in the AI service
> config; the M2 gateway keeps the same provider-abstraction design. Google SSO needs
> `GOOGLE_CLIENT_ID/SECRET` env values (kept in `keys/`, never committed) to activate.

## Milestone 1 — Valuation core & workflow · ~2–3 wks
- [ ] **#5** Valuation state machine + guarded `/transition`; `waiting_on_client`; reassign; clone/roll-forward.
- [ ] **#6** Temporal `ValuationLifecycle` workflow (restartable, idempotent activities, SLA timers).
- [ ] **#7** Valuation Params CRUD + validation (weights sum to 1, DLOM method, market multiples).
- [ ] **#8** Overwrites (68 fields) with original-value preservation + Overwrites schema explorer parity.
- [ ] **#9** Admin worklist: filters/scopes/sort/CSV + ops dashboard (stage×product pivot + charts).

**Exit:** a valuation moves pending→published manually via the workflow with full audit.

## Milestone 2 — Documents & AI extraction · ~3 wks
- [ ] **#10** Ingestion: multipart upload, doc classification by kind, virus scan, KMS-encrypted S3, signed URLs.
- [ ] **#11** AI gateway + provider adapters (Anthropic Opus 4.8, Bedrock Sonnet 3.5/Llama 3.3, Perplexity); budget guardrails, caching, retries, `ai_jobs` provenance.
- [ ] **#12** **Cap-table anonymization** gate before any LLM call.
- [ ] **#13** Pipelines: Data Extraction, Missing Data, Public Comparables, Set Params, Summarize, Find Mappings — **auto-run on upload** + workflow signal.
- [ ] **#14** Prompt registry (versioned) + eval/regression harness on a golden set.
- [ ] **#15** Human-in-the-loop review UI: confidence + source citation + accept/edit/reject per extracted value.

**Exit:** upload financials → AI populates params/comparables with provenance → analyst accepts.

## Milestone 3 — Engine integration & calculations · ~2–3 wks
- [ ] **#16** Wrap existing **R/Plumber engine** behind the versioned `/engine/v1` contract; digest-pinned images.
- [ ] **#17** `compute` + `sensitivity` + `roll-forward` endpoints; persist `calculations`, `share_class_values`, `sensitivity_results`.
- [ ] **#18** Reproducibility: pin engine/template/prompt versions + inputs snapshot per valuation.
- [ ] **#19** Automated QA gates (FMV vs last round, DLOM bounds, cross-foot, weights) → block draft on failure.
- [ ] **#20** Sensitivity dashboard (OPM stress grids).

**Exit:** engine computes FMV reproducibly; QA gates run before drafting.

## Milestone 4 — Reporting & review workflow · ~3 wks
- [ ] **#21** Report service: versioned templates, structured editor persistence, PDF render, version history.
- [ ] **#22** Review/task system: typed sections, assignment, SLA/overdue, "assigned to me".
- [ ] **#23** Draft→accept/changes→sign(main/second)→publish; deliver PDF; immutable snapshot.
- [ ] **#24** **SLA escalation automation** (notify/reassign on overdue).

**Exit:** full drafted→reviewed→signed→published path with e-signatures and snapshots.

## Milestone 5 — Comms & client experience · ~2 wks
- [ ] **#25** Email ingestion → valuation comments; unassigned-email routing; read/unread tracking.
- [ ] **#26** Per-valuation client chat + status emails on transitions.
- [ ] **#27** **Client portal**: status tracker/timeline, valuation list, report re-download, one-click roll-forward.

**Exit:** clients self-serve status; inbound email lands on the right valuation.

## Milestone 6 — Partner platform · ~2 wks
- [ ] **#28** Partner API (`/partner/v1`) + token management (hashed secrets, scopes).
- [ ] **#29** Partner **webhooks** (created/updated/waiting/drafted/published) — signed, retried.
- [ ] **#30** Partner portal + **white-label reports** (branding per partner).

**Exit:** partners create valuations, receive webhooks, get branded PDFs.

## Milestone 7 — Hardening & cutover · ongoing
- [ ] **#31** Load/perf tuning to NFR targets; read replicas; table partitioning (`events`, `ai_jobs`).
- [ ] **#32** Security review + pen test; audit-log tamper-evidence; data-residency handling.
- [ ] **#33** AI **cost dashboard** + tiered model routing.
- [ ] **#34** Strangler cutover: migrate remaining admin surfaces; decommission monolith; data backfill/migration.

---

## Cross-cutting definition of done
- Tests: unit + integration + contract (engine/AI) + golden-file valuation regressions.
- Docs updated (this folder) before merge; ADRs for significant decisions.
- Observability: traces/metrics/alerts for every new path.
- Security: RBAC + partner scoping enforced; PII redacted in logs; secrets in vault.

## GitHub setup (to run when the GitHub connector is authorized)
- **Labels:** `milestone/0…7`, `area/valuation`, `area/ai`, `area/engine`, `area/report`,
  `area/partner`, `type/feature`, `type/infra`, `priority/{high,med,low}`, `compliance`.
- **Milestones:** M0–M7 as above.
- **Issues:** #1–#34 above (title = bold text; body = checklist + acceptance criteria).
- The GitHub MCP server was **unauthenticated** during this session, so issues are drafted here
  rather than filed. Authorize GitHub (via `claude mcp` / `/mcp` in an interactive session) to
  auto-create them.
```
