# R366 — Performance (M8)

**Cycle 54 · Pair 3 · 2026-10-06**

Focus: sequential DB round-trips that could be parallelised, N+1 patterns,
unnecessary data loading, O(n²) algorithms on hot paths — particularly areas
changed since R355 (billing R364, error messages R365, computation paths).

---

## Findings

### 1. `runAiPipeline` runs four independent DB queries sequentially

**File:** `src/services/valuation/src/routes/ai.ts`  
**Severity:** MEDIUM  
**Lines:** 491–577 (before fix)

`runAiPipeline` is the entry point for every AI agent run — extraction,
narrative drafting, QA review, tagging, and anonymisation.  Before the fix
it issued four sequential `await` calls against independent tables:

```
findParams(pool, valuation.id)           → valuation_params
listDocuments(pool, valuation.id)        → documents
findPromptByPipeline(pool, pipeline)     → ai_prompts
findRedactionIdentity(pool, user_id)     → users
```

None of these depends on another's result.  `latestPromptVersion` (which
*does* depend on `promptRow`) ran after the third, correctly.

**Impact:** Each call is a Postgres round-trip (~1–3 ms local, ~5–15 ms
cross-AZ).  Four sequential round-trips added 4–60 ms of pure wait to every
AI pipeline invocation — the most expensive user-initiated path in the
product.

**Fix:** Wrap all four in a single `Promise.all`.  `latestPromptVersion`
and the `promptRow.enabled` check remain sequential since they depend on
`promptRow`.

### 2. Evidence bundle spreads 18 independent queries across three sequential `Promise.all` batches

**File:** `src/services/valuation/src/routes/evidence.ts`  
**Severity:** MEDIUM  
**Lines:** 77–166 (before fix)

The evidence bundle route loaded engagement data in three sequential waves:

| Wave | Queries | Round-trips |
|------|---------|-------------|
| 1    | events, calculations, documents, comments, signatures, aiJobs, report, generator | 1 |
| 2    | decisions, qaReviews, scenarios, research, comparables, traces, workbook | 1 |
| 3    | review_tasks, admin_events, prompt_versions, listVersions(report) | 1 |

Waves 1 and 2 are completely independent.  Three of wave 3's four queries
are also independent of waves 1 and 2.  Only `listVersions` depends on
`report` from wave 1.

**Impact:** Three sequential round-trip windows instead of one (plus a tiny
second for `listVersions`).  The evidence bundle is an ops-triggered export
that touches 18 tables; collapsing the waves saves two full Postgres
round-trips per bundle generation.

**Fix:** Merge waves 1, 2, and the three independent wave-3 queries into a
single 18-query `Promise.all`.  `listVersions` stays in a separate `await`
since it needs `report`.

---

## Files changed

| File | Change |
|------|--------|
| `src/services/valuation/src/routes/ai.ts` | Parallelise four sequential DB reads in `runAiPipeline` |
| `src/services/valuation/src/routes/evidence.ts` | Merge three sequential `Promise.all` batches into one |
| `src/services/valuation/test/unit/parallelQueryBatching.test.ts` | **New** — structural guards for both fixes |

## Tests

- `parallelQueryBatching.test.ts` — 4 tests verifying:
  - `runAiPipeline` runs all four loaders in one `Promise.all`
  - No standalone sequential awaits of `findParams`, `listDocuments`, or
    `findRedactionIdentity` in `runAiPipeline`
  - Evidence bundle runs all 15+ independent queries in one `Promise.all`
  - Evidence bundle has at most 2 `Promise.all` batches (was 3)
- `evidenceBundleCensus.test.ts` — 6 existing tests pass
- `evidence.test.ts` (integration) — 8 existing tests pass
- `pipeline.test.ts` — 34 existing tests pass
- TypeScript type check clean

## Previous M8 findings (for context)

| Round | Finding | Severity |
|-------|---------|----------|
| R358  | AI redactor ~1000 regex passes per string | HIGH |
| R351  | 5 paged consoles running count+page in series | HIGH |
| R330  | Evidence bundle shipped uncompressed (36× reduction) | HIGH |
