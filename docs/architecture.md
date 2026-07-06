# 409.ai — Target Architecture

A scalable, production-ready architecture for the rebuild. It preserves what the current system
does well (AI extraction + an R quant engine + a rich analyst back-office) while addressing the
gaps in [`feature-gap-analysis.md`](./feature-gap-analysis.md) — reproducibility, auditability,
observability, and independent scaling.

## 1. Principles
- **Domain-driven, service-per-capability** — not nano-services; split where scaling, isolation,
  or team boundaries justify it.
- **The Valuation is the aggregate root**; everything is an event on it.
- **Reproducibility & audit are first-class** — event-sourced valuation history; pinned engine/
  template/prompt versions.
- **Async by default** — long work (AI, engine, PDF) runs on queues with idempotent, retryable
  jobs; the web tier stays fast.
- **Provider-abstracted AI** — one gateway, many models (Anthropic, Bedrock, Perplexity).
- **Clean architecture / SOLID** inside each service; ports & adapters at the edges.

## 2. C4 — Context
```
        ┌─────────┐        ┌──────────┐        ┌───────────┐
        │ Clients │        │ Partners │        │ Ops team  │
        │(founders)│       │ (APIs)   │        │(analysts, │
        └────┬────┘        └────┬─────┘        │ reviewers)│
             │                  │              └─────┬─────┘
             ▼                  ▼                    ▼
        ┌───────────────────────────────────────────────────┐
        │                 409.ai Platform                    │
        │  onboarding · valuations · AI · engine · reports   │
        └───────────────────────────────────────────────────┘
             │            │            │            │
             ▼            ▼            ▼            ▼
        Stripe      Anthropic /   Cap-table    Email / e-sign
        (payments)  Bedrock /     integrations (SES / DocuSign)
                    Perplexity    (Carta…)
```

## 3. C4 — Containers (services)
| Service | Responsibility | Stack (proposed) |
|---------|----------------|------------------|
| **Web/BFF (client + partner + admin)** | UI, auth, request orchestration | Next.js (React) + Node/TS API, or keep Rails for admin during migration |
| **Valuation service** | Aggregate root, state machine, params, overrides, audit events | Node/TS or Rails; PostgreSQL |
| **Workflow orchestrator** | Drives lifecycle transitions & fan-out of jobs; restartable | Temporal (durable workflows) |
| **AI service** | Pipelines (extraction, missing-data, comparables), prompt registry, model routing, anonymization | Python (best AI SDK ecosystem) |
| **Valuation engine** | The finance math (OPM, income/market/asset, DLOM, roll-forward, sensitivity) | **R + Plumber** (keep), C++ hot paths; versioned container images |
| **Report service** | Template render, editor persistence, PDF, versioning | Node/TS + headless Chromium / Typst |
| **Ingestion service** | Uploads, virus scan, document classification, storage | Node/TS + S3 |
| **Notification/Email** | Inbound email→comments, outbound status emails, unassigned routing | Node/TS + SES + inbound parse |
| **Identity/RBAC** | Auth (password + Google OIDC), roles, sessions, API tokens | Provider (e.g. Auth) + policy service |

Shared infra: **PostgreSQL** (primary), **Redis** (cache/queues), **S3** (documents/PDFs),
**object-level KMS encryption**, **message bus** (SQS/Kafka), **Temporal**, **OpenTelemetry**
collector, **API gateway**.

## 4. Key flows
### 4.1 Intake → published (happy path)
1. Client onboards (kind, company, contact) → **Valuation** created (`pending`).
2. Payment (Stripe) → `paid`; SLA `due_date` set.
3. Uploads land in **Ingestion** → classified by kind → stored (encrypted) → event emitted.
4. **Workflow** fans out **AI** pipelines: anonymize cap table → extract data → missing-data →
   comparables → set params. Each writes results + provenance as valuation events.
5. Analyst reviews/overrides in the workbench; **Engine** computes FMV (pinned engine version).
6. **Report** renders draft → review tasks (Data/Review/Approve) → client accepts →
   signatures → `published`; final PDF delivered; immutable snapshot stored.

### 4.2 Reproducibility
Every valuation stores `{engine_version, template_version, prompt_versions[], inputs_snapshot}`.
Re-running references the same container digests → identical output.

### 4.3 AI model routing
AI service resolves each prompt → provider/model (Anthropic Opus 4.8 for structured extraction,
Bedrock Sonnet 3.5 for anonymization, Perplexity for research), with budget guardrails, caching,
retries, and full request/response logging (anonymized inputs).

## 5. Cross-cutting concerns
- **Security:** TLS everywhere; KMS-encrypted docs/DB; PII/cap-table anonymization before any LLM
  call; secrets in a vault; RBAC enforced in a central policy layer; least-privilege service IAM.
- **Audit/compliance:** append-only `valuation_events`; who/what/when/source on every change;
  retention policy for published reports.
- **Observability:** OpenTelemetry traces spanning web→workflow→engine→AI; per-job cost/latency
  metrics; dashboards + alerts on stuck workflows, overdue SLAs, AI spend, error rates.
- **Resilience:** idempotency keys on payments & jobs; dead-letter queues; circuit breakers around
  AI/engine; graceful degradation (queue when a provider is down).
- **Scalability:** stateless web/workers scale horizontally; engine and AI workers scale
  independently by queue depth; read replicas for reporting/dashboards.

## 6. Deployment
- **Containers** (Docker) on **Kubernetes** (or ECS) with per-service autoscaling.
- **CI/CD:** GitHub Actions → build/test → scan → deploy; engine images are immutable, digest-
  pinned, and promoted staging→prod via the pipeline (not from the app UI).
- **Environments:** dev / staging / prod isolated; IaC (Terraform).
- **Data:** managed PostgreSQL (multi-AZ) + read replicas; S3 with versioning + lifecycle; Redis.

See [`system-design.md`](./system-design.md) for component/deployment detail,
[`database-design.md`](./database-design.md) for the schema, and [`api-design.md`](./api-design.md)
for the API surface.
