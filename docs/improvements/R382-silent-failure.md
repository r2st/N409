# R382 — Silent Failure Audit

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Round          | R382                                     |
| Methodology    | M5 — silent failure audit                |
| Cycle / Pass   | 94 / 5                                   |
| Findings       | 1 MEDIUM                                 |
| Commit         | (this commit)                            |

## Finding 1 — MEDIUM: OrderHistory hides its own error from the user

**File**: `src/services/web-frontend/src/pages/OrderPage.tsx` (lines 197–256, pre-fix)

**Bug**: The `OrderHistory` sub-component fetches `/me/orders` and stores any
error in state, but the render path silently returns `null` when the error is
set — the entire "Order history" section vanishes as though the user has no
orders:

```typescript
// Before
.catch(() => setError('Could not load order history.'));
// …
if (error) return null;   // section vanishes
```

Two issues:

1. **Silent UI**: an error makes the section disappear entirely. A user who has
   past orders sees nothing — no heading, no error message, no indication that
   anything went wrong. The failure is indistinguishable from "you have no
   orders".

2. **Discarded server detail**: the `.catch` ignores the `err` parameter and
   substitutes a fixed string. When the server responds with a structured
   `Problem` whose `detail` explains what happened (e.g. "database connection
   lost"), that detail is thrown away.

This pattern escapes the automated swallowed-failure census because
`.catch(() => setError('string'))` is explicitly excluded from its `SWALLOW`
regex — the census considers `setError` a handler, and it is, but only if the
error is actually shown.

**Impact**: A transient backend failure (a database hiccup, a 503) silently
hides the order history section on the purchase page. The user sees an empty
page where their orders should be, with no way to know something went wrong or
that a retry might help.

**Fix**:

1. Changed the catch to capture the error and use `describeLoadFailure`:
   ```typescript
   .catch((err: unknown) => setError(describeLoadFailure(err, 'Could not load order history.')))
   ```

2. Changed the error branch from `return null` to render the section heading
   with an `<ErrorNote>` showing the error message, so the user sees what
   happened and knows to retry.

**Tests**: `test/OrderPage.test.tsx` — 2 new cases:
- `shows error when order history fails to load` — verifies the section renders
  with a `role="alert"` element on a 500
- `preserves server detail in order-history error message` — verifies a 503's
  `detail` field ("Service temporarily unavailable") appears in the alert text

## Scan summary

Searched the full `src/` tree for M5 patterns:

- All `.catch(() => ...)` chains in the frontend — compared against
  `describeLoadFailure` / `describeActionFailure` / `describeRequestFailure`
  usage; the one gap is OrderHistory above
- "Set error but return null" pattern — only OrderHistory has it
- Block-form `try/catch` discards — all classified in the census or have
  upstream error handling
- Backend catch blocks — all use `logUnretried` / `logFailure` or re-throw
- `Number()` coercion, `parseInt`/`parseFloat` — all guarded since R367/R376
- `JSON.parse` without try/catch — all inside validated paths
- New files since R376 (`FundingHistory.tsx`, `IntakeLinksPanel.tsx`,
  `fmvEstimator.ts`) — clean error handling throughout

This is M5 Pass 5 across 94 improvement cycles. The one finding is a render-
path bug that the automated census cannot see: the failure is captured into
state but the render branch hides it instead of showing it.
