# R383 — State Machine (M3, Pass 5 / C94)

Targets: invalid state transitions, missing guards, unreachable states, race conditions.

## Findings

### 1. PATCH with unchanged state echoed back alongside field changes → bogus 409

| | |
|---|---|
| File | `src/services/valuation/src/routes/valuations.ts:509-517` |
| Severity | High — any client echoing all form fields gets a spurious conflict |
| Category | Missing guard condition |

The route attached `preCommit: stateWriteGuard(…)` and forced `expectedVersion`
whenever `parsed.data.state` was truthy, regardless of whether the state actually
differed from the current row. `assertTransitionForWrite` then read `live === to`
and threw: "This valuation is already X — someone else made that change." A
whole-form PATCH like `{ state: 'review', company_name: 'New' }` on an engagement
already in `review` hit this path: the diff had `company_name`, so the transaction
opened, and the preCommit refused a state that was never changing.

**Fix:** Gate both `expectedVersion` and `preCommit` on
`parsed.data.state !== valuation.state`, matching the existing gate on
`assertTransition` and `onStateChanged` at lines 477 and 522.

### 2. Retention archive does not bump version → race allows transitioning archived engagements

| | |
|---|---|
| File | `src/services/valuation/src/repos/retention.ts:540-544` |
| Severity | High — archived engagement transitions fire emails, webhooks, audit events |
| Category | Race condition / missing version guard |

`markValuationsArchived` wrote `archived_at = now()` without incrementing
`version`. Every state transition door supplies `expectedVersion`, which is
checked against the row's `version` in the UPDATE's WHERE clause. Because the
archive left the version unchanged, a concurrent transition whose read preceded
the archive found the version still matching and the write succeeded — moving an
archived engagement through the pipeline with full downstream effects.

`refuseIfRetired` checks `archived_at` on the row the route loaded, not the live
row, so it judged the engagement active from a stale reading. The preCommit
(`stateWriteGuard`) re-reads `state` under `FOR UPDATE` but does not check
`archived_at`.

**Fix:** Add `version = version + 1` to the archive UPDATE, so any concurrent
state write with a stale `expectedVersion` is rejected.

## Tests added

| Test file | Tests |
|---|---|
| `test/integration/stateGuardNoOpState.test.ts` | 3 — unchanged state + field change accepted; illegal transition + field change rejected; terminal state + field change accepted |
| `test/integration/retentionArchiveVersion.test.ts` | 2 — version incremented on archive; state transition after archive rejected by version mismatch |

## Verification

- All 5 new tests pass
- `transitionGuard.test.ts` (5 tests) — pass, no regressions
- `retention.test.ts` (14 tests) — pass, no regressions
- `retentionRestore.test.ts` (19 tests) — pass, no regressions
- `retentionSweepAtomicity.test.ts` (6 tests) — pass, no regressions
- TypeScript build clean
