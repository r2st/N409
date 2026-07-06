# 409.ai — System Design

Component- and infrastructure-level detail behind [`architecture.md`](./architecture.md).

## 1. Workflow orchestration (the heart)
The valuation lifecycle is a long-running, human-and-machine workflow. Model it with a **durable
workflow engine (Temporal)** so it survives restarts, supports the existing "Restart Workflow"
action, and makes every step observable.

```
Workflow: ValuationLifecycle(valuationId)
  pending
   └─ await payment  ──▶ paid
        └─ await uploads (signal) ─▶ onboarding_completed
             ├─ activity: anonymizeCapTable
             ├─ activity: extractData        (AI)
             ├─ activity: findMissingData     (AI)  ─▶ signal client if gaps
             ├─ activity: findComparables     (AI)
             ├─ activity: setValuationParams  (AI)
             └─ activity: computeValuation    (Engine)  ─▶ completed
                  └─ human task: analyst review/override
                       └─ activity: renderDraft (Report) ─▶ drafted
                            └─ human task: client accept ── draft_changes ↺
                                 └─ human tasks: review → sign(main,second)
                                      └─ activity: publish ─▶ published
   timers: dueDate SLA (escalate), timeout; compensations on cancel
```
Each activity is **idempotent** and **retryable**; state transitions and outputs are written as
**valuation events** (audit + reproducibility).

## 2. Component design (clean architecture per service)
Each service is layered: **domain** (entities, value objects, invariants) → **application**
(use-cases/ports) → **adapters** (HTTP, DB, queue, provider SDKs). Example — Valuation service:
- Domain: `Valuation`, `ValuationParams`, `Overwrite`, `ReviewTask`, `state machine`.
- Application: `CreateValuation`, `TransitionState`, `ApplyOverwrite`, `AssignReview`.
- Adapters: REST controllers, PostgreSQL repositories, Temporal client, event publisher.

## 3. AI service design
- **Prompt registry** (DB-backed, versioned) → resolves `{prompt, model, params}`.
- **Model router / gateway** with provider adapters: Anthropic (Opus 4.8 structured extraction),
  Bedrock (Sonnet 3.5 anonymization, Llama 3.3 competitors), Perplexity (research). Uniform
  interface: `run(promptRef, context) → {output, tokens, cost, latency, model}`.
- **Pipelines** compose prompts + parsing + validation: `DataExtraction`, `MissingData`,
  `PublicComparables`, `SetParams`, `Summarize`, `FindMappings`.
- **Guardrails:** budget check → cache lookup → anonymize inputs → call with retry/backoff →
  schema-validate output → persist `AiJob` + provenance → emit event.
- **Human-in-the-loop:** extracted values carry `confidence` + `source_ref`; low-confidence or
  high-risk values require analyst acceptance before use.

## 4. Valuation engine
- Keep the **R/Plumber** service (it encodes hard-won methodology: `BLACK_SCHOLES`, `back_solve`,
  `sa_bsm`, `CHAFFEE`, `FINNERTY`, `WEIGHTS`, `COMPARABLES`, `FRODO`/`ROLL_FRODO`, NLP comparable
  matchers, `newton_raphson` in C++).
- Wrap it behind a **stable, versioned HTTP contract** (see [`api-design.md`](./api-design.md));
  ship as **immutable, digest-pinned container images**.
- Inputs = normalized valuation params + financials + cap table; outputs = concluded FMV per
  share class, allocation, discounts, and a sensitivity grid.
- **Reproducibility:** the valuation records the engine image digest used.

## 5. Reporting
- Templates are **versioned**; report content stored structured (blocks) + rendered to PDF via
  headless Chromium or Typst. Editor persists edits as report versions; PDF stored in S3
  (versioned). Overwrites feed both the report and the audit log.

## 6. Data & storage
- **PostgreSQL** primary (see [`database-design.md`](./database-design.md)); **read replicas** for
  dashboard/reporting queries.
- **Redis** for cache (dashboard aggregates, prompt lookups), rate limiting, and light queues.
- **S3** for documents & PDFs — server-side KMS encryption, versioning, lifecycle rules,
  per-object access via signed URLs.
- **Message bus** (SQS/Kafka) between services; **DLQs** for poison messages.

## 7. Security & privacy design
- **Boundary:** API gateway (authN/z, rate limit, WAF). Central **RBAC policy service** evaluates
  role + partner scoping (partners see only their valuations).
- **Data protection:** field-level encryption for the most sensitive PII; cap-table anonymization
  gate in front of every LLM call; secrets in vault; audit log is append-only + tamper-evident.
- **Tenancy:** partner data isolation enforced at query + policy layers.

## 8. Observability
- **Tracing:** OpenTelemetry context propagated web→workflow→engine→AI; one trace per valuation
  action.
- **Metrics:** valuations by state, time-in-state, SLA breaches, AI cost/latency/token per model,
  engine compute time, PDF render time, queue depth, error rates.
- **Logging:** structured JSON, PII-redacted; correlation id = valuation id + workflow run id.
- **Alerting:** stuck workflow (no transition in N hours), overdue review, AI budget breach,
  provider errors, failed payments.

## 9. Scalability & capacity
- Web/BFF & workers: stateless, HPA on CPU/RPS/queue-depth.
- AI workers: scale on queue depth; concurrency capped per provider to respect rate limits + cost.
- Engine: pool of R workers behind a queue; scale on pending compute jobs.
- DB: connection pooling (pgbouncer), read replicas, partition high-volume tables (events, ai_jobs).
- Targets (NFR): list/dashboard p95 < 500 ms; extraction pass minutes; PDF < 30 s; 99.9% uptime.

## 10. Migration strategy (strangler)
1. Stand up new services alongside the current Rails+R app; share the DB read-only at first.
2. Route new valuations through the new workflow; keep admin on Rails until parity.
3. Move AI pipelines to the new AI service (behind the same prompt registry).
4. Wrap the existing R engine with the versioned contract before refactoring internals.
5. Cut over admin surfaces feature-by-feature; retire the monolith last.
See [`implementation-plan.md`](./implementation-plan.md) for milestones.
