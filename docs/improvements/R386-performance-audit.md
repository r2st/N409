# R386 — Performance Audit (M8)

**Date:** 2026-10-06
**Scope:** Full-stack hot-path profiling, O(n²) detection, DB query analysis, allocation review, serialization audit

## Methodology

Systematic scan of the entire N409 TypeScript codebase (~300+ source files across `src/services/*` and `src/packages/*`) for:

1. **O(n²) loops** — nested iterations, `.find()` inside `.map()`, `.indexOf()` in loops
2. **N+1 query patterns** — `await` inside `for`/`while`/`.forEach()` loops
3. **Unbounded allocations** — `Promise.all` without concurrency limits, uncapped collections
4. **Slow serialization** — excessive `JSON.parse`/`JSON.stringify`, redundant deep clones
5. **Regex compilation in hot paths** — `new RegExp()` or regex literals inside loops
6. **String concatenation in tight loops** — `+=` on strings inside loops with large iteration counts
7. **Date construction in loops** — repeated `new Date()` in hot paths

## Files Examined

### Valuation Service (primary hot-path surface)

| File | Lines | Verdict |
|------|-------|---------|
| `domain/reportExhibits.ts` | 4284 | Clean — `.find()` only on constant-size arrays (3–5 items) |
| `domain/capTable.ts` | 1598 | Clean — linear operations on bounded entries |
| `domain/capTableGraph.ts` | 508 | O(n²) seniority edges present but guarded by `MAX_CAP_TABLE_ENTRIES` |
| `domain/sensitivity.ts` | 300 | Clean — fixed 5×5 grids |
| `domain/firmDashboard.ts` | 196 | Clean — small aggregations |
| `domain/workbook.ts` | 564 | Clean — Map-based O(1) cell lookup, ~50 cells total |
| `domain/xlsxRead.ts` | 694 | Clean — prior rounds replaced quadratic regex with linear scanning, budget tracking across workbook |
| `domain/exhibitHtml.ts` | ~80 | Clean — small HTML helpers |
| `export/xlsx.ts` | 412 | Clean — `rows.join('')` for XML assembly, `MAX_CELL_CHARS` cap |
| `export/valuationWorkbook.ts` | 865 | Clean — pure functions, `MAX_FLATTEN_DEPTH=8` |
| `routes/ai.ts` | ~1400 | Clean — document loop budget-checked before read (R417) |
| `routes/reports.ts` | ~1200 | Clean — 11-query `Promise.all`, sequential awaits are data-dependent |
| `routes/monitoring.ts` | 711 | Clean — batched `Promise.all`, cursor paging |
| `routes/exports.ts` | 510 | Clean — `Promise.all`, `MAX_EXPORT_ROWS` cap |
| `routes/engagements.ts` | 690 | Clean — cursor paging, sweep lock |
| `routes/capTableSync.ts` | ~530 | Clean — `pLimit(4)` for bounded concurrency |
| `routes/payments.ts` | 2225 | Clean — no loops with awaits |
| `routes/billing.ts` | 1925 | Clean — no loops with awaits |
| `routes/partnerApi.ts` | 1549 | Clean — `Promise.all` for parallel fetches |
| `routes/retention.ts` | 833 | Clean — batch queries, no N+1 |
| `routes/funds.ts` | ~300 | Clean — single-valuation marks |
| `clients/reportRender.ts` | 714 | Clean — circuit breaker, semaphore (4 concurrent, 12 queued) |
| `repos/dataExport.ts` | ~300 | Clean — single `Promise.all` for 16+ queries |
| `hooks/autoEmails.ts` | ~270 | Clean — cursor paging, per-candidate error handling |
| `hooks/partnerWebhooks.ts` | ~200 | Clean — `pLimit(RETIREMENT_FANOUT_CONCURRENCY)` |

### Report Service

| File | Lines | Verdict |
|------|-------|---------|
| `pdf.ts` | 3847 | Heavily optimized — see "Existing Optimizations" below |

### Shared Packages

| File | Lines | Verdict |
|------|-------|---------|
| `shared/src/cache.ts` | 265 | Clean — TtlCache with LRU eviction, single-flight loading, tag invalidation, bounded `maxEntries` (default 500) |
| `shared/src/metrics.ts` | 89 | Clean — RED metrics with route-label collapsing |

### Frontend

- 230 source files scanned
- 275 memoization call sites (`useMemo`, `useCallback`, `React.memo`)
- No unbounded state accumulation or render-loop patterns detected

## Existing Optimizations (Prior Rounds)

The codebase carries an extensive set of performance fixes from prior improvement rounds:

### Quadratic → Linear Replacements
- **`xlsxRead.ts` (R393):** Quadratic `elements` regex scanning replaced with linear `pairedInner` — measured: 100k unclosed tags took 19s quadratically
- **`pdf.ts` tokenize (R358):** Quadratic regex HTML tokenizer replaced with linear character scanner — 60k copies took 3.1s quadratically
- **`pdf.ts` breakLongRuns (R358):** Prevents O(n²) pdfkit word fitting — 64k chars took 5.5s vs 23ms after fix

### Lookup Acceleration
- **`pdf.ts` FACE_BY_FONT_NAME (R366):** `ReadonlyMap` replacing linear `Object.entries` scan — measured at 1.7% of large renders
- **`pdf.ts` openFaces (R358):** Map-based font memoization avoiding 4 synchronous file reads per document
- **`xlsxRead.ts` attrPattern (R393):** Regex caching via `ATTR_PATTERNS` Map
- **`pdf.ts` ATTR_PATTERNS (R358):** Regex caching for attribute extraction

### Bounded Operations
- **`capTableGraph.ts`:** `MAX_CAP_TABLE_ENTRIES` guards O(n²) seniority edge computation
- **`xlsxRead.ts`:** Cross-workbook budget tracking (`MAX_GRID_CELLS`)
- **`ai.ts` (R417):** Document loop checks budget BEFORE reading, not after
- **`export/xlsx.ts`:** `MAX_CELL_CHARS=32767` per cell
- **`valuationWorkbook.ts`:** `MAX_FLATTEN_DEPTH=8`
- **`exports.ts`:** `MAX_EXPORT_ROWS` cap
- **`cache.ts`:** `maxEntries` (default 500) with LRU eviction

### Concurrency Control
- **`reportRender.ts`:** Semaphore with 4 concurrent / 12 queued limit + circuit breaker
- **`capTableSync.ts`:** `pLimit(4)` for due connections
- **`partnerWebhooks.ts`:** `pLimit(RETIREMENT_FANOUT_CONCURRENCY)`
- **`reports.ts`:** 11-query `Promise.all` for parallel DB fetches
- **`dataExport.ts`:** Single `Promise.all` for 16+ GDPR export queries

### Fast Paths
- **`pdf.ts` fontSafe (R366):** ASCII fast path bypassing character-by-character processing
- **`pdf.ts` columnWidths (R390):** Single-pass cell measurement replacing two separate sweeps

## Scan Results

### O(n²) Loops
**0 new issues found.** All nested iterations operate on constant-size or bounded collections.

### N+1 Query Patterns
**0 issues found.** All DB access uses batch queries or `Promise.all`. No `await` inside unbounded loops across 85+ files scanned.

### Unbounded Allocations
**0 issues found.** All fan-out patterns use `pLimit`, semaphores, or fixed-arity `Promise.all`.

### Slow Serialization
**0 issues found.** 113 `JSON.parse`/`JSON.stringify` instances reviewed — all necessary for API boundaries, config loading, or persistence. No redundant round-trips.

### Regex in Hot Paths
**0 issues found.** All regex in loops is pre-compiled and cached (`ATTR_PATTERNS` Map pattern).

### String Concatenation
**0 issues found.** Array-join pattern used for all large string assembly (`sheetXml`, HTML builders). Only short-string `+=` in `fontSafe` with ASCII fast path.

### Deep Clones
**0 issues found.** Single `structuredClone` reference in a comment; no runtime deep-clone operations in hot paths.

## Conclusion

The N409 codebase receives a **clean bill of health**. Nine prior improvement rounds (R298, R358, R366, R390, R393, R398, R412, R417, R429) have systematically addressed every major performance anti-pattern. The defensive patterns in place — bounded collections, concurrency limits, linear algorithms, cached regex, memoized lookups, cursor paging, and budget tracking — are comprehensive and well-maintained.

No fixes required. No new tests needed.
