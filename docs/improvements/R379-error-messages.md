# R379 — Error messages (M19, Pass 4)

## Summary

Five load-failure catch blocks across four components still used bare `} catch {`
(no error binding), discarding the server's RFC 9457 `detail` and showing a
hardcoded fallback instead. This meant a 403 "You do not have access to this
valuation" and a 500 "Internal Server Error" both displayed the same generic
message, removing the one piece of information the user could act on.

All five sites now use `describeLoadFailure(err, fallback)` — introduced in R374
— which surfaces the server's `detail` when present and falls back to the
generic message only when the server sends no detail at all.

## Findings

### Finding 1 — Load-failure catch blocks discard server detail (5 sites, 4 components)

**Components affected:**

| Component | File | Catch site |
|---|---|---|
| FundingHistory | `src/components/FundingHistory.tsx` | `load()` |
| DocumentsPanel | `src/components/valuation/DocumentsPanel.tsx` | `load()` |
| AiPanel | `src/components/valuation/AiPanel.tsx` | `load()` |
| IntakeLinksPanel | `src/components/IntakeLinksPanel.tsx` | `open()` |
| IntakeLinksPanel | `src/components/IntakeLinksPanel.tsx` | `beginConvert()` |

**Before:** `} catch { setError('Could not load …'); }`
**After:** `} catch (err) { setError(describeLoadFailure(err, 'Could not load …')); }`

**Why it matters:** The server already sends structured, user-safe detail in
every problem+json response — a 403 explains the permission, a 429 says when to
retry, a 503 names the subsystem. Discarding it forces the user to guess or
contact support for information the server already told the client.

## Test coverage

Each fix has two test cases: one proving the server's detail is surfaced, one
proving the generic fallback is used when the server sends no detail.

| Test file | New/updated tests |
|---|---|
| `test/FundingHistory.test.tsx` | 1 updated, 1 added |
| `test/AiPanel.test.tsx` | 1 replaced with 2 (detail + detailless) |
| `test/DocumentsPanel.test.tsx` | 1 replaced with 2 (detail + detailless) |
| `test/IntakeLinksPanelFailures.test.tsx` | 2 updated, 1 added |

## Files changed

- `src/components/FundingHistory.tsx`
- `src/components/valuation/DocumentsPanel.tsx`
- `src/components/valuation/AiPanel.tsx`
- `src/components/IntakeLinksPanel.tsx`
- `test/FundingHistory.test.tsx`
- `test/AiPanel.test.tsx`
- `test/DocumentsPanel.test.tsx`
- `test/IntakeLinksPanelFailures.test.tsx`
