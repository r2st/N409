# R381 — Observability Audit (Clean Pass)

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Round          | R381                                     |
| Methodology    | M11 — observability audit                |
| Cycle / Pass   | 94 / 5                                   |
| Findings       | 0 — clean pass                           |
| Commit         | (this commit)                            |

## Audit scope

Searched the full estate for M11 observability gaps: missing structured logging,
missing metrics, missing health checks, insufficient error context, and blind
spots in monitoring. This is the fifth M11 pass; the most recent was R377, which
found and fixed three issues (alert `for` clause, gauge naming, event loop lag).

## Areas scanned

### Shared packages (`src/packages/shared/`)

- **scheduler.ts** — `nonOverlapping` tracks `running`, `skipped`, `started`,
  `failed` counts; `sweepFailed` uses `logFailure` for classified alerting;
  `trackedSweep` correlates logs with `runWithSweep`; `quiesceAndLog` reports
  shutdown outcomes. No gaps.

- **startup.ts** — `awaitDependencies` logs retries with failure classification,
  permanent failures at `error` with `alert: true`, optional dependencies at
  `warn`; `StartupGate` for readiness. No gaps.

- **prometheus.ts** — `seriesCensus`, `collectFailures` counter for gauge
  throws, `registerHttpMetrics` for RED, `registerProcessMetrics` for build
  info / uptime / memory / event loop lag / series census / alert lines. No gaps.

- **circuit.ts** — `CircuitBreaker` with `onStateChange` callback,
  `CircuitTicket` episode tracking for straggler detection, `snapshot()` for
  gauge exposure, `CircuitOpenError` with `retryAfterMs`. No gaps.

- **cache.ts** — `TtlCache` with tag-based invalidation and `getOrLoad` single-
  flight. Pure in-memory utility; callers instrument as needed. No gaps.

### Valuation service — hooks and sweeps

- **hooks/pipelineRetry.ts** — every branch calls `recordPipelineRetryOutcome`
  with labelled outcomes (`skipped_deleted`, `skipped_retired`,
  `skipped_opted_out`, `resumed`, `stranded`); per-row catch with
  `logUnretried`. No gaps.

- **email/sendAttempt.ts** — `sendAndRecord` separates transport from
  bookkeeping failures; `recordEmailSendAttempt` with outcomes `sent`, `failed`,
  `unrecorded`; `logUnretried` for unrecorded deliveries. No gaps.

- **email/smtp.ts** — `SmtpError` carries `stage` and `replyCode` for
  downstream classification; `smtpTransport.send` logs delivered messages at
  `info` with `emailId` (not PII). No gaps.

### Valuation service — clients and integrations

- **clients/deadline.ts** — `IntegrationError` with `status` and
  `retryAfterSeconds`, `withDeadline` with transient marking,
  `readCappedBytes` / `readJson` with size caps, `pagedPullBudget` with time
  and byte budgets, `providerRefused` with Retry-After parsing,
  `describeConnectorFailure` for safe error echoing. No gaps.

- **clients/accounting.ts** / **clients/hris.ts** — shared instrumentation
  pattern via `deadline.ts` utilities. No gaps.

- **clients/oauthRefresh.ts** — `storeRefreshedTokens` uses `logUnretried`
  with `rotated` flag for credential loss detection;
  `ReconnectRequiredError` for permanent auth failures. No gaps.

- **clients/capTableSync.ts** — uses `withDeadline`, `readJson`,
  `pagedPullBudget`, `providerRefused`, `IntegrationError` from the shared
  client infrastructure. No gaps.

### Valuation service — crypto and storage

- **crypto/envelope.ts** — pure crypto module (AES-256-GCM seal/open with key
  rotation). No observability needed beyond what callers provide. No gaps.

- **crypto/connectionSecrets.ts** — seal/open for integration credentials with
  key ring fallback chain. Callers handle logging. No gaps.

- **storage/blobFile.ts** — `writeBlobAtomically` for safe blob writes;
  `readStoredBlob` logs decryption/integrity failures at `error` with
  `alert: true`. No gaps.

### Valuation service — payments and export

- **payments/stripe.ts** — `recordStripeRequest` and `stripeOutcomeForStatus`
  for Stripe HTTP outcomes. No gaps.

- **observability/exportMetrics.ts** — `data_exports_total` counter and
  `data_export_duration_seconds` histogram by format/kind. No gaps.

- **export/pdf.ts** — pure data transform (tabular PDF generation). No
  observability needed. No gaps.

### Valuation service — realtime and infrastructure

- **realtime/hub.ts** — `stats()` for gauge exposure, `ceilings()` for capacity
  reporting, `HubCapacityError` for refusals. No gaps.

- **db/migrate.ts** — `MigrationLockTimeoutError` with holder PIDs,
  `MigrationDriftError`, `EmptyMigrationError`, `explainMigrationFailure` for
  lock/statement timeout codes, `onIssue` channel for unreleased locks. No gaps.

- **documents/virusScan.ts** — `scanUpload` logs scanner errors at `error` with
  `alert: true` on both fail-open and fail-closed arms; infected verdicts at
  `warn`. No gaps.

### Cross-cutting checks

- **`console.log/error/warn`**: only `db/migrate-cli.ts` (CLI tool, intentional)
  and a comment in `clientErrors.ts`. No unstructured logging in service code.

- **Empty catch blocks**: none found anywhere in `src/`.

- **Alert `for` clauses**: all page-severity rules carry `for` per R377's test.

- **Health endpoints**: `/health` (liveness) and `/ready` (dependency checks)
  both correct per R377's audit.

- **Log levels**: failure logging uses `logFailure` / `logUnretried` with
  `alert: true` throughout; informational sweep summaries at `info`. Correct.

## Conclusion

The codebase is thoroughly instrumented after four prior M11 passes. Every
external HTTP client has deadlines and classified failure handling. Every
background sweep uses `trackedSweep` with `logFailure` / `logUnretried` and
`alert: true`. Prometheus metrics cover HTTP RED, process health, event loop
lag, circuit breakers, export durations, email delivery, pipeline retry
outcomes, and Stripe operations. Health checks, startup gates, and dependency
probes are comprehensive. No actionable observability gaps remain.
